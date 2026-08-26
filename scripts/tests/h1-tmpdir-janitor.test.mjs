// H1 SessionStart tmpdir JANITOR — adversarial, SPEC-ONLY regression pins for
// board 2d4cf493. RED NOW (the janitor does not exist yet), GREEN once H1's
// SessionStart janitor is built.
//
// SPEC UNDER TEST (handed by the launching agent; NOT inferred from any hook
// source — authored BLIND to scripts/hooks/h1-session-start.mjs and to
// scripts/hooks/h17-bash-write-sweep.mjs per the H4 read wall; no hook source
// was read):
//
//   H17 writes per-call transient files into os.tmpdir(), named exactly
//     sterling-enforce-<projectTag>-<runId>-call-<key>
//   with an optional suffix and ALWAYS ending .json — three shapes:
//     <base>.json  ·  <base>.dirty.json  ·  <base>.baseline.json
//   where
//     <key>        = 32 lowercase hex chars
//     <projectTag> = createHash('sha256').update(realpathSync(cwd))
//                      .digest('hex').slice(0,16)
//     <runId>      = an arbitrary non-empty string.
//
//   On SessionStart, H1 now sweeps os.tmpdir() and removes THIS project's
//   leaked per-call files that are STALE — defined as mtime older than a TTL of
//   1 HOUR. The sweep is scoped to THIS project's projectTag, bounded, and
//   best-effort: it never throws, never blocks, and never changes H1's exit
//   behavior.
//
// HARNESS: the project fixture + h1 spawn are modeled on the sibling
// scripts/tests/h1-session-residue.test.mjs (makeProject / runHook / hookInput
// / the h1() wrapper + env). That sibling proves a project with just
// .sterling/config.json + an empty store runs h1-session-start.mjs cleanly
// (exit 0), so no git repo is required for H1 to run. Nothing is imported from
// it (it exports nothing); the idiom is copied.
//
// COLLISION SAFETY: every fixture file embeds a UNIQUE per-test runId marker
// ('run-' + randomUUID()) so a real, concurrent session's tmpdir files can
// never collide with ours; and every tmpdir file + temp dir a test creates is
// removed in a `finally`, both this-project and other-project fixtures, so the
// suite never litters os.tmpdir(). Child-process stderr interpolated into an
// assertion message is flattened with oneLine() (anti-pattern ee89c3fd) so an
// expected-fail message cannot poison the TAP classifier.
//
// SUITE-LEVEL CONTROL RELATIONSHIP (which guard carries which verdict): AC1 is
// the shared liveness/deletion proof — it establishes the janitor runs and
// reclaims a stale in-scope file, and its own in-test control proves that
// reclamation is age-selective, not a blanket tmpdir wipe. AC2/AC3/AC4 are
// SCOPE controls: each pins one dimension the sweep must NOT cross (age,
// project, shape). Each of AC2/AC3/AC4 stays green under a NO-OP janitor
// (nothing is deleted, so everything survives) — that specific failure mode is
// owned by AC1, not by them; each of AC2/AC3/AC4 instead goes RED under ITS OWN
// named sabotage below, which is the property each exists to pin. AC5 pins the
// best-effort/liveness contract.
//
// RUN COMMAND (node toolchain adapter):
//   node --test scripts/tests/h1-tmpdir-janitor.test.mjs

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, realpathSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');

const HOUR_MS = 60 * 60 * 1000;
const STALE_MS = 2 * HOUR_MS; // mtime = now - 2h  → older than the 1h TTL
const RECENT_MS = 5 * 60 * 1000; // mtime = now - 5min → inside the 1h TTL

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

