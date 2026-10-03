// H1 SessionStart — PROJECT MODE LINE (decision
// project-mode-hobby-work-toggle-decides-flow, slice S1). Informational only:
// H1 states the project's config.mode next to the MACHINE ROLE / TDD posture
// lines. A missing key means hobby; an invalid value reads INVALID (never as
// either flow); an unreadable config reads UNKNOWN (never the default).
// Harness copied from scripts/tests/h1-tdd-posture-line.test.mjs.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

const BASE_CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
};

function project(rawConfig) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h1-mode-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), typeof rawConfig === 'string' ? rawConfig : JSON.stringify(rawConfig));
  new SterlingStore(join(dir, '.sterling', 'sterling.db')).close();
  return dir;
}

function context(dir) {
  const input = { session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', hook_event_name: 'SessionStart', source: 'startup' };
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'hooks', 'h1-session-start.mjs')], {
    input: JSON.stringify(input), encoding: 'utf8', cwd: dir, timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1', NO_COLOR: '1', STERLING_NO_BANNER: '1', STERLING_PLUGIN_ROOT: root },
  });
  assert.equal(r.status, 0, `H1 must exit 0 (soft hook): ${r.stderr}`);
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
}

const modeLines = (ctx) => ctx.split('\n').filter((l) => l.startsWith('Project mode:'));

// CHANGED (decision
// project-mode-means-shipping-flow-only-handoff-files-are-a-separate-setting):
// the mode line used to say whether the OpenCode agents and handoff files were
// written. It now says only how work ships; the Handoff files line below it
// carries the other fact.
const WORK_LINE = 'Project mode: WORK (config.mode — TUI System tab) — work ships as a pull request through /sterling:merge, followed by the review loop; nothing is merged directly.';
const HOBBY_LINE = 'Project mode: HOBBY (config.mode — TUI System tab) — work ships by direct merge through /sterling:merge.';
const handoffLines = (ctx) => ctx.split('\n').filter((l) => l.startsWith('Handoff files:'));
const HANDOFF_ON_LINE = 'Handoff files: ON (config.handoff.enabled — TUI System tab) — the portable OpenCode agents and the handoff projection for colleagues without Sterling are written and maintained.';
const HANDOFF_OFF_LINE = 'Handoff files: OFF (config.handoff.enabled — TUI System tab) — the portable OpenCode agents and the handoff projection for colleagues without Sterling are not written; existing ones are left in place.';
const HANDOFF_NOT_SET_LINE = 'Handoff files: OFF (not set: config.handoff.enabled is absent and no handoff files are tracked in git — TUI System tab) — the portable OpenCode agents and the handoff projection for colleagues without Sterling are not written; existing ones are left in place.';

