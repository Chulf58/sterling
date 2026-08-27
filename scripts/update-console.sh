#!/usr/bin/env bash
# Sterling updater console [S] — the WSL side of the per-project
# sterling-update.bat double-click entry. COMMITTED, not generated: it bakes no
# machine paths (node is resolved at runtime, the clone is wherever this file
# lives), so it travels with the clone and every update updates its own updater.
#
# WHY IT EXISTS: /sterling:update driven through a Claude session leaves a model
# interpreting refusals, and it has interpreted them wrong (see the
# consumer-update-path article's history). The updater itself is deterministic —
# this wrapper runs it with NO session in the loop and holds the window open so
# a Windows user actually reads the outcome instead of watching it flash away.
#
# DELIBERATELY HAS NO NATIVE-WINDOWS COUNTERPART, and must not grow one: the
# updater itself is node (scripts/update.mjs), so all this wrapper adds is node
# resolution, the outcome line and the pause — and cmd.exe does those three
# things inline. templates/update-win-native.bat is that inline form; porting
# this file to batch would duplicate the updater's console duties in a second
# language for no gain (decision ffe7c416).
#
# Deliberately NOT `set -e`: a failed update must still reach the pause below.
set -u
cd "$(dirname "$0")/.."

# node resolved at runtime (PATH first, then the ~/.local tarball install) —
# same resolution as sterling-launch.sh, no baked exe paths (P5 on missing).
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
[ -n "$NODE_BIN" ] || NODE_BIN="$(ls -d "$HOME"/.local/node-v*-linux-x64/bin/node 2>/dev/null | head -1)"
if [ -z "$NODE_BIN" ]; then
  echo "sterling-update: 'node' not found on PATH (set NODE_BIN)" >&2
  read -n 1 -s -r -p "Press any key to close..."
  exit 1
fi

"$NODE_BIN" scripts/update.mjs "$@"
STATUS=$?

echo
if [ "$STATUS" -eq 0 ]; then
  echo "── Update finished. If it applied changes, RESTART any open Sterling sessions."
else
  echo "── Update did NOT complete (exit $STATUS). The message above names the defect and where it gets fixed — nothing was half-applied."
fi
read -n 1 -s -r -p "Press any key to close..."
exit "$STATUS"