// anti-pattern ee89c3fd: raw multi-line child-process stderr interpolated into
// an assertion message poisons the TAP crash/assertion classifier. Flatten
// whitespace, never truncate.
function oneLine(s) {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function runHook(script, input, cwd, env = {}) {
  const r = spawnSync(process.execPath, [join(HOOKS, script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1', ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function hookInput(dir, over = {}) {
  return { session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', ...over };
}

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};

// A minimally valid project fixture: .sterling/config.json + an empty store, per
// the h1-session-residue sibling. projectTag is computed EXACTLY as the spec
// defines it — sha256(realpathSync(cwd)).slice(0,16) — from the same cwd H1
// receives, so the janitor must derive the identical tag to match our fixtures.
function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h1jan-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const projectTag = createHash('sha256').update(realpathSync(dir)).digest('hex').slice(0, 16);
  const cleanup = () => {
    try {
      store.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, projectTag, cleanup };
}

function h1(dir, source) {
  const r = runHook('h1-session-start.mjs', hookInput(dir, { hook_event_name: 'SessionStart', source }), dir, {
    NO_COLOR: '1',
    STERLING_NO_BANNER: '1',
    STERLING_PLUGIN_ROOT: root,
  });
  let out = null;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    // caller asserts on r.out when parseability matters
  }
  return { ...r, out };
}

// -------------------------- tmpdir fixture helpers --------------------------

// a 32 lowercase-hex key, exactly as the spec names it
function validKey() {
  return createHash('sha256').update(randomUUID()).digest('hex').slice(0, 32);
}

function base(tag, runId, key) {
  return `sterling-enforce-${tag}-${runId}-call-${key}`;
}

// the three per-call shapes for one <base>
function shapes(b) {
  return [`${b}.json`, `${b}.dirty.json`, `${b}.baseline.json`];
}

// write a tmpdir file, backdate its mtime by ageMs, and track it for cleanup
function makeTmp(created, name, ageMs) {
  const p = join(tmpdir(), name);
  writeFileSync(p, '{}');
  const when = new Date(Date.now() - ageMs);
  utimesSync(p, when, when); // backdate atime + mtime
  created.push(p);
  return p;
}

// remove every tmpdir artifact a test created — this-project AND other-project
function sweepCreated(created) {
  for (const p of created) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {}
  }
}

// --------------------------------- tests ---------------------------------

// AC1 (RECLAIM). Stale files of all three shapes, under THIS project's tag, with
// a valid 32-hex key, are gone after SessionStart. An in-test CONTROL, placed
// FIRST and asserted after the run, proves the deletion is age-selective (a
// recent in-scope file survives) rather than a blanket wipe of os.tmpdir() —
// so the green carries its evidence.
//
// SABOTAGE (turns this test RED): remove the janitor / make it a no-op — the
// three stale files remain and every reclaim assertion flips (exists true,
// expected false). (A "delete everything unconditionally" sabotage flips the
// CONTROL instead — the recent file would vanish — so this test also catches
// over-broad reclamation.)
test('AC1 (reclaim): stale per-call files of ALL THREE shapes for THIS project tag are reclaimed on SessionStart', () => {
  const { dir, projectTag, cleanup } = makeProject();
  const created = [];
  try {
    const runId = 'run-' + randomUUID();

    // CONTROL (opposite reason, evaluated first): a RECENT in-scope file must
    // survive — its survival proves any absence below is age-selective, not a
    // blanket tmpdir wipe. Passes now (nothing runs) and under the real impl.
    const recent = makeTmp(created, `${base(projectTag, runId, validKey())}.json`, RECENT_MS);

    const stale = shapes(base(projectTag, runId, validKey())).map((n) => makeTmp(created, n, STALE_MS));
    for (const f of stale) assert.equal(existsSync(f), true, `PRECONDITION: stale fixture written: ${f}`);

    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, oneLine(r.stderr));

    assert.equal(existsSync(recent), true, 'CONTROL: a recent in-scope file survives — reclamation is age-selective, not a blanket tmpdir wipe');
    for (const f of stale) {
      assert.equal(existsSync(f), false, `stale per-call file (all three shapes) must be reclaimed: ${f}`);
    }
  } finally {
    sweepCreated(created);
    cleanup();
  }
});

// AC2 (TTL CONTROL). A RECENT (mtime = now - 5min) correctly-named per-call file
// for this project SURVIVES.
//
// SABOTAGE (turns this test RED): drop the TTL check — delete regardless of age.
// That would also delete a concurrent session's in-flight files; here the recent
// file vanishes and the survival assertion flips. (Stays green under a no-op
// janitor — that failure mode is owned by AC1.)
test('AC2 (TTL control): a RECENT correctly-named per-call file for this project SURVIVES the sweep', () => {
  const { dir, projectTag, cleanup } = makeProject();
  const created = [];
  try {
    const runId = 'run-' + randomUUID();
    const recent = makeTmp(created, `${base(projectTag, runId, validKey())}.json`, RECENT_MS);

    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, oneLine(r.stderr));

    assert.equal(existsSync(recent), true, 'a per-call file younger than the 1h TTL (now-5min) must survive — it may belong to a live concurrent session');
  } finally {
    sweepCreated(created);
    cleanup();
  }
});

