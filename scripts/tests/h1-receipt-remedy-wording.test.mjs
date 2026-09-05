// H1 SessionStart — SURVIVING-REVIEW-RECEIPT REPORT: the remedy it prints must
// be the SANCTIONED one (spec-only, red-first).
// Objective dome-farmer-issues-2026-09-05, slice 1 (board 891284a9).
//
// IN ONE SENTENCE: when H1 reports review receipts that outlived their session,
// its additionalContext must NOT tell the conductor to "remove it by hand", and
// MUST name the sanctioned route `scripts/review-ledger.mjs discharge`.
//
// ---------------------------------------------------------------------------
// WHY THIS IS A DEFECT AND NOT A WORDING PREFERENCE
// ---------------------------------------------------------------------------
// Decision 57984926 (`review-ledger-v2-lifecycle-refuse-flip-and-external-
// review-design`, standing) makes DISCHARGE "a dedicated command
// (scripts/review-ledger.mjs discharge), explicit-only, NEVER automatic",
// requiring an entry selector plus a SHA-256 digest of the exact ledger bytes as
// a concurrency token, and it preserves the original evidence while setting
// status:'discharged' + a disposition record. A hand-edit of
// .sterling/review-ledger.json does NONE of that: it destroys the evidence the
// record promises to preserve, leaves no disposition, and races the atomic
// locked replace the command performs.
//
// It is also a route the machine DENIES. H15 seals `.sterling/` from the shell,
// so "remove it by hand" instructs the conductor to do the one thing the store
// guard exists to stop — the same shape decision 1434cd54 Ruling 2 records as
// its sharpest finding ("the sanctioned recovery route H17's own denial text
// prescribes ... is UNREACHABLE BY ITS OPERATOR"), and the same shape the
// consuming project's issues log reports on 2026-09-03 as an unreachable
// receipt discharge. A hook that prints a denied remedy manufactures a
// workaround: the operator either gives up or routes around the guard.
//
// The slice that fixes this also makes `scripts/review-ledger.mjs` a
// SANCTIONED_SCRIPTS entry so the printed route actually runs — pinned
// separately in scripts/tests/h15-active-root-provenance.test.mjs (PV-9a/PV-9b).
// The two pins are deliberately in different files: one is about what H1 SAYS,
// the other about whether H15 LETS IT HAPPEN, and a fix can land either half
// alone.
//
// ---------------------------------------------------------------------------
// Written BLIND to scripts/hooks/h1-session-start.mjs (H4 read wall; it was
// never opened by this author). Harness idioms (spawnSync + JSON stdin,
// makeH1Project / writeH1Ledger / h1() / additionalContext(), isoAgo) are
// COPIED, not imported, from scripts/tests/h22-receipt-expiry.test.mjs:446-494
// and scripts/tests/h1-session-residue.test.mjs:84-116. Those files are neither
// modified nor referenced at runtime; this file is standalone.
//
// LEDGER SHAPES: decision 57984926 ships a v2 entry envelope AND requires a
// compatibility adapter for v1 ("missing schema_version = legacy roster
// receipt; missing status = active; age falls back to `at`") — with v1 receipts
// explicitly NOT ageing out, "that persistence IS the pathology discharge
// exists for". So BOTH shapes are exercised: a wording fix applied only to the
// v2 reporting path would leave the v1 receipts — the ones actually stuck in
// consumers today — still printing the denied remedy.
//
// MUTATION DISCIPLINE (decision 23afbc83): every pin carries a SABOTAGE comment
// naming the one-line change that must turn it RED. None is executed here —
// this file's author holds no Bash by design, and no mutation result is claimed.
// ---------------------------------------------------------------------------

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const H1_HOOK = 'h1-session-start.mjs';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

const flat = (s) => String(s ?? '').replace(/\r?\n/g, ' | ');
// Date.now()-relative, never a hardcoded date, so age-bearing fixtures do not
// rot as the calendar moves.
const isoAgo = (msAgo) => new Date(Date.now() - msAgo).toISOString();

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};

