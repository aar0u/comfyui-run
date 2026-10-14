#!/usr/bin/env bash
# Builds the web page of sd-server (https://github.com/leejet/sdcpp-webui) into one file, webui.html next to this script (WEBUI_HTML: elsewhere),
# which run_sdcpp.sh serves with --serve-html-path (a sd-server built without -DSD_SERVER_BUILD_FRONTEND=ON has the API only).
# Needs git, Node >= 20 and pnpm >= 10. Run it again to update the page, then restart run_sdcpp.sh.
set -euo pipefail

RUNNER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGEGEN_DIR="${IMAGEGEN_DIR:-${HOME}/imagegen}"
SRC="${IMAGEGEN_DIR}/runtime/sdcpp-webui"
WEBUI_HTML="${WEBUI_HTML:-${RUNNER_DIR}/webui.html}"

for tool in git node pnpm; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing '$tool' (git, Node >= 20 and pnpm >= 10 are needed)." >&2; exit 1; }
done
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || { echo "Node >= 20 is needed, this is $(node -v)." >&2; exit 1; }

if [ -d "$SRC/.git" ]; then
  git -C "$SRC" pull --ff-only --quiet
else
  mkdir -p "$(dirname "$SRC")"
  git clone --depth 1 https://github.com/leejet/sdcpp-webui "$SRC"
fi

cd "$SRC"
# --ignore-scripts: building the page needs no install script of any dependency, and none of them should run on this machine.
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
mkdir -p "$(dirname "$WEBUI_HTML")"
cp dist/index.html "$WEBUI_HTML"
echo "Built ${WEBUI_HTML}; restart run_sdcpp.sh and open http://<host>:1234/"
