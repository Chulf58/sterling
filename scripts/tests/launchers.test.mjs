// Launchers (decision launchers-consolidated-to-claude-code-and-opencode-pair): the
// engine sterling-launch.sh claude|opencode|tui, the per-host openers, and the ensure
// pass in scripts/lib/launchers.mjs. The engine runs against a fake tmux that records
// every call and answers has-session / list-panes / display from env, so mode
// selection, session naming, the legacy-session attach and the TUI takeover are all
// checked without a tmux server.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTmuxLauncher } from '../lib/launcher-tmux.mjs';
import { stampBody, verifyStamp } from '../lib/generated-marker.mjs';
import {
  ensureLauncherIgnores, ensureLaunchers, launcherHost, launcherTools, legacySessionName, removeRetiredLaunchers, renderOpener, sessionName,
  LAUNCHER_GITIGNORE_ENTRIES, OPENERS,
} from '../lib/launchers.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LINUX = process.platform === 'linux' ? false : 'the engine and openers are bash scripts that read /proc';
const tmps = [];
const tmp = (prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); tmps.push(d); return d; };
after(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const which = (tool) => spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();

// A bin dir holding only the tools named, so a claude/opencode/terminal installed on the
// machine running the suite can never leak into a case.
function hermeticBin(tools) {
  const bin = tmp('sterling-ln-bin-');
  for (const t of tools) {
    const real = which(t);
    if (!real) throw new Error(`test needs ${t} on PATH`);
    symlinkSync(real, join(bin, t));
  }
  return bin;
}
const script = (path, body) => { writeFileSync(path, body); chmodSync(path, 0o755); };

// ---- launcherHost ----

test('launcherHost: WSL (kernel release or WSL_DISTRO_NAME) and native Windows are windows; plain Linux is linux; the override wins and a bad one throws', () => {
  const none = () => '6.17.0-1032-oem';
  assert.equal(launcherHost({ env: {}, platform: 'linux', osrelease: () => '5.15.167.4-microsoft-standard-WSL2' }), 'windows');
  assert.equal(launcherHost({ env: { WSL_DISTRO_NAME: 'Ubuntu-24.04' }, platform: 'linux', osrelease: none }), 'windows');
  assert.equal(launcherHost({ env: {}, platform: 'win32', osrelease: none }), 'windows');
  assert.equal(launcherHost({ env: {}, platform: 'linux', osrelease: none }), 'linux');
  assert.equal(launcherHost({ env: { STERLING_LAUNCHER_HOST: 'linux' }, platform: 'win32', osrelease: none }), 'linux');
  assert.equal(launcherHost({ env: { STERLING_LAUNCHER_HOST: 'windows' }, platform: 'linux', osrelease: none }), 'windows');
  assert.throws(() => launcherHost({ env: { STERLING_LAUNCHER_HOST: 'mac' }, platform: 'linux', osrelease: none }), /STERLING_LAUNCHER_HOST must be 'windows' or 'linux' \(got 'mac'\)/);
});

test('legacySessionName: sterling-<basename> lower-cased with every other run of characters as one dash', () => {
  assert.equal(legacySessionName('/mnt/c/Users/cuj/Diesel priser'), 'sterling-diesel-priser');
  assert.equal(legacySessionName('/home/u/My.App_2'), 'sterling-my-app-2');
  assert.equal(legacySessionName('/home/u/...'), 'sterling-project');
});

test('sessionName (issue #52): two checkouts with the same directory name get different sessions; one checkout always gets the same one', () => {
  const a = sessionName('/home/u/work/sterling');
  const b = sessionName('/home/u/hobby/sterling');
  assert.match(a, /^sterling-sterling-[0-9a-f]{4}$/, 'the readable basename, then 4 hex of the path hash');
  assert.match(b, /^sterling-sterling-[0-9a-f]{4}$/);
  assert.notEqual(a, b);
  assert.equal(sessionName('/home/u/work/sterling'), a, 'stable for one path');
  assert.ok(a.startsWith(`${legacySessionName('/home/u/work/sterling')}-`));
});

// ---- the openers as rendered ----

test('Windows openers: CRLF, @echo off then the stamp, wt.exe by absolute path, wsl --cd into the project, the engine in its mode', () => {
  const drv = renderOpener(REPO, '/mnt/c/Users/demo/My Project', 'windows', OPENERS.windows[0]);
  assert.ok(drv.split('\r\n').length > 3 && !/[^\r]\n/.test(drv), 'every line ends CRLF');
  const lines = drv.split('\r\n');
  assert.equal(lines[0], '@echo off');
  assert.match(lines[1], /^rem sterling-generated content_hash=[0-9a-f]{64}$/);
  assert.deepEqual(verifyStamp(drv, 'rem'), { unmodified: true });
  assert.ok(drv.includes('"%LOCALAPPDATA%\\Microsoft\\WindowsApps\\wt.exe" wsl.exe --cd "C:\\Users\\demo\\My Project" -- bash -lic "./sterling-launch.sh claude"'), drv);
  assert.match(drv, /Claude Code/);
  const ext4 = renderOpener(REPO, '/home/demo/proj', 'windows', OPENERS.windows[1]);
  assert.ok(ext4.includes('wsl.exe --cd "/home/demo/proj" -- bash -lic "./sterling-launch.sh opencode"'), 'a project on the WSL filesystem keeps its POSIX path');
  assert.match(ext4, /OpenCode/);
  for (const text of [drv, ext4]) assert.doesNotMatch(text, /\{\{[A-Z_]+\}\}/);
});

test('Linux openers: shebang then the stamp, LF, about 15 lines, bash -n clean, no program path written in', () => {
  for (const opener of OPENERS.linux) {
    const text = renderOpener(REPO, '/home/demo/proj', 'linux', opener);
    const lines = text.split('\n');
    assert.equal(lines[0], '#!/usr/bin/env bash');
    assert.match(lines[1], /^# sterling-generated content_hash=[0-9a-f]{64}$/);
    assert.ok(!text.includes('\r'));
    assert.ok(lines.filter(Boolean).length <= 18, `thin opener, got ${lines.length} lines`);
    assert.ok(text.includes(`exec bash ./sterling-launch.sh ${opener.mode}`));
    assert.doesNotMatch(lines.slice(1).join('\n'), /\{\{[A-Z_]+\}\}|\/home\/demo|\/snap\/|\/usr\/bin\//, 'nothing machine-specific is baked in below the shebang');
    const f = join(tmp('sterling-ln-n-'), opener.file);
    writeFileSync(f, text);
    const n = spawnSync('bash', ['-n', f], { encoding: 'utf8' });
    assert.equal(n.status, 0, n.stderr);
  }
});

// ---- the opener at run time ----

function openerWorkdir(mode) {
  const work = tmp('sterling-ln-open-');
  const opener = OPENERS.linux.find((o) => o.mode === mode);
  writeFileSync(join(work, opener.file), renderOpener(REPO, work, 'linux', opener));
  writeFileSync(join(work, 'sterling-launch.sh'), 'echo "ENGINE $1 $PWD"\n');
  return { work, path: join(work, opener.file) };
}
const fakeTerminal = (bin, name, log) => script(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "${name}" "$PWD" "$@" > "${log}"\n`);
const waitFor = (file) => { for (let i = 0; i < 100 && !existsSync(file); i++) sleepMs(20); return existsSync(file) ? readFileSync(file, 'utf8').split('\n') : null; };

test('Linux opener without a terminal: the first terminal found in the order ghostty, gnome-terminal, kitty, konsole, x-terminal-emulator opens a window in the project running the engine', { skip: LINUX }, () => {
  const cases = [
    { present: ['ghostty', 'kitty'], args: (w) => ['ghostty', `--working-directory=${w}`, '-e'] },
    { present: ['gnome-terminal', 'konsole'], args: (w) => ['gnome-terminal', `--working-directory=${w}`, '--'] },
    { present: ['kitty', 'x-terminal-emulator'], args: (w) => ['kitty', '--directory', w] },
    { present: ['konsole', 'x-terminal-emulator'], args: (w) => ['konsole', '--workdir', w, '-e'] },
    { present: ['x-terminal-emulator'], args: () => ['x-terminal-emulator', '-e'] },
  ];
  for (const { present, args } of cases) {
    const { work, path } = openerWorkdir('opencode');
    const bin = hermeticBin(['dirname', 'setsid']);
    const log = join(work, 'terminal.log');
    for (const t of present) fakeTerminal(bin, t, log);
    const r = spawnSync(which('bash'), [path], { cwd: tmpdir(), env: { PATH: bin }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const got = waitFor(log);
    assert.ok(got, `${present[0]} was started`);
    const expected = args(work);
    // the terminal's own name, the cwd it was started in (the project), then its flags and the command
    assert.deepEqual(got.slice(0, 2), [expected[0], work]);
    assert.deepEqual(got.slice(2, 2 + expected.length - 1), expected.slice(1), `${present[0]} flags`);
    assert.deepEqual(got.slice(1 + expected.length, 1 + expected.length + 2), ['bash', '-c']);
    assert.match(got[3 + expected.length], /^bash \.\/sterling-launch\.sh opencode \|\| read /);
  }
});

test('Linux opener: no terminal found is loud, on stderr and through notify-send', { skip: LINUX }, () => {
  const { work, path } = openerWorkdir('claude');
  const bin = hermeticBin(['dirname', 'setsid']);
  const notified = join(work, 'notify.log');
  script(join(bin, 'notify-send'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${notified}"\n`);
  const r = spawnSync(which('bash'), [path], { env: { PATH: bin }, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no terminal found \(tried ghostty, gnome-terminal, kitty, konsole, x-terminal-emulator\)/);
  assert.match(readFileSync(notified, 'utf8'), /no terminal found/);
});

test('Linux opener from a terminal: runs the engine in place, in the project directory', { skip: LINUX || (which('script') ? false : 'needs script(1) for a pty') }, () => {
  const { work, path } = openerWorkdir('claude');
  const r = spawnSync('script', ['-qec', `bash '${path}'`, '/dev/null'], { cwd: tmpdir(), encoding: 'utf8', timeout: 20_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`ENGINE claude ${work.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

// ---- the engine at run time ----

const ENGINE_TOOLS = ['cat', 'tr', 'awk', 'sleep', 'ls', 'head'];
function engine({ installed = false } = {}) {
  const root = tmp('sterling-ln-root-');
  mkdirSync(join(root, 'templates'));
  cpSync(join(REPO, 'templates', 'launcher-tmux.sh'), join(root, 'templates', 'launcher-tmux.sh'));
  mkdirSync(join(root, 'tui'));
  writeFileSync(join(root, 'tui', 'sterling-tui.mjs'), '');
  return { root, text: renderTmuxLauncher(root, { session: 'sterling-demo-1a2b', legacySession: 'sterling-demo', splitPercent: 35, installed }) };
}
// The fake tmux: has-session answers from $RUNNING ('=name' exact, a bare name also as a prefix, as tmux does),
// list-panes -a from $PANES_ALL, other list-panes from $PANES, display from $CALLER.
const FAKE_TMUX = `#!/bin/sh
printf '%s\\n' "$*" >> "$TMUX_LOG"
case "$1" in
  has-session) case "$3" in
    =*) for s in $RUNNING; do [ "$s" = "\${3#=}" ] && exit 0; done ;;
    *) for s in $RUNNING; do case "$s" in "$3"*) exit 0 ;; esac; done ;;  # like tmux: a bare name also matches as a prefix
  esac
  exit 1 ;;
  list-panes) case " $* " in *" -a "*) printf '%s\\n' "$PANES_ALL" ;; *) printf '%s\\n' "$PANES" ;; esac; exit 0 ;;
  display) printf '%s\\n' "$CALLER"; exit 0 ;;
