#!/usr/bin/env bash
# Opt-in live smoke for the Sterling OpenCode 2 server plugin (run by
# scripts/tests/opencode-plugin.test.mjs when STERLING_OC_LIVE=1).
# usage: opencode-live-smoke.sh <dir with env.sh and node_modules/@opencode/cli> <path to opencode/sterling-server.mjs>
# It builds a throwaway Sterling project, links the bundle into an isolated
# OpenCode config dir, starts `opencode serve`, and asks the free model two
# questions whose answers exist only in what the plugin injects.
set -euo pipefail
OC_DIR=$1
BUNDLE=$2
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
. "$OC_DIR/env.sh"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/sterling-oc-live-XXXXXX")
SERVE_PID=
cleanup() {
  if [ -n "$SERVE_PID" ]; then kill "$SERVE_PID" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

PROJ=$WORK/proj
mkdir -p "$PROJ/src" "$PROJ/.sterling" "$WORK/cfg/plugins"
printf 'export const a = 1;\n' > "$PROJ/src/a.mjs"
printf '.sterling/\n' > "$PROJ/.gitignore"
printf '{"project_name":"quartz-heron-41"}' > "$PROJ/.sterling/config.json"
node --input-type=module -e "
import { createHash, randomUUID } from 'node:crypto';
const { SterlingStore } = await import('$REPO/packages/store/dist/index.js');
const now = new Date().toISOString();
const s = new SterlingStore('$PROJ/.sterling/sterling.db');
s.create({ id: randomUUID(), type: 'feature_article', created_at: now, updated_at: now, author: 'conductor', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [],
  slug: 'live-smoke-article', title: 'Live smoke article', what_it_does: 'The codeword for this module is MANGO-88.', intended_behavior: 'x',
  files: [{ path: 'src/a.mjs', role: 'impl' }], file_baselines: { 'src/a.mjs': createHash('sha256').update('export const a = 1;\n').digest('hex') },
  current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }], dependencies: { relies_on: [], relied_by: [] }, state: 'active', version: 1,
  history: [{ date: now, event: 'live smoke fixture' }], live_test_refs: [] });
s.close();"
git -C "$PROJ" init -q
git -C "$PROJ" -c user.email=t@example.com -c user.name=t add -A
git -C "$PROJ" -c user.email=t@example.com -c user.name=t commit -q -m init

printf '{"model":"opencode/big-pickle"}' > "$WORK/cfg/opencode.json"
ln -s "$(readlink -f "$BUNDLE")" "$WORK/cfg/plugins/sterling-server.js"
export OPENCODE_CONFIG_DIR=$WORK/cfg
PORT=$((4300 + RANDOM % 500))

cd "$PROJ"
opencode serve --port "$PORT" > "$WORK/serve.out" 2>&1 &
SERVE_PID=$!
for _ in $(seq 1 40); do grep -q 'password' "$WORK/serve.out" 2>/dev/null && break; sleep 0.5; done
export OPENCODE_SERVER_PASSWORD=$(grep -o 'password .*' "$WORK/serve.out" | cut -d' ' -f2)

ask() {
  timeout 180 opencode run --server "http://127.0.0.1:$PORT" --auto -m opencode/big-pickle --format json "$1" > "$WORK/$2.out" 2>&1 || true
  grep -o '"text":"[^}]*' "$WORK/$2.out" | tail -3 | cut -c1-600
}

echo "== layer probe"
ask "Do not use any tools. Your instructions contain a heading of the form 'CLAUDE.md — <name> (Sterling layer)' and may contain a section titled 'OpenCode host'. Reply exactly: NAME=<name> HOST=<yes or no>" layer | tee "$WORK/layer.txt"
echo "== edit probe"
ask "Use the edit tool once to change 'a = 1' to 'a = 2' in src/a.mjs. The first read or edit tool result for that file will include a STERLING KNOWLEDGE DELIVERY block naming a codeword of the form WORD-digits. Reply with that codeword only." edit | tee "$WORK/edit.txt"

if grep -q 'quartz-heron-41' "$WORK/layer.txt" && grep -q 'HOST=yes' "$WORK/layer.txt"; then echo "LAYER-SEEN: yes"; else echo "LAYER-SEEN: no"; fi
if grep -q 'MANGO-88' "$WORK/edit.txt"; then echo "DELIVERY-SEEN: yes"; else echo "DELIVERY-SEEN: no"; fi
if grep -q 'MANGO-88' "$WORK/edit.out"; then echo "DELIVERY-IN-TOOL-RESULT: yes"; else echo "DELIVERY-IN-TOOL-RESULT: no"; fi
echo "plugin log:"; cat "$PROJ/.sterling/transient/opencode-plugin.log" 2>/dev/null || echo "(none)"
echo "settled snapshot: $([ -f "$PROJ/.sterling/transient/git-settled.json" ] && echo present || echo absent)"
echo "serve log tail:"; tail -15 "$WORK/serve.out"
