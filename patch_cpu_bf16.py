"""Let ComfyUI compute in bf16 on CPU (upstream forces fp32 there).

On a CPU with avx512_bf16 (Zen4) this halves sampling time (~10.5 -> ~4.9 s/it, Anima-Turbo 512x768).
Usage: patch_cpu_bf16.py <comfyui-dir>. Idempotent; exits 1 if upstream code no longer matches.
"""
import sys
from pathlib import Path

OLD = """        if is_device_cpu(device): #TODO ? bf16 works on CPU but is extremely slow
            return False
"""
NEW = """        if is_device_cpu(device):  # imagegen-stack: bf16 on CPU
            return not FORCE_FP32
"""

path = Path(sys.argv[1]).expanduser() / "comfy" / "model_management.py"
text = path.read_text(encoding="utf-8")

if NEW in text:
    print("[patch_cpu_bf16] already applied")
elif text.count(OLD) == 1:
    path.write_text(text.replace(OLD, NEW), encoding="utf-8")
    print("[patch_cpu_bf16] applied")
else:
    sys.exit(f"[patch_cpu_bf16] upstream changed, expected code not found in {path}")
