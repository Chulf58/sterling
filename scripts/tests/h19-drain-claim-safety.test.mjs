// H19 DRAIN CLAIM SAFETY — spec-only pin for three SHIPPED-BUT-UNPINNED S2a
// drain mechanisms (reviewer's coverage note: "a regression in them fails
// silently and in exactly the loss-shaped direction they were written to
// prevent"). Campaign S2a. Companion to (never edits) the FROZEN
// scripts/tests/h19-drain-reresolve.test.mjs.
//
// GOVERNING SPEC (read directly, never inferred from implementation):
//   - decision db3392db-4118-474c-a2f8-e29ccea50eff (slug
//     delivery-lifecycle-and-drain-reresolve-design, v4) — PART 2 (atomic
//     claim: rename pending->claimed-batch inside a REQUIRED lock, producers'
//     proceed-unlocked degrade NOT inherited by the drain; leftover claimed
//     batches re-claimed first by rename; per-entry contained fallback) and
//     the v2 recipe amendment (shape-VALIDATED before iteration; a v1 or
//     malformed recipe takes the legacy payload+banner arm).
//   - decision cdb50670-ca4d-4c40-9c25-f848191b981b (slug
//     pending-queue-cooperating-writer-lock) — the ONLY record that states the
//     lock's on-disk shape: "withFileLock(target): an mkdirSync(<target>.lock)
//     mutex". Read BEFORE this file's AC-LOCK fixture was written, specifically
//     to avoid inventing a lock path (H4 forbids reading lib/delivery.mjs
//     itself to learn it — see H4 COMPLIANCE below).
//
// H4 COMPLIANCE: scripts/hooks/lib/delivery.mjs and scripts/hooks/
// h19-delivery-drain.mjs were NOT read to author this file (nor were they
// grep'd in content mode — attempted once for the lock-path search, H4 denied
// it outright, confirming the wall holds even for a path-scoped query). Every
// fixture below is built from (a) the two governing decisions above, read via
// knowledge_get, (b) scripts/tests/h19-drain-reresolve.test.mjs and
// scripts/tests/h19-delivery.test.mjs, read for HARNESS CONVENTION and PROVEN
// fixture shapes only (makeProject, runHook/drain, hand-written pending.json
// entries, the v2 rerender recipe field set proven by that file's own AC9),
// and (c) the dispatching brief's own disclosed filename shapes (claimed-*.json,
// corrupt-*.json — prefix-matched, never assumed exact) and the "UNVERIFIED AT
// DRAIN" banner text (reused verbatim from the frozen sibling's AC6/AC10,
// never re-derived).
//
// DISCLOSED ASSUMPTION (AC-LOCK, load-bearing — flag prominently to the
// conductor): decision cdb50670 names the lock shape (mkdirSync(<target>.lock))
// for the PRODUCERS' writer lock on the pending queue, and db3392db says the
// drain's atomic claim is "a REQUIRED lock (withRequiredFileLock)" guarding the
// SAME rename-of-pending.json critical section the producers' append also
// touches. This file infers <target> = the pending.json path itself (i.e. the
// held lock dir is pending.json's sibling `pending.json.lock`), because that is
// the ONLY target that makes the design's own stated goal ("a concurrent
// enqueue cannot be deleted with the drained batch") coherent — a drain lock on
// a DIFFERENT target could not serialize against a producer's append at all.
// This inference was never confirmed by reading lib/delivery.mjs (H4). If the
// real target differs, AC-LOCK's CASE arm will fail even against a correct
// implementation — that failure mode is called out explicitly so it reads as
// "wrong lock path assumption," never as "the feature is broken."
//
// RED-BEFORE-THE-FIX: unlike the frozen sibling (authored pre-build), this
// slice's three mechanisms are represented as ALREADY SHIPPED by the
// dispatching brief, with "a fixer concurrently applying final touches." Per
// test below: EXPECTED GREEN against the finished S2a drain; a transient red
// while the fixer's edit is mid-flight is disclosed, not a defect in the pin.
// SABOTAGE is stated per test: the one-line change that must reproduce a red
// once the feature is finished and stable.
//
// NO RED/GREEN OUTPUT IS CLAIMED FROM THIS AUTHOR: the test-writer holds no
// Bash. Run with: node --test scripts/tests/h19-drain-claim-safety.test.mjs

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-08-31T12:00:00.000Z';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

