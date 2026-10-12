#!/usr/bin/env node
// Stable Diffusion WebUI (A1111) API in front of Local Dream's host mode (Android app), so SillyTavern's image generation can use
// the phone. The phone's control API (:8808: models, select, status) and generation port (:8081: /generate, SSE) are
// unauthenticated: LAN only. The prompt comes finished from SillyTavern's /pic script; this bridge only knows the backend's limits.
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

const START_TIMEOUT_MS = 180_000;
const GENERATE_TIMEOUT_MS = 600_000;
const MODELS_TTL_MS = 30_000;

// A1111 sampler name -> Local Dream scheduler id.
const SAMPLERS = [
  ["DPM++ 2M", "dpm"],
  ["DPM++ 2M Karras", "dpm_karras"],
  ["Euler a", "euler_a"],
  ["Euler a Karras", "euler_a_karras"],
  ["Euler", "euler"],
  ["Euler Karras", "euler_karras"],
  ["DPM++ 2M SDE", "dpm_sde"],
  ["DPM++ 2M SDE Karras", "dpm_sde_karras"],
  ["LCM", "lcm"],
];

// The text encoder reads about 77 tokens and no CJK: drop CJK text and keep whole leading tags within maxChars (tags are written
// most important first), so a long or mixed-language prompt degrades instead of being cut mid-tag.
export function cleanPrompt(text, maxChars) {
  const tags = text.replace(/[　-鿿＀-￯]+/g, " ").split(",").map((tag) => tag.replace(/\s+/g, " ").trim()).filter(Boolean);
  let out = "";
  for (const tag of tags) {
    const next = out ? `${out}, ${tag}` : tag;
    if (next.length > maxChars) break;
    out = next;
  }
  return out || tags.join(", ").slice(0, maxChars);
}

// Fixed-canvas models ignore the request size; SD1.5 NPU only has the patch resolutions the phone reports. SD1.5 beyond ~768px
// duplicates faces and bodies, so larger canvases are skipped when a smaller one exists.
export function pickResolution(model, width, height, maxSide) {
  if (model.resolutions?.length) {
    const small = model.resolutions.filter(([w, h]) => Math.max(w, h) <= maxSide);
    const candidates = small.length ? small : model.resolutions;
    const ratio = Math.log(width / height);
    const area = Math.log(width * height);
    const cost = ([w, h]) => Math.abs(Math.log(w / h) - ratio) * 4 + Math.abs(Math.log(w * h) - area);
    return [...candidates].sort((a, b) => cost(a) - cost(b))[0];
  }
  if (model.is_sdxl || model.is_anima) return [model.generation_size, model.generation_size];
  return [width, height];
}

async function* sseEvents(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (data) yield { event, data: JSON.parse(data) };
    }
  }
}

