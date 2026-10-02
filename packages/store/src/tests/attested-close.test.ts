// ---------------------------------------------------------------------------
// R9 — the attested-close primitive (board 8c8b6d78; decision
// attestation-bypass-requires-affirmative-exemption-not-unavailable-evidence
// for the missing-repoRoot ruling referenced in the sibling mcp-server file).
//
// STORE-LEVEL pins for `SterlingStore.updateRecordMetadata(id, fields,
// {expected_version, activity_at})` — the versioned, closed-field-set write
// the tools-layer attested close (see
// packages/mcp-server/src/tests/attested-close.test.ts, which routes
// boardRemove/maintenanceRemove of a reconcile_needed item through this same
// primitive) is built on. Written from the SPEC handed down with the board
// item, NOT from the implementation (H4 read wall) — grep confirms
// `updateRecordMetadata` exists in packages/store/src/index.ts, but its exact
// behavior below is asserted from the spec's own words, not mined from that
// file.
//
// Harness conventions copied verbatim from sibling files in this directory:
//   - envelope()/article()/tempStore(): store.test.ts
//   - the "named not-found" tolerant adapter, so a wrong/missing method name
//     fails with a clear diagnostic instead of a bare TypeError or a
//     TypeScript compile error: stable-identity-write-path.test.ts /
//     stable-identity-hardening.test.ts (callUpdateRecord / callGetRecordVersion)
//
// PIN R9-STORE-4 deliberately does NOT pass `baseline_attestations` through
// the ordinary `updateRecord` patch (even though the record already carries
// it) — only through the create-time envelope / updateRecordMetadata calls —
// because whether the general content-update schema even recognizes
// `baseline_attestations` as caller-input is a separate, unresolved question
// (see the sibling mcp-server file's PIN R9-13 note); mentioning it in an
// ordinary patch could make that test fail for the wrong reason. The pin
// instead checks that an ordinary content write, which never MENTIONS
// baseline_attestations at all, still clears the map server-side.
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '../index.js';

const NOW = '2026-09-06T12:00:00.000Z';
const LATER = '2026-09-06T13:00:00.000Z';

type Loose = Record<string, unknown>;

function envelope(type: string, at = NOW) {
  return {
    id: randomUUID(),
    type,
    created_at: at,
    updated_at: at,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: ['node'],
  };
}

function article(over: Loose = {}): Loose {
  return {
    ...envelope('feature_article'),
    slug: (over.slug as string) ?? `art-${randomUUID().slice(0, 8)}`,
    title: 'An article',
    what_it_does: 'x',
    intended_behavior: 'x',
    files: [{ path: 'src/a.ts', role: 'impl' }],
    current_ac: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'seed' }],
    live_test_refs: [],
    file_baselines: { 'src/a.ts': 'oldhash0000000000000000000000000000000000000000000000000000' },
    ...over,
  };
}

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-attested-close-store-'));
  return { dir, store: new SterlingStore(join(dir, 'sterling.db')) };
}

type MetaOpts = { expected_version?: number; activity_at?: string };
type MetaFields = {
  file_baselines?: Record<string, string>;
  baseline_attestations?: Record<string, unknown>;
  absence_attestations?: Record<string, unknown>;
};

// --- SPEC-ONLY adapters: named "not found" red, never a bare TypeError -----

function callUpdateRecordMetadata(store: SterlingStore, id: string, fields: MetaFields, opts?: MetaOpts): Loose {
  const fn = (store as unknown as { updateRecordMetadata?: (...a: unknown[]) => unknown }).updateRecordMetadata;
  if (typeof fn !== 'function') {
    throw new Error(
      'SterlingStore.updateRecordMetadata not found — expected `store.updateRecordMetadata(id, fields, {expected_version, activity_at})` per board 8c8b6d78'
    );
  }
  return fn.call(store, id, fields, opts) as Loose;
}

function callUpdateRecord(store: SterlingStore, id: string, patch: Loose, opts?: { expected_version?: number }): Loose {
  const fn = (store as unknown as { updateRecord?: (...a: unknown[]) => unknown }).updateRecord;
  if (typeof fn !== 'function') {
    throw new Error("SterlingStore.updateRecord not found — expected `store.updateRecord(id, patch, opts?)` (stable-identity-design-v2)");
  }
  return fn.call(store, id, patch, opts) as Loose;
}

function callGetRecordVersion(store: SterlingStore, id: string, version: number): Loose | undefined {
  const fn = (store as unknown as { getRecordVersion?: (...a: unknown[]) => unknown }).getRecordVersion;
  if (typeof fn !== 'function') {
    throw new Error("SterlingStore.getRecordVersion not found — expected `store.getRecordVersion(id, version)` (stable-identity-design-v2)");
  }
  return fn.call(store, id, version) as Loose | undefined;
}