function makeH1Project() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h1remedy-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  return { dir, store, cleanup };
}

function writeH1Ledger(dir, entries) {
  writeFileSync(join(dir, '.sterling', 'review-ledger.json'), JSON.stringify(entries));
}

function h1(dir, source = 'startup') {
  const r = spawnSync(process.execPath, [join(HOOKS, H1_HOOK)], {
    input: JSON.stringify({
      session_id: 's1',
      transcript_path: join(dir, 't', 's1.jsonl'),
      cwd: dir,
      permission_mode: 'default',
      hook_event_name: 'SessionStart',
      source,
    }),
    encoding: 'utf8',
    cwd: dir,
    timeout: 60_000,
    env: {
      ...process.env,
      STERLING_CURRENCY_DISABLE: '1',
      NO_COLOR: '1',
      STERLING_NO_BANNER: '1',
      STERLING_PLUGIN_ROOT: root,
    },
  });
  let out = null;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    // caller asserts
  }
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', out };
}

function additionalContext(res) {
  return (res.out && res.out.hookSpecificOutput ? res.out.hookSpecificOutput.additionalContext : '') ?? '';
}

// ---------------------------------------------------------------------------
// Fixture receipts. Both are FOREIGN-SESSION (session_id !== the 's1' H1 runs
// under) and ACTIVE — the class decision 57984926 calls unspendable-but-not-gone,
// i.e. exactly what H1's surviving-receipt report is for.
// ---------------------------------------------------------------------------

const FOREIGN_SESSION = 'foreign-session-xyz';

// v1 / legacy flat entry — no schema_version, no status; age falls back to `at`.
const legacyReceipt = () => ({
  agent_type: 'reviewer-correctness',
  files: ['src/a.mjs'],
  at: isoAgo(30 * 3_600_000),
  session_id: FOREIGN_SESSION,
  branch: 'sterling/some-other-slice',
  base_sha: 'd'.repeat(40),
});

// v2 envelope entry, per decision 57984926 (1).
const v2Receipt = () => ({
  schema_version: 2,
  entry_id: randomUUID(),
  kind: 'roster_receipt',
  status: 'active',
  started_at: isoAgo(30 * 3_600_000),
  finished_at: isoAgo(29 * 3_600_000),
  reviewer: { agent_type: 'reviewer-correctness', model: null, model_family: 'unknown', model_source: 'unknown' },
  identity: { session_id: FOREIGN_SESSION, branch: 'sterling/some-other-slice', base_sha: 'e'.repeat(40) },
  territory: { files: ['src/a.mjs'], source: 'review-territory', attribution: 'block' },
  content_evidence: { status: 'unavailable', blobs: {}, absent_paths: [], truncated_of: null, failure_reason: 'fixture' },
  disposition: null,
});

// ---------------------------------------------------------------------------
// SCOPING THE ASSERTIONS TO THE SURVIVING-RECEIPT BLOCK.
//
// CORRECTED 2026-09-05, on a measured red gate. The first cut of this file
// asserted against the WHOLE additionalContext, and both of its controls went
// RED at HEAD — correctly. H1's ordinary SessionStart banner ALREADY carries
// the phrase "by hand" in its delegation-conventions prose ("reading files by
// hand", h1-session-start.mjs:89, coordinator-supplied) and already matches a
// bare /receipt/i for unrelated reasons. So an unscoped BY_HAND pin would have
// been RED against a PERFECTLY CORRECT implementation, and an unscoped
// REPORT_MARKER pin would have been GREEN whether or not any report existed.
// The controls detected the pattern defect rather than letting either pin lie —
// which is what they are for, and the reason they are written first.
//
// HOW THE BLOCK IS ISOLATED, AND WHY NOT BY ITS HEADING: this author has never
// opened scripts/hooks/h1-session-start.mjs (H4 read wall), so keying extraction
// to a heading string would mean INVENTING one — a fixture that silently matches
// nothing extracts an empty block and makes every absence pin below vacuously
// green, which is precisely the hollow shape this file exists to avoid.
// Instead the block is derived DIFFERENTIALLY: run H1 once with no ledger and
// once with one, normalize the project path out of both, and take the lines the
// LEDGER caused to appear. By construction that set is the surviving-receipt
// report and nothing else, and it needs no knowledge of H1's internals.
// RW-C2 pins the assumption that makes it sound (the banner is deterministic
// across two independent no-ledger runs); if that ever fails, RW-C2 goes red and
// names the extractor as the suspect instead of blaming a pin below.
// ---------------------------------------------------------------------------