// filter: lower-case substrings of a model's id or name; only matching models are offered (all when empty).
export function createProxy({ phone, controlPort = 8808, generationPort = 8081, filter = [], maxSide = 768, maxPrompt = 330, log = () => {} }) {
  const control = `http://${phone}:${controlPort}`;
  const generation = `http://${phone}:${generationPort}`;
  let cache = { at: 0, models: [] };
  let selectedTitle;
  let activeAbort;
  // The phone runs one generation at a time and /select must not interleave with it.
  let queue = Promise.resolve();

  async function phoneJson(path, init = {}) {
    const url = `${control}${path}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000), ...init });
    if (!response.ok) throw new Error(`phone ${url} -> ${response.status} ${(await response.text()).slice(0, 200)}`);
    return response.json();
  }

  async function listModels() {
    if (Date.now() - cache.at < MODELS_TTL_MS && cache.models.length) return cache.models;
    const catalog = await phoneJson("/models");
    const wanted = (catalog.models ?? []).filter((model) => {
      const text = `${model.id} ${model.name}`.toLowerCase();
      return !filter.length || filter.some((part) => text.includes(part));
    });
    cache = { at: Date.now(), models: wanted.map((model) => ({ ...model, title: model.name || model.id })) };
    return cache.models;
  }

  async function currentModel() {
    const list = await listModels();
    const model = list.find((m) => m.title === selectedTitle) ?? list[0];
    if (!model) throw new Error(`no matching model on the phone (filter: ${filter.join(",") || "none"})`);
    return model;
  }

  // Starts the model at that size unless it already runs that way, and waits until it can generate.
  async function ensureBackend(model, [width, height]) {
    const matches = (s) => s.state === "running" && s.serving_model_id === model.id && s.width === width && s.height === height;
    if (matches(await phoneJson("/status"))) return;
    log(`starting ${model.id} at ${width}x${height}`);
    await phoneJson("/select", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model_id: model.id, width, height }),
    });
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(1000);
      const status = await phoneJson("/status");
      if (matches(status)) return waitHealthy(deadline);
      if (status.state === "error") throw new Error(`phone failed to start ${model.id}: ${status.message}`);
    }
    throw new Error(`phone did not start ${model.id} within ${START_TIMEOUT_MS / 1000}s`);
  }

  // The phone reports "running" before the native server listens on the generation port.
  async function waitHealthy(deadline) {
    while (Date.now() < deadline) {
      const ok = await fetch(`${generation}/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
      if (ok) return;
      await sleep(1000);
    }
    throw new Error("phone backend is running but its generation port never answered");
  }

  async function attempt(body, signal) {
    const started = Date.now();
    const response = await fetch(`${generation}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(GENERATE_TIMEOUT_MS)]),
    });
    if (!response.ok) throw new Error(`phone /generate -> ${response.status} ${(await response.text()).slice(0, 300)}`);
    for await (const { event, data } of sseEvents(response.body)) {
      if (event === "error") throw new Error(`phone generation failed: ${data.message}`);
      if (event === "complete") {
        log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s (phone ${data.generation_time_ms}ms)`);
        return { image: data.image, seed: data.seed };
      }
    }
    throw new Error("phone closed the stream without a result");
  }

  async function txt2img(params) {
    const model = await currentModel();
    const original = params.prompt ?? "";
    const prompt = cleanPrompt(original, maxPrompt);
    if (prompt !== original) log(`prompt cleaned: ${original.length} -> ${prompt.length} chars`);
    const size = pickResolution(model, params.width ?? 512, params.height ?? 512, maxSide);
    await ensureBackend(model, size);
    const body = {
      prompt,
      negative_prompt: params.negative_prompt ?? "",
      steps: params.steps ?? model.defaults?.steps ?? 20,
      cfg: params.cfg_scale ?? model.defaults?.cfg ?? 7,
      width: size[0],
      height: size[1],
      scheduler: SAMPLERS.find(([name]) => name === params.sampler_name)?.[1] ?? "dpm",
      output_format: "png",
      ...(params.seed >= 0 ? { seed: params.seed } : {}),
    };
    log(`generate ${model.id} ${size[0]}x${size[1]} steps=${body.steps} ${body.scheduler}`);
    log(`  prompt (${body.prompt.length} chars): ${body.prompt.slice(0, 400)}`);
    log(`  negative (${body.negative_prompt.length} chars): ${body.negative_prompt.slice(0, 120)}`);
    const abort = new AbortController();
    activeAbort = abort;
    // The backend sometimes drops the connection (right after a model or size switch, or when it restarts mid-run, e.g. when
    // someone else uses the phone): a network error is retried once; regenerating is harmless.
    let result;
    try {
      result = await attempt(body, abort.signal);
    } catch (error) {
      if (abort.signal.aborted || !(error instanceof TypeError)) throw error;
      log(`generate connection failed (${error.cause?.code ?? error.message}), retrying once`);
      await sleep(3000);
      await ensureBackend(model, size);
      result = await attempt(body, abort.signal);
    }
    return { images: [result.image], parameters: body, info: JSON.stringify({ seed: result.seed }) };
  }

  function serialized(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }

  async function route(method, path, body) {
    const key = `${method} ${path.replace(/^\/sdapi\/v1\//, "")}`;
    switch (key) {
      case "GET options": {
        await phoneJson("/info");
        return { sd_model_checkpoint: (await currentModel()).title };
      }
      case "POST options":
        if (body.sd_model_checkpoint) selectedTitle = body.sd_model_checkpoint;
        return {};
      case "GET sd-models":
        return (await listModels()).map((m) => ({ title: m.title, model_name: m.title }));
      case "GET samplers":
        return SAMPLERS.map(([name]) => ({ name }));
      case "GET schedulers":
        return [{ name: "automatic", label: "Automatic" }];
      case "GET progress":
        return { progress: 0, state: { job_count: 0 } };
      case "GET upscalers":
      case "GET latent-upscale-modes":
      case "GET sd-vae":
      case "GET sd-modules":
        return [];
      case "POST interrupt":
        activeAbort?.abort();
        return {};
      case "POST txt2img":
        return serialized(() => txt2img(body));
      default:
        return undefined;
    }
  }

  return createServer(async (req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    const send = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    try {
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 1_000_000) return send(413, { error: "body too large" });
      }
      if (path === "/" || path === "/health") return send(200, { ok: true });
      const result = await route(req.method, path, raw ? JSON.parse(raw) : {});
      if (result === undefined) return send(404, { error: `not found: ${req.method} ${path}` });
      send(200, result);
    } catch (error) {
      log(`${req.method} ${path} failed: ${error.message}`);
      send(500, { error: error.message });
    }
  });
}