esac
exit 0
`;
function runEngine(args, { running = '', panes = '', panesAll = '', caller = '', tmux, home, extraEnv = {}, lock } = {}) {
  const { root, text } = engine();
  const work = tmp('sterling-ln-work-');
  mkdirSync(join(work, '.sterling', 'transient'), { recursive: true });
  writeFileSync(join(work, '.sterling', 'sterling.db'), '');
  if (lock !== undefined) writeFileSync(join(work, '.sterling', 'transient', 'tui.lock'), lock);
  writeFileSync(join(work, 'sterling-launch.sh'), text);
  const bin = hermeticBin(ENGINE_TOOLS);
  script(join(bin, 'tmux'), FAKE_TMUX);
  const log = join(work, 'tmux.log');
  const env = {
    PATH: bin, HOME: home ?? tmp('sterling-ln-home-'), TMUX_LOG: log, RUNNING: running, PANES: panes, PANES_ALL: panesAll, CALLER: caller,
    NODE_BIN: process.execPath, CLAUDE_BIN: '/bin/true', ...(tmux ? { TMUX: tmux } : {}), ...extraEnv,
  };
  const r = spawnSync(which('bash'), [join(work, 'sterling-launch.sh'), ...args], { cwd: work, env, encoding: 'utf8', timeout: 30_000 });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  return { r, calls, root, work, out: r.stdout + r.stderr };
}
const first = (calls, verb) => calls.find((c) => c.startsWith(`${verb} `)) ?? '';
const all = (calls, verb) => calls.filter((c) => c.startsWith(`${verb} `));

test('engine: bash -n clean in both shapes (authoring clone, installed copy)', () => {
  for (const installed of [false, true]) {
    const f = join(tmp('sterling-ln-n-'), 'sterling-launch.sh');
    writeFileSync(f, engine({ installed }).text);
    const n = spawnSync('bash', ['-n', f], { encoding: 'utf8' });
    assert.equal(n.status, 0, n.stderr);
  }
});

test('engine: no argument is claude mode — a fresh sterling-<proj>-claude session running claude, the TUI split in unfocused', { skip: LINUX }, () => {
  const { r, calls, root, work } = runEngine([]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(first(calls, 'new-session'), `new-session -d -s sterling-demo-1a2b-claude -c ${work} /bin/true --plugin-dir ${root}`);
  const split = first(calls, 'split-window');
  assert.ok(split.startsWith('split-window -h -d -t =sterling-demo-1a2b-claude: '), `-d keeps the keyboard on the left pane: ${split}`);
  assert.ok(split.endsWith(`${root}/tui/sterling-tui.mjs --store ${work}/.sterling/sterling.db`), split);
  assert.ok(calls.includes('set-option -t =sterling-demo-1a2b-claude: mouse on'), 'mouse on, session-scoped');
  assert.equal(calls.at(-1), 'attach-session -t =sterling-demo-1a2b-claude');
  assert.equal(all(calls, 'set-option').filter((c) => / -g /.test(c)).length, 0, 'never a global option');
});

test('engine: opencode mode runs a separate sterling-<proj>-opencode session with opencode and no --plugin-dir', { skip: LINUX }, () => {
  const { r, calls, work } = runEngine(['opencode'], { extraEnv: { OPENCODE_BIN: '/opt/oc/opencode' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(first(calls, 'new-session'), `new-session -d -s sterling-demo-1a2b-opencode -c ${work} /opt/oc/opencode`);
  assert.ok(first(calls, 'split-window').includes('-t =sterling-demo-1a2b-opencode:'));
  assert.equal(calls.at(-1), 'attach-session -t =sterling-demo-1a2b-opencode');
});

test('engine: opencode is found at run time in ~/.opencode/bin when it is not on PATH, and missing everywhere is loud', { skip: LINUX }, () => {
  const home = tmp('sterling-ln-home-');
  mkdirSync(join(home, '.opencode', 'bin'), { recursive: true });
  script(join(home, '.opencode', 'bin', 'opencode'), '#!/bin/sh\n');
  const found = runEngine(['opencode'], { home });
  assert.equal(found.r.status, 0, found.r.stderr);
  assert.ok(first(found.calls, 'new-session').endsWith(` ${home}/.opencode/bin/opencode`), first(found.calls, 'new-session'));

  const missing = runEngine(['opencode']);
  assert.equal(missing.r.status, 1);
  assert.match(missing.r.stderr, /'opencode' not found on PATH or in ~\/\.opencode\/bin \(set OPENCODE_BIN\)/);
  assert.equal(all(missing.calls, 'new-session').length, 0);
});

test('engine: a running legacy sterling-<proj> session is attached to in claude mode (no duplicate), and gets its TUI pane back', { skip: LINUX }, () => {
  const { r, calls } = runEngine(['claude'], { running: 'sterling-demo' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(all(calls, 'new-session').length, 0, 'no new session');
  assert.ok(first(calls, 'split-window').includes('-t =sterling-demo:'), 'the missing TUI pane is re-added to the legacy session');
  assert.equal(calls.at(-1), 'attach-session -t =sterling-demo');
  assert.ok(calls.includes('has-session -t =sterling-demo-1a2b-claude'), 'the suffixed session was looked for first');
});

test('engine: the suffixed session wins over a legacy one; opencode mode never attaches to the legacy (Claude Code) session', { skip: LINUX }, () => {
  const both = runEngine(['claude'], { running: 'sterling-demo sterling-demo-1a2b-claude' });
  assert.equal(both.r.status, 0, both.r.stderr);
  assert.equal(both.calls.at(-1), 'attach-session -t =sterling-demo-1a2b-claude');

  // an OpenCode session is not a legacy session, though its name starts with sterling-demo
  const ocOnly = runEngine(['claude'], { running: 'sterling-demo-1a2b-opencode' });
  assert.equal(ocOnly.r.status, 0, ocOnly.r.stderr);
  assert.match(first(ocOnly.calls, 'new-session'), /-s sterling-demo-1a2b-claude /);

  const oc = runEngine(['opencode'], { running: 'sterling-demo', extraEnv: { OPENCODE_BIN: '/opt/oc/opencode' } });
  assert.equal(oc.r.status, 0, oc.r.stderr);
  assert.match(first(oc.calls, 'new-session'), /-s sterling-demo-1a2b-opencode /);
});

test('engine: re-attach re-adds a missing TUI pane, and leaves one that is there alone', { skip: LINUX }, () => {
  const missing = runEngine(['claude'], { running: 'sterling-demo-1a2b-claude', panes: '/bin/true' });
  assert.equal(missing.r.status, 0, missing.r.stderr);
  assert.equal(all(missing.calls, 'new-session').length, 0);
  assert.equal(all(missing.calls, 'split-window').length, 1);
  assert.equal(missing.calls.at(-1), 'attach-session -t =sterling-demo-1a2b-claude');

  const present = runEngine(['claude'], { running: 'sterling-demo-1a2b-claude', panes: '/bin/true\n"/usr/bin/node" "/x/tui/sterling-tui.mjs" --store "/p/.sterling/sterling.db"' });
  assert.equal(present.r.status, 0, present.r.stderr);
  assert.equal(all(present.calls, 'split-window').length, 0, 'no second TUI pane');
  assert.match(present.r.stdout, /tmux session sterling-demo-1a2b-claude already shows the TUI/);
  assert.equal(present.calls.at(-1), 'attach-session -t =sterling-demo-1a2b-claude');
});

test('engine tui mode: the caller\'s own session inside tmux; outside, -claude, then -opencode; neither running is loud', { skip: LINUX }, () => {
  const inside = runEngine(['tui'], { tmux: '/tmp/tmux-1/default,1,0', caller: 'sterling-demo-1a2b-opencode', running: 'sterling-demo-1a2b-claude' });
  assert.equal(inside.r.status, 0, inside.r.stderr);
  assert.ok(first(inside.calls, 'split-window').includes('-t =sterling-demo-1a2b-opencode:'), first(inside.calls, 'split-window'));
  assert.equal(all(inside.calls, 'has-session').length, 0, 'inside tmux nothing is looked up by name');

  const claude = runEngine(['tui'], { running: 'sterling-demo-1a2b-opencode sterling-demo-1a2b-claude' });
  assert.ok(first(claude.calls, 'split-window').includes('-t =sterling-demo-1a2b-claude:'));

  const oc = runEngine(['tui'], { running: 'sterling-demo-1a2b-opencode' });
  assert.ok(first(oc.calls, 'split-window').includes('-t =sterling-demo-1a2b-opencode:'));

  const none = runEngine(['tui']);
  assert.equal(none.r.status, 1);
  assert.match(none.r.stderr, /no session of this project is running \(sterling-demo-1a2b-claude, sterling-demo-1a2b-opencode\)/);
  assert.equal(all(none.calls, 'split-window').length, 0);
});

test('engine: an unknown mode is refused', { skip: LINUX }, () => {
  const r = runEngine(['split']);
  assert.equal(r.r.status, 1);
  assert.match(r.r.stderr, /unknown mode 'split' \(use claude, opencode or tui\)/);
});

// A stand-in TUI: a process whose command line names sterling-tui, started through a
// shell that exits at once, so it is not this test's child (a dead child of ours would
// stay a zombie, alive to kill -0, until the event loop reaps it).
function standInTui() {
  const r = spawnSync('bash', ['-c', `'${process.execPath}' -e 'setInterval(() => {}, 1000)' sterling-tui.mjs >/dev/null 2>&1 </dev/null & echo $!`], { encoding: 'utf8' });
  const pid = Number(r.stdout.trim());
  for (let i = 0; i < 100; i++) {
    try { if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('sterling-tui')) break; } catch { /* not there yet */ }
    sleepMs(20);
  }
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const start = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19];
  return { pid, start };
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const stop = (pid) => { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } };

test('engine takeover: the TUI named by tui.lock (live pid, same start time) is stopped, the losing session is named, and the pane opens here', { skip: LINUX }, () => {
  const tui = standInTui();
  try {
    const run = runEngine(['tui'], { running: 'sterling-demo-1a2b-claude', lock: `${tui.pid} ${tui.start}`, panesAll: `${tui.pid} sterling-demo-1a2b-opencode` });
    assert.equal(run.r.status, 0, run.r.stderr);
    assert.match(run.r.stdout, new RegExp(`tmux session sterling-demo-1a2b-opencode lost the TUI \\(pid ${tui.pid}\\); it opens in sterling-demo-1a2b-claude`));
    assert.ok(!alive(tui.pid), 'the old TUI was stopped');
    assert.doesNotMatch(run.r.stderr, /has not exited/);
    assert.equal(all(run.calls, 'split-window').length, 1);
  } finally {
    stop(tui.pid);
  }
});

test('engine takeover: a lock whose start time does not match (a recycled pid) or a caller that already shows the TUI stops nothing', { skip: LINUX }, () => {
  const tui = standInTui();
  try {
    const recycled = runEngine(['tui'], { running: 'sterling-demo-1a2b-claude', lock: `${tui.pid} 1`, panesAll: `${tui.pid} sterling-demo-1a2b-opencode` });
    assert.equal(recycled.r.status, 0, recycled.r.stderr);
    assert.ok(alive(tui.pid), 'a pid whose start time differs from the lock is not the TUI that wrote it');
    assert.doesNotMatch(recycled.out, /lost the TUI/);

    const shown = runEngine(['tui'], { running: 'sterling-demo-1a2b-claude', lock: `${tui.pid} ${tui.start}`, panes: '"node" "/x/tui/sterling-tui.mjs" --store "/p"' });
    assert.equal(shown.r.status, 0, shown.r.stderr);
    assert.ok(alive(tui.pid), 'the caller already has a TUI pane: nothing to take');
    assert.equal(all(shown.calls, 'split-window').length, 0);

    const bare = runEngine(['tui'], { running: 'sterling-demo-1a2b-claude', lock: String(process.pid) });
    assert.equal(bare.r.status, 0, bare.r.stderr);
    assert.doesNotMatch(bare.out, /lost the TUI/, 'a live pid whose command line is not the TUI is never stopped');
  } finally {
    stop(tui.pid);
  }
});

// ---- ensureLaunchers ----

test('ensureLaunchers: linux host writes the engine and the two .sh openers, executable; windows host the two .bat openers; re-run matches', () => {
  for (const host of ['linux', 'windows']) {
    const target = tmp('sterling-ln-target-');
    const first = ensureLaunchers(target, REPO, { splitPercent: 35, host, installedCopy: false });
    const names = ['sterling-launch.sh', ...OPENERS[host].map((o) => o.file)];
    assert.deepEqual(first.items.map((i) => [i.item, i.status]), names.map((n) => [n, 'created']));
    const other = host === 'linux' ? 'windows' : 'linux';
    for (const o of OPENERS[other]) assert.ok(!existsSync(join(target, o.file)), `${o.file} is not written on a ${host} host`);
    for (const f of ['sterling.bat', 'tui.bat']) assert.ok(!existsSync(join(target, f)), `${f} is no longer generated`);
    if (host === 'linux') {
      for (const n of names) assert.equal(statSync(join(target, n)).mode & 0o111, 0o111, `${n} is executable`);
    }
    const engineText = readFileSync(join(target, 'sterling-launch.sh'), 'utf8');
    assert.ok(engineText.includes(`\nSESSION="${sessionName(target)}"`), 'the per-checkout session is baked in');
    assert.ok(engineText.includes(`\nLEGACY_SESSION="${legacySessionName(target)}"`), 'and the pre-hash name the engine still attaches to');
    const again = ensureLaunchers(target, REPO, { splitPercent: 35, host, installedCopy: false });
    assert.deepEqual(again.items.map((i) => i.status), names.map(() => 'matches'));
    assert.deepEqual(again.warns, []);
  }
});

test('ensureLaunchers: an unmodified stamped opener that renders differently now is refreshed; an edited one is left byte-identical, loudly', () => {
  const target = tmp('sterling-ln-target-');
  ensureLaunchers(target, REPO, { splitPercent: 35, host: 'linux', installedCopy: false });
  const older = stampBody('#!/usr/bin/env bash\necho an older generated opener\n', '#');
  writeFileSync(join(target, 'claude-code.sh'), older);
  const edited = readFileSync(join(target, 'opencode.sh'), 'utf8').replace('cd "$(dirname "$0")"', 'cd "$(dirname "$0")" # mine');
  writeFileSync(join(target, 'opencode.sh'), edited);
  const r = ensureLaunchers(target, REPO, { splitPercent: 35, host: 'linux', installedCopy: false });
  const status = Object.fromEntries(r.items.map((i) => [i.item, i.status]));
  assert.equal(status['claude-code.sh'], 'refreshed');
  assert.equal(readFileSync(join(target, 'claude-code.sh'), 'utf8'), renderOpener(REPO, target, 'linux', OPENERS.linux[0]));
  assert.equal(status['opencode.sh'], 'differs');
  assert.equal(readFileSync(join(target, 'opencode.sh'), 'utf8'), edited);
  assert.ok(r.warns.some((w) => w.includes('opencode.sh was changed after it was generated')), r.warns.join('\n'));
});

test('ensureLaunchers: checkText sees every render before it is written', () => {
  const target = tmp('sterling-ln-target-');
  const seen = [];
  ensureLaunchers(target, REPO, { splitPercent: 35, host: 'windows', installedCopy: false, checkText: (label, text) => { seen.push(label); return text; } });
  assert.deepEqual(seen, ['sterling-launch.sh', 'claude-code.bat', 'opencode.bat']);
});

test('removeRetiredLaunchers: a current-template render of sterling.bat and tui.bat (any project path) is deleted; a hand-written one is kept and reported; none present is silent', () => {
  const target = tmp('sterling-ln-target-');
  assert.deepEqual(removeRetiredLaunchers(target, REPO), { items: [], warns: [] });
  const render = (name, dir) => readFileSync(join(REPO, 'templates', name), 'utf8').replaceAll('{{WIN_PROJECT_DIR}}', dir).replace(/\r?\n/g, '\r\n');
  writeFileSync(join(target, 'sterling.bat'), render('launcher-win.bat', 'D:\\elsewhere\\proj'));
  writeFileSync(join(target, 'tui.bat'), '@echo off\r\nrem my own\r\n');
  const r = removeRetiredLaunchers(target, REPO);
  assert.deepEqual(r.items.map((i) => [i.item, i.status]), [['sterling.bat', 'removed'], ['tui.bat', 'differs']]);
  assert.ok(!existsSync(join(target, 'sterling.bat')));
  assert.equal(readFileSync(join(target, 'tui.bat'), 'utf8'), '@echo off\r\nrem my own\r\n');
  assert.match(r.items[1].detail, /kept — no longer generated .*re-adds a closed TUI pane/);
  assert.ok(r.warns.some((w) => w.includes('tui.bat') && /kept/.test(w)), r.warns.join('\n'));
});

test('launcherTools: claude on PATH; opencode on PATH or in ~/.opencode/bin; the claude argument and STERLING_LAUNCHER_OPENCODE override; a bad override throws', () => {
  const bin = tmp('sterling-ln-path-');
  const home = tmp('sterling-ln-home-');
  assert.deepEqual(launcherTools({ env: { PATH: bin }, home }), { claude: false, opencode: false });
  script(join(bin, 'claude'), '#!/bin/sh\n');
  writeFileSync(join(bin, 'opencode'), 'not executable');
  assert.deepEqual(launcherTools({ env: { PATH: bin }, home }), { claude: true, opencode: false }, 'a file without the execute bit is not a program');
  mkdirSync(join(home, '.opencode', 'bin'), { recursive: true });
  script(join(home, '.opencode', 'bin', 'opencode'), '#!/bin/sh\n');
  assert.deepEqual(launcherTools({ env: { PATH: bin }, home }), { claude: true, opencode: true });
  assert.deepEqual(launcherTools({ env: { PATH: bin }, home, claude: false }), { claude: false, opencode: true });
  assert.deepEqual(launcherTools({ env: { PATH: bin, STERLING_LAUNCHER_OPENCODE: 'absent' }, home }), { claude: true, opencode: false });
  assert.deepEqual(launcherTools({ env: { PATH: '', STERLING_LAUNCHER_OPENCODE: 'found' }, home: tmp('sterling-ln-home-') }), { claude: false, opencode: true });
  assert.throws(() => launcherTools({ env: { STERLING_LAUNCHER_OPENCODE: 'yes' } }), /STERLING_LAUNCHER_OPENCODE must be 'found' or 'absent' \(got 'yes'\)/);
});

test('ensureLaunchers: an opener only for a tool that is found', () => {
  for (const [tools, files] of [[{ claude: true, opencode: false }, ['claude-code.sh']], [{ claude: false, opencode: true }, ['opencode.sh']]]) {
    const target = tmp('sterling-ln-target-');
    const r = ensureLaunchers(target, REPO, { splitPercent: 35, host: 'linux', tools, installedCopy: false });
    assert.deepEqual(r.items.map((i) => i.item), ['sterling-launch.sh', ...files]);
    for (const o of OPENERS.linux) assert.equal(existsSync(join(target, o.file)), files.includes(o.file), o.file);
  }
});

test('ensureLauncherIgnores: appends only the missing launcher names, once', () => {
  const target = tmp('sterling-ln-target-');
  writeFileSync(join(target, '.gitignore'), 'node_modules/\nsterling.bat');
  const added = ensureLauncherIgnores(target);
  assert.ok(!added.includes('sterling.bat') && added.includes('claude-code.bat'), added.join(','));
  assert.deepEqual(ensureLauncherIgnores(target), []);
  const lines = readFileSync(join(target, '.gitignore'), 'utf8').split('\n');
  assert.equal(lines[0], 'node_modules/');
  assert.equal(lines.filter((l) => l === 'sterling.bat').length, 1);
});

test('LAUNCHER_GITIGNORE_ENTRIES: the engine, all four openers and the retired names', () => {
  assert.deepEqual([...LAUNCHER_GITIGNORE_ENTRIES].sort(), ['claude-code.bat', 'claude-code.sh', 'opencode.bat', 'opencode.sh', 'sterling-launch.sh', 'sterling-windows.bat', 'sterling.bat', 'tui.bat']);
});

test('ensureLaunchers (issue #52): a generated engine or Linux opener without the execute bit gets it back; a hand-edited one is left as it is', { skip: LINUX }, () => {
  const target = tmp('sterling-ln-target-');
  ensureLaunchers(target, REPO, { splitPercent: 35, host: 'linux', installedCopy: false });
  for (const f of ['sterling-launch.sh', 'claude-code.sh', 'opencode.sh']) chmodSync(join(target, f), 0o644);
  const edited = `${readFileSync(join(target, 'opencode.sh'), 'utf8')}# mine\n`;
  writeFileSync(join(target, 'opencode.sh'), edited);
  const r = ensureLaunchers(target, REPO, { splitPercent: 35, host: 'linux', installedCopy: false });
  assert.deepEqual(r.items.map((i) => i.status), ['matches', 'matches', 'differs']);
  for (const f of ['sterling-launch.sh', 'claude-code.sh']) assert.equal(statSync(join(target, f)).mode & 0o777, 0o755, `${f} is 0755 again`);
  assert.equal(statSync(join(target, 'opencode.sh')).mode & 0o777, 0o644, 'a hand-edited opener keeps its mode');
});