const PROJECT_TOKEN = '<PROJECT>';

// The only text that differs between two fixture projects is their mkdtemp path,
// so it is replaced before any comparison. Both the native and the POSIX
// spelling are normalized (Windows/WSL parity).
function normalizeCtx(ctx, dir) {
  let out = String(ctx ?? '');
  for (const variant of [dir, String(dir).split(sep).join('/'), String(dir).split('/').join(sep)]) {
    if (variant) out = out.split(variant).join(PROJECT_TOKEN);
  }
  return out;
}

const lineSet = (ctx) => new Set(String(ctx).split(/\r?\n/).map((l) => l.trim()));

// Lines present in `withCtx` that are absent from `baseCtx`. Line-wise and
// trim-insensitive so an indentation change cannot manufacture a difference.
function differential(withCtx, baseCtx) {
  const base = lineSet(baseCtx);
  return String(withCtx)
    .split(/\r?\n/)
    .filter((l) => !base.has(l.trim()))
    .join('\n');
}

// A no-ledger SessionStart context, normalized. Captured fresh each call;
// memoized once for the common case so the suite pays one extra hook run total.
function captureBaseline() {
  const { dir, cleanup } = makeH1Project();
  try {
    const r = h1(dir);
    assert.equal(r.code, 0, `baseline capture: H1 must run cleanly with no ledger — stderr=${flat(r.stderr)}`);
    const ctx = normalizeCtx(additionalContext(r), dir);
    assert.ok(ctx.length > 0, 'baseline capture: H1 emitted an EMPTY additionalContext — the differential extractor would then return the whole report and every scoped pin in this file would be meaningless');
    return ctx;
  } finally {
    cleanup();
  }
}
let memoBaseline = null;
function baselineContext() {
  if (memoBaseline === null) memoBaseline = captureBaseline();
  return memoBaseline;
}

// Run H1 over a project holding exactly one surviving receipt, and return the
// ledger-caused portion of its report.
function receiptReport(makeEntry) {
  const { dir, cleanup } = makeH1Project();
  try {
    writeH1Ledger(dir, [makeEntry()]);
    const r = h1(dir);
    assert.equal(r.code, 0, `H1 must not fail the session start on a ledger it can read — stderr=${flat(r.stderr)}`);
    const ctx = normalizeCtx(additionalContext(r), dir);
    return { ctx, block: differential(ctx, baselineContext()), stderr: r.stderr };
  } finally {
    cleanup();
  }
}

// The report marker, applied ONLY to the extracted block. Vocabulary is not
// pinned (no record fixes H1's phrasing); inside a block that exists only
// because a ledger was present, a loose marker is safe and a tight one would be
// guessing.
const REPORT_MARKER = /receipt/i;

// THE TWO SUBJECTS OF THIS FILE, both applied ONLY to the extracted block.
// Absence is asserted with a LOOSE pattern on purpose: for a must-not-contain
// pin, looser is STRONGER — a strict verbatim match would be satisfied
// vacuously by a line wrap, a capitalization change, or "delete it by hand".
// Scoping is what makes the loose pattern safe: H1's banner prose is excluded
// by construction, so any match is the receipt block's own text.
const BY_HAND = /\bby\s+hand\b/i;
// Presence is asserted with a TIGHT pattern on purpose: the whole point is that
// the operator can COPY the route. Whitespace between the two words is
// normalized so a line wrap inside the printed command does not fail it.
const SANCTIONED_ROUTE = /scripts\/review-ledger\.mjs\s+discharge/;

