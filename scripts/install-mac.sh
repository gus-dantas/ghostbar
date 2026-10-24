#!/bin/zsh
# Build Ghostbar and install it in /Applications, leaving no second copy
# in the build folder for Spotlight to list.
set -euo pipefail
cd "${0:A:h}/.."
export PATH="$HOME/.cargo/bin:$HOME/.bun/bin:$PATH"

[[ "${1:-}" == --skip-build ]] || bun run tauri build
built="src-tauri/target/release/bundle/macos/Ghostbar.app"
[[ -d "$built" ]] || { echo "build left no app at $built" >&2; exit 1; }

# Quitting cuts a dictation or a Cast short, so wait until the app is idle
# (it answers on its local socket; no answer means it isn't running).
sock="$HOME/Library/Application Support/com.gusdantas.assistant/bridge.sock"
busy() {
  /usr/bin/python3 - "$sock" <<'PY' 2>/dev/null
import json, socket, sys
s = socket.socket(socket.AF_UNIX); s.settimeout(2)
try:
    s.connect(sys.argv[1]); s.sendall(b'{"type":"busy"}\n')
    buf = b""
    while b"\n" not in buf:
        chunk = s.recv(4096)
        if not chunk: break
        buf += chunk
    for line in buf.decode().splitlines():
        m = json.loads(line)
        if m.get("type") == "busy":
            sys.exit(0 if (m.get("dictating") or m.get("casting")) else 1)
except Exception:
    pass
sys.exit(1)
PY
}
if busy; then
  echo "Ghostbar is dictating or recording; installing as soon as it finishes…"
  for _ in {1..900}; do busy || break; sleep 2; done
fi

osascript -e 'tell application id "com.gusdantas.assistant" to quit' 2>/dev/null || true
for _ in {1..20}; do pgrep -xq ghostbar || break; sleep 0.25; done

ditto "$built" "/Applications/Ghostbar.app.new"
# Ad-hoc signatures change with every build, and macOS ties Accessibility and
# Microphone approvals to the signature. Requiring only the bundle identifier
# keeps those approvals across rebuilds.
codesign --force --deep --sign - --options runtime \
  --entitlements src-tauri/Entitlements.plist \
  -r='designated => identifier "com.gusdantas.assistant"' \
  "/Applications/Ghostbar.app.new"
rm -rf "/Applications/Ghostbar.app"
mv "/Applications/Ghostbar.app.new" "/Applications/Ghostbar.app"

# The build copy goes; LaunchServices and Spotlight keep only /Applications.
lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
"$lsregister" -u "$PWD/$built" 2>/dev/null || true
rm -rf "$built" src-tauri/target/release/bundle/dmg
"$lsregister" -f "/Applications/Ghostbar.app"
mdimport "/Applications/Ghostbar.app" 2>/dev/null || true

open -b com.gusdantas.assistant
echo "installed /Applications/Ghostbar.app"