// AC3 (PROJECT-SCOPE CONTROL). A STALE, correctly-shaped file under a DIFFERENT
// projectTag SURVIVES.
//
// SABOTAGE (turns this test RED): widen the sweep to ignore projectTag — the
// other project's stale file gets swept and the survival assertion flips. (Stays
// green under a no-op janitor — owned by AC1.)
test('AC3 (project-scope control): a STALE correctly-shaped file under a DIFFERENT projectTag SURVIVES', () => {
  const { dir, projectTag, cleanup } = makeProject();
  const created = [];
  try {
    const runId = 'run-' + randomUUID();
    const otherTag = createHash('sha256').update('other-' + randomUUID()).digest('hex').slice(0, 16);
    assert.notEqual(otherTag, projectTag, 'PRECONDITION: the other project tag genuinely differs from this one');

    const otherFile = makeTmp(created, `${base(otherTag, runId, validKey())}.json`, STALE_MS);

    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, oneLine(r.stderr));

    assert.equal(existsSync(otherFile), true, "another project's stale per-call file must NOT be swept — the janitor is scoped to THIS project's tag");
  } finally {
    sweepCreated(created);
    cleanup();
  }
});

// AC4 (SHAPE CONTROL). STALE near-miss files that are NOT the per-call shape
// SURVIVE — all under THIS tag and all stale, so only shape mismatch saves them:
//   (a) no `-call-` segment
//   (b) a key that is not 32 hex — too short (16 hex)
//   (c) a key that is not 32 hex — 32 chars but non-hex
//   (d) a name not ending `.json`
//
// SABOTAGE (turns this test RED): an over-broad glob (e.g. prefix-only match on
// `sterling-enforce-<projectTag>`) — every near-miss shares that prefix, so all
// four get swept and every survival assertion flips. (Stays green under a no-op
// janitor — owned by AC1.)
test('AC4 (shape control): STALE near-miss files that are not the per-call shape SURVIVE', () => {
  const { dir, projectTag, cleanup } = makeProject();
  const created = [];
  try {
    const runId = 'run-' + randomUUID();

    const noCall = makeTmp(created, `sterling-enforce-${projectTag}-${runId}-nocall-${validKey()}.json`, STALE_MS);
    const shortKey = makeTmp(created, `sterling-enforce-${projectTag}-${runId}-call-${'a'.repeat(16)}.json`, STALE_MS);
    const nonHexKey = makeTmp(created, `sterling-enforce-${projectTag}-${runId}-call-${'g'.repeat(32)}.json`, STALE_MS);
    const notJson = makeTmp(created, `${base(projectTag, runId, validKey())}.log`, STALE_MS);

    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, oneLine(r.stderr));

    assert.equal(existsSync(noCall), true, 'a name without the -call- segment is not the per-call shape and must survive');
    assert.equal(existsSync(shortKey), true, 'a key that is not 32 hex (16 chars) is not the per-call shape and must survive');
    assert.equal(existsSync(nonHexKey), true, 'a 32-char key that is not hex (gg…g) is not the per-call shape and must survive');
    assert.equal(existsSync(notJson), true, 'a name not ending .json is not the per-call shape and must survive');
  } finally {
    sweepCreated(created);
    cleanup();
  }
});

// AC5 (LIVENESS / best-effort). With the janitor present and stale files to
// sweep, H1 still exits 0 AND still emits its normal parseable-JSON stdout — the
// janitor never blocks, never throws, and never disturbs H1's stdout contract.
//
// SABOTAGE (turns this test RED): make the janitor write its sweep summary to
// stdout (a stray console.log), corrupting H1's JSON-only stdout so r.out no
// longer parses; OR drop the best-effort guard so a sweep error propagates and
// changes H1's exit code. Either flips an assertion here.
test('AC5 (liveness): H1 still exits 0 and emits parseable JSON with the janitor present and stale files to sweep', () => {
  const { dir, projectTag, cleanup } = makeProject();
  const created = [];
  try {
    const runId = 'run-' + randomUUID();
    makeTmp(created, `${base(projectTag, runId, validKey())}.json`, STALE_MS);
    makeTmp(created, `${base(projectTag, runId, validKey())}.dirty.json`, STALE_MS);

    const r = h1(dir, 'startup');
    assert.equal(r.code, 0, `H1 must exit 0 with the janitor active — stderr: ${oneLine(r.stderr)}`);
    assert.ok(r.out, `H1's stdout must remain parseable JSON — the janitor must not write to stdout. stdout: ${oneLine(r.stdout)}`);
  } finally {
    sweepCreated(created);
    cleanup();
  }
});
