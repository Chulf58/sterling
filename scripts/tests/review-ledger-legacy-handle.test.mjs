// REVIEW-LEDGER `discharge --legacy-handle` — THE v1 SELECTOR AND THE ONE
// LEGACY ADAPTER (R1 PIN RE-CUT).
//
// AUTHORITY: decision review-receipt-rebuild-invariant-three-owner-modules-
// tri-state-liveness-receipt-bound-supersession — "legacy v1 entries are read
// through ONE adapter as a 'legacy' disposition, never rewritten by reading,
// never spent, dischargeable via --legacy-handle" — projected by contract sheet
// §1.2 (adaptLegacyEntry, LEGACY_HANDLE_PATTERN, legacyReceiptHandle) and §3.1
// (the `legacy` class, legacy-handle only).
//
// THE HANDLE IS NOT A NEW IDENTITY. It is a content fingerprint derived by the
// shared adapter; these pins IMPORT that function rather than re-deriving it,
// because a second copy of the computation in the test would pin the test's own
// arithmetic. What IS pinned independently is the handle's SHAPE, its
// DETERMINISM, and the exact-form-only addressing rule that a destroying
// operation with no resurrection verb demands.
//
// RETIRED IN THIS RE-CUT (each with its reason):
//   RETIRED: L2-0 ("the SAME v1 receipt, NOT discharged, is stamped and consumed normally") — inverted by the rebuild: a v1 entry is NEVER spendable, discharged or not. The new direction is pinned once, in review-ledger-discharge-hardening.test.mjs R1-C27.
//   RETIRED: L2's post-discharge spend refusal — same inversion; a v1 entry never spends before the discharge either, so the pin no longer separates anything.
//   RETIRED: L8, L9 and L9-0 (the stray bare `status:"discharged"` marker, its "REPLACES" disclosure, and that disclosure's ordering) — the whole authenticity notion is retired: a v1 entry has no lifecycle to authenticate, so a stray key is just a key.
//   RETIRED: L10b and L10c (a second and third stray-key permutation) — duplicate permutations of L10's one contract, schema-disjoint candidate sets; one arm kept.
//   RETIRED: L12 (source-text ordering of a console.error against renameSync) — an internal placement assertion about a disclosure that no longer exists.
//   RETIRED: L7's five-arm re-litigation of the class preconditions on the legacy arm — duplicate permutations of codes already pinned in review-ledger-discharge.test.mjs; the two arms that are genuinely LEGACY-SPECIFIC are kept (R1-C69 the digest token still binds, R1-C70 no-live is not available to a v1 entry).
//   RETIRED: every v1 CONSTRUCTION fixture beyond one per legacy shape — the adapter is now pinned directly (R1-C61), so the shapes do not need re-deriving through the CLI.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { legacyReceiptHandle, adaptLegacyEntry, LEGACY_HANDLE_PATTERN } from '../hooks/lib/review-ledger-entry.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEDGER_CLI = join(root, 'scripts', 'review-ledger.mjs');

const GIT_SKIP = (() => {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0 ? false : 'git not available on this host';
})();

const SESSION = 'this-session';
const ENV_SESSION = { STERLING_SESSION_ID: SESSION };
const flat = (s) => String(s ?? '').replace(/\r?\n/g, ' | ');
const isoAgo = (msAgo) => new Date(Date.now() - msAgo).toISOString();

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-legacy-handle-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@sterling.local']);
  git(dir, ['config', 'user.name', 'Sterling Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, '.gitignore'), '.sterling/\n');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'base.mjs'), 'export const base = 1;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'base']);
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const ledgerPath = (dir) => join(dir, '.sterling', 'review-ledger.json');
const writeLedger = (dir, entries) => writeFileSync(ledgerPath(dir), JSON.stringify(entries));
const readLedger = (dir) => (existsSync(ledgerPath(dir)) ? JSON.parse(readFileSync(ledgerPath(dir), 'utf8')) : null);
const readLedgerRaw = (dir) => (existsSync(ledgerPath(dir)) ? readFileSync(ledgerPath(dir), 'utf8') : null);
const ledgerDigest = (dir) => createHash('sha256').update(readFileSync(ledgerPath(dir))).digest('hex');
const stagedBlob = (dir, relPath) => git(dir, ['hash-object', relPath]);