// ===========================================================================
// PIN R9-STORE-1 — success path: writes the closed field set, bumps version,
// archives the PRIOR snapshot (readable by (id, version)).
// SABOTAGE THAT MUST MAKE THIS RED: skip the record_versions archive on this
// write path (write the new body in place with no snapshot) → the
// getRecordVersion read for the prior version returns undefined or the NEW
// baseline instead of the old one.
// ===========================================================================
test('[R9-STORE-1] updateRecordMetadata with the correct expected_version writes byte/absence attestation metadata and bumps version; the PRIOR body is archived and readable by (id, version)', () => {
  const { dir, store } = tempStore();
  try {
    const a = store.create(article());
    const startVersion = (a.version as number) ?? 1;
    const attestation = { attested_at: NOW, item_id: 'item-1', head_commit: 'a'.repeat(40), sha256: 'newhash' };
    const absence = { attested_at: NOW, item_id: 'item-2', head_commit: 'b'.repeat(40) };

    const patched = callUpdateRecordMetadata(
      store,
      a.id as string,
      {
        file_baselines: { 'src/a.ts': 'newhash' },
        baseline_attestations: { 'src/a.ts': attestation },
        absence_attestations: { 'src/gone.ts': absence },
      },
      { expected_version: startVersion, activity_at: NOW }
    );
    assert.equal(patched.version, startVersion + 1, 'version bumped by exactly one');
    assert.deepEqual(patched.file_baselines, { 'src/a.ts': 'newhash' }, 'the new baseline landed');
    assert.deepEqual((patched.baseline_attestations as Loose)['src/a.ts'], attestation, 'the new attestation entry landed');
    assert.deepEqual((patched.absence_attestations as Loose)['src/gone.ts'], absence, 'the byte-free absence attestation landed');

    const archived = callGetRecordVersion(store, a.id as string, startVersion);
    assert.ok(archived, 'the prior version is readable via (id, version)');
    assert.deepEqual((archived as Loose).file_baselines, (a as Loose).file_baselines, 'the archived snapshot preserves the PRIOR baseline, not the new one');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// PIN R9-STORE-2 — CAS + atomic rollback: a STALE expected_version refuses
// loudly naming BOTH the expected and actual versions, and changes NOTHING.
// This is also the deterministic angle on "atomic rollback": since a genuine
// mid-transaction interleave cannot be driven from a synchronous test
// harness without mocking an unknown-to-us internal primitive (H4 forbids
// knowing which), the CAS refusal IS the reachable, faithful proof that a
// concurrent write leaves the article untouched rather than partially
// stamped — see the sibling mcp-server file's note on why this pin lives
// here rather than being re-driven via a live race at the tools layer.
// SABOTAGE: drop the WHERE version=? clause (always overwrite) → this whole
// test goes red: no throw, and `after.version` reads as 3 with the
// "attemptedhash" baseline present.
// ===========================================================================
test('[R9-STORE-2] a STALE expected_version on updateRecordMetadata refuses, naming BOTH the expected and actual versions, and writes NOTHING (CAS + atomic rollback)', () => {
  const { dir, store } = tempStore();
  try {
    const a = store.create(article());
    const observedVersion = (a.version as number) ?? 1;
    // an intervening ordinary write bumps the real version, unseen by our caller.
    callUpdateRecord(store, a.id as string, { ...a, what_it_does: 'concurrently edited' });

    let caught: unknown;
    try {
      callUpdateRecordMetadata(
        store,
        a.id as string,
        { file_baselines: { 'src/a.ts': 'attemptedhash' } },
        { expected_version: observedVersion } // stale: real version has moved on
      );
      assert.fail('a stale expected_version must throw');
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof Error, 'the refusal is a real Error');
    const message = (caught as Error).message;
    assert.match(message, new RegExp(String(observedVersion)), 'names the EXPECTED (stale) version supplied by the caller');
    assert.match(message, new RegExp(String(observedVersion + 1)), 'names the ACTUAL current version');

    const after = store.query({ types: ['feature_article'], cap: 10 }).find((r) => r.id === a.id) as Loose;
    assert.equal(after.version, observedVersion + 1, 'version is exactly what the intervening write left it at — the refused call changed nothing');
    assert.notEqual((after.file_baselines as Loose | undefined)?.['src/a.ts'], 'attemptedhash', 'the refused write never landed on the record');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// PIN R9-STORE-3 — the clock guarantee: updated_at is PRESERVED across a
// metadata-only attestation write, even though version increments and
// content (file_baselines) changes. This is the anti-masking guarantee named
// in the board item: an advanced clock would let H7's mtime prefilter
// suppress OLDER genuine drift on a DIFFERENT path.
// SABOTAGE: stamp updated_at = activity_at (or `now()`) on this write path,
// the way an ordinary content update does → `patched.updated_at` reads LATER
// instead of NOW, and this test goes red on that single assertion.
// ===========================================================================
test('[R9-STORE-3] updateRecordMetadata PRESERVES the record\'s stored updated_at while version increments — the clock never advances on an attestation-only write', () => {
  const { dir, store } = tempStore();
  try {
    const a = store.create(article());
    assert.equal(a.updated_at, NOW, 'precondition: created at NOW');
    const startVersion = (a.version as number) ?? 1;

    const patched = callUpdateRecordMetadata(
      store,
      a.id as string,
      { file_baselines: { 'src/a.ts': 'newhash' } },
      { expected_version: startVersion, activity_at: LATER }
    );
    assert.equal(patched.version, startVersion + 1, 'version DID increment');
    assert.notDeepEqual(patched.file_baselines, (a as Loose).file_baselines, 'content DID change');
    assert.equal(patched.updated_at, NOW, 'updated_at is UNCHANGED — never advanced to activity_at, and never to "now"');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// PIN R9-STORE-4 — an ORDINARY content write (the generalized updateRecord
// path knowledge_update rides) CLEARS the WHOLE baseline_attestations map,
// including entries the write never mentions — a fresh content generation
// supersedes every standing attestation on the record, not just the touched
// path.
// SABOTAGE: only clear the attestation entry for a path present in the
// patch's own file set (a per-path clear instead of a whole-map clear) → the
// unrelated 'src/b.ts' entry survives the content write and this test's
// final assertion goes red.
// ===========================================================================
test('[R9-STORE-4] an ordinary content update (updateRecord) clears WHOLE byte and absence attestation maps — including entries the write never mentions', () => {
  const { dir, store } = tempStore();
  try {
    const a = store.create(article());
    const startVersion = (a.version as number) ?? 1;
    const attested = callUpdateRecordMetadata(
      store,
      a.id as string,
      {
        baseline_attestations: {
          'src/a.ts': { attested_at: NOW, item_id: 'i1', head_commit: 'a'.repeat(40), sha256: 'h1' },
          'src/b.ts': { attested_at: NOW, item_id: 'i2', head_commit: 'a'.repeat(40), sha256: 'h2' },
        },
        absence_attestations: {
          'src/gone.ts': { attested_at: NOW, item_id: 'i3', head_commit: 'a'.repeat(40) },
        },
      },
      { expected_version: startVersion }
    );
    assert.equal(Object.keys(attested.baseline_attestations as Loose).length, 2, 'precondition: two standing attestations, on two different paths');
    assert.equal(Object.keys(attested.absence_attestations as Loose).length, 1, 'precondition: one standing absence attestation');

    // the ordinary patch never MENTIONS baseline_attestations at all — only a
    // real content field changes, exactly like a knowledge_update call would send.
    const updated = callUpdateRecord(store, a.id as string, { ...a, what_it_does: 'a real content change' }, { expected_version: attested.version as number });
    const map = (updated.baseline_attestations as Loose | undefined) ?? {};
    assert.equal(Object.keys(map).length, 0, 'the WHOLE map is cleared, not just one path — a content generation invalidates every standing attestation on the record');
    const absenceMap = (updated.absence_attestations as Loose | undefined) ?? {};
    assert.equal(Object.keys(absenceMap).length, 0, 'the WHOLE absence map is cleared too — a content generation supersedes every historical tree-miss claim');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// PIN R9-STORE-5 (support pin — not one of the nine/six numbered pins, but
// stated as fact in the board item's "WHAT THE MECHANISM IS": the primitive
// is "restricted to a closed field set"). A caller attempting to smuggle an
// ordinary content field through this narrower primitive is refused, naming
// the field — updateRecordMetadata is not a back door around the normal
// content-update path.
// SABOTAGE: accept and apply any field passed to updateRecordMetadata
// verbatim (no field-set check) → the throw never happens and this test's
// assert.throws itself fails.
// ===========================================================================
test('[R9-STORE-5 support] updateRecordMetadata refuses a field outside its closed set {file_baselines, baseline_attestations}, naming it — it is not a general-purpose write path', () => {
  const { dir, store } = tempStore();
  try {
    const a = store.create(article());
    const startVersion = (a.version as number) ?? 1;
    assert.throws(
      () => callUpdateRecordMetadata(store, a.id as string, { title: 'sneak a content change through' } as unknown as MetaFields, { expected_version: startVersion }),
      (err: Error) => {
        assert.match(err.message, /title/, 'names the disallowed field');
        return true;
      }
    );
    const after = store.query({ types: ['feature_article'], cap: 10 }).find((r) => r.id === a.id) as Loose;
    assert.equal(after.version, startVersion, 'the refused call wrote nothing');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