// ---------------------------------------------------------------------------
// Harness (idioms mirrored from h19-drain-reresolve.test.mjs / h19-delivery.test.mjs)
// ---------------------------------------------------------------------------

function runHook(script, input, cwd) {
  const r = spawnSync(process.execPath, [join(HOOKS, script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function drain(dir) {
  return runHook('h19-delivery-drain.mjs', { hook_event_name: 'UserPromptSubmit', cwd: dir }, dir);
}

function ctxOf(r) {
  if (!r.stdout) return '';
  try {
    return JSON.parse(r.stdout).hookSpecificOutput?.additionalContext ?? '';
  } catch {
    return r.stdout;
  }
}

function envelope(type, extra = {}) {
  return {
    id: randomUUID(),
    type,
    created_at: NOW,
    updated_at: NOW,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: [],
    ...extra,
  };
}

function article(slug, paths, extra = {}) {
  return {
    ...envelope('feature_article'),
    slug,
    title: slug,
    what_it_does: `${slug} does the ${slug} thing`,
    intended_behavior: `${slug} intends`,
    files: paths.map((p) => ({ path: p, role: 'owner' })),
    current_ac: [{ ac_id: 'AC1', text: `${slug} works`, verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [],
    live_test_refs: [],
    ...extra,
  };
}

function decisionRec(statement, paths, extra = {}) {
  return {
    ...envelope('decision'),
    title: statement.slice(0, 80),
    statement,
    alternatives_rejected: [],
    rationale: 'r',
    file_keys: paths,
    ...extra,
  };
}

function makeProject({ rung = 'prompt' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h19-claim-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ delivery: { injection_rung: rung } }));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

const deliveryDir = (dir) => join(dir, '.sterling', 'transient', 'delivery');
const pendingPath = (dir) => join(deliveryDir(dir), 'pending.json');
const pendingOf = (dir) => (existsSync(pendingPath(dir)) ? JSON.parse(readFileSync(pendingPath(dir), 'utf8')) : []);
const filesByPrefix = (dir, prefix) =>
  existsSync(deliveryDir(dir)) ? readdirSync(deliveryDir(dir)).filter((f) => f.startsWith(prefix)) : [];

const postRead = (dir, file, extra = {}) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Read',
  tool_input: { file_path: join(dir, file) },
  cwd: dir,
  ...extra,
});

// The ONLY lock-shape fact any consulted decision states (cdb50670):
// "withFileLock(target): an mkdirSync(<target>.lock) mutex". See the file
// header's DISCLOSED ASSUMPTION for why <target> = pendingPath here.
const pendingLockDir = (dir) => `${pendingPath(dir)}.lock`;

// ===========================================================================
// AC-LOCK — a held lock skips the claim entirely; the unlocked case still
// drains (control placed first, per the multi-cause-verdict rule: "pending.json
// intact + exit 0" is also what a CRASHED drain or an EMPTY queue would look
// like, so the control proves the pipeline genuinely works end-to-end absent
// the lock, and the CASE fixture always seeds a real, non-empty queue first).
// ===========================================================================

test('AC-LOCK (control): with the pending-queue lock NOT held, a real queued delivery drains and empties the queue', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('lockctl', ['src/a.mjs']));
    const enq = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(enq.code, 0, enq.stderr);
    assert.equal(pendingOf(dir).length, 1, 'fixture sanity: a real entry is queued');

    const d = drain(dir);
    assert.equal(d.code, 0, d.stderr);
    const ctx = ctxOf(d);
    assert.match(ctx, /lockctl does the lockctl thing/, 'the queued delivery is served');
    assert.equal(pendingOf(dir).length, 0, 'the queue is emptied — the baseline claim pipeline works absent contention');
  } finally {
    cleanup();
  }
});
// EXPECTED GREEN (unchanged baseline behavior; also pinned in
// h19-delivery.test.mjs, repeated here as this AC's own control arm).
// SABOTAGE: none needed as a distinct arm — this is the floor the CASE below is
// judged against; a sabotage that breaks this would show up as this control
// going red, at which point the CASE arm's silence would be uninterpretable.