function assertNoLedgerResidue(dir, label) {
  const residue = readdirSync(join(dir, '.sterling')).filter((n) => /^review-ledger\.json\..+/.test(n) && !n.endsWith('.lock'));
  assert.deepEqual(residue, [], `${label}: the replace leaves no partial ledger behind — got ${JSON.stringify(residue)}`);
}

function runLedger(dir, args, env = ENV_SESSION) {
  const r = spawnSync(process.execPath, [LEDGER_CLI, ...args], { cwd: dir, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env } });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
function runLedgerJson(dir, args, env = ENV_SESSION) {
  const r = runLedger(dir, [...args, '--json'], env);
  let json = null;
  let parseError = null;
  try {
    json = JSON.parse(r.stdout);
  } catch (e) {
    parseError = e;
  }
  return { ...r, json, parseError };
}

// A LEGACY v1 entry: FLAT fields, no schema_version, no entry_id, no lifecycle.
function v1({ agent_type = 'reviewer-correctness', files = ['src/base.mjs'], at = isoAgo(60_000), session_id = 'a-session-that-ended', branch = 'main', base_sha = null, blobs = null, extra = {} } = {}) {
  const e = { agent_type, files, at, session_id, branch };
  if (base_sha) e.base_sha = base_sha;
  if (blobs) e.reviewed_state = { blobs, completed_at: at };
  return { ...e, ...extra };
}

// A structurally complete v2 entry — the OTHER selector's territory.
function v2({ entry_id, agent_type = 'reviewer-security', files = ['src/base.mjs'], blobs = {}, at = isoAgo(60_000), session_id = SESSION }) {
  return {
    schema_version: 2,
    entry_id,
    kind: 'roster_receipt',
    status: 'active',
    started_at: at,
    finished_at: at,
    reviewer: { agent_type, model: 'claude-opus-5', model_family: 'anthropic', model_source: 'observed' },
    identity: { session_id, branch: 'main', base_sha: null, agent_id: 'agent-0001' },
    territory: { files, source: 'review-territory', attribution: 'block' },
    content_evidence: { basis: 'stop-time-worktree-snapshot', status: 'complete', blobs, absent_paths: [] },
    disposition: null,
  };
}

const V2_ID = 'e0000000-0000-4000-8000-00000000000a';

// ===========================================================================
// R1-C60 / R1-C61 — THE ADAPTER, PINNED DIRECTLY. Pure, no CLI.
// ===========================================================================

// SABOTAGE (determinism half): derive the handle from Date.now(), randomUUID or
// the commit sha -> the two round-trip comparisons go red. A per-invocation value
// is a fingerprint of nothing and cannot say WHICH receipt is addressed, which is
// the only thing a selector is for.
// SABOTAGE (discrimination half): drop `files` from the fingerprint inputs -> the
// notEqual arms go red. Territory is what distinguishes two receipts that share
// an agent_type AND a dispatch millisecond.
test('R1-C60: the legacy handle is receipt-<32 lowercase hex>, matches LEGACY_HANDLE_PATTERN, is deterministic over the receipt content, and differs for receipts differing in any identity-bearing field', () => {
  // v1()'s default `at` is evaluated PER CALL, so the determinism arms share one
  // pinned instant; the discrimination arms keep their own values.
  const at = isoAgo(60_000);
  const base = v1({ at });
  const h = legacyReceiptHandle(base);
  assert.match(h, /^receipt-[0-9a-f]{32}$/, `the handle has exactly one spelling — got ${JSON.stringify(h)}`);
  assert.match(h, LEGACY_HANDLE_PATTERN, 'and the exported pattern is the same rule the CLI validates against, not a second spelling of it');

  assert.equal(h, legacyReceiptHandle(JSON.parse(JSON.stringify(base))), 'the same receipt fingerprints identically across a serialize/parse round trip');
  assert.equal(h, legacyReceiptHandle(v1({ at })), 'and identically for an independently-constructed byte-identical receipt');

  assert.notEqual(h, legacyReceiptHandle(v1({ at, agent_type: 'reviewer-security' })), 'agent_type is part of the identity');
  assert.notEqual(h, legacyReceiptHandle(v1({ at, files: ['src/other.mjs'] })), 'declared territory is part of the identity');
  assert.notEqual(h, legacyReceiptHandle(v1({ at: isoAgo(120_000) })), 'the dispatch instant is part of the identity');
  assert.notEqual(h, legacyReceiptHandle(v1({ at, blobs: { 'src/base.mjs': 'a'.repeat(40) } })), 'the recorded blob map is part of the identity');

  const twoBlobs = { 'src/a.mjs': 'a'.repeat(40), 'src/b.mjs': 'b'.repeat(40) };
  const reversed = { 'src/b.mjs': 'b'.repeat(40), 'src/a.mjs': 'a'.repeat(40) };
  assert.equal(
    legacyReceiptHandle(v1({ at, files: ['src/a.mjs', 'src/b.mjs'], blobs: twoBlobs })),
    legacyReceiptHandle(v1({ at, files: ['src/a.mjs', 'src/b.mjs'], blobs: reversed })),
    'blob key order in the ledger file cannot change the answer'
  );
});

