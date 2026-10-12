#!/usr/bin/env bash
# Anima-Turbo on the AMD 780M through stable-diffusion.cpp (Vulkan). Linux only; models are shared with ComfyUI.
# Serves the A1111-style API for SillyTavern ("sdcpp" source) on http://<host>:1234. Extra arguments go to sd-server.
set -euo pipefail

[ "$(uname -s)" = "Linux" ] || { echo "Linux only; macOS uses run_comfyui.sh." >&2; exit 1; }

RUNNER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export IMAGEGEN_DIR="${IMAGEGEN_DIR:-${HOME}/imagegen}"
SD_DIR="${SD_DIR:-${IMAGEGEN_DIR}/runtime/sdcpp}"
LISTEN_IP="${LISTEN_IP:-0.0.0.0}"
LISTEN_PORT="${LISTEN_PORT:-1234}"
SERVER="${SD_DIR}/build/bin/sd-server"
LOG_DIR="${IMAGEGEN_DIR}/logs"
M="${IMAGEGEN_DIR}/models"

# 1. Models (skips what exists)
"${RUNNER_DIR}/fetch_models.sh"

# 2. Build stable-diffusion.cpp with Vulkan on first use
if [ ! -x "$SERVER" ]; then
  for tool in git cmake glslc; do
    command -v "$tool" >/dev/null 2>&1 || {
      echo "Missing '$tool'. Arch: sudo pacman -S --needed base-devel cmake git vulkan-headers vulkan-icd-loader shaderc spirv-headers" >&2
      exit 1
    }
  done
  [ -d "$SD_DIR" ] || git clone --recursive https://github.com/leejet/stable-diffusion.cpp "$SD_DIR"
  cmake -S "$SD_DIR" -B "$SD_DIR/build" -DSD_VULKAN=ON
  cmake --build "$SD_DIR/build" --config Release -j"$(nproc)"
fi

# LoRAs every request gets: sd-server parses <lora:name:weight> tags of its default prompt (-p) once at startup, requests start
# from those defaults, and a request's own "lora" field replaces them. SD_LORA_TAGS= (empty) disables; several tags can be joined.
SD_LORA_TAGS="${SD_LORA_TAGS-<lora:waiAnima:0.8>}"
LORA_ARGS=()
[ -z "$SD_LORA_TAGS" ] || LORA_ARGS=(-p "$SD_LORA_TAGS")

mkdir -p "$LOG_DIR"
echo "sd-server on http://${LISTEN_IP}:${LISTEN_PORT} (log: ${LOG_DIR}/server.log, default LoRA: ${SD_LORA_TAGS:-none})"
"$SERVER" \
  --diffusion-model "$M/diffusion_models/anima-turbo-v1.1.safetensors" \
  --llm "$M/text_encoders/qwen_3_06b_base.safetensors" \
  --vae "$M/vae/qwen_image_vae.safetensors" \
  --lora-model-dir "$M/loras" "${LORA_ARGS[@]}" \
  --diffusion-fa --cfg-scale 1.0 \
  --listen-ip "$LISTEN_IP" --listen-port "$LISTEN_PORT" -v "$@" 2>&1 | tee -a "$LOG_DIR/server.log"
