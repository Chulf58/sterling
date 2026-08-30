// Board 9f8d4c03, residual (3): the `droppedKeyPaths` TYPE-CHANGE blind spot.
//
// HEADER CORRECTED 2026-08-30 — EVERYTHING BELOW THE LINE USED TO SAY THE
// OPPOSITE, AND IT WAS FALSE. The original text asserted that the type-change
// pins "cannot be constructed", that they are deliberately absent from this
// file, and that whether `droppedKeyPaths` was exported "was the blocking
// question". An independent review found all three claims stale: the function
// IS exported (packages/store/src/index.ts, `export function droppedKeyPaths`),
// unit-level pins for BOTH container arms are constructible today, and this
// file now contains them. It also cited index.ts:469/:476, line numbers that
// have since rotted.
//
// The correction is recorded rather than silently applied because a stale
// header is not a cosmetic defect: it is FALSE ASSURANCE of exactly the shape
// anti-pattern `artifact-asserts-unperformed-verification` names. A reader who
// trusted it would conclude the missing coverage was impossible rather than
// merely unwritten, and would not look again.
//
// WHAT IS ACTUALLY TRUE ABOUT REACHABILITY, which is the part worth keeping:
// through `SterlingStore.create()` and `MountedStores.create()` the body ends
// in a STRICT `entry.schema.parse(input)`. Zod's strip only ever REMOVES a key,
// never RETYPES one, and a genuine type mismatch on a schema-defined field
// throws `invalid_type` before the loss walk runs. So the type-change arms are
// hard to reach FROM CREATE — which is why these pins address `droppedKeyPaths`
// as a directly-imported unit. "Hard to reach through one caller" was never the
// same claim as "cannot be constructed", and collapsing the two is what made
// the original header wrong.
//
// STILL UNCOVERED, named here so the next reader does not have to re-derive it
// (from the same review): scalar->container specifically — mutating the scalar
// guard to enumerate `after` leaves all 12 tests green, so the "growth is not
// loss" fence is real in the code but NOT constrained by its pin, which
// exercises a default-added key caught by different code entirely. Also
// uncovered: array->object and object->array as distinct cases, a `before`
// array longer than `after`, and any direct pin on `allKeyPathsUnder` emitting
// both container and leaf addresses.
//
// WHAT THIS FILE IS: the CONTROL half of that investigation, made executable. It
// pins the contract that IS reachable here — an unknown field is REFUSED naming
// its path, whatever TYPE its value has — and its verdict is the evidence for
// whether the blind spot reproduces through create. If every test here is GREEN,
// the type-change defect does NOT reproduce at this entry point and the residual
// is latent code fragility, not live silent knowledge loss. Those two call for
// different fixes, so the distinction is load-bearing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore } from '../index.js';

const NOW = '2026-08-27T09:00:00.000Z';

function envelope(type: string) {
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
    stack_tags: ['node'],
  };
}

function article(over: Record<string, unknown> = {}) {
  return {
    ...envelope('feature_article'),
    slug: 'csv-export',
    title: 'CSV export',
    what_it_does: 'Exports the board as a CSV file for spreadsheets.',
    intended_behavior: 'User clicks Export and receives a CSV download.',
    files: [{ path: 'src/export/csv.ts', role: 'serializer' }],
    current_ac: [{ ac_id: 'AC1', text: 'export downloads a file', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [{ date: NOW, event: 'originating brief' }],
    live_test_refs: [],
    ...over,
  };
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'sterling-type-change-'));
}