// THE ONE ADAPTER PIN PER LEGACY SHAPE — this is what replaces the retired
// construction-fixture sprawl. Two shapes, because a v1 receipt either carries a
// reviewed_state blob map or it does not, and those are different code paths.
// SABOTAGE (the no-rewrite half): have the adapter normalize its input in place
// (sort files, add a status, stamp a schema_version) -> the deepEqual against the
// frozen copy goes red. The whole reason there is an adapter rather than a
// migration is that reading an agent-writable evidence file must not rewrite it.
// SABOTAGE (the projection half): return the raw entry instead of the named
// projection -> the field assertions go red; every consumer reads a v1 entry
// through these names and nothing else.
test('R1-C61: adaptLegacyEntry projects a v1 entry to {kind:"legacy", handle, agent_type, files, at, session_id, branch, base_sha, blobs, status} and NEVER rewrites its input — with and without a reviewed_state blob map', () => {
  const at = isoAgo(60_000);
  const shapes = [
    { label: 'with blobs', raw: v1({ at, base_sha: 'd'.repeat(40), blobs: { 'src/base.mjs': 'a'.repeat(40) } }), blobs: { 'src/base.mjs': 'a'.repeat(40) } },
    { label: 'without blobs', raw: v1({ at, base_sha: 'd'.repeat(40) }), blobs: {} },
  ];
  for (const shape of shapes) {
    const frozen = JSON.parse(JSON.stringify(shape.raw));
    const out = adaptLegacyEntry(shape.raw);

    assert.equal(out.kind, 'legacy', `[${shape.label}] a v1 entry is a LEGACY disposition, never a receipt — got ${JSON.stringify(out)}`);
    assert.equal(out.handle, legacyReceiptHandle(shape.raw), `[${shape.label}] the projection carries the handle it is addressed by`);
    assert.equal(out.agent_type, 'reviewer-correctness', `[${shape.label}] agent_type`);
    assert.deepEqual(out.files, ['src/base.mjs'], `[${shape.label}] declared files`);
    assert.equal(out.at, at, `[${shape.label}] the dispatch instant`);
    assert.equal(out.session_id, 'a-session-that-ended', `[${shape.label}] session identity`);
    assert.equal(out.branch, 'main', `[${shape.label}] branch identity`);
    assert.equal(out.base_sha, 'd'.repeat(40), `[${shape.label}] base_sha`);
    assert.deepEqual(out.blobs, shape.blobs, `[${shape.label}] the blob map, empty rather than absent when the entry has none — got ${JSON.stringify(out.blobs)}`);
    assert.equal(out.status, 'active', `[${shape.label}] a v1 entry has no lifecycle of its own, so it reads as active — got ${JSON.stringify(out.status)}`);

    assert.deepEqual(shape.raw, frozen, `[${shape.label}] READING an entry never rewrites it — the input object is byte-identical afterwards`);
  }
});

// ===========================================================================
// R1-C62 — THE HAPPY PATH (CONTROL, PLACED FIRST). Every refusal pin below would
// be satisfied by a CLI that refuses --legacy-handle unconditionally.
// ===========================================================================

