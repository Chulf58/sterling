// Older generated launchers are refreshed (decision init-and-update-refresh-an-older-
// generated-launcher): init, and the /sterling:update ensure pass that runs it, rewrite a
// sterling-launch.sh / sterling.bat / tui.bat that is a pristine render of an EARLIER
// template version, and say so. A launcher matching no known version is a hand edit: it
// stays byte-identical and a loud line names it and the remedy. The known versions come
// from the templates' git log on a clone, and from bin/launcher-history.json on an
// installed copy (no git).
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
  matchesTemplateRender,
  historicalLauncherTemplates,
  isOlderGeneratedLauncher,
  launcherHistorySnapshot,
} from '../lib/launcher-history.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const made = new Set();
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); made.add(d); return d; };
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

// Dome Farmer's sterling-launch.sh as init wrote it on 2026-09-19 (template 3f9097b1),
// paths and session name scrubbed: no `mouse on`, TUI from packages/tui/bundle.
const SEP19 = readFileSync(join(REPO, 'scripts', 'tests', 'fixtures', 'launcher-tmux-2026-09-19.sh'), 'utf8');
// A hand edit of that file: one line the user added.
const HAND_EDITED = SEP19.replace('set -euo pipefail\n', 'set -euo pipefail\nexport MY_SETTING=1\n');
const gitShow = (sha, rel) => spawnSync('git', ['show', `${sha}:${rel}`], { cwd: REPO, encoding: 'utf8' }).stdout;

test('matchesTemplateRender: placeholder values may be anything on one line; literal text must match whole, start to end', () => {
  const tpl = 'A="{{X}}"\nB={{Y}}\nend\n';
  assert.equal(matchesTemplateRender('A="one two"\nB=3\nend\n', tpl), true);
  assert.equal(matchesTemplateRender('A="one two"\r\nB=3\r\nend\r\n', tpl), true, 'CRLF reads the same as LF');
  assert.equal(matchesTemplateRender('A="one"\nadded\nB=3\nend\n', tpl), false, 'an extra line is not a placeholder value');
  assert.equal(matchesTemplateRender('A="one"\nB=3\nend\nmore\n', tpl), false, 'trailing text is a hand edit');
  assert.equal(matchesTemplateRender('# x\nA="one"\nB=3\nend\n', tpl), false, 'leading text is a hand edit');
  assert.equal(matchesTemplateRender('A="one"\nB=3\nEND\n', tpl), false);
});

test('matchesTemplateRender: {{PLUGIN_PATHS}} accepts the authoring and installed blocks and nothing else spanning lines', () => {
  const tpl = 'top\n{{PLUGIN_PATHS}}\nbottom\n';
  assert.equal(matchesTemplateRender('top\nPLUGIN_DIR="/c"\nTUI_BUNDLE="/c/tui/sterling-tui.mjs"\nbottom\n', tpl), true);
  const installed = '# installed copy: nothing below names a versioned install directory; the newest\nwhatever\nSTERLING_RESOLVER\n)"';
  assert.equal(matchesTemplateRender(`top\n${installed}\nbottom\n`, tpl), true);
  assert.equal(matchesTemplateRender('top\nPLUGIN_DIR="/c"\nexport X=1\nTUI_BUNDLE="/c"\nbottom\n', tpl), false);
});

test('the 2026-09-19 Dome Farmer launcher is an older generated version; a hand edit of it and the current template are not', () => {
  const history = historicalLauncherTemplates({ repoRoot: REPO, warn: (l) => assert.fail(l) });
  assert.equal(isOlderGeneratedLauncher(SEP19, 'launcher-tmux.sh', history), true);
  assert.equal(isOlderGeneratedLauncher(HAND_EDITED, 'launcher-tmux.sh', history), false);
  const current = readFileSync(join(REPO, 'templates', 'launcher-tmux.sh'), 'utf8');
  assert.ok(!history.get('launcher-tmux.sh').includes(current), 'the current template is not an older version');
});

