// plan-lock.mjs --bind-pending: the no-argument bind OpenCode's Plan agent runs.
// Why it exists: an OpenCode shell rule ending in `*` cannot be made safe by the
// script, because the shell runs $(...), redirects and separators before argv
// reaches it (anti-pattern an-opencode-bash-permission-with-a-trailing-cannot-be-made-s).
// So the agent may run only exact literals, and the script picks the plan file
// itself. Pinned here, against the source and the bin bundle: it binds the newest
// valid plan exactly as --plan does, and it refuses (exit 2, nothing written)
// rather than fall back to some other file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, symlinkSync, utimesSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLIS = { source: join(root, 'scripts', 'plan-lock.mjs'), bundle: join(root, 'bin', 'plan-lock.mjs') };

function project({ plans = true } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'plan-lock-bind-')));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  if (plans) mkdirSync(join(dir, '.sterling', 'plans'));
  writeFileSync(join(dir, '.sterling', 'config.json'), '{}\n');
  return dir;
}

/** Writes a plan with an explicit mtime (seconds ago), so "newest" never depends on write speed. */
function plan(dir, name, ageSeconds, body = `# ${name}\n\nsteps\n`) {
  const p = join(dir, '.sterling', 'plans', name);
  writeFileSync(p, body);
  const t = Date.now() / 1000 - ageSeconds;
  utimesSync(p, t, t);
  return p;
}

const lockOf = (dir) => join(dir, '.sterling', 'plan-lock.json');