// SABOTAGE (preservation half): implement the legacy discharge as a splice -> the
// length and evidence assertions go red.
// SABOTAGE (no-migration half): rewrite the entry into the v2 envelope while
// discharging it -> the schema_version/entry_id assertions go red. In-place
// migration is a bulk rewrite of an agent-writable evidence file, which the
// design rejected outright; only the lifecycle fields are added.
// SABOTAGE (disposition half): flip status without writing a disposition -> the
// class/reason/head_sha assertions go red while status stays green.
test('R1-C62 (CONTROL, first): a LEGACY v1 entry is discharged by --legacy-handle --class legacy — evidence preserved byte-for-byte, STILL a v1 entry, status+disposition added, bystander untouched', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const target = v1({ files: ['src/base.mjs'], blobs: { 'src/base.mjs': stagedBlob(dir, 'src/base.mjs') } });
    const bystander = v1({ agent_type: 'reviewer-bystander', files: ['src/elsewhere.mjs'], at: isoAgo(90_000) });
    writeLedger(dir, [target, bystander]);

    const handle = legacyReceiptHandle(target);
    const reason = 'a v1 receipt can never be spent here; the ledger keeps it as evidence';
    const tMin = Date.now() - 1_000;

    const r = runLedgerJson(dir, ['discharge', '--legacy-handle', handle, '--digest', ledgerDigest(dir), '--class', 'legacy', '--reason', reason]);
    assert.equal(r.code, 0, `a well-formed legacy discharge succeeds — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(r.json.ok, true, `got ${JSON.stringify(r.json)}`);

    const after = readLedger(dir);
    assert.equal(after.length, 2, `NOTHING is deleted — got ${JSON.stringify(after)}`);
    assert.deepEqual(after[1], bystander, 'the bystander entry is byte-for-byte untouched — this verb writes exactly one entry');

    const d = after[0];
    assert.equal(d.schema_version, undefined, 'the entry is NOT migrated to v2');
    assert.equal(d.entry_id, undefined, 'and gains no invented entry_id');
    for (const k of ['agent_type', 'files', 'at', 'session_id', 'branch', 'reviewed_state']) {
      assert.deepEqual(d[k], target[k], `${k} is preserved exactly as it was on disk`);
    }
    assert.equal(d.status, 'discharged', 'the status flips to discharged');
    assert.equal(d.disposition.class, 'legacy', 'under the legacy class');
    assert.equal(d.disposition.reason, reason, 'with the conductor-supplied reason recorded verbatim');
    assert.equal(d.disposition.head_sha, git(dir, ['rev-parse', 'HEAD']), 'and head_sha pinning WHEN in history it was decided');
    assert.equal(d.disposition.classifier_version, 2, `classifier_version — got ${JSON.stringify(d.disposition.classifier_version)}`);
    const at = Date.parse(d.disposition.at);
    assert.ok(Number.isFinite(at) && at >= tMin && at <= Date.now() + 1_000, `disposition.at is the moment of the discharge — got ${JSON.stringify(d.disposition.at)}`);

    assertNoLedgerResidue(dir, 'R1-C62');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// R1-C63 … R1-C68 — ADDRESSING. A destroying call with no resurrection verb
// never widens its selector to find something close.
// ===========================================================================

// SABOTAGE: fall back to "the only legacy entry" / "the first entry" when the
// handle matches nothing -> the bystander is discharged as a consolation prize
// and the status/byte-identical assertions go red.
// SABOTAGE (the discovery half): make the refusal a bare not-found with no
// listing -> the includes() assertion goes red. A handle is DERIVED, never
// stored, so this refusal is the ONE place a conductor can read the real one; a
// selector nobody can discover is a selector nobody can use.
test('R1-C63: a well-formed handle matching NO entry is [entry_not_found] — nothing is discharged in its place, and the refusal LISTS the handles that do exist', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const present = v1({});
    writeLedger(dir, [present]);
    const before = readLedgerRaw(dir);

    const r = runLedgerJson(dir, ['discharge', '--legacy-handle', `receipt-${'0'.repeat(32)}`, '--digest', ledgerDigest(dir), '--class', 'legacy', '--reason', 'no such receipt']);
    assert.equal(r.code, 1, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(r.json.code, 'entry_not_found', `got ${JSON.stringify(r.json)}`);
    assert.equal(readLedgerRaw(dir), before, 'the ledger is byte-identical');
    assert.equal(readLedger(dir)[0].status, undefined, 'the ONLY entry present is untouched');
    assert.ok(
      JSON.stringify(r.json.facts).includes(legacyReceiptHandle(present)),
      `the facts list the legacy handles that DO exist, in full — got ${JSON.stringify(r.json.facts)}`
    );
  } finally {
    cleanup();
  }
});

// SABOTAGE (the one this pin exists for): resolve an unambiguous PREFIX, trim
// whitespace, or lowercase the input "for convenience" -> the corresponding arm
// discharges and its assertions go red. Every arm is a spelling a conductor could
// plausibly paste; NONE may resolve, because this call destroys and there is no
// resurrection verb.
test('R1-C64: an ABBREVIATED, PREFIX, BARE-HEX, UPPERCASED, PADDED or SUFFIXED handle is [entry_not_found] — the selector is never widened', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const target = v1({});
    writeLedger(dir, [target]);
    const before = readLedgerRaw(dir);
    const good = legacyReceiptHandle(target);

    const arms = [
      ['8-char prefix (the id ladder\'s shape — deliberately NOT honored here)', good.slice(0, 'receipt-'.length + 8)],
      ['one character short', good.slice(0, good.length - 1)],
      ['bare hex, no receipt- prefix', good.slice('receipt-'.length)],
      ['uppercased hex', `receipt-${good.slice('receipt-'.length).toUpperCase()}`],
      ['whitespace padded', ` ${good} `],
      ['trailing junk', `${good}x`],
    ];
    for (const [label, bad] of arms) {
      const r = runLedgerJson(dir, ['discharge', '--legacy-handle', bad, '--digest', ledgerDigest(dir), '--class', 'legacy', '--reason', `[${label}] must not resolve`]);
      assert.equal(r.code, 1, `[${label}] must REFUSE — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      assert.equal(r.json.code, 'entry_not_found', `[${label}] got ${JSON.stringify(r.json)}`);
      assert.equal(readLedgerRaw(dir), before, `[${label}] the ledger is byte-identical`);
      assert.equal(readLedger(dir)[0].status, undefined, `[${label}] the entry is NOT discharged`);
    }
  } finally {
    cleanup();
  }
});

