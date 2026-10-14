# imagegen-stack

Image-generation backends for SillyTavern (see the `tavern-stack` repo, whose seed points at the ports below): Anima-Turbo on an AMD 780M (Linux) box and an Apple Silicon Mac, plus a bridge to a phone running Local Dream. Everything lives under one neutral directory, `~/imagegen` (override with `IMAGEGEN_DIR`):

```
~/imagegen/
├── models/            diffusion_models, text_encoders, vae, loras   (shared by both stacks, filled by fetch_models.sh)
├── logs/              comfyui.log, server.log, localdream.log
└── runtime/           everything rebuildable: `rm -rf ~/imagegen/runtime` resets both stacks
    ├── comfyui/       ComfyUI checkout + .venv                       (run_comfyui.sh)
    ├── sdcpp/         stable-diffusion.cpp checkout + build          (run_sdcpp.sh)
    └── sdcpp-webui/   checkout of the web page's source              (build_webui.sh)
```

| Script | What it does |
|---|---|
| `fetch_models.sh` | Downloads the models (and the waiAnima LoRA unless `DOWNLOAD_RECOMMENDED_LORA=false`; `LORA_URL`/`LORA_NAME` add your own). Called by both launchers. |
| `run_comfyui.sh` | Clones ComfyUI, creates the venv, writes `extra_model_paths.yaml` (points ComfyUI at `~/imagegen/models`), starts ComfyUI on :8188. Linux: CPU. macOS: MPS with `--use-split-cross-attention`. |
| `run_sdcpp.sh` | Linux only. Builds stable-diffusion.cpp with Vulkan on first use and starts `sd-server` on :1234 (A1111-style API for SillyTavern's "sdcpp" source). |
| `build_webui.sh` | Builds the web page of `sd-server` ([leejet/sdcpp-webui](https://github.com/leejet/sdcpp-webui)) into one `webui.html` next to the scripts. A built copy is committed, so the box that runs `run_sdcpp.sh` needs nothing; `build_webui.sh` (git, Node >= 20, pnpm >= 10) is only for updating it. `run_sdcpp.sh` serves it at `http://<host>:1234/` (see below). |
| `run_localdream.sh` | Starts `localdream.mjs` (plain Node, no dependencies) on :7860: an A1111-style API in front of Local Dream's host mode on an Android phone (SD1.5). `LOCALDREAM_HOST` (the phone's IP or hostname) is required, `LOCALDREAM_MODELS` filters the phone's models. It drops CJK text, limits tags to the ~77-token text encoder, snaps the canvas to the sizes the phone supports (max 768) and retries dropped connections; the prompt itself comes finished from SillyTavern's `/pic`. The phone's own API (:8808, :8081) is unauthenticated, keep it on the LAN. `node localdream.mjs --self-test` runs it against a fake phone. |
| `patch_cpu_bf16.py` | Lets ComfyUI compute in bf16 on CPU; applied by `run_comfyui.sh`, aborts if upstream code changed. |
| `anima_*workflow.json` | ComfyUI editor workflow and the SillyTavern API-format workflows (with and without LoRA). |

## Performance (Ryzen 7 7840HS, 512x768, 8 steps, cfg 1, euler)

- **sd.cpp Vulkan (`run_sdcpp.sh`): ~26-28 s per image**, sampling ~22 s.
- **ComfyUI CPU: ~43 s per image** (~4.5 s/it). ComfyUI forces fp32 on CPU (`should_use_bf16` returns False, ~100 s); `patch_cpu_bf16.py` lifts that for CPUs with `avx512_bf16` (without it, remove the patch and `--bf16-unet`). `OMP_NUM_THREADS` is set to the physical core count (~5% faster than SMT threads). Sampling is near the CPU's bf16 limit; `cfg=1` and `euler` are already the cheapest settings.
- The old ROCm path took ~32 s but hung the driver.

## SillyTavern with sd-server

- SillyTavern's "sdcpp" source sends its own steps, CFG, sampler and scheduler with every request, so set them for Anima-Turbo: 8 steps, CFG 1, euler, simple. Its defaults (20 steps, CFG 7) cost ~5x: CFG above 1 doubles the model passes per step (~118 s instead of ~26 s). Fallback if a client cannot be configured: the server applies `<sd_cpp_extra_args>{"sample_params":{"sample_steps":8,"guidance":{"txt_cfg":1.0}}}</sd_cpp_extra_args>` inside the prompt over the request (measured: ~29 s for an outer request of 20 steps / CFG 7; the removed tag leaves a trailing space that changes the image slightly).
- **LoRA is set on the server, not from SillyTavern** (its request has no LoRA field). `run_sdcpp.sh` starts `sd-server` with `-p "<lora:waiAnima:0.8>"`: the server parses LoRA tags of its default prompt once at startup (against `--lora-model-dir`), every request starts from a copy of those defaults, and ST's prompt replaces only the prompt text. Change or disable it with `SD_LORA_TAGS` (`SD_LORA_TAGS= ./run_sdcpp.sh` for none, several tags can be joined) and restart. A request that sends its own `lora` array (`"lora":[{"path":"waiAnima.safetensors","multiplier":0.8}]` in `POST /sdapi/v1/txt2img`) replaces the defaults. Prompt-embedded `<lora:...>` tags in a request are not parsed, and inside `<sd_cpp_extra_args>` only an absolute server path is resolved (bare name and `~/...` are silently ignored). A LoRA costs ~+1 s per image and ~+4 s once after switching (measured with both ComfyUI and sd.cpp). Found by reading `examples/server` (`default_gen_params`, `SDGenerationParams::resolve`) and confirmed on a live server with SillyTavern requests (no `lora` field): `server.log` shows `LoRA tensors have been applied` and `lora ...waiAnima.safetensors:0.80`, 27.3 s per 768x512 image after a 32.3 s first one. Check that log line after changing `SD_LORA_TAGS`: a missing file is only a warning and the LoRA is silently skipped.

## The web page of sd-server

`sd-server` has a page of its own at `/`, but upstream only builds it in with `-DSD_SERVER_BUILD_FRONTEND=ON` (Node and pnpm at build time); `run_sdcpp.sh` builds without it, and without the page `/` answers one line of text (the API under `/sdapi/v1` and `/sdcpp/v1` is there either way). `webui.html`, next to the scripts, is that page built from [leejet/sdcpp-webui](https://github.com/leejet/sdcpp-webui) (MIT; to update it run `./build_webui.sh`, commit the result and update `THIRD_PARTY_NOTICES.md`, which holds the license texts of the page and of Vue; `WEBUI_HTML` makes it write, and `run_sdcpp.sh` read, another file). `run_sdcpp.sh` passes it as `--serve-html-path` when it exists, wherever the script is started from. It is passed only if `sd-server --help` lists the option, because an unknown option would stop the server from starting; the start line says whether the page is served. The page talks to the server it came from, so it needs no CORS setup.

- **Set the steps to 8 on the page** (Sample section; the CFG default is already 1): its default is 20 steps, ~48 s per image instead of ~26 s.
- It has no access control and `sd-server` listens on `0.0.0.0`: anyone on the LAN can open it, as they can already call the API.
- Checked with a real browser (headless Chromium) against this server through a same-origin proxy, which behaves like `--serve-html-path`: the page lists `anima-turbo-v1.1` and "service online", and one image came back through `POST /sdcpp/v1/img_gen` and `GET /sdcpp/v1/jobs/<id>`. Not checked: that the sd-server binary on this box knows `--serve-html-path` (the guard above is for that).
- `bash test/run_sdcpp.test.sh` tests the launcher part against a fake `sd-server`.

## Why the 780M GPU is not used through ROCm

On Radeon 780M (gfx1103, Phoenix) the amdgpu driver hangs during ROCm/PyTorch sampling, usually at step 0/8, sometimes after dozens of images:

```
amdgpu: MES failed to respond to msg=REMOVE_QUEUE
amdgpu: failed to remove hardware queue from MES
amdgpu: Failed to evict process queues
amdgpu: GPU reset begin! ... MODE2 reset
```

ComfyUI dies with `HW Exception ... GPU Hang` / `Fatal Python error: Aborted`; Hyprland blacks out for a moment and can crash during the reset.

Tested without a fix (kernel 6.18 LTS and 7.2.9, linux-firmware-amdgpu 20260916): reverting all ROCm/attention/RoPE workaround patches (recipe below), extra synchronization, software cursor, async offload off, `HSA_ENABLE_SDMA=0`, native gfx1103 PyTorch (2.11.0+rocm7.13, no `HSA_OVERRIDE_GFX_VERSION`; crashed on the first job after a clean boot), `HSA_USE_SVM=0` (best: 67 images in a row, then the same crash). Synthetic GPU loads never reproduced it. This points at the kernel/firmware MES path, not at ComfyUI or PyTorch.

Vulkan (Mesa RADV, via stable-diffusion.cpp) does not use the KFD compute queues involved in these hangs and has been stable so far: 50/50 images on kernel 6.18 LTS (one process per image) and 10/10 requests from a resident `sd-server` on 7.2.9, zero kernel events. Long-run stability with SillyTavern in the loop is still to be confirmed.

`amdgpu.cwsr_enable=0` is the mitigation reported to work in the upstream threads below (0/5 failures in one reproducer); not applied here. Other projects also add `amdgpu.mes_kiq=1`; check `modinfo amdgpu` first, it is unverified on 6.18.

## Where to check for a fix

- ROCm/ROCm#6386 (KFD SVM invalidation triggers MES REMOVE_QUEUE on 780M): https://github.com/ROCm/ROCm/issues/6386
- ROCm/legacy-rocm-build#6658 (gfx1103 REMOVE_QUEUE): https://github.com/ROCm/legacy-rocm-build/issues/6658
- ROCm/ROCm#5590 (CWSR / MES hang): https://github.com/ROCm/ROCm/issues/5590
- amd-gfx patches: "drm/amdkfd: Add TLB flush after ..." https://ratatoskr.run/amd-gfx/2026/08/17413602/t and "drm/amdkfd: mark queues as reset after ..." https://ratatoskr.run/amd-gfx/2026/08/17438017/t
- Community setup using `cwsr_enable=0`: https://github.com/vaskes/comfyui-rocm-780m
- stable-diffusion.cpp server API (LoRA, `sd_cpp_extra_args`): https://github.com/leejet/stable-diffusion.cpp/blob/master/examples/server/api.md

## Checking the Vulkan path after a kernel/firmware update

With `run_sdcpp.sh` running, 50 distinct requests and a kernel-log watch (stable result so far: 26.1-30 s each, zero kernel events):

```bash
journalctl -k -f -n 0 --no-pager | grep --line-buffered -E 'MES failed|failed to remove|Failed to evict|GPU reset' &   # must stay silent
for i in $(seq 1 50); do
  curl -s -H 'Content-Type: application/json' http://127.0.0.1:1234/sdapi/v1/txt2img -o /dev/null -w "req $i: %{time_total} s\n" \
    -d '{"prompt":"1girl, solo, upper body","width":512,"height":768,"steps":8,"cfg_scale":1,"sampler_name":"euler","seed":'"$i"'}'
done; kill %1
```

## Retesting ROCm after a kernel/firmware update

The ROCm scripts and patches are no longer kept; this is what the last working-but-unstable GPU setup was (~32 s per image, hung every few dozen images):

- venv: torch 2.5.1+rocm6.2 from `https://download.pytorch.org/whl/rocm6.2` (no gfx1103 kernels, hence the override below). Newer path tried: AMD's native wheels `https://rocm.nightlies.amd.com/v2/gfx110X-all/` (`torch==2.11.0+rocm7.13.0a20260423` with the matching torchvision/torchaudio), no override needed.
- env: `HSA_OVERRIDE_GFX_VERSION=11.0.0` (rocm6.2 wheel only), `TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL=0`, `HIPBLASLT_ENABLE_FALLBACK=1`, `TORCH_BLAS_PREFER_HIPBLASLT=0`, `PYTORCH_CUDA_ALLOC_CONF="garbage_collection_threshold:0.8,max_split_size_mb:128"`, `HSA_ENABLE_SDMA=0`, `HSA_USE_SVM=0`.
- ComfyUI args: `--fp16-unet --use-split-cross-attention --cpu-vae --lowvram --disable-async-offload`.
- Source patches that were applied (all ROCm workarounds; none fixed the hang): `comfy/ldm/modules/attention.py` einsum to `torch.bmm`; `comfy_kitchen` `list[int]` to `typing.List[int]` (torch 2.5 only); `comfy/ldm/anima/model.py` RoPE outer product by broadcast multiplication and `F.scaled_dot_product_attention` replaced by `optimized_attention`.

Pass criterion for a retest: 50+ images with the desktop in use (open and close apps, queue 1-2 jobs at a time) and no `MES failed to respond` in `journalctl -k -b`. Watch with `journalctl -k -f | grep -E 'MES failed|Failed to evict|GPU reset'`.