// A fake phone (control and generation ports) stands in for the real one.
async function selfTest() {
  assert.equal(cleanPrompt("a, adobe驿station, 牛仔 jacket, b", 100), "a, adobe station, jacket, b");
  assert.equal(cleanPrompt("one, two, three, four", 12), "one, two");
  assert.equal(cleanPrompt("x".repeat(50), 10), "x".repeat(10));

  const npu = { resolutions: [[512, 512], [512, 768], [768, 512], [768, 1024]] };
  assert.deepEqual(pickResolution(npu, 500, 760, 768), [512, 768]);
  assert.deepEqual(pickResolution(npu, 896, 512, 768), [768, 512], "a wide request picks the nearest wide canvas");
  assert.deepEqual(pickResolution(npu, 768, 1024, 768), [512, 768], "canvases above maxSide are skipped when a smaller one exists");
  assert.deepEqual(pickResolution({ resolutions: [[1024, 1024]] }, 512, 512, 768), [1024, 1024], "…but never when it is the only one");
  assert.deepEqual(pickResolution({ is_sdxl: true, generation_size: 1024 }, 512, 768, 768), [1024, 1024]);
  assert.deepEqual(pickResolution({}, 512, 768, 768), [512, 768], "free canvas keeps the request");

  const calls = [];
  const png = Buffer.from("fake-png").toString("base64");
  let state = { state: "idle" };
  const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
  const readJson = async (req) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    return raw ? JSON.parse(raw) : {};
  };
  const controlServer = createServer(async (req, res) => {
    const json = (payload) => (res.writeHead(200, { "content-type": "application/json" }), res.end(JSON.stringify(payload)));
    if (req.url === "/info") return json({ app: "localdream" });
    if (req.url === "/models")
      return json({
        models: [
          { id: "anythingv5", name: "Anything 5.0", resolutions: npu.resolutions, defaults: { steps: 20, cfg: 7 } },
          { id: "other", name: "Other", resolutions: [] },
        ],
      });
    if (req.url === "/status") return json(state);
    if (req.url === "/select") {
      const body = await readJson(req);
      calls.push(["select", body]);
      state = { state: "running", serving_model_id: body.model_id, width: body.width, height: body.height };
      return json({ ok: true });
    }
    res.writeHead(404).end();
  });
  let failNext = false;
  let dropNext = false;
  const generationServer = createServer(async (req, res) => {
    if (req.url === "/health") return res.writeHead(200).end();
    const body = await readJson(req);
    if (dropNext) {
      dropNext = false;
      return req.socket.destroy();
    }
    calls.push(["generate", body]);
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (failNext) return res.end(`event: error\ndata: ${JSON.stringify({ type: "error", message: "boom" })}\n\n`);
    res.write(`event: progress\ndata: ${JSON.stringify({ type: "progress", step: 1, total_steps: 2 })}\n\n`);
    res.end(`event: complete\ndata: ${JSON.stringify({ type: "complete", image: png, seed: 7, generation_time_ms: 5 })}\n\n`);
  });
  const controlPort = await listen(controlServer);
  const generationPort = await listen(generationServer);
  const proxy = createProxy({ phone: "127.0.0.1", controlPort, generationPort, filter: ["anything"] });
  const proxyPort = await listen(proxy);
  const call = async (method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/sdapi/v1/${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body && JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  assert.deepEqual((await call("GET", "sd-models")).body, [{ title: "Anything 5.0", model_name: "Anything 5.0" }]);
  assert.equal((await call("GET", "options")).body.sd_model_checkpoint, "Anything 5.0");
  assert.equal((await call("GET", "samplers")).body[0].name, "DPM++ 2M");

  const ok = await call("POST", "txt2img", { prompt: "cat", width: 500, height: 760, sampler_name: "Euler a", cfg_scale: 6, steps: 12 });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.images, [png]);
  assert.deepEqual(calls[0], ["select", { model_id: "anythingv5", width: 512, height: 768 }]);
  assert.deepEqual(calls[1][1], {
    prompt: "cat", negative_prompt: "", steps: 12, cfg: 6, width: 512, height: 768, scheduler: "euler_a", output_format: "png",
  });

  await call("POST", "txt2img", { prompt: "dog", width: 512, height: 768, seed: 42 });
  assert.equal(calls.filter(([kind]) => kind === "select").length, 1, "backend already running at that size: no second select");
  assert.equal(calls.at(-1)[1].seed, 42);

  await call("POST", "txt2img", { prompt: "wide, 牛仔", width: 896, height: 512 });
  assert.deepEqual([calls.at(-1)[1].width, calls.at(-1)[1].height, calls.at(-1)[1].prompt], [768, 512, "wide"], "wide canvas, CJK dropped");

  dropNext = true;
  const retried = await call("POST", "txt2img", { prompt: "retry", width: 512, height: 768 });
  assert.equal(retried.status, 200, "a dropped connection is retried once");

  failNext = true;
  const failed = await call("POST", "txt2img", { prompt: "x" });
  assert.equal(failed.status, 500);
  assert.match(failed.body.error, /boom/);
  assert.equal((await call("GET", "nope")).status, 404);

  for (const server of [proxy, controlServer, generationServer]) server.close();
  console.log("Local Dream proxy self-test passed");
}

if (process.argv.includes("--self-test")) await selfTest();
else {
  const { HOST = "127.0.0.1", PORT = "7860", LOCALDREAM_HOST: phone } = process.env;
  if (!phone) throw new Error("LOCALDREAM_HOST is required (the phone's IP or hostname)");
  // Comma-separated, case-insensitive substrings of model id or name; only matching phone models are offered.
  const filter = (process.env.LOCALDREAM_MODELS ?? "anything,absolute,chillout").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const log = (message) => console.log(`${new Date().toISOString().slice(11, 19)} ${message}`);
  const server = createProxy({ phone, filter, log });
  server.listen(Number(PORT), HOST, () => log(`A1111 API on http://${HOST}:${PORT} -> phone ${phone} (models: ${filter.join(",") || "all"})`));
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close(() => process.exit(0)));
}