// SABOTAGE: pick matches[0] on a collision -> exit 0, one of the two flips, and
// the code/byte-identical assertions go red. Two receipts that fingerprint
// identically are indistinguishable to this selector, so choosing either is
// choosing at random on a call that overwrites evidence.
test('R1-C65: two v1 entries producing the SAME handle are [entry_selector_ambiguous] — the facts name BOTH and nothing is written', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const at = isoAgo(60_000);
    const a = v1({ at });
    const b = v1({ at }); // byte-identical content => identical fingerprint
    assert.equal(legacyReceiptHandle(a), legacyReceiptHandle(b), 'fixture guard: these two receipts genuinely collide');
    writeLedger(dir, [a, b]);
    const before = readLedgerRaw(dir);

    const r = runLedgerJson(dir, ['discharge', '--legacy-handle', legacyReceiptHandle(a), '--digest', ledgerDigest(dir), '--class', 'legacy', '--reason', 'ambiguous target']);
    assert.equal(r.code, 1, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(r.json.code, 'entry_selector_ambiguous', `got ${JSON.stringify(r.json)}`);
    assert.equal(readLedgerRaw(dir), before, 'NEITHER entry is discharged and the ledger is byte-identical');
    const facts = JSON.stringify(r.json.facts);
    assert.ok(/0/.test(facts) && /1/.test(facts), `the facts name both colliding positions — a refusal naming one of two is not a disambiguation aid — got ${facts}`);
  } finally {
    cleanup();
  }
});

