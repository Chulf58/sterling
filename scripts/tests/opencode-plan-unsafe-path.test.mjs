// GitHub #85: sync-agents on an EXISTING project whose path is not shell-safe skips the
// OpenCode Plan agent with one loud line and exits 0, instead of refusing with exit 2
// (user-ruled 2026-10-12, decision existing-unsafe-path-project-skips-opencode-plan-agent-not-refuse).
// Init still refuses a NEW project there (init-shell-safe-path.test.mjs). The other
// refusals in the Sterling-full loop (tracked, no header, edited after write) stay refusals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setupOpenCode, formatOpenCodeRows } from '../lib/opencode-install.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OC = () => ({ installed: true, version: '2.0.23', major: 2 });
const PLAN_REL = '.opencode/agents/plan.md';
const CONDUCTOR_REL = '.opencode/agents/sterling/conductor.md';
const SCOUT_REL = '.opencode/agents/sterling/scout.md';

function git(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
}

// A fresh project; `spaced` puts a space in its path, so the plan agent's shell rules cannot match it.
function project(spaced) {
  const parent = mkdtempSync(join(tmpdir(), spaced ? 'oc plan-unsafe-' : 'oc-plan-safe-'));
  const dir = join(parent, 'p');
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  git(dir, ['init', '-q']);
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ mode: 'hobby' }));
  return { dir, parent };
}

const setup = (dir, home) => setupOpenCode({ projectDir: dir, pluginRoot: repoRoot, env: { HOME: home }, home, installed: false, probe: OC });
const rowOf = (r, item) => r.rows.find((x) => x.item === item);
const cleanup = (...dirs) => dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));

test('an unsafe project path: the plan row is skipped, never refused, plan.md is not written, the roster still is', () => {
  const home = mkdtempSync(join(tmpdir(), 'oc-home-'));
  const { dir, parent } = project(true);
  try {
    const r = setup(dir, home);
    const plan = rowOf(r, PLAN_REL);
    assert.equal(plan.status, 'skipped');
    assert.ok(!plan.refused);
    assert.ok(!plan.instruction);
    assert.ok(!existsSync(join(dir, PLAN_REL)));
    assert.ok(!r.rows.some((x) => x.refused), 'no row of the whole setup is a refusal');
    for (const rel of [CONDUCTOR_REL, SCOUT_REL]) {
      assert.equal(rowOf(r, rel)?.status, 'created', rel);
      assert.ok(existsSync(join(dir, rel)), rel);
    }
    const line = formatOpenCodeRows(r).find((l) => l.includes(PLAN_REL));
    assert.match(line, /^OpenCode skipped: \.opencode\/agents\/plan\.md — the Plan agent is not installed at this path/);
    assert.match(line, /rename the folder/);
    assert.ok(!line.includes('\n'), 'one line');
  } finally {
    cleanup(parent, home);
  }
});

test('a safe project path still installs plan.md (the skip covers only the unsafe path)', () => {
  const home = mkdtempSync(join(tmpdir(), 'oc-home-'));
  const { dir, parent } = project(false);
  try {
    assert.equal(rowOf(setup(dir, home), PLAN_REL).status, 'created');
    assert.ok(existsSync(join(dir, PLAN_REL)));
  } finally {
    cleanup(parent, home);
  }
});

test('at an unsafe path the other refusals still refuse: a roster agent edited after write, and one tracked by git', () => {
  const home = mkdtempSync(join(tmpdir(), 'oc-home-'));
  const { dir, parent } = project(true);
  try {
    setup(dir, home);
    const edited = `${readFileSync(join(dir, CONDUCTOR_REL), 'utf8')}\nmy edit\n`;
    writeFileSync(join(dir, CONDUCTOR_REL), edited);
    const row = rowOf(setup(dir, home), CONDUCTOR_REL);
    assert.equal(row.status, 'refused');
    assert.match(row.instruction, /was edited after Sterling wrote it/);
    assert.equal(readFileSync(join(dir, CONDUCTOR_REL), 'utf8'), edited);

    git(dir, ['add', '-f', SCOUT_REL]);
    git(dir, ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'scout']);
    const tracked = rowOf(setup(dir, home), SCOUT_REL);
    assert.equal(tracked.status, 'refused');
    assert.match(tracked.instruction, /git rm --cached/);
  } finally {
    cleanup(parent, home);
  }
});

// The integrity checks come before the skip: an existing plan.md that is tracked, foreign or
// edited refuses as it does at a safe path; only an untouched Sterling-owned one is skipped.
test('at an unsafe path a git-tracked plan.md refuses and is left byte-identical', () => {
  const home = mkdtempSync(join(tmpdir(), 'oc-home-'));
  const { dir, parent } = project(true);
  try {
    mkdirSync(join(dir, '.opencode', 'agents'), { recursive: true });
    const mine = '# my own plan agent\n';
    writeFileSync(join(dir, PLAN_REL), mine);
    git(dir, ['add', '-f', PLAN_REL]);
    git(dir, ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'plan']);
    const row = rowOf(setup(dir, home), PLAN_REL);
    assert.equal(row.status, 'refused');
    assert.match(row.instruction, /git rm --cached \.opencode\/agents\/plan\.md/);
    assert.equal(readFileSync(join(dir, PLAN_REL), 'utf8'), mine);
  } finally {
    cleanup(parent, home);
  }
});