const SHAPES = [
  ['v1 legacy flat receipt (the shape actually stuck in consumers today)', legacyReceipt],
  ['v2 envelope receipt (decision 57984926)', v2Receipt],
];

// =============================================================================
// CONTROL ARM — FIRST, DELIBERATELY.
//
// Every pin below asserts something about the CONTENT of H1's receipt report,
// and both directions have a second possible cause: an absence pin passes
// vacuously if no report was emitted at all, and a presence pin's red cannot be
// told from "receipt reporting is switched off". RW-C1 must pass for the
// OPPOSITE reason (a report EXISTS), and RW-C0 must pass for the opposite
// reason again (with nothing to report, H1 stays silent) — so a green anywhere
// below always carries its own evidence.
// =============================================================================

test('RW-C0 (CONTROL, OPPOSITE REASON, expect GREEN today and after): with no review-ledger.json at all, H1 reports no SURVIVING receipt', () => {
  // Asserted on a string that can ONLY have come from a ledger — the fixture's
  // foreign session id. The bare word "receipt" is deliberately NOT used here:
  // H1's banner carries it in unrelated conventions prose (measured 2026-09-05),
  // and a control that fails on someone else's static text tests nothing.
  const ctx = baselineContext();
  assert.ok(ctx.length > 0, 'H1 must emit a SessionStart context at all — if it does not, every pin in this file is vacuous');
  assert.doesNotMatch(
    ctx,
    new RegExp(FOREIGN_SESSION),
    `nothing survives, nothing is said. Without this arm, RW-C1's "a report exists" could be satisfied by a report H1 emits unconditionally, and RW-1's absence pin would be scoped to a block that has nothing to do with the ledger. baseline=${flat(ctx)}`
  );
});
// SABOTAGE: make the receipt report unconditional (emit a receipt block, with
// placeholder identities, even for an empty/absent ledger) — this pin goes red
// only if the placeholder collides with the fixture id, so its REAL carrier is
// narrower than it looks: it pins that the report is LEDGER-DRIVEN. The
// stronger companion is RW-C1, which pins that a ledger produces a NON-EMPTY
// differential — together they bracket "the block comes from the ledger".

test('RW-C2 (CONTROL, EXTRACTOR SOUNDNESS, expect GREEN today and after): two independent no-ledger SessionStarts produce a byte-identical normalized context', () => {
  // THE ASSUMPTION THE WHOLE FILE NOW RESTS ON. Every assertion below is scoped
  // by subtracting the baseline banner from the with-ledger report. That is only
  // valid if the banner is DETERMINISTIC across runs once the project path is
  // normalized out — otherwise run-to-run noise leaks into the "block" and an
  // absence pin can go red for a reason that has nothing to do with receipts.
  const a = baselineContext();
  const b = captureBaseline();
  const noise = differential(b, a);
  assert.equal(
    noise,
    '',
    `H1's no-ledger banner differs between two identical runs, so the differential extractor cannot isolate the receipt block cleanly. IF THIS IS RED, DO NOT WEAKEN RW-1/RW-2 — the finding is about the EXTRACTOR, and the fix is to strip the varying lines (a timestamp, a duration, a counter) in normalizeCtx(). Lines that appeared in run B but not run A: ${flat(noise)}`
  );
});
// SABOTAGE: emit any per-run varying value (a wall-clock time, an elapsed-ms
// figure) in H1's SessionStart banner — this pin goes red while RW-C0 stays
// green. WHICH GUARD CARRIES THE VERDICT: nothing in the implementation — this
// pins the TEST'S OWN extraction premise, which is why it is a control and not
// a behavioural claim. It is stated rather than assumed because a silently
// unsound extractor is exactly how a scoped absence pin goes hollow.