for (const [mode, modeLine] of [['hobby', HOBBY_LINE], ['work', WORK_LINE]]) {
  for (const [on, handoffLine] of [[true, HANDOFF_ON_LINE], [false, HANDOFF_OFF_LINE]]) {
    test(`H1 (${mode}, handoff ${on ? 'on' : 'off'}): the mode line says only how work ships, and the handoff line follows it`, () => {
      const dir = project({ ...BASE_CONFIG, mode, handoff: { enabled: on } });
      try {
        const ctx = context(dir);
        assert.deepEqual(modeLines(ctx), [modeLine]);
        assert.deepEqual(handoffLines(ctx), [handoffLine]);
        assert.doesNotMatch(ctx, /work-only/);
        assert.equal(ctx.slice(ctx.indexOf('Project mode:'), ctx.indexOf('Handoff files:')).split('\n\n').length, 2, 'nothing sits between the two lines');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}

test('H1 reads a missing handoff key as OFF (not set), a non-boolean as INVALID and an unreadable config as UNKNOWN', () => {
  const missing = project({ ...BASE_CONFIG, mode: 'work' });
  const invalid = project({ ...BASE_CONFIG, mode: 'work', handoff: { enabled: 'yes' } });
  const broken = project('{ not json');
  try {
    // CHANGED (review round 2): an absent key used to print the same line as an explicit
    // false. It now says the key is not set, so the two are told apart.
    assert.deepEqual(handoffLines(context(missing)), [HANDOFF_NOT_SET_LINE], 'work mode does not turn the handoff files on');
    assert.notEqual(HANDOFF_NOT_SET_LINE, HANDOFF_OFF_LINE);
    assert.deepEqual(handoffLines(context(invalid)), ["Handoff files: INVALID ('yes') — config.handoff.enabled must be true or false; init, sync-agents, /sterling:update and the handoff projection refuse to act on it until it is fixed (TUI System tab)."]);
    assert.deepEqual(handoffLines(context(broken)), ['Handoff files: UNKNOWN — the project config could not be read, so config.handoff.enabled could not be determined. This is NOT the off default: repair the config.']);
  } finally {
    for (const dir of [missing, invalid, broken]) rmSync(dir, { recursive: true, force: true });
  }
});

for (const [label, cfg, expected] of [
  ['work', { ...BASE_CONFIG, mode: 'work' }, WORK_LINE],
  ['hobby', { ...BASE_CONFIG, mode: 'hobby' }, HOBBY_LINE],
  ['a missing key (hobby)', BASE_CONFIG, HOBBY_LINE],
]) {
  test(`H1 states the project mode exactly once, full text: ${label}`, () => {
    const dir = project(cfg);
    try {
      const lines = modeLines(context(dir));
      assert.deepEqual(lines, [expected]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('H1 reads an invalid mode as INVALID, never as either flow', () => {
  const dir = project({ ...BASE_CONFIG, mode: 'Work' });
  try {
    const lines = modeLines(context(dir));
    assert.equal(lines.length, 1);
    assert.equal(lines[0], "Project mode: INVALID ('Work') — config.mode must be 'hobby' or 'work'; /sterling:merge, sync-agents and /sterling:update refuse to act on it until it is fixed (TUI System tab).");
    assert.doesNotMatch(lines[0], /HOBBY|WORK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('H1 reads an unreadable config as UNKNOWN, never the hobby default', () => {
  const dir = project('{ not json');
  try {
    const lines = modeLines(context(dir));
    assert.equal(lines.length, 1);
    assert.equal(lines[0], 'Project mode: UNKNOWN — the project config could not be read, so config.mode could not be determined. This is NOT the hobby default: repair the config.');
    assert.doesNotMatch(lines[0], /HOBBY/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the project-mode line sits right after the TDD posture line', () => {
  const dir = project({ ...BASE_CONFIG, mode: 'work' });
  try {
    const ctx = context(dir);
    const tdd = ctx.indexOf('TDD posture:');
    const mode = ctx.indexOf('Project mode:');
    assert.ok(tdd !== -1 && mode > tdd, 'the mode line follows the TDD posture line');
    assert.equal(ctx.slice(tdd, mode).split('\n\n').length, 2, 'nothing sits between the two lines');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('H1: no handoff key and a git failure reads UNKNOWN with the git error, never OFF', () => {
  const dir = project({ ...BASE_CONFIG, mode: 'work' });
  const git = (args) => assert.equal(spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' }).status, 0, `git ${args.join(' ')}`);
  try {
    git(['init', '-q']);
    mkdirSync(join(dir, '.opencode', 'agents'), { recursive: true });
    writeFileSync(join(dir, '.opencode', 'agents', 'scout.md'), 'portable\n');
    git(['add', '.opencode/agents/scout.md']);
    git(['commit', '-qm', 'portable']);
    writeFileSync(join(dir, '.git', 'index'), 'not an index');
    const lines = handoffLines(context(dir));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^Handoff files: UNKNOWN — config\.handoff\.enabled is not set and git could not say whether handoff files are committed \(git ls-files exited 128: [^)]+\)\. This is NOT the off default: /);
    assert.doesNotMatch(lines[0], /Handoff files: (ON|OFF)\b/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
