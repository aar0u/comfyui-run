#!/usr/bin/env bash
# Download the Anima-Turbo models into the shared directory; existing files are skipped.
# DOWNLOAD_RECOMMENDED_LORA=false skips waiAnima; LORA_URL (+ LORA_NAME) adds your own LoRA.
set -euo pipefail

IMAGEGEN_DIR="${IMAGEGEN_DIR:-${HOME}/imagegen}"
HF_ENDPOINT="${HF_ENDPOINT:-https://huggingface.co}"
M="${IMAGEGEN_DIR}/models"

fetch_model() {
  local url="$1"
  local dest="$2"
  mkdir -p "$(dirname "$dest")"

  if [ -s "$dest" ]; then
    echo "✓ 已存在，跳过: $dest"
    return 0
  fi

  echo "⬇ 正在下载: $dest ..."
  if command -v curl >/dev/null 2>&1; then
    curl -fL -C - --retry 3 "$url" -o "$dest"
  elif command -v wget >/dev/null 2>&1; then
    wget -c "$url" -O "$dest"
  else
    echo "❌ 错误: 未找到 curl 或 wget，请先安装" >&2
    exit 1
  fi
}

fetch_model \
  "${HF_ENDPOINT}/circlestone-labs/Anima/resolve/main/split_files/diffusion_models/anima-turbo-v1.1.safetensors" \
  "$M/diffusion_models/anima-turbo-v1.1.safetensors"
fetch_model \
  "${HF_ENDPOINT}/circlestone-labs/Anima/resolve/main/split_files/text_encoders/qwen_3_06b_base.safetensors" \
  "$M/text_encoders/qwen_3_06b_base.safetensors"
fetch_model \
  "${HF_ENDPOINT}/circlestone-labs/Anima/resolve/main/split_files/vae/qwen_image_vae.safetensors" \
  "$M/vae/qwen_image_vae.safetensors"

mkdir -p "$M/loras"
if [ "${DOWNLOAD_RECOMMENDED_LORA:-true}" = "true" ]; then
  fetch_model \
    "${HF_ENDPOINT}/Kutches/Anim4/resolve/main/waiAnima.safetensors" \
    "$M/loras/waiAnima.safetensors"
fi
if [ -n "${LORA_URL:-}" ]; then
  fetch_model "$LORA_URL" "$M/loras/${LORA_NAME:-$(basename "${LORA_URL%%\?*}")}"
fi
