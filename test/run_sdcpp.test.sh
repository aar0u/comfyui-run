#!/usr/bin/env bash
# bash test/run_sdcpp.test.sh: run_sdcpp.sh with a fake sd-server and a fake fetch_models.sh (nothing is downloaded or built):
# the web page is passed to the server only when the file exists and the server knows --serve-html-path.
set -euo pipefail

[ "$(uname -s)" = "Linux" ] || { echo "run_sdcpp.sh is Linux only: skipped"; exit 0; }
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cp "$here/run_sdcpp.sh" "$tmp/"
printf '#!/usr/bin/env bash\nexit 0\n' >"$tmp/fetch_models.sh"
chmod +x "$tmp/fetch_models.sh"
export IMAGEGEN_DIR="$tmp/data" SD_DIR="$tmp/sd" LISTEN_IP=127.0.0.1
mkdir -p "$SD_DIR/build/bin" "$IMAGEGEN_DIR"
page="$tmp/webui.html" # next to the script, which is where it is looked for

# The fake server: --help says what the version knows, anything else is a start and prints its arguments.
fake_server() {
  printf '#!/usr/bin/env bash\nif [ "${1:-}" = "--help" ]; then echo "%s"; exit 0; fi\necho "STARTED $*"\n' "$1" >"$SD_DIR/build/bin/sd-server"
  chmod +x "$SD_DIR/build/bin/sd-server"
}
start() { "$tmp/run_sdcpp.sh" 2>&1; }
check() { # name, output, pattern that must (or, with !, must not) match
  if [ "${3:0:1}" = "!" ]; then
    ! grep -q -- "${3:1}" <<<"$2" || { echo "FAIL: $1"; echo "$2"; exit 1; }
  else
    grep -q -- "$3" <<<"$2" || { echo "FAIL: $1"; echo "$2"; exit 1; }
  fi
  echo "ok: $1"
}

fake_server "  --serve-html-path <path>  serve a custom page"
out="$(start)"
check "no page built: nothing is passed" "$out" "!--serve-html-path"
check "and the start line says how to get one" "$out" "web page: none (build_webui.sh makes one)"

echo "<html></html>" >"$page"
out="$(start)"
check "a page and a server that knows the option: the page is passed" "$out" "STARTED .*--serve-html-path $page"
check "and the start line gives the address" "$out" "web page: http://127.0.0.1:1234/"

fake_server "  --listen-port <port>"
out="$(start)"
check "a server that does not know the option: it is not passed" "$out" "!--serve-html-path $page"
check "and the server still starts" "$out" "STARTED"
check "and the start line says why there is no page" "$out" "does not know --serve-html-path"

fake_server "  --serve-html-path <path>"
cp "$page" "$tmp/other.html"
out="$(WEBUI_HTML="$tmp/other.html" start)"
check "WEBUI_HTML points to another page" "$out" "--serve-html-path $tmp/other.html"

echo "run_sdcpp.sh tests passed"