test('AC-LOCK (case): with the pending-queue lock HELD externally, drain leaves pending.json byte-identical, performs no claim, and exits 0', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('lockcase', ['src/a.mjs']));
    const enq = runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs'), dir);
    assert.equal(enq.code, 0, enq.stderr);
    assert.equal(pendingOf(dir).length, 1, 'fixture sanity: a real entry is queued before the lock is held');
    const before = readFileSync(pendingPath(dir), 'utf8');

    const lockDir = pendingLockDir(dir);
    mkdirSync(lockDir, { recursive: true }); // held for the rest of this test, never released

    const d = drain(dir);
    assert.equal(d.code, 0, d.stderr, 'a contended drain must be disclosed loudly, never denied/crashed');

    const after = existsSync(pendingPath(dir)) ? readFileSync(pendingPath(dir), 'utf8') : null;
    assert.equal(after, before, 'pending.json is byte-identical — no entries lost, no partial claim');
    assert.equal(filesByPrefix(dir, 'claimed-').length, 0, 'no claim (rename to claimed-*.json) was performed while the lock was held');
    assert.match(`${d.stdout}\n${d.stderr}`, /lock/i, 'the skip is disclosed in words, not silent (P5) — loose match, no exact wording is settled by any record');
  } finally {
    cleanup();
  }
});
// EXPECTED GREEN against the finished S2a drain (decision db3392db, "an
// unlocked drain skips the turn with a stderr note, never deletes unlocked").
// SABOTAGE: make the drain proceed with the claim regardless of lock
// contention (inherit the PRODUCERS' proceed-unlocked-on-deadline degrade
// instead of the drain's REQUIRED-lock semantics) — the byte-identical
// assertion goes red (pending.json is emptied/renamed) while the control above
// stays green, proving the CASE assertion is genuinely about the lock, not
// about the pipeline being broken.

// ===========================================================================
// AC-LEFTOVER — a crashed-prior-drain claimed-*.json is re-served first, and
// removed; a co-present pending.json is also drained; control is the
// pending-only baseline (the "opposite reason" pass: proves this fixture's
// pending.json alone still drains normally, so the case's leftover-first
// ordering isn't an artifact of a broken baseline).
// ===========================================================================

test('AC-LEFTOVER (control): with NO leftover claimed-*.json present, a plain pending.json still drains and empties normally', () => {
  const { dir, cleanup } = makeProject();
  try {
    const pDir = deliveryDir(dir);
    mkdirSync(pDir, { recursive: true });
    writeFileSync(pendingPath(dir), JSON.stringify([{ kind: 'delivery', payload: 'LEFTOVER_CTL_PENDING_SENTINEL only entry' }]));

    const d = drain(dir);
    assert.equal(d.code, 0, d.stderr);
    const ctx = ctxOf(d);
    assert.match(ctx, /LEFTOVER_CTL_PENDING_SENTINEL/, 'the sole pending entry serves');
    assert.equal(existsSync(pendingPath(dir)), false, 'pending.json is gone after a normal drain');
  } finally {
    cleanup();
  }
});
// EXPECTED GREEN (baseline single-file drain, unaffected by the leftover
// mechanism). SABOTAGE: none as a distinct arm — floor for the case below.

test('AC-LEFTOVER (case): a hand-written leftover claimed-*.json is served BEFORE a co-present pending.json, then both source files are gone', () => {
  const { dir, cleanup } = makeProject();
  try {
    const pDir = deliveryDir(dir);
    mkdirSync(pDir, { recursive: true });
    // A crashed prior drain's shape: pending.json was already renamed to a
    // claimed batch (valid entries array) but never finished flushing.
    writeFileSync(
      join(pDir, 'claimed-leftover-test.json'),
      JSON.stringify([{ kind: 'delivery', payload: 'LEFTOVER_CLAIMED_SENTINEL from a crashed prior drain' }])
    );
    // A fresh pending.json, queued normally since the crash.
    writeFileSync(pendingPath(dir), JSON.stringify([{ kind: 'delivery', payload: 'LEFTOVER_FRESH_PENDING_SENTINEL queued since the crash' }]));

    const d = drain(dir);
    assert.equal(d.code, 0, d.stderr);
    const ctx = ctxOf(d);

    const iClaimed = ctx.indexOf('LEFTOVER_CLAIMED_SENTINEL');
    const iPending = ctx.indexOf('LEFTOVER_FRESH_PENDING_SENTINEL');
    assert.ok(iClaimed >= 0, 'the leftover claimed batch is served, not silently dropped (the loss-shape this AC exists to prevent)');
    assert.ok(iPending >= 0, 'the co-present fresh pending.json is ALSO served — the leftover does not suppress it');
    assert.ok(iClaimed < iPending, 'the leftover claimed batch is served FIRST (re-claimed before the fresh pending.json claim)');

    assert.equal(filesByPrefix(dir, 'claimed-').length, 0, 'the leftover claimed file is gone once its output has flushed');
    assert.equal(existsSync(pendingPath(dir)), false, 'pending.json is also gone — both sources were drained in this one pass');
  } finally {
    cleanup();
  }
});
// EXPECTED GREEN against the finished S2a drain (db3392db: "leftover claimed
// batches re-claimed first by rename").
// SABOTAGE: skip/ignore any pre-existing claimed-*.json entirely (treat it as
// opaque residue never read) — the `iClaimed >= 0` assertion goes red (the
// leftover content never appears at all) while the control above stays green,
// proving this pin is genuinely about leftover re-service, not about the
// pending-only baseline.