test('historicalLauncherTemplates on a clone: every committed version of each launcher template except the current one', () => {
  const history = historicalLauncherTemplates({ repoRoot: REPO, warn: (l) => assert.fail(l) });
  assert.deepEqual([...history.keys()].sort(), [...LAUNCHER_TEMPLATES].sort());
  for (const name of LAUNCHER_TEMPLATES) {
    const shas = spawnSync('git', ['log', '--format=%H', '--', `templates/${name}`], { cwd: REPO, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
    const current = readFileSync(join(REPO, 'templates', name), 'utf8').replace(/\r\n/g, '\n');
    const expected = new Set(shas.map((s) => gitShow(s, `templates/${name}`).replace(/\r\n/g, '\n')).filter((t) => t !== current));
    assert.deepEqual(new Set(history.get(name)), expected, name);
  }
});

test('installed copy: the history is read from bin/launcher-history.json; a missing snapshot degrades loudly to no history', () => {
  const root = tmp('sterling-lh-installed-');
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, LAUNCHER_HISTORY_REL), launcherHistorySnapshot({ repoRoot: REPO }));
  const warns = [];
  const history = historicalLauncherTemplates({ repoRoot: root, warn: (l) => warns.push(l) });
  assert.deepEqual(warns, []);
  assert.equal(isOlderGeneratedLauncher(SEP19, 'launcher-tmux.sh', history), true);

  const bare = tmp('sterling-lh-bare-');
  const empty = historicalLauncherTemplates({ repoRoot: bare, warn: (l) => warns.push(l) });
  assert.equal(isOlderGeneratedLauncher(SEP19, 'launcher-tmux.sh', empty), false);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /DEGRADED/);
  assert.ok(warns[0].includes(join(bare, LAUNCHER_HISTORY_REL)), warns[0]);
});

test('launcherHistorySnapshot: deterministic JSON of every launcher template, current versions left out', () => {
  const a = launcherHistorySnapshot({ repoRoot: REPO });
  assert.equal(a, launcherHistorySnapshot({ repoRoot: REPO }));
  const parsed = JSON.parse(a);
  assert.deepEqual(Object.keys(parsed), [...LAUNCHER_TEMPLATES].sort());
  assert.ok(parsed['launcher-tmux.sh'].length >= 1);
  assert.ok(!parsed['launcher-tmux.sh'].includes(readFileSync(join(REPO, 'templates', 'launcher-tmux.sh'), 'utf8')));
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

test('init: the 2026-09-19 launcher is rewritten from the current template and announced; a second run finds it current (idempotent)', () => {
  const target = tmp('sterling-lh-project-');
  writeFileSync(join(target, 'sterling-launch.sh'), SEP19);

  const first = runInit(target);
  assert.equal(first.code, 0, first.out);
  assert.match(row(first.out, 'sterling-launch.sh'), /\brefreshed\b/);
  assert.match(row(first.out, 'sterling-launch.sh'), /earlier generated version/);
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
  const loud = out.split('\n').find((l) => l.startsWith('⚠') && l.includes('sterling-launch.sh'));
  assert.ok(loud, `a ⚠ line names the launcher: ${out}`);
  assert.match(loud, /delete it and re-run \/sterling:init/);
});

test('init: a current launcher is left as is; an older generated tui.bat and sterling.bat are refreshed the same way', () => {
  const target = tmp('sterling-lh-project-');
  const fresh = runInit(target);
  assert.equal(fresh.code, 0, fresh.out);
  const current = {};
  for (const f of ['sterling-launch.sh', 'sterling.bat', 'tui.bat']) current[f] = readFileSync(join(target, f), 'utf8');

  // The oldest committed version of each .bat template, rendered with some project path.
  const oldest = (name) => {
    const shas = spawnSync('git', ['log', '--format=%H', '--', `templates/${name}`], { cwd: REPO, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
    return gitShow(shas.at(-1), `templates/${name}`);
  };
  const renderOld = (name) => oldest(name).replace(/\{\{[A-Z_]+\}\}/g, 'C:\\Users\\demo\\lh-target').replace(/\r?\n/g, '\r\n');
  writeFileSync(join(target, 'sterling.bat'), renderOld('launcher-win.bat'));
  writeFileSync(join(target, 'tui.bat'), renderOld('tui-win.bat'));

  const { code, out } = runInit(target);
  assert.equal(code, 0, out);
  assert.match(row(out, 'sterling-launch.sh'), /\bmatches\b/);
  assert.equal(readFileSync(join(target, 'sterling-launch.sh'), 'utf8'), current['sterling-launch.sh']);
  for (const f of ['sterling.bat', 'tui.bat']) {
    assert.match(row(out, f), /\brefreshed\b/, out);
    assert.equal(readFileSync(join(target, f), 'utf8'), current[f], `${f} is the current render again`);
  }
});
