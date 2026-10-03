// Older generated launchers are refreshed (decision init-and-update-refresh-an-older-
// generated-launcher): init, and the /sterling:update ensure pass that runs it, rewrite a
// sterling-launch.sh / sterling.bat / tui.bat that is a pristine render of an EARLIER
// template version, and say so. A launcher matching no known version is a hand edit: it
// stays byte-identical and a loud line names it and the remedy. The known versions come
// from git on a clone, and from bin/launcher-history.json on an installed copy (no git).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LAUNCHER_TEMPLATES,
  LAUNCHER_HISTORY_REL,
  INSTALLED_BLOCKS_KEY,
  PLACEHOLDER_VALUES,
  matchTemplateRender,
  historicalLauncherTemplates,
  olderGeneratedLauncher,
  launcherHistorySnapshot,
  replayFailureLine,
} from '../lib/launcher-history.mjs';
import { INSTALLED_PATHS } from '../lib/launcher-tmux.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const made = new Set();
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); made.add(d); return d; };
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
const lf = (s) => s.replace(/\r\n/g, '\n');

// Dome Farmer's sterling-launch.sh as init wrote it on 2026-09-19 (template 3f9097b1),
// paths and session name scrubbed: no `mouse on`, TUI from packages/tui/bundle.
const SEP19 = readFileSync(join(REPO, 'scripts', 'tests', 'fixtures', 'launcher-tmux-2026-09-19.sh'), 'utf8');
// A hand edit of that file: one line the user added.
const HAND_EDITED = SEP19.replace('set -euo pipefail\n', 'set -euo pipefail\nexport MY_SETTING=1\n');
const gitShow = (sha, rel) => spawnSync('git', ['show', `${sha}:${rel}`], { cwd: REPO, encoding: 'utf8' }).stdout;
const gitShas = (rel) => spawnSync('git', ['log', '--format=%H', '--', rel], { cwd: REPO, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
// Every commit that touched `rel` on any branch (--full-history keeps the side of a merge
// that default simplification drops), the set the history reads.
const gitShasFull = (rel) => spawnSync('git', ['log', '--full-history', '--format=%H', '--', rel], { cwd: REPO, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
// The 43232a67 template (the first with {{CLAUDE_PLUGIN_FLAG}}) rendered in the authoring
// shape, optionally with flags a user appended to the claude command.
const render43232a67 = (extraFlags = '') => gitShow('43232a67', 'templates/launcher-tmux.sh')
  .replaceAll('{{SESSION}}', 'sterling-demo-project')
  .replaceAll('{{PLUGIN_PATHS}}', 'PLUGIN_DIR="/home/demo/sterling-clone"\nTUI_BUNDLE="/home/demo/sterling-clone/tui/sterling-tui.mjs"')
  .replaceAll('{{CLAUDE_PLUGIN_FLAG}}', ` --plugin-dir "$PLUGIN_DIR"${extraFlags}`)
  .replaceAll('{{SPLIT_RATIO}}', '35');
const FLAGS = ' --model opus --permission-mode acceptEdits';

test('matchTemplateRender: each placeholder value must be one init could render; literal text must match whole, start to end', () => {
  const tpl = 'S="{{SESSION}}"\nR={{SPLIT_RATIO}}\nend\n';
  assert.deepEqual(matchTemplateRender('S="sterling-x"\nR=35\nend\n', tpl), { SESSION: 'sterling-x', SPLIT_RATIO: '35' });
  assert.ok(matchTemplateRender('S="sterling-x"\r\nR=35\r\nend\r\n', tpl), 'CRLF reads the same as LF');
  assert.equal(matchTemplateRender('S="sterling-x"\nR=35 # wider\nend\n', tpl), null, 'text appended to a value is a hand edit');
  assert.equal(matchTemplateRender('S="Sterling X"\nR=35\nend\n', tpl), null, 'a session name init could not produce');
  assert.equal(matchTemplateRender('S="sterling-x"\nadded\nR=35\nend\n', tpl), null, 'an extra line is not a value');
  assert.equal(matchTemplateRender('S="sterling-x"\nR=35\nend\nmore\n', tpl), null, 'trailing text is a hand edit');
  assert.equal(matchTemplateRender('# x\nS="sterling-x"\nR=35\nend\n', tpl), null, 'leading text is a hand edit');
  assert.equal(matchTemplateRender('A=1\nend\n', 'A={{SOMETHING_NEW}}\nend\n'), null, 'a placeholder with no validator fails closed');
});

test('matchTemplateRender: {{CLAUDE_PLUGIN_FLAG}} is empty or the authoring flag, with nothing appended', () => {
  const tpl = 'x "$CLAUDE_BIN"{{CLAUDE_PLUGIN_FLAG}}\n';
  assert.ok(matchTemplateRender('x "$CLAUDE_BIN"\n', tpl));
  assert.ok(matchTemplateRender('x "$CLAUDE_BIN" --plugin-dir "$PLUGIN_DIR"\n', tpl));
  assert.equal(matchTemplateRender(`x "$CLAUDE_BIN" --plugin-dir "$PLUGIN_DIR"${FLAGS}\n`, tpl), null);
  assert.equal(matchTemplateRender(`x "$CLAUDE_BIN"${FLAGS}\n`, tpl), null);
});

test('matchTemplateRender: {{PLUGIN_PATHS}} accepts the authoring pair and known installed blocks only', () => {
  const tpl = 'top\n{{PLUGIN_PATHS}}\nbottom\n';
  assert.ok(matchTemplateRender('top\nPLUGIN_DIR="/c"\nTUI_BUNDLE="/c/tui/sterling-tui.mjs"\nbottom\n', tpl));
  assert.ok(matchTemplateRender(`top\n${INSTALLED_PATHS}\nbottom\n`, tpl), 'today\'s installed block');
  const lines = INSTALLED_PATHS.split('\n');
  const inserted = [...lines.slice(0, 3), 'export SNEAKY=1', ...lines.slice(3)].join('\n');
  assert.equal(matchTemplateRender(`top\n${inserted}\nbottom\n`, tpl), null, 'an installed block with an inserted line');
  assert.equal(matchTemplateRender('top\nPLUGIN_DIR="/c"\nexport X=1\nTUI_BUNDLE="/c"\nbottom\n', tpl), null);
});

test('every placeholder in every committed version of the launcher templates has a validator', () => {
  for (const name of LAUNCHER_TEMPLATES) {
    for (const sha of gitShas(`templates/${name}`)) {
      for (const [, token] of gitShow(sha, `templates/${name}`).matchAll(/\{\{([A-Z_]+)\}\}/g)) {
        assert.ok(Object.hasOwn(PLACEHOLDER_VALUES, token), `${name}@${sha.slice(0, 8)}: {{${token}}} has no validator`);
      }
    }
  }
});

test('the 2026-09-19 Dome Farmer launcher is an older generated version; a hand edit of it, appended claude flags and the current template are not', () => {
  const history = historicalLauncherTemplates({ repoRoot: REPO });
  assert.equal(history.degraded, null);
  assert.ok(olderGeneratedLauncher(SEP19, 'launcher-tmux.sh', history));
  assert.equal(olderGeneratedLauncher(HAND_EDITED, 'launcher-tmux.sh', history), null);
  assert.ok(olderGeneratedLauncher(render43232a67(), 'launcher-tmux.sh', history), 'CONTROL: the pristine 43232a67 render matches');
  assert.equal(olderGeneratedLauncher(render43232a67(FLAGS), 'launcher-tmux.sh', history), null);
  const current = lf(readFileSync(join(REPO, 'templates', 'launcher-tmux.sh'), 'utf8'));
  assert.ok(!history.templates.get('launcher-tmux.sh').includes(current), 'the current template is not an older version');
});

test('historicalLauncherTemplates on a clone: every committed template version except the current one, and the installed blocks of every renderer version', () => {
  const history = historicalLauncherTemplates({ repoRoot: REPO });
  assert.deepEqual([...history.templates.keys()].sort(), [...LAUNCHER_TEMPLATES].sort());
  for (const name of LAUNCHER_TEMPLATES) {
    const current = lf(readFileSync(join(REPO, 'templates', name), 'utf8'));
    const expected = new Set(gitShasFull(`templates/${name}`).map((s) => lf(gitShow(s, `templates/${name}`))).filter((t) => t !== current));
    assert.deepEqual(new Set(history.templates.get(name)), expected, name);
  }
  assert.ok(history.installedBlocks.has(INSTALLED_PATHS));
  assert.ok(history.installedBlocks.size >= 2, `earlier renderer versions add their installed blocks (got ${history.installedBlocks.size})`);
  for (const block of history.installedBlocks) {
    assert.ok(block.startsWith('# installed') && !block.includes('{{'), block.slice(0, 80));
  }
});

test('installed copy: the history is read from bin/launcher-history.json; a missing snapshot is reported as degraded, with no history', () => {
  const root = tmp('sterling-lh-installed-');
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, LAUNCHER_HISTORY_REL), launcherHistorySnapshot({ repoRoot: REPO }));
  const history = historicalLauncherTemplates({ repoRoot: root });
  assert.equal(history.degraded, null);
  assert.ok(olderGeneratedLauncher(SEP19, 'launcher-tmux.sh', history));
  assert.deepEqual(history.installedBlocks, historicalLauncherTemplates({ repoRoot: REPO }).installedBlocks);

  const bare = tmp('sterling-lh-bare-');
  const empty = historicalLauncherTemplates({ repoRoot: bare });
  assert.equal(olderGeneratedLauncher(SEP19, 'launcher-tmux.sh', empty), null);
  assert.ok(empty.degraded.includes(join(bare, LAUNCHER_HISTORY_REL)), empty.degraded);
});

test('launcherHistorySnapshot: deterministic JSON of every launcher template and the installed blocks, current versions left out', () => {
  const a = launcherHistorySnapshot({ repoRoot: REPO });
  assert.equal(a, launcherHistorySnapshot({ repoRoot: REPO }));
  const parsed = JSON.parse(a);
  assert.deepEqual(Object.keys(parsed), [INSTALLED_BLOCKS_KEY, ...LAUNCHER_TEMPLATES].sort());
  assert.ok(parsed['launcher-tmux.sh'].length >= 1);
  assert.ok(!parsed['launcher-tmux.sh'].includes(lf(readFileSync(join(REPO, 'templates', 'launcher-tmux.sh'), 'utf8'))));
  assert.ok(!parsed[INSTALLED_BLOCKS_KEY].includes(INSTALLED_PATHS));
  assert.throws(() => launcherHistorySnapshot({ repoRoot: tmp('sterling-lh-nogit-') }), /no git history/);
});

// ---- end to end: the real init, run from this clone (authoring shape) ----

function runInit(target, initScript = join(REPO, 'scripts', 'init.mjs')) {
  const cfg = tmp('sterling-lh-cfg-');
  writeFileSync(join(cfg, 'settings.json'), '{}');
  const r = spawnSync(process.execPath, [initScript, '--target', target,
    '--project-name', 'lh-target', '--stack-tags', 'node', '--domain-description', 'node=test domain node', '--toolchain', 'node:**/*.mjs', '--backup-path', 'backups'], {
    encoding: 'utf8',
    cwd: target,
    timeout: 180_000,
    env: {
      ...process.env,
      HOME: tmp('sterling-lh-home-'),
      STERLING_REGISTRY_DB: join(target, 'registry.db'),
      STERLING_PLUGIN_ROOT_MATCH: tmp('sterling-lh-prm-'),
      STERLING_CODEX_PROBE: 'absent',
      STERLING_CLAUDE_PROBE: 'ok',
      CLAUDE_CONFIG_DIR: cfg,
    },
  });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
const row = (out, item) => out.split('\n').find((l) => l.startsWith(item + ' ')) ?? '';
const loudLine = (out, file) => out.split('\n').find((l) => l.startsWith('⚠') && l.includes(file));

test('init: the 2026-09-19 launcher is rewritten from the current template and announced with its old path; a second run finds it current (idempotent)', () => {
  const target = tmp('sterling-lh-project-');
  writeFileSync(join(target, 'sterling-launch.sh'), SEP19);

  const first = runInit(target);
  assert.equal(first.code, 0, first.out);
  assert.match(row(first.out, 'sterling-launch.sh'), /\brefreshed\b/);
  assert.match(row(first.out, 'sterling-launch.sh'), /earlier generated version/);
  assert.ok(row(first.out, 'sterling-launch.sh').includes(`rendered for /home/demo/sterling-clone, now ${REPO.replace(/\\/g, '/')}`), row(first.out, 'sterling-launch.sh'));
  const after1 = readFileSync(join(target, 'sterling-launch.sh'), 'utf8');
  assert.match(after1, /tmux set-option -t "\$SESSION" mouse on/);
  assert.ok(after1.includes(`TUI_BUNDLE="${REPO.replace(/\\/g, '/')}/tui/sterling-tui.mjs"`), after1);
  assert.doesNotMatch(after1, /packages\/tui\/bundle/);

  const second = runInit(target);
  assert.equal(second.code, 0, second.out);
  assert.match(row(second.out, 'sterling-launch.sh'), /\bmatches\b/);
  assert.equal(readFileSync(join(target, 'sterling-launch.sh'), 'utf8'), after1);
});

test('init: a hand-edited launcher stays byte-identical, and a loud line names it and how to refresh it', () => {
  const target = tmp('sterling-lh-project-');
  writeFileSync(join(target, 'sterling-launch.sh'), HAND_EDITED);

  const { code, out } = runInit(target);
  assert.equal(code, 0, out);
  assert.equal(readFileSync(join(target, 'sterling-launch.sh'), 'utf8'), HAND_EDITED);
  assert.match(row(out, 'sterling-launch.sh'), /\bdiffers\b/);
  const loud = loudLine(out, 'sterling-launch.sh');
  assert.ok(loud, `a ⚠ line names the launcher: ${out}`);
  assert.match(loud, /delete it and re-run \/sterling:init/);
});

test('init: a 43232a67 launcher with flags appended to the claude command is not refreshed and stays byte-identical', () => {
  const target = tmp('sterling-lh-project-');
  const edited = render43232a67(FLAGS);
  writeFileSync(join(target, 'sterling-launch.sh'), edited);

  const { code, out } = runInit(target);
  assert.equal(code, 0, out);
  assert.equal(readFileSync(join(target, 'sterling-launch.sh'), 'utf8'), edited);
  assert.match(row(out, 'sterling-launch.sh'), /\bdiffers\b/);
  assert.ok(loudLine(out, 'sterling-launch.sh'), out);
});

test('init: a current launcher is left as is; older generated .bat files are refreshed; a hand-edited .bat stays byte-identical', () => {
  const target = tmp('sterling-lh-project-');
  const fresh = runInit(target);
  assert.equal(fresh.code, 0, fresh.out);
  const current = {};
  for (const f of ['sterling-launch.sh', 'sterling.bat', 'tui.bat']) current[f] = readFileSync(join(target, f), 'utf8');

  // The oldest committed version of each .bat template, rendered with values the init of
  // its day produced (scripts/init.mjs at 495cef15).
  const OLD_VALUES = {
    WT: '"C:\\Program Files\\WindowsApps\\wt.exe"',
    CLAUDE: '"C:\\Users\\demo\\.local\\bin\\claude.exe" --plugin-dir "C:/Users/demo/sterling"',
    NODE: '"C:\\Program Files\\nodejs\\node.exe"',
    TUI_BUNDLE: 'C:\\Users\\demo\\sterling\\packages\\tui\\bundle\\sterling-tui.mjs',
    SPLIT_RATIO: '0.35',
    WIN_PROJECT_DIR: 'C:\\Users\\demo\\lh-target',
  };
  const renderOldest = (name) => gitShow(gitShas(`templates/${name}`).at(-1), `templates/${name}`)
    .replace(/\{\{([A-Z_]+)\}\}/g, (_, t) => OLD_VALUES[t])
    .replace(/\r?\n/g, '\r\n');
  writeFileSync(join(target, 'sterling.bat'), renderOldest('launcher-win.bat'));
  writeFileSync(join(target, 'tui.bat'), renderOldest('tui-win.bat'));

  const second = runInit(target);
  assert.equal(second.code, 0, second.out);
  assert.match(row(second.out, 'sterling-launch.sh'), /\bmatches\b/);
  assert.equal(readFileSync(join(target, 'sterling-launch.sh'), 'utf8'), current['sterling-launch.sh']);
  for (const f of ['sterling.bat', 'tui.bat']) {
    assert.match(row(second.out, f), /\brefreshed\b/, second.out);
    assert.equal(readFileSync(join(target, f), 'utf8'), current[f], `${f} is the current render again`);
  }

  const handBat = current['tui.bat'].replace('\r\n', '\r\nREM my own line\r\n');
  writeFileSync(join(target, 'tui.bat'), handBat);
  const third = runInit(target);
  assert.equal(third.code, 0, third.out);
  assert.equal(readFileSync(join(target, 'tui.bat'), 'utf8'), handBat);
  assert.match(row(third.out, 'tui.bat'), /\bdiffers\b/);
  assert.ok(loudLine(third.out, 'tui.bat'), third.out);
});

// ---- the replay of earlier renderer versions (residuals of the launcher-refresh re-check) ----

const realGit = (args, opts = {}) => spawnSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 28, ...opts });
const CLOSURE_RELS = ['scripts/lib/launcher-tmux.mjs', 'scripts/lib/sterling-roots.mjs', 'scripts/lib/installed-copy.mjs'];
const newestRendererSha = () => realGit(['log', '--format=%H', '--', ...CLOSURE_RELS]).stdout.split('\n').filter(Boolean)[0];
// The blob reads are one `git cat-file --batch` (stdin: one spec per line; stdout: per spec
// "<oid> blob <size>\n<bytes>\n", or "<spec> missing\n"). The fakes below speak that
// protocol: split real output into one entry per spec, replace entries, join them again.
function splitBatch(out, specs) {
  const entries = [];
  let pos = 0;
  for (const spec of specs) {
    const eol = out.indexOf(0x0a, pos);
    const header = out.subarray(pos, eol).toString('utf8');
    const size = header.endsWith(' missing') ? -1 : Number(header.split(' ')[2]);
    const end = size < 0 ? eol + 1 : eol + 1 + size + 1;
    entries.push({ spec, bytes: out.subarray(pos, end) });
    pos = end;
  }
  return entries;
}
const servedBlob = (text) => Buffer.concat([Buffer.from(`0000000 blob ${Buffer.byteLength(text)}\n`), Buffer.from(text), Buffer.from('\n')]);
const missingBlob = (spec) => Buffer.from(`${spec} missing\n`);
// A git that serves `files` ({rel: source}) for `sha`'s scripts/lib closure and the real
// repository for everything else; a rel the fake does not list is absent at that commit.
const gitWithRendererAt = (sha, files) => (args, opts) => {
  if (args[0] !== 'cat-file') return realGit(args, opts);
  const specs = opts.input.toString('utf8').split('\n').filter(Boolean);
  const real = realGit(args, { input: Buffer.from(`${specs.join('\n')}\n`), encoding: 'buffer' });
  const bytes = splitBatch(real.stdout, specs).map(({ spec, bytes: served }) => {
    if (!spec.startsWith(`${sha}:scripts/lib/`)) return served;
    const rel = spec.slice(sha.length + 1);
    return Object.hasOwn(files, rel) ? servedBlob(files[rel]) : missingBlob(spec);
  });
  return { status: 0, stdout: Buffer.concat(bytes), stderr: '' };
};
const RENDERER = 'scripts/lib/launcher-tmux.mjs';
const FAILING = { [RENDERER]: "export function renderTmuxLauncher() { throw new Error('renderer exploded'); }\n" };

test('a renderer version that cannot run is skipped with one loud reason; the other versions still replay', () => {
  const sha = newestRendererSha();
  const history = historicalLauncherTemplates({ repoRoot: REPO, git: gitWithRendererAt(sha, FAILING) });
  assert.equal(history.degraded, null);
  assert.equal(history.replayFailures.length, 1, JSON.stringify(history.replayFailures));
  assert.ok(history.replayFailures[0].includes(sha.slice(0, 8)), history.replayFailures[0]);
  assert.ok(history.replayFailures[0].includes('renderer exploded'), history.replayFailures[0]);
  assert.ok(history.installedBlocks.has(INSTALLED_PATHS));
  assert.ok(history.installedBlocks.size >= 2, `the other versions still contribute (got ${history.installedBlocks.size})`);
  assert.ok(olderGeneratedLauncher(SEP19, 'launcher-tmux.sh', history), 'template history is unaffected');
  assert.deepEqual(historicalLauncherTemplates({ repoRoot: REPO }).replayFailures, [], 'every real commit replays cleanly');
});

test('launcherHistorySnapshot (build:bin) survives a renderer version that cannot run and says so', () => {
  const sha = newestRendererSha();
  const warned = [];
  const snapshot = launcherHistorySnapshot({ repoRoot: REPO, git: gitWithRendererAt(sha, FAILING), warn: (line) => warned.push(line) });
  assert.ok(JSON.parse(snapshot)[INSTALLED_BLOCKS_KEY].length >= 1);
  assert.equal(warned.length, 1, JSON.stringify(warned));
  assert.ok(warned[0].includes('renderer exploded'), warned[0]);
});

test('a renderer that re-exports from a double-quoted specifier has its whole import closure replayed', () => {
  const sha = newestRendererSha();
  const files = {
    [RENDERER]: 'export { renderTmuxLauncher } from "./replayed-impl.mjs";\n',
    'scripts/lib/replayed-impl.mjs': "export function renderTmuxLauncher() { return '# installed (replayed re-export)'; }\n",
  };
  const history = historicalLauncherTemplates({ repoRoot: REPO, git: gitWithRendererAt(sha, files) });
  assert.deepEqual(history.replayFailures, []);
  assert.ok(history.installedBlocks.has('# installed (replayed re-export)'), [...history.installedBlocks].join('\n---\n'));
});

test('the history is one git log plus a few git cat-file --batch calls, never a git show per blob', () => {
  const calls = [];
  const git = (args, opts) => { calls.push(args[0]); return realGit(args, opts); };
  const history = historicalLauncherTemplates({ repoRoot: REPO, git });
  assert.ok(calls.filter((c) => c === 'cat-file').length <= 3, calls.join(','));
  assert.equal(calls.filter((c) => c === 'show').length, 0, calls.join(','));
  assert.equal(calls.filter((c) => c === 'log').length, 1, calls.join(','));
  assert.ok(history.installedBlocks.size >= 2);
  assert.ok(olderGeneratedLauncher(SEP19, 'launcher-tmux.sh', history));
});

// ---- scratch repositories: history shapes the real one may not have ----

function scratchRepo() {
  const dir = tmp('sterling-lh-scratch-');
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  git('init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't'], ['core.autocrlf', 'false'], ['commit.gpgsign', 'false']]) git('config', k, v);
  const write = (rel, text) => { mkdirSync(join(dir, dirname(rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
  const commit = (message) => { git('add', '-A'); git('commit', '-q', '-m', message); };
  for (const name of LAUNCHER_TEMPLATES) write(`templates/${name}`, 'template\n');
  return { dir, git, write, commit };
}
const renderer = (block, imports = '') => `${imports}export function renderTmuxLauncher() { return '# installed ${block}'; }\n`;

test('a merge whose side branch touched only the renderer does not hide the mainline renderer versions (--full-history)', () => {
  const repo = scratchRepo();
  repo.write(RENDERER, renderer('v1'));
  repo.commit('v1');
  repo.git('checkout', '-q', '-b', 'side');
  repo.write(RENDERER, renderer('side'));
  repo.commit('side touches only the renderer');
  repo.git('checkout', '-q', 'main');
  repo.write(RENDERER, renderer('v1.5'));
  repo.commit('v1.5');
  repo.write(RENDERER, renderer('v1'));
  repo.commit('revert to v1');
  repo.git('merge', '-q', 'side', '-m', 'merge side');
  const history = historicalLauncherTemplates({ repoRoot: repo.dir });
  assert.deepEqual(history.replayFailures, []);
  assert.deepEqual([...history.installedBlocks].filter((b) => b !== INSTALLED_PATHS).sort(), ['# installed side', '# installed v1', '# installed v1.5']);
});

test('files only an older renderer imported are read level by level across all versions, not one cat-file per blob', () => {
  const repo = scratchRepo();
  const versions = 5;
  for (let i = 1; i <= versions; i += 1) {
    repo.write(`scripts/lib/old-${i}.mjs`, `export const tag = 'old-${i}';\n`);
    repo.write(RENDERER, `import { tag } from './old-${i}.mjs';\nexport function renderTmuxLauncher() { return \`# installed \${tag}\`; }\n`);
    repo.commit(`renderer ${i}`);
  }
  repo.write(RENDERER, renderer('today'));
  repo.commit('today: imports nothing');
  const calls = [];
  const git = (args, opts) => { calls.push(args[0]); return spawnSync('git', args, { cwd: repo.dir, encoding: 'utf8', maxBuffer: 1 << 28, ...opts }); };
  const history = historicalLauncherTemplates({ repoRoot: repo.dir, git });
  assert.deepEqual(history.replayFailures, []);
  assert.deepEqual([...history.installedBlocks].filter((b) => b !== INSTALLED_PATHS).sort(), [...Array.from({ length: versions }, (_, i) => `# installed old-${i + 1}`), '# installed today']);
  // One batch for everything the current closure names, one more for the second level of
  // every older version together: the count follows closure depth, not the version count.
  assert.equal(calls.filter((c) => c === 'cat-file').length, 2, calls.join(','));
});

const deadChild = (result) => () => result;
test('a replay child that exits non-zero fails every version with its stderr, and the loud line states the reason once with the count', () => {
  let replayed = null;
  const dead = deadChild({ status: 1, stdout: '', stderr: 'boom\nsecond line' });
  const history = historicalLauncherTemplates({ repoRoot: REPO, spawn: (cmd, args, opts) => { replayed = JSON.parse(/const dirs = (\[.*\]);/.exec(args[2])[1]).length; return dead(cmd, args, opts); } });
  const n = history.replayFailures.length;
  assert.ok(n >= 2, `several real renderer versions (got ${n})`);
  assert.equal(n, replayed, 'one failure per version handed to the replay child');
  for (const f of history.replayFailures) assert.match(f, /^[0-9a-f]{8}: the replay process exited 1: boom$/);
  assert.deepEqual(historicalLauncherTemplates({ repoRoot: REPO, spawn: deadChild({ status: 1, stderr: 'boom' }) }).installedBlocks, new Set([INSTALLED_PATHS]));
  const line = replayFailureLine(history.replayFailures, 'left alone');
  assert.equal(line.split('the replay process exited 1: boom').length - 1, 1, line);
  assert.ok(line.includes(`${n} earlier renderer version(s)`), line);
  assert.ok(line.endsWith('left alone'), line);
});

test('a replay child that could not start or was killed names the error or the signal, not an empty reason', () => {
  const failed = historicalLauncherTemplates({ repoRoot: REPO, spawn: deadChild({ status: null, error: new Error('spawn ENOENT') }) }).replayFailures;
  assert.ok(failed.length >= 2);
  for (const f of failed) assert.ok(f.includes('spawn ENOENT'), f);
  const killed = historicalLauncherTemplates({ repoRoot: REPO, spawn: deadChild({ status: null, signal: 'SIGKILL', stderr: '' }) }).replayFailures;
  for (const f of killed) assert.ok(f.includes('SIGKILL'), f);
});

test('a replay child whose output is not the expected JSON fails every version with the reason', () => {
  for (const stdout of ['not json', '{"block":1}', '[]']) {
    const failures = historicalLauncherTemplates({ repoRoot: REPO, spawn: deadChild({ status: 0, stdout, stderr: '' }) }).replayFailures;
    assert.ok(failures.length >= 2, stdout);
    for (const f of failures) assert.match(f, /^[0-9a-f]{8}: the replay process printed (?:unparseable|unexpected) output/, `${stdout}: ${f}`);
  }
});

test('a replay child that prints null entries fails every version without throwing', () => {
  const spawn = (cmd, args) => {
    const count = JSON.parse(/const dirs = (\[.*\]);/.exec(args[2])[1]).length;
    return { status: 0, stderr: '', stdout: JSON.stringify(Array.from({ length: count }, () => null)) };
  };
  const failures = historicalLauncherTemplates({ repoRoot: REPO, spawn }).replayFailures;
  assert.ok(failures.length >= 2, `several real renderer versions (got ${failures.length})`);
  for (const f of failures) assert.match(f, /^[0-9a-f]{8}: the renderer returned no text$/, f);
});

test('the whole replay runs in one child process, however many renderer versions there are', () => {
  let spawns = 0;
  const spawn = (...args) => { spawns += 1; return spawnSync(...args); };
  const history = historicalLauncherTemplates({ repoRoot: REPO, spawn });
  assert.ok(history.installedBlocks.size >= 2);
  assert.equal(spawns, 1);
});

test('init on an installed copy with no bin/launcher-history.json: a differing launcher is left untouched and the degraded wording says there is no template history', () => {
  const root = tmp('sterling-lh-installed-root-');
  for (const dir of ['bin', 'templates', 'agent-templates', '.claude-plugin', 'skills', 'commands', 'mcp', 'tui', 'scripts/adapters']) {
    cpSync(join(REPO, dir), join(root, dir), { recursive: true });
  }
  rmSync(join(root, LAUNCHER_HISTORY_REL), { force: true });
  const installedInit = join(root, 'bin', 'init.mjs');
  const target = tmp('sterling-lh-project-');
  const fresh = runInit(target, installedInit);
  assert.equal(fresh.code, 0, fresh.out);
  // A launcher that differs but names no clone, so it is not the clone-launcher replacement.
  const noClone = SEP19.replace(' --plugin-dir "$PLUGIN_DIR"', '');
  assert.notEqual(noClone, SEP19);
  const handBat = readFileSync(join(target, 'tui.bat'), 'utf8').replace('\r\n', '\r\nREM my own line\r\n');
  writeFileSync(join(target, 'sterling-launch.sh'), noClone);
  writeFileSync(join(target, 'tui.bat'), handBat);

  const { code, out } = runInit(target, installedInit);
  assert.equal(code, 0, out);
  assert.equal(readFileSync(join(target, 'sterling-launch.sh'), 'utf8'), noClone);
  assert.equal(readFileSync(join(target, 'tui.bat'), 'utf8'), handBat);
  for (const file of ['sterling-launch.sh', 'tui.bat']) {
    assert.match(row(out, file), /\bdiffers\b.*could not be checked \(no template history\)/, out);
    const loud = loudLine(out, file);
    assert.ok(loud, out);
    assert.match(loud, /could not be checked against earlier versions \(no template history: no git history at .+ \(installed plugin copy\) and .+launcher-history\.json is missing\)/);
    assert.match(loud, /delete it and re-run \/sterling:init/);
  }
});
