#!/usr/bin/env bash
# A1111-style API in front of Local Dream's host mode (Android phone, SD1.5), for SillyTavern's "Stable Diffusion web UI" source.
# Serves http://<host>:7860. LOCALDREAM_HOST (the phone's IP or hostname) is required; LOCALDREAM_MODELS filters the phone's models.
set -euo pipefail

RUNNER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGEGEN_DIR="${IMAGEGEN_DIR:-${HOME}/imagegen}"
: "${LOCALDREAM_HOST:?LOCALDREAM_HOST must be set to the IP or hostname of the phone}"
command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 1; }

# 0.0.0.0 so the SillyTavern container can reach it through host.docker.internal; the phone's own API has no authentication.
export HOST="${LISTEN_IP:-0.0.0.0}" PORT="${LISTEN_PORT:-7860}"
mkdir -p "${IMAGEGEN_DIR}/logs"
node "${RUNNER_DIR}/localdream.mjs" "$@" 2>&1 | tee -a "${IMAGEGEN_DIR}/logs/localdream.log"