// ---------------------------------------------------------------------------
// CONTROL ARM, PLACED FIRST, AND IT PASSES FOR THE OPPOSITE REASON.
// Every pin below asserts that a create THREW. On its own that verdict has more
// than one possible cause: a guard that refused this particular record, or a
// guard that refuses everything. This arm rules the second one out, so a green
// below always carries its evidence.
// ---------------------------------------------------------------------------
test('CONTROL: a clean record still CREATES — the pins below are not satisfied by blanket refusal', () => {
  const dir = tempDir();
  const store = new SterlingStore(join(dir, 'sterling.db'));
  try {
    const clean = article();
    assert.equal(store.create(clean).id, clean.id);
    assert.ok(store.get(clean.id), 'a clean create must still land');
    assert.equal(store.listActivityLog(50).length, 1, 'and must still write exactly one activity entry');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
// SABOTAGE: make assertNoFieldLoss throw unconditionally -> red here, while every
// pin below stays green. That is precisely the hollow shape this arm exists to catch.
// EXPECTED: GREEN today and after any correct fix.

test('an unknown key whose value is an ARRAY is refused and NAMED — container-valued loss is not exempt', () => {
  const dir = tempDir();
  const store = new SterlingStore(join(dir, 'sterling.db'));
  try {
    const input = article({ bogus: [{ a: 1 }, { b: 2 }] });
    const activityBefore = store.listActivityLog(50).length;
    assert.throws(
      () => store.create(input),
      (err: unknown) => {
        const message = (err as Error).message;
        assert.ok(
          message.includes('bogus'),
          `an ARRAY-valued unknown key must be named exactly like a scalar one — a caller cannot fix what it is not told. Got: ${message}`
        );
        assert.match(message, /NOTHING WAS WRITTEN/);
        return true;
      }
    );
    assert.equal(store.get(input.id), undefined, 'the refused record must not exist');
    assert.equal(store.listActivityLog(50).length, activityBefore, 'a refused create leaves no activity entry');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
// THIS TEST IS THE DIAGNOSTIC. Read its verdict before building anything:
//   GREEN -> the walk reports an unknown key by KEY-ABSENCE at the parent, so an
//            array value never reaches :469 and the blind spot does not reproduce
//            through create.
//   RED   -> the walk reports absence by recursing into
//            droppedKeyPaths(before[key], undefined), :469 swallows it, and the
//            board item reproduces here as live silent knowledge loss.
// SABOTAGE: delete the `if (!(key in after)) out.push(...)` line in the object
// branch -> red. (Not a single-guard survivor: this is the only guard that can
// report a stripped top-level key.)

test('an unknown key whose value is an OBJECT is refused and named at its FULL nested path', () => {
  const dir = tempDir();
  const store = new SterlingStore(join(dir, 'sterling.db'));
  try {
    const input = article({
      dependencies: { relies_on: [], relied_by: [], extra: { nested: 'lost before this guard' } },
    });
    assert.throws(
      () => store.create(input),
      (err: unknown) => {
        const message = (err as Error).message;
        assert.ok(
          message.includes('dependencies.extra'),
          `an OBJECT-valued unknown key must be named at its full path, not just at the top level. Got: ${message}`
        );
        return true;
      }
    );
    assert.equal(store.get(input.id), undefined);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
// SABOTAGE: make the walk top-level only (delete the recursive call in the object
// branch) -> red. Board e85ddb63 measured that exact mutation leaving all 117
// store tests green before the create-field-loss suite existed; this extends that
// oracle from an array-of-objects element to a plain nested object.

test('an unknown key nested THREE levels down, inside an array element, is refused and named', () => {
  const dir = tempDir();
  const store = new SterlingStore(join(dir, 'sterling.db'));
  try {
    // current_ac[0].untestable_because is a schema-defined OBJECT, so `deeper`
    // sits at depth 3: root -> current_ac[0] -> untestable_because -> deeper.
    // A guard that recurses one level past the array element still misses this.
    const input = article({
      current_ac: [
        {
          ac_id: 'AC1',
          text: 'export downloads a file',
          verifiable_at: 'final',
          untestable_because: {
            reason: 'blocked upstream',
            blocking_record_id: '00000000-0000-0000-0000-000000000000',
            deeper: 'vanishes silently at depth',
          },
        },
      ],
    });
    assert.throws(
      () => store.create(input),
      (err: unknown) => {
        const message = (err as Error).message;
        assert.ok(
          message.includes('current_ac[0].untestable_because.deeper'),
          `depth-3 loss must be named at its full path. Got: ${message}`
        );
        return true;
      }
    );
    assert.equal(store.get(input.id), undefined);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
// SABOTAGE (CORRECTED 2026-08-30 — the original oracle named the WRONG GUARD and
// is recorded here because a wrong oracle is worse than none: it sends the next
// reader to mutate a mechanism that does not carry this verdict, and a green run
// then reads as a hollow pin).
//
// THE VERDICT IS CARRIED BY THE ISSUE-PATH RENDERING DEPTH, NOT BY THE WALK.
// `current_ac[].untestable_because` is .strict() (packages/schemas/src/records.ts:90),
// so validateRecord's parse THROWS on `deeper` and assertNoFieldLoss NEVER RUNS
// for this input. The two shallower pins reach the strip-then-walk path instead —
// a different guard entirely, which is exactly why they pass while this one did not.
//
//   CORRECT SABOTAGE: truncate the zod issue-path reduce to 2 segments -> this pin
//   RED (reports `current_ac[0].deeper`, the middle segment dropped) while all four
//   others stay GREEN. That is the asymmetry this pin is for.
//
//   WHAT THE ORIGINAL SABOTAGE ACTUALLY DOES, measured: setting
//   MAX_BODY_COMPARE_DEPTH = 2 INVERTS the claimed result. The bound THROWS, and a
//   legal feature_article body is already 3 deep (`files[0].path`), so the CONTROL
//   and both shallower pins go RED while THIS pin stays GREEN. That was already
//   true at HEAD, independent of the fix that made this pin pass.
//
//   ALSO MEASURED: the truncating reading (`if (depth > 2) return out` inside the
//   walk) leaves all 5 green — this pin is not carried by the walk's depth and
//   structurally cannot be, because zod refuses before the walk is ever reached.

// ---------------------------------------------------------------------------
// GROWTH IS NOT LOSS — the fence around any fix for the type-change blind spot.
// Stated rather than assumed symmetric: the walk answers "which keys present in
// `before` are absent from `after`". A SCALAR before holds no keys, so
// scalar->array and scalar->object lose nothing; they GROW. Reporting them would
// be a false positive, and a false positive here is a REFUSED create. Zod
// DEFAULTS legitimately add keys the caller never sent, so a fix implemented as
// "report whenever typeof before !== typeof after" would start refusing valid
// records. This arm must stay green through that fix.
// ---------------------------------------------------------------------------
test('a schema DEFAULT that ADDS a key is not read as loss — one-directional containment holds', () => {
  const dir = tempDir();
  const store = new SterlingStore(join(dir, 'sterling.db'));
  try {
    // research_finding.source_urls carries a zod default, so the parse adds a key
    // the caller never sent.
    const finding = {
      ...envelope('research_finding'),
      question: 'does the platform rate-limit per org or per token?',
      answer: 'per-org',
      source_date: '2026-01-15',
      capture_date: '2026-08-01',
      volatility_hint: 'medium',
    };
    assert.equal(store.create(finding).id, finding.id, 'an added key must never be read as a dropped key');
    assert.ok(store.get(finding.id));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
// SABOTAGE: replace one-directional containment with round-trip EQUALITY, or drop
// the "before is a container" precondition when reporting a type change -> red here.
// EXPECTED: GREEN today, and this is the arm most likely to be broken by a careless
// fix for pins 1/2 of the brief.