test('at an unsafe path a foreign or edited plan.md refuses and is left byte-identical', () => {
  const home = mkdtempSync(join(tmpdir(), 'oc-home-'));
  const safe = project(false);
  const { dir, parent } = project(true);
  try {
    mkdirSync(join(dir, '.opencode', 'agents'), { recursive: true });
    const foreign = '# not written by Sterling\n';
    writeFileSync(join(dir, PLAN_REL), foreign);
    const foreignRow = rowOf(setup(dir, home), PLAN_REL);
    assert.equal(foreignRow.status, 'refused');
    assert.match(foreignRow.instruction, /carries no Sterling header/);
    assert.equal(readFileSync(join(dir, PLAN_REL), 'utf8'), foreign);

    // a Sterling-written file (rendered at a safe path), then edited, then placed at the unsafe path
    setup(safe.dir, home);
    const edited = `${readFileSync(join(safe.dir, PLAN_REL), 'utf8')}\nmy edit\n`;
    writeFileSync(join(dir, PLAN_REL), edited);
    const editedRow = rowOf(setup(dir, home), PLAN_REL);
    assert.equal(editedRow.status, 'refused');
    assert.match(editedRow.instruction, /was edited after Sterling wrote it/);
    assert.equal(readFileSync(join(dir, PLAN_REL), 'utf8'), edited);
  } finally {
    cleanup(parent, safe.parent, home);
  }
});

test('at an unsafe path an unmodified Sterling-owned plan.md is left untouched; the skip line says it was left in place', () => {
  const home = mkdtempSync(join(tmpdir(), 'oc-home-'));
  const safe = project(false);
  const { dir, parent } = project(true);
  try {
    setup(safe.dir, home);
    mkdirSync(join(dir, '.opencode', 'agents'), { recursive: true });
    const owned = readFileSync(join(safe.dir, PLAN_REL), 'utf8');
    writeFileSync(join(dir, PLAN_REL), owned);
    const r = setup(dir, home);
    const row = rowOf(r, PLAN_REL);
    assert.equal(row.status, 'skipped');
    assert.ok(!row.refused);
    assert.equal(readFileSync(join(dir, PLAN_REL), 'utf8'), owned, 'byte-identical');
    assert.match(row.detail, /the existing \.opencode\/agents\/plan\.md was left in place and is no longer updated/);
    assert.match(row.detail, /rename the folder .* to have it maintained again, or delete it/);
    assert.ok(!r.rows.some((x) => x.refused));
  } finally {
    cleanup(parent, safe.parent, home);
  }
});

// The real CLI: a fake `opencode` on PATH answers the version probe, the Claude side is probed absent.
function syncAgents(dir, home, binDir) {
  const r = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'sync-agents.mjs'), '--target', dir], {
    encoding: 'utf8',
    cwd: dir,
    timeout: 180_000,
    env: { ...process.env, HOME: home, PATH: `${binDir}${delimiter}${process.env.PATH}`, STERLING_CLAUDE_PROBE: 'absent', STERLING_OPENCODE_SETUP_DISABLE: '' },
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

test('sync-agents on an unsafe-path project exits 0 with the skip line; an edited roster agent there still exits 2', { skip: process.platform === 'win32' }, () => {
  const home = mkdtempSync(join(tmpdir(), 'oc-home-'));
  const binDir = mkdtempSync(join(tmpdir(), 'oc-bin-'));
  writeFileSync(join(binDir, 'opencode'), '#!/bin/sh\necho 2.0.23\n');
  chmodSync(join(binDir, 'opencode'), 0o755);
  const { dir, parent } = project(true);
  try {
    const ok = syncAgents(dir, home, binDir);
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /OpenCode skipped: \.opencode\/agents\/plan\.md — the Plan agent is not installed at this path/);
    assert.ok(!/REFUSED/.test(ok.out), ok.out);
    assert.ok(!existsSync(join(dir, PLAN_REL)));
    assert.ok(existsSync(join(dir, CONDUCTOR_REL)));

    writeFileSync(join(dir, CONDUCTOR_REL), `${readFileSync(join(dir, CONDUCTOR_REL), 'utf8')}\nmy edit\n`);
    const refused = syncAgents(dir, home, binDir);
    assert.equal(refused.code, 2, refused.out);
    assert.match(refused.out, /was edited after Sterling wrote it/);
  } finally {
    cleanup(parent, home, binDir);
  }
});