// ===========================================================================
// AC-CORRUPT-PARK — a non-array pending.json is parked (never destroyed), the
// drain still exits 0 and discloses, and the original bytes are recoverable.
// Control: a WELL-FORMED array pending.json must NOT be parked at all.
// ===========================================================================

test('AC-CORRUPT-PARK (control): a well-formed pending.json (a real array) is never parked as corrupt', () => {
  const { dir, cleanup } = makeProject();
  try {
    const pDir = deliveryDir(dir);
    mkdirSync(pDir, { recursive: true });
    writeFileSync(pendingPath(dir), JSON.stringify([{ kind: 'delivery', payload: 'CORRUPT_CTL_WELLFORMED_SENTINEL' }]));

    const d = drain(dir);
    assert.equal(d.code, 0, d.stderr);
    const ctx = ctxOf(d);
    assert.match(ctx, /CORRUPT_CTL_WELLFORMED_SENTINEL/, 'the well-formed entry serves normally');
    assert.equal(filesByPrefix(dir, 'corrupt-').length, 0, 'a genuinely valid array must never be parked as corrupt');
  } finally {
    cleanup();
  }
});
// EXPECTED GREEN. SABOTAGE: none as a distinct arm — floor for the case below
// (a broken implementation that ALWAYS parks would show up here first).

test('AC-CORRUPT-PARK (case): pending.json holding valid JSON that is NOT an array is parked, recoverable byte-for-byte, disclosed, and the drain still exits 0', () => {
  const { dir, cleanup } = makeProject();
  try {
    const pDir = deliveryDir(dir);
    mkdirSync(pDir, { recursive: true });
    const original = JSON.stringify({ a: 1 });
    writeFileSync(pendingPath(dir), original);

    const d = drain(dir);
    assert.equal(d.code, 0, d.stderr, 'a non-array pending.json must never block or crash the prompt');
    const ctx = ctxOf(d);
    assert.match(ctx, /unverified|corrupt/i, 'the drain discloses the corrupt-shaped queue rather than staying silent');

    const parked = filesByPrefix(dir, 'corrupt-');
    assert.equal(parked.length, 1, `expected exactly one parked corrupt-*.json, found ${parked.length}: ${JSON.stringify(parked)}`);
    const parkedContent = readFileSync(join(deliveryDir(dir), parked[0]), 'utf8');
    assert.equal(parkedContent, original, 'the ORIGINAL bytes are recoverable byte-for-byte from the parked file — never rewritten, never destroyed');
    assert.equal(existsSync(pendingPath(dir)), false, 'pending.json itself is gone — it was renamed to the parked file, not left behind AND parked');
  } finally {
    cleanup();
  }
});
// EXPECTED GREEN against the finished S2a drain.
// SABOTAGE: on a non-array (but valid-JSON) pending.json, fall back to the
// PRE-S2a behavior of rmSync'ing the whole queue (decision cdb50670's own
// rationale names this exact prior failure mode: "drainPending's JSON.parse
// failure rmSyncs the WHOLE queue") — the `parked.length === 1` assertion goes
// red (nothing was parked) AND the byte-recovery assertion has nothing to read,
// catching precisely the silent-destruction direction this AC exists to bar.

// ===========================================================================
// AC-MALFORMED-RECIPE — a v2 rerender recipe with decision_ids as the STRING
// "abc" takes the payload+banner fallback arm, with no per-character lookup
// artifact; control is the same entry with a valid decision_ids array, which
// must show the LIVE (re-resolved) record content instead of the stale cache.
// ===========================================================================