for (const [label, makeEntry] of SHAPES) {
  test(`RW-C1 [${label}] (CONTROL, NON-VACUITY, expect GREEN today and after): H1 REPORTS a surviving foreign-session receipt, and the extracted block is non-empty`, () => {
    const { block, ctx } = receiptReport(makeEntry);
    assert.notEqual(
      block.trim(),
      '',
      `THE NON-VACUITY ARM for this ledger shape, and the one that keeps the SCOPED absence pins honest. An empty block makes RW-1 vacuously green — it would pass by asserting nothing is present in nothing. Two causes to tell apart if this is red: H1 does not report this ledger shape at all, or the differential extractor removed the block (check RW-C2 first). full context=${flat(ctx)}`
    );
    assert.match(
      block,
      REPORT_MARKER,
      `the ledger-caused lines must actually be a receipt report. Decision 57984926 (3): "H1, spending, amend spending, fallback selection and counts all ignore DISCHARGED entries" — this receipt is ACTIVE and foreign-session, so it must be reported. block=${flat(block)}`
    );
  });
  // SABOTAGE: filter ACTIVE foreign-session receipts out of H1's report (e.g.
  // report only entries older than some threshold) — this pin goes red while
  // RW-C0 stays green, and it would silently hollow out every other pin in this
  // file, which is exactly why it is pinned per SHAPE rather than once.

  test(`RW-1 [${label}] (expect RED today): the surviving-receipt BLOCK does NOT tell the conductor to remove it BY HAND`, () => {
    const { block } = receiptReport(makeEntry);
    assert.notEqual(block.trim(), '', `precondition (RW-C1): the block must be non-empty for this absence pin to mean anything`);
    assert.doesNotMatch(
      block,
      BY_HAND,
      `"by hand" instructs the operator to edit .sterling/review-ledger.json directly. That route (a) is DENIED by H15's store seal, so the conductor cannot take it, and (b) destroys the evidence decision 57984926 promises to preserve, records no disposition, and races the discharge command's atomic locked replace. A hook that prints a denied remedy manufactures a workaround — the exact failure 1434cd54 Ruling 2 records. SCOPED to the ledger-caused lines, so H1's unrelated delegation-conventions prose ("reading files by hand") cannot produce this verdict. block=${flat(block)}`
    );
  });
  // SABOTAGE: restore the "remove it by hand" phrasing in H1's receipt report —
  // this pin goes red while RW-C1 and RW-2 stay green. WHICH GUARD CARRIES THE
  // VERDICT: the report's remedy STRING, a single guard with no defense in
  // depth. Note RW-1 and RW-2 are INDEPENDENT: a report can name the sanctioned
  // route AND still offer the hand-edit beside it, which is the likeliest
  // half-fix and the reason both are pinned.

  test(`RW-2 [${label}] (expect RED today): the surviving-receipt BLOCK NAMES the sanctioned route, scripts/review-ledger.mjs discharge`, () => {
    const { block } = receiptReport(makeEntry);
    assert.notEqual(block.trim(), '', `precondition (RW-C1): the block must be non-empty`);
    assert.match(
      block,
      SANCTIONED_ROUTE,
      `decision 57984926 (3): discharge is "a dedicated command (scripts/review-ledger.mjs discharge), explicit-only, NEVER automatic", and it is the ONLY route that preserves evidence and records a disposition. Naming a remedy the operator can copy is the whole value of the report — an unspendable receipt that is merely ANNOUNCED, with no route out, is the "permanent refusal" state the consuming project reported on 2026-09-03. SCOPED deliberately: the route must appear in the RECEIPT block, where the operator is actually reading, not merely somewhere in the banner. block=${flat(block)}`
    );
  });
  // SABOTAGE: print the route as bare prose ("discharge the receipt") without the
  // literal `scripts/review-ledger.mjs discharge` command — this pin goes red
  // while RW-1 and RW-C1 stay green. A remedy the reader must go and look up is
  // the same class of defect as the CLAUDE.md rule that an index locates a source
  // but never replaces it.
}

