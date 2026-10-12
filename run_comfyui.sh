#!/usr/bin/env bash
set -euo pipefail

RUNNER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export IMAGEGEN_DIR="${IMAGEGEN_DIR:-${HOME}/imagegen}"
COMFY_DIR="${COMFY_DIR:-${IMAGEGEN_DIR}/runtime/comfyui}"
COMFY_REPO_URL="${COMFY_REPO_URL:-https://github.com/comfy-org/ComfyUI.git}"
OS="$(uname -s)"

echo "=================================================="
echo "  Anima-Turbo (ComfyUI 自动化运行脚本)"
echo "  ComfyUI: ${COMFY_DIR}"
echo "=================================================="

# 0. 检查 ComfyUI 目录，不存在则自动 clone
if [ ! -d "$COMFY_DIR" ]; then
  echo "📥 检测到未安装 ComfyUI，正在克隆至 ${COMFY_DIR} ..."
  git clone "$COMFY_REPO_URL" "$COMFY_DIR"
fi

cd "$COMFY_DIR"
export UV_CACHE_DIR="${COMFY_DIR}/.uv_cache"
mkdir -p "$UV_CACHE_DIR"
mkdir -p "${IMAGEGEN_DIR}/logs"
LOG_FILE="${IMAGEGEN_DIR}/logs/comfyui.log"

# 1. 检查模型文件（共享目录 ${IMAGEGEN_DIR}/models，ComfyUI 与 sd.cpp 共用）
echo "[1/3] 检查 Anima 模型文件..."
"${RUNNER_DIR}/fetch_models.sh"

# ComfyUI loads this file from its root and finds the shared models through it.
cat > extra_model_paths.yaml <<EOF
imagegen:
  base_path: ${IMAGEGEN_DIR}/models/
  is_default: true
  diffusion_models: diffusion_models/
  text_encoders: text_encoders/
  vae: vae/
  loras: loras/
EOF

# 2. 检查 Python 虚拟环境与依赖（维护在 ${COMFY_DIR}/.venv）
echo "[2/3] 检查 Python 运行环境与依赖..."
if [ ! -d ".venv" ] || ! .venv/bin/python -c "import yaml, torch" 2>/dev/null; then
  echo "📦 配置 Python 3.12 虚拟环境并安装依赖..."
  uv venv --python 3.12 --seed --allow-existing
  if [ "$OS" = "Darwin" ]; then
    echo "🍏 检测到 macOS，安装通用 PyTorch (MPS 加速)..."
    uv pip install torch torchvision torchaudio
  else
    echo "🐧 检测到 Linux，安装 CPU 版 PyTorch..."
    uv pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu
  fi
  uv pip install -r requirements.txt
fi

# 3. 平台参数
EXTRA_ARGS=()
if [ "$OS" = "Darwin" ]; then
  echo "[3/3] 配置 macOS (Apple Silicon MPS) 运行环境..."
  EXTRA_ARGS=(--use-split-cross-attention)
else
  echo "[3/3] Linux: CPU only (780M GPU path hangs the amdgpu driver, see README.md)"
  # Even a stray torch.cuda call must not create a GPU queue, so hide the device from a ROCm build too.
  export HIP_VISIBLE_DEVICES=-1
  # One thread per physical core: SMT siblings slow bf16 matmul (~5% on a 7840HS).
  export OMP_NUM_THREADS="${OMP_NUM_THREADS:-$(lscpu -p=core,socket | grep -v '^#' | sort -u | wc -l)}"
  .venv/bin/python "${RUNNER_DIR}/patch_cpu_bf16.py" "$COMFY_DIR"
  EXTRA_ARGS=(--cpu --bf16-unet --use-pytorch-cross-attention)
fi

echo "--------------------------------------------------"
echo "ComfyUI 运行地址: http://127.0.0.1:8188"
echo "日志文件: ${LOG_FILE}"
echo "--------------------------------------------------"

.venv/bin/python main.py --listen 0.0.0.0 --port 8188 --enable-cors-header "${EXTRA_ARGS[@]}" "$@" 2>&1 | tee -a "$LOG_FILE"