// Distinct sentinels so "which arm actually ran" is unambiguous: the CACHED
// payload text is deliberately stale/different from the record's LIVE
// statement, mirroring the frozen sibling's AC3 staleness technique.
function malformedFixture(dir, store, decisionIdsField) {
  const rec = store.create(decisionRec('MALFORMED_LIVE_SENTINEL the current, re-resolvable statement', []));
  const pDir = deliveryDir(dir);
  mkdirSync(pDir, { recursive: true });
  writeFileSync(
    pendingPath(dir),
    JSON.stringify([
      {
        kind: 'delivery',
        payload: `STERLING KNOWLEDGE DELIVERY — owning knowledge for 'src/a.mjs'\nDECISIONS for this path (1)\n  → MALFORMED_STALE_CACHED_SENTINEL (knowledge_get ${rec.id})\n`,
        recipe: {
          version: 2,
          mode: 'rerender',
          rel: 'src/a.mjs',
          unowned: true,
          char_cap: 8192,
          hazard_ids: [],
          owner_ids: [],
          decision_ids: decisionIdsField,
          tails: { hazards: 0, decisions: 0 },
          trailing_blocks: [],
        },
      },
    ])
  );
  return rec;
}

test('AC-MALFORMED-RECIPE (control): decision_ids as a VALID array takes the rerender arm — the LIVE record content is shown, not the stale cache', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const rec = store.create(decisionRec('MALFORMED_LIVE_SENTINEL the current, re-resolvable statement', []));
    const pDir = deliveryDir(dir);
    mkdirSync(pDir, { recursive: true });
    writeFileSync(
      pendingPath(dir),
      JSON.stringify([
        {
          kind: 'delivery',
          payload: `STERLING KNOWLEDGE DELIVERY — owning knowledge for 'src/a.mjs'\nDECISIONS for this path (1)\n  → MALFORMED_STALE_CACHED_SENTINEL (knowledge_get ${rec.id})\n`,
          recipe: {
            version: 2,
            mode: 'rerender',
            rel: 'src/a.mjs',
            unowned: true,
            char_cap: 8192,
            hazard_ids: [],
            owner_ids: [],
            decision_ids: [rec.id],
            tails: { hazards: 0, decisions: 0 },
            trailing_blocks: [],
          },
        },
      ])
    );

    const d = drain(dir);
    assert.equal(d.code, 0, d.stderr);
    const ctx = ctxOf(d);
    assert.match(ctx, /MALFORMED_LIVE_SENTINEL/, 'a valid decision_ids array re-resolves and shows the LIVE record content');
    assert.doesNotMatch(ctx, /UNVERIFIED AT DRAIN/, 'a healthy rerender never carries the fallback banner');
  } finally {
    cleanup();
  }
});
// EXPECTED GREEN. SABOTAGE: none as a distinct arm — floor for the case below
// (a broken implementation that ALWAYS takes the fallback banner arm, valid
// recipe or not, would show up here first: MALFORMED_LIVE_SENTINEL would never
// appear and the banner would appear where it must not).

test('AC-MALFORMED-RECIPE (case): decision_ids as the STRING "abc" takes the payload+banner fallback arm, with no per-character lookup artifact', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    malformedFixture(dir, store, 'abc');

    const d = drain(dir);
    assert.equal(d.code, 0, d.stderr);
    const ctx = ctxOf(d);

    assert.match(ctx, /MALFORMED_STALE_CACHED_SENTINEL/, 'the fallback arm replays the CACHED payload verbatim');
    assert.match(ctx, /UNVERIFIED AT DRAIN/, 'and carries the fallback banner');
    assert.doesNotMatch(ctx, /MALFORMED_LIVE_SENTINEL/, 'the malformed recipe must never trigger a live re-resolve');

    // No per-character lookup artifact: a naive `for (const id of "abc")`
    // iteration (strings are iterable in JS) would attempt to resolve 'a',
    // 'b', 'c' as record ids and, per every other disclosure format proven in
    // this suite, would render them as `(knowledge_get a)` or similar — this
    // never appears if the recipe is rejected wholesale BEFORE iteration.
    assert.doesNotMatch(ctx, /knowledge_get [abc]\b/, 'no single-character id was ever looked up');
    assert.doesNotMatch(ctx, /missing|no longer resolves|not found|unresolvable|dangling/i, 'no per-id missing/dangling disclosure fired at all — the recipe was rejected wholesale, never iterated');
  } finally {
    cleanup();
  }
});
// EXPECTED GREEN against the finished S2a drain (db3392db: "recipe fields are
// shape-VALIDATED before iteration ... a v1 or malformed recipe takes the
// legacy payload+banner arm").
// SABOTAGE: validate every OTHER v2 field but skip validating decision_ids's
// type, then iterate it with `for (const id of recipe.decision_ids)` — with
// the fixture's string "abc" this silently iterates its characters; the
// `doesNotMatch(/knowledge_get [abc]\b/)` assertion goes red the moment any of
// 'a'/'b'/'c' is rendered as a looked-up id, while the control above stays
// green (a real UUID array is unaffected by a for-of iteration bug).