// =============================================================================
// RW-4 — THE ROUTE IS RUNNABLE AS PRINTED (decision 95c2c109, MEDIUM a).
// A remedy printed with a `<clone>` placeholder is outside H15's sanctionable
// word syntax, so pasting it as printed is DENIED — the sanctioned route sits on
// the allowlist while the displayed command still cannot run, the other half of
// anti_pattern 43bebe5c. H1 knows its own plugin root (the harness names it
// through STERLING_PLUGIN_ROOT = this repo), so the route must carry that
// RESOLVED absolute path, forward-slashed.
// =============================================================================

test('RW-4 (95c2c109 MEDIUM a): the printed discharge route carries the RESOLVED clone path, never the literal <clone> placeholder', () => {
  const results = [];
  for (const [label, makeEntry] of SHAPES) {
    const { block } = receiptReport(makeEntry);
    assert.notEqual(block.trim(), '', `${label}: precondition (RW-C1) — the block must be non-empty`);
    const m = block.match(/node (\S+)\/scripts\/review-ledger\.mjs discharge/);
    results.push({ label, placeholder: /<clone/.test(block), prefix: m ? m[1] : null });
  }
  const expectedPrefix = String(root).split(sep).join('/').replace(/\/+$/, '');
  assert.deepEqual(
    results,
    SHAPES.map(([label]) => ({ label, placeholder: false, prefix: expectedPrefix })),
    'the route must be copy-pasteable: the RESOLVED plugin root (this repo, named to H1 through STERLING_PLUGIN_ROOT) precedes /scripts/review-ledger.mjs, and no <clone> placeholder survives in either ledger shape'
  );
});
// SABOTAGE: print the literal `<clone>` again (or print pluginRoot() with
// backslashes on a Windows host) — this pin goes red while RW-2 stays green,
// because RW-2 matches the route by its tail and never inspects the prefix.

// =============================================================================
// RW-3 — SHAPE PARITY, stated as its own claim.
// The loop above pins each shape independently; this pin states the INVARIANT
// that binds them, so a half-fix (v2 path corrected, v1 path left printing the
// denied remedy) fails on a pin that NAMES the asymmetry rather than on two
// unrelated reds a reader might attribute to two different causes.
// =============================================================================

test('RW-3 (expect RED today): both ledger shapes get the SAME remedy — a v1 legacy receipt is not left with the denied one', () => {
  const results = [];
  for (const [label, makeEntry] of SHAPES) {
    const { block } = receiptReport(makeEntry);
    assert.notEqual(block.trim(), '', `${label}: precondition (RW-C1) — the block must be non-empty`);
    results.push({ label, byHand: BY_HAND.test(block), route: SANCTIONED_ROUTE.test(block) });
  }
  // COLLECT, never short-circuit (anti_pattern f1d66bef): an early assertion
  // would hide WHICH shape regressed, and that is the finding here.
  assert.deepEqual(
    results.map(({ label, byHand, route }) => ({ label, byHand, route })),
    SHAPES.map(([label]) => ({ label, byHand: false, route: true })),
    'decision 57984926 keeps v1 receipts alive on purpose ("v1 receipts do NOT age out — that persistence IS the pathology discharge exists for"), so the v1 reporting path is the one a stuck consumer actually reads. A wording fix applied to the v2 branch alone leaves exactly the wrong half broken'
  );
});
// SABOTAGE: apply the remedy-wording fix to the v2 reporting branch only,
// leaving the legacy/compat branch printing "remove it by hand" — this pin goes
// red together with the v1 half of RW-1/RW-2, while the v2 half of both stays
// green. WHICH GUARD CARRIES THE VERDICT: the compatibility adapter's report
// path. If the implementation turns out to have ONE shared report path, this pin
// is defense in depth rather than load-bearing — say so in the report rather
// than deleting it.