// SABOTAGE (arm a): compute the handle over EVERY entry rather than only legacy
// ones -> a v2 entry becomes handle-addressable and its byte-identical assertion
// goes red. Keeping the candidate sets disjoint BY SCHEMA VERSION is what stops
// one selector from owning the other's entries — and `entry_id` on a v1 entry is
// an unowned stray key that any ledger writer can add.
// SABOTAGE (arm b): let one selector silently win when both are given -> a
// mistyped flag discharges an entry the conductor never looked at.
// SABOTAGE (arm d): make the zero-match refusal a bare not-found with no redirect
// -> a conductor holding a v1 entry with a stray id is dead-ended exactly as
// before the handle existed.
test('R1-C66: the two selectors are DISJOINT and MUTUALLY EXCLUSIVE — a v2 entry is unreachable by handle, --entry-id never addresses a v1 entry (and redirects to its handle), and neither "both" nor "neither" is accepted', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const legacy = v1({});
    const modern = v2({ entry_id: V2_ID, session_id: 'a-session-that-ended' });
    writeLedger(dir, [legacy, modern]);
    let before = readLedgerRaw(dir);
    const handle = legacyReceiptHandle(legacy);

    // (a) A handle NEVER addresses a v2 entry.
    const a = runLedgerJson(dir, ['discharge', '--legacy-handle', legacyReceiptHandle(modern), '--digest', ledgerDigest(dir), '--class', 'legacy', '--reason', 'v2 must be unreachable by handle']);
    assert.equal(a.code, 1, `[a] stdout=${a.stdout} stderr=${flat(a.stderr)}`);
    assert.equal(a.json.code, 'entry_not_found', `[a] got ${JSON.stringify(a.json)}`);
    assert.equal(readLedgerRaw(dir), before, '[a] ledger byte-identical');

    // (b) Both selectors at once — two possible targets is no target.
    const b = runLedgerJson(dir, ['discharge', '--entry-id', V2_ID, '--legacy-handle', handle, '--digest', ledgerDigest(dir), '--class', 'foreign-session', '--reason', 'two targets']);
    assert.equal(b.code, 1, `[b] stdout=${b.stdout} stderr=${flat(b.stderr)}`);
    assert.equal(b.json.code, 'argument_invalid', `[b] got ${JSON.stringify(b.json)}`);
    assert.equal(readLedgerRaw(dir), before, '[b] ledger byte-identical — neither target is discharged');

    // (c) Neither selector — a discharge with no target.
    const c = runLedgerJson(dir, ['discharge', '--digest', ledgerDigest(dir), '--class', 'foreign-session', '--reason', 'no target']);
    assert.equal(c.code, 1, `[c] stdout=${c.stdout} stderr=${flat(c.stderr)}`);
    assert.equal(c.json.code, 'argument_invalid', `[c] got ${JSON.stringify(c.json)}`);

    // (d) --entry-id against a LEGACY entry carrying a stray entry_id key: it is
    //     never a v2 candidate, and the refusal REDIRECTS to the handle.
    const strayId = 'ffffffff-0000-4000-8000-00000000ffff';
    const legacyWithId = { ...v1({}), entry_id: strayId };
    writeLedger(dir, [legacyWithId]);
    before = readLedgerRaw(dir);
    const d = runLedgerJson(dir, ['discharge', '--entry-id', strayId, '--digest', ledgerDigest(dir), '--class', 'foreign-session', '--reason', 'wrong selector for a v1 entry']);
    assert.equal(d.code, 1, `[d] stdout=${d.stdout} stderr=${flat(d.stderr)}`);
    assert.equal(d.json.code, 'entry_not_found', `[d] got ${JSON.stringify(d.json)}`);
    assert.equal(readLedgerRaw(dir), before, '[d] ledger byte-identical');
    assert.ok(
      JSON.stringify(d.json.facts).includes(legacyReceiptHandle(legacyWithId)),
      `[d] the facts name THE HANDLE to re-run with — a dead-end refusal here is what stranded the receipt this selector exists for — got ${JSON.stringify(d.json.facts)}`
    );
  } finally {
    cleanup();
  }
});