for (const [which, cli] of Object.entries(CLIS)) {
  const runCli = (dir, args) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8', timeout: 30_000 });

  function assertRefused(dir, args, re) {
    const r = runCli(dir, args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, re, args.join(' '));
    assert.ok(!existsSync(lockOf(dir)), `${args.join(' ')} wrote no lock`);
  }

  test(`${which}: --bind-pending binds the newest slug-named plan, exactly as --plan would, and names the file`, () => {
    const dir = project();
    try {
      plan(dir, 'older-plan.md', 300);
      const newest = plan(dir, 'new-plan-2.md', 10, '# The New Plan\n\nsteps\n');
      // a newer file that is not *.md is not a plan candidate at all
      writeFileSync(join(dir, '.sterling', 'plans', 'notes.txt'), 'scratch\n');
      const r = runCli(dir, ['--bind-pending']);
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.bound_file, newest);
      assert.equal(out.replaced, false);
      const lock = JSON.parse(readFileSync(lockOf(dir), 'utf8'));
      assert.equal(lock.plan_path, newest);
      assert.equal(lock.title, 'The New Plan');
      assert.equal(lock.source, 'manual');
      assert.equal(lock.approved_sha256, lock.file_sha256_at_approval);
      assert.equal(lock.approved_session_id, null);
      assert.equal(lock.approved_branch, null);
      assert.equal(lock.approved_head, null);
      // the same file bound through --plan yields the same lock, timestamp aside
      const viaPlan = project();
      const samePath = plan(viaPlan, 'new-plan-2.md', 10, '# The New Plan\n\nsteps\n');
      assert.equal(runCli(viaPlan, ['--plan', samePath]).status, 0);
      const strip = (l) => ({ ...l, plan_path: null, approved_at: null });
      assert.deepEqual(strip(JSON.parse(readFileSync(lockOf(viaPlan), 'utf8'))), strip(lock));
      rmSync(viaPlan, { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${which}: --bind-pending refuses a missing or empty plans directory`, () => {
    const missing = project({ plans: false });
    const empty = project();
    try {
      assertRefused(missing, ['--bind-pending'], /no plans directory at/);
      writeFileSync(join(empty, '.sterling', 'plans', 'notes.txt'), 'not a plan\n');
      assertRefused(empty, ['--bind-pending'], /no \*\.md plan in/);
    } finally {
      rmSync(missing, { recursive: true, force: true });
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test(`${which}: --bind-pending refuses a newest plan whose name is not a slug, never falling back to an older one`, () => {
    for (const bad of ['My Plan.md', 'Plan.md', '-dash.md', '.hidden.md', 'a_b.md']) {
      const dir = project();
      try {
        plan(dir, 'good-plan.md', 300);
        plan(dir, bad, 10);
        assertRefused(dir, ['--bind-pending'], /is not named <slug>\.md/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test(`${which}: --bind-pending refuses two plans with the same newest modification time`, () => {
    const dir = project();
    try {
      plan(dir, 'one.md', 10);
      plan(dir, 'two.md', 10);
      assertRefused(dir, ['--bind-pending'], /same modification time/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${which}: --bind-pending refuses a symlink that leaves the plans directory, and a plans directory that leaves the project`, () => {
    const dir = project();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'plan-lock-outside-')));
    try {
      writeFileSync(join(outside, 'secret.md'), '# Not a plan\n');
      plan(dir, 'good-plan.md', 300);
      // a plan file inside the project but outside .sterling/plans/ is still outside
      writeFileSync(join(dir, 'README.md'), '# Readme\n');
      for (const target of [join(outside, 'secret.md'), join(dir, 'README.md')]) {
        const link = join(dir, '.sterling', 'plans', 'evil.md');
        rmSync(link, { force: true });
        symlinkSync(target, link);
        assertRefused(dir, ['--bind-pending'], /resolves to .*, outside/);
      }
      // a dangling link is refused, not skipped
      rmSync(join(dir, '.sterling', 'plans', 'evil.md'));
      symlinkSync(join(outside, 'gone.md'), join(dir, '.sterling', 'plans', 'evil.md'));
      assertRefused(dir, ['--bind-pending'], /could not be resolved/);

      const moved = project({ plans: false });
      mkdirSync(join(outside, 'plans'));
      writeFileSync(join(outside, 'plans', 'elsewhere.md'), '# Elsewhere\n');
      symlinkSync(join(outside, 'plans'), join(moved, '.sterling', 'plans'));
      assertRefused(moved, ['--bind-pending'], /outside the project/);
      rmSync(moved, { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test(`${which}: --bind-pending takes no argument but --force; anything else exits 2 and writes nothing`, () => {
    const dir = project();
    try {
      const p = plan(dir, 'good-plan.md', 10);
      const cases = [
        [['--bind-pending', 'x'], /unexpected argument "x"/],
        [['--bind-pending', p], /unexpected argument/],
        [['--bind-pending=x'], /--bind-pending takes no value/],
        [['--bind-pending', '--force=yes'], /--force takes no value/],
        [['--bind-pending', '--reason', 'x'], /--reason does not go with --bind-pending/],
        [['--bind-pending', '--evil'], /--evil does not go with --bind-pending/],
        [['--bind-pending', '--plan', p], /exactly one verb/],
        [['--bind-pending', '--show'], /exactly one verb/],
        [['--bind-pending', '--bind-pending'], /given more than once/],
      ];
      for (const [args, re] of cases) assertRefused(dir, args, re);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${which}: --bind-pending over an ExitPlanMode lock needs --force, as --plan does; a manual lock is replaced without it`, () => {
    const dir = project();
    try {
      const p = plan(dir, 'good-plan.md', 10);
      const approved = {
        schema_version: 1,
        plan_path: join(dir, 'approved.md'),
        title: 'Approved Plan',
        approved_at: '2026-09-06T09:00:00.000Z',
        approved_sha256: 'a'.repeat(64),
        file_sha256_at_approval: 'a'.repeat(64),
        approved_session_id: 's0',
        approved_branch: 'main',
        approved_head: 'deadbeef',
        source: 'exit_plan_mode',
      };
      writeFileSync(lockOf(dir), JSON.stringify(approved));
      const before = readFileSync(lockOf(dir), 'utf8');
      let r = runCli(dir, ['--bind-pending']);
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /ExitPlanMode APPROVAL \(Approved Plan\) — replacing it by hand requires --force/);
      assert.equal(readFileSync(lockOf(dir), 'utf8'), before, 'the approval lock is untouched');

      r = runCli(dir, ['--bind-pending', '--force']);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(JSON.parse(r.stdout).replaced, true);
      assert.equal(JSON.parse(readFileSync(lockOf(dir), 'utf8')).plan_path, p);
      const previous = JSON.parse(readFileSync(join(dir, '.sterling', 'transient', 'plan-lock-previous.json'), 'utf8'));
      assert.equal(previous.title, 'Approved Plan');

      // the lock is now manual: a newer plan rebinds without --force
      const next = plan(dir, 'next-plan.md', 1);
      r = runCli(dir, ['--bind-pending']);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(JSON.parse(r.stdout).bound_file, next);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
