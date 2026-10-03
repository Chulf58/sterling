// Older generated launchers are refreshed (decision init-and-update-refresh-an-older-
// generated-launcher): init, and the /sterling:update ensure pass that runs it, rewrite a
// sterling-launch.sh / sterling.bat / tui.bat that is a pristine render of an EARLIER
// template version, and say so. A launcher matching no known version is a hand edit: it
// stays byte-identical and a loud line names it and the remedy. The known versions come
// from git on a clone, and from bin/launcher-history.json on an installed copy (no git).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
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
    const expected = new Set(gitShas(`templates/${name}`).map((s) => lf(gitShow(s, `templates/${name}`))).filter((t) => t !== current));
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

function runInit(target) {
  const cfg = tmp('sterling-lh-cfg-');
  writeFileSync(join(cfg, 'settings.json'), '{}');
  const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'init.mjs'), '--target', target,
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