// SABOTAGE: return the FIRST occurrence's value while validating only that the
// flag is PRESENT -> the CLI acts on X while the caller was looking at Y, and the
// arms go red. This is the same forgiving-address defect one level up, arriving
// through the argument parser, and it is the shape a copy-paste retry produces.
// SABOTAGE (the "surely identical values are fine" relaxation): accept a repeat
// when both values are EQUAL -> the identical-repeat arm goes red. A duplicated
// flag means the caller does not know what they typed.
// CONTROL, LAST: exactly one selector still works on the same ledger, so the
// refusals are about the REPETITION and not about the fixture.
test('R1-C67: a selector flag given more than once is [argument_invalid] — never silently resolved to the first or last occurrence', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const a = v1({});
    const b = v1({ agent_type: 'reviewer-other' });
    writeLedger(dir, [a, b, v2({ entry_id: V2_ID, session_id: 'a-session-that-ended' })]);
    const before = readLedgerRaw(dir);

    const arms = [
      ['--legacy-handle twice, DIFFERENT values', ['--legacy-handle', legacyReceiptHandle(a), '--legacy-handle', legacyReceiptHandle(b)]],
      ['--legacy-handle twice, IDENTICAL values', ['--legacy-handle', legacyReceiptHandle(a), '--legacy-handle', legacyReceiptHandle(a)]],
      ['--entry-id twice', ['--entry-id', V2_ID, '--entry-id', 'e0000000-0000-4000-8000-00000000000b']],
    ];
    for (const [label, selector] of arms) {
      const r = runLedgerJson(dir, ['discharge', ...selector, '--digest', ledgerDigest(dir), '--class', 'legacy', '--reason', `[${label}] must write nothing`]);
      assert.equal(r.code, 1, `[${label}] a repeated selector must REFUSE — stdout=${r.stdout} stderr=${flat(r.stderr)}`);
      assert.equal(r.json.code, 'argument_invalid', `[${label}] got ${JSON.stringify(r.json)}`);
      assert.equal(readLedgerRaw(dir), before, `[${label}] the ledger is byte-identical — no occurrence wins`);
    }

    const ok = runLedgerJson(dir, ['discharge', '--legacy-handle', legacyReceiptHandle(a), '--digest', ledgerDigest(dir), '--class', 'legacy', '--reason', 'exactly one selector']);
    assert.equal(ok.code, 0, `CONTROL: a single selector still discharges on this same ledger — stdout=${ok.stdout} stderr=${flat(ok.stderr)}`);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// R1-C68 / R1-C69 — THE LEGACY ARM IS NOT A LAXER DOOR.
// ===========================================================================

// SABOTAGE: verify the token outside the lock, or against a re-serialization of
// the parsed ledger -> this discharges and the code assertion goes red. The new
// selector must bind the same concurrency token as the v2 one.
test('R1-C68: on the legacy arm a STALE digest is still [ledger_digest_mismatch] — the second selector is not a second, weaker door into the same write', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const target = v1({});
    writeLedger(dir, [target]);
    const before = readLedgerRaw(dir);

    const r = runLedgerJson(dir, ['discharge', '--legacy-handle', legacyReceiptHandle(target), '--digest', createHash('sha256').update('not the ledger bytes').digest('hex'), '--class', 'legacy', '--reason', 'stale']);
    assert.equal(r.code, 1, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(r.json.code, 'ledger_digest_mismatch', `got ${JSON.stringify(r.json)}`);
    assert.equal(readLedgerRaw(dir), before, 'the ledger is byte-identical');
    assertNoLedgerResidue(dir, 'R1-C68');
  } finally {
    cleanup();
  }
});

// SABOTAGE: let the no-live verifier judge a v1 entry on its flat files_source
// (a legacy entry CAN carry 'review-territory' as a flat field) -> this
// discharges and the code assertion goes red. A v2 roster receipt is that class's
// first precondition, and the fixture deliberately carries the flat field so a
// verifier that reads it passes everything else and fails only here.
test('R1-C69: --class no-live-territory on a v1 entry is [class_not_applicable] — the class needs a v2 receipt, whatever flat fields the legacy entry happens to carry', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    const target = v1({ base_sha: git(dir, ['rev-parse', 'HEAD']), extra: { files_source: 'review-territory' } });
    writeLedger(dir, [target]);
    const before = readLedgerRaw(dir);

    const r = runLedgerJson(dir, ['discharge', '--legacy-handle', legacyReceiptHandle(target), '--digest', ledgerDigest(dir), '--class', 'no-live-territory', '--reason', 'a v1 entry cannot be classified no-live']);
    assert.equal(r.code, 1, `stdout=${r.stdout} stderr=${flat(r.stderr)}`);
    assert.equal(r.json.code, 'class_not_applicable', `got ${JSON.stringify(r.json)}`);
    assert.equal(readLedgerRaw(dir), before, 'the ledger is byte-identical');
  } finally {
    cleanup();
  }
});