// ===========================================================================
// AC-FRACTIONAL-CAP — char_cap: 0.5 must take the banner arm, never an
// unbounded render of a large live record. Control: a valid integer cap
// renders substantial live content (proving the banner-arm case isn't just
// "the drain always shows the banner").
// ===========================================================================

const CAP_TOKEN = 'CAPBODYTOKEN';
function capFixture(dir, store, charCap) {
  const bigStatement = `${CAP_TOKEN} `.repeat(1000); // > 10KB, well over any sane render
  const rec = store.create(decisionRec(bigStatement, []));
  const pDir = deliveryDir(dir);
  mkdirSync(pDir, { recursive: true });
  writeFileSync(
    pendingPath(dir),
    JSON.stringify([
      {
        kind: 'delivery',
        payload: 'FRACTIONAL_CACHED_PAYLOAD_SENTINEL (unrelated to the CAPBODYTOKEN record body)',
        recipe: {
          version: 2,
          mode: 'rerender',
          rel: 'src/a.mjs',
          unowned: true,
          char_cap: charCap,
          hazard_ids: [],
          owner_ids: [],
          decision_ids: [rec.id],
          tails: { hazards: 0, decisions: 0 },
          trailing_blocks: [],
        },
      },
    ])
  );
  return rec;
}

test('AC-FRACTIONAL-CAP (control): a valid integer char_cap renders substantial LIVE content, not the banner', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    capFixture(dir, store, 8192);

    const d = drain(dir);
    assert.equal(d.code, 0, d.stderr);
    const ctx = ctxOf(d);
    // REPAIRED 2026-08-31 (test-repair register): decision pointers render as
    // CLIPPED two-line pointers by design (decision 6a3b1a46), so a 10KB
    // statement yields ~9 sentinel occurrences under ANY cap — the original
    // >100 floor encoded a full-body rendering this surface never had. The
    // control's property survives: LIVE render arm (sentinel present), never
    // the banner arm.
    const count = ctx.split(CAP_TOKEN).length - 1;
    assert.ok(count >= 1, `a valid 8192-char cap must render live content — found ${count} occurrences of the sentinel token`);
    assert.doesNotMatch(ctx, /UNVERIFIED AT DRAIN/, 'a valid cap must not take the fallback banner arm');
  } finally {
    cleanup();
  }
});
// EXPECTED GREEN. SABOTAGE: none as a distinct arm — floor for the case below
// (a broken implementation that ALWAYS bans the record and always shows the
// banner, valid cap or not, would show up here first).

test('AC-FRACTIONAL-CAP (case): char_cap: 0.5 takes the banner arm — the >10KB live record is never rendered unbounded', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    capFixture(dir, store, 0.5);

    const d = drain(dir);
    assert.equal(d.code, 0, d.stderr);
    const ctx = ctxOf(d);
    const count = ctx.split(CAP_TOKEN).length - 1;
    assert.ok(count < 5, `a fractional char_cap must never allow an unbounded render — found ${count} occurrences of the live record's sentinel token`);
    assert.match(ctx, /FRACTIONAL_CACHED_PAYLOAD_SENTINEL/, 'the fallback arm replays the cached payload');
    assert.match(ctx, /UNVERIFIED AT DRAIN/, 'and carries the fallback banner');
  } finally {
    cleanup();
  }
});
// EXPECTED GREEN against the finished S2a drain (db3392db: recipe fields are
// shape-validated before iteration; "numeric caps must be non-negative safe
// integers" per the dispatching brief).
// SABOTAGE: validate char_cap only for `typeof === 'number'` (not
// Number.isSafeInteger and non-negative) and pass 0.5 straight into a
// substring/slice bound — depending on the renderer's exact slice semantics
// this either renders far more than 5 occurrences of CAPBODYTOKEN (a
// near-zero or fractional slice bound coerced oddly) or throws mid-render; the
// `count < 5` assertion (or the `d.code === 0` assertion, if it crashes
// instead) goes red, while the control above — an integer cap untouched by
// this validation gap — stays green.
