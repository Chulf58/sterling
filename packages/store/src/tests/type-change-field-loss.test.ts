// Board 9f8d4c03, residual (3): the `droppedKeyPaths` TYPE-CHANGE blind spot.
//
// HEADER CORRECTED AGAIN, 2026-08-31 (campaign S2d). Decision
// `droppedkeypaths-arms-kept-budgeted-one-shared-walker` (961e4842) adjudicated
// this file's shape: KEEP the type-change total-loss arms (they express the
// function's correct contract), BUDGET the walk as a MANDATORY condition of
// keeping them (a shared work/edge budget and an output-path budget across the
// WHOLE comparison, failing closed with a distinct error on exhaustion — never
// a partial list — and deliberately NO visited set, because a shared node
// legitimately owns multiple key paths that must all be reported), and narrow
// the export to `droppedKeyPaths(before, after)` — depth/output/budget
// plumbing is module-internal. This header is the "test file's false header is
// corrected in the same slice" half of that ruling.
//
// The 2026-08-30 correction (preserved in spirit below) fixed one false claim
// — that the type-change pins "cannot be constructed" — but left a second one
// standing: it said the five tests then in this file "address droppedKeyPaths
// as a directly-imported unit". They did not. Every one of them imported only
// `SterlingStore` and drove the walk through `store.create()`'s zod parse,
// which throws `invalid_type` on a genuine type mismatch on a schema-defined
// field before the loss walk ever runs — so a type-change arm was never once
// exercised from this file. That is exactly what 961e4842's evidence base
// (reachability + hollow-pin static audit, S0 2026-08-31) confirmed: the
// claimed direct-unit pins were STATICALLY HOLLOW.
//
// WHAT THIS FILE IS NOW, IN TWO PARTS:
//
// PART 1 — INTEGRATION PINS, through `SterlingStore.create()`. The five
// original tests are KEPT, relabeled honestly below: they pin real, live
// behavior — unknown-field refusal (scalar/array/object-valued, to depth 3)
// and the growth-via-schema-defaults fence — reachable from the real write
// path. They were never pins on `droppedKeyPaths`'s type-change arms and are
// not claimed as such anymore.
//
// PART 2 — DIRECT-IMPORT UNIT PINS on `droppedKeyPaths(before, after)`,
// written from decision 961e4842's contract (not from index.ts — H4 read
// wall): object->array and array->object as DISTINCT total-loss cases;
// scalar->container growth reporting ZERO loss (the mutation-killer for the
// scalar guard that board 7df896c9 found unpinned — the old pin's only
// witness was a default-added key, caught by unrelated code); a `before`
// array longer than `after`; a shared subtree reachable through two container
// paths reporting BOTH alias path sets (no visited set); the depth-bound
// cycle guard; and the slice's core new surface — budgets: benign
// realistic-body controls that must NOT trip a budget, and the three measured
// pathological fixtures (structure-sharing depth-22, fan-out-6 depth-9
// breadth, matching heavily-shared DAGs) that MUST fail closed with a
// distinguishable budget error, promptly, rather than hang or partial-report.
//
// Because these are written to the contract rather than to the code: the
// type-change arms, the depth bound, and the general work/edge + output-path
// budgets have ALL LANDED as of this slice — MEASURED, 2026-08-31: all 19
// tests in this file are GREEN at the current tree. The path-length cap (the
// last gap the review pair found) has landed, and the depth-bound error's
// message is confirmed to contain "depth" — see each test's own EXPECTED
// note for the confirmed wording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SterlingStore, droppedKeyPaths, renderCappedPathList } from '../index.js';

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

// ===========================================================================
// PART 1 — INTEGRATION PINS (through `SterlingStore.create()`).
// Real behavior, reachable from the real write path. NOT pins on
// `droppedKeyPaths`'s type-change arms — see the header.
// ===========================================================================
//
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
//            array value never reaches the total-loss enumeration and the blind
//            spot does not reproduce through create.
//   RED   -> the walk reports absence by recursing into the dropped subtree
//            unguarded, the total-loss emission swallows it, and the board
//            item reproduces here as live silent knowledge loss.
// SABOTAGE (CORRECTED — the line this named no longer exists): delete the
// `hasOwnProperty`-then-`emitTotalLoss` guard in the object walk (the
// mechanism that replaced the old `if (!(key in after)) out.push(...)` line
// this oracle used to name) -> red. (Not a single-guard survivor: this is the
// only guard that can report a stripped top-level key.)

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

// ===========================================================================
// PART 2 — DIRECT-IMPORT UNIT PINS on `droppedKeyPaths(before, after)`.
// Written from decision 961e4842's contract, not from index.ts (H4 read wall).
// Semantics under test: a path is LOST iff it is addressable in `before` and
// NOT addressable in `after`. Growth (scalar->container, schema defaults) is
// never loss.
// ===========================================================================

function buildSharedBinaryTree(depth: number): unknown {
  // `let x={v:1}; for(depth) x={a:x,b:x};` — the S2d probe's structure-sharing
  // fixture: 2^depth distinct PATHS over O(depth) actual objects.
  let x: unknown = { v: 1 };
  for (let i = 0; i < depth; i++) {
    x = { a: x, b: x };
  }
  return x;
}

function buildSharedFanoutChain(depth: number, fanout: number): unknown {
  // Same sharing trick, wider: `fanout` children at each of `depth` levels all
  // point at the SAME node, giving fanout^depth distinct PATHS over
  // O(depth*fanout) actual objects — memory-cheap to construct, exactly as
  // expensive to (mis)walk as a true fan-6/depth-9 tree.
  let node: unknown = { leaf: true };
  for (let d = 0; d < depth; d++) {
    const next: Record<string, unknown> = {};
    for (let i = 0; i < fanout; i++) {
      next[`c${i}`] = node;
    }
    node = next;
  }
  return node;
}

function buildRealisticRecordBody(fieldCount = 250): Record<string, unknown> {
  // "a few hundred keys, depth <= 8, no sharing" — the budget's benign-control
  // shape. Depth here is 4 (field -> nested -> deep -> deeper).
  const body: Record<string, unknown> = {};
  for (let i = 0; i < fieldCount; i++) {
    body[`field${i}`] = { nested: { value: i, deep: { deeper: `v${i}` } } };
  }
  return body;
}

// ---------------------------------------------------------------------------
// TYPE CHANGE = TOTAL LOSS, pinned as two DISTINCT arms.
// ---------------------------------------------------------------------------

test('TYPE CHANGE object->array is TOTAL LOSS: the container path and every path beneath it are reported', () => {
  const before = { root: { a: 1, b: { c: 2 } } };
  const after = { root: ['x', 'y'] };
  const lost = droppedKeyPaths(before, after).slice().sort();
  assert.deepEqual(lost, ['root', 'root.a', 'root.b', 'root.b.c'].sort());
});
// SABOTAGE: revert the object-before/array-after arm to bare `return out`
// (board 41ac749e's exact missing-pin regression) -> `lost` collapses to [],
// red here.
// EXPECTED: GREEN today — this arm shipped at 86e7a7d; this is its first
// direct-unit witness.

test('TYPE CHANGE array->object is TOTAL LOSS, pinned as a case DISTINCT from object->array', () => {
  const before = { root: ['x', 'y', { z: 1 }] };
  const after = { root: { note: 'now an object' } };
  const lost = droppedKeyPaths(before, after).slice().sort();
  assert.deepEqual(lost, ['root', 'root[0]', 'root[1]', 'root[2]', 'root[2].z'].sort());
});
// SABOTAGE: revert the array-before/object-after arm to bare `return out` ->
// `lost` collapses to [], red here — a DIFFERENT arm than the previous test's,
// so a fix to only one of the two leaves this one exposed.
// EXPECTED: GREEN today, same basis as above.

test('GROWTH IS NOT LOSS at the type level: scalar->container reports ZERO loss for that field', () => {
  const before = { note: 'hello' };
  const after = { note: { detail: 'hello', extra: 'grown' } };
  assert.deepEqual(droppedKeyPaths(before, after), []);
});
// SABOTAGE: make the scalar guard recurse into `after` instead of returning
// immediately (i.e. treat a scalar `before` value as though it owned `after`'s
// keys) -> `note.detail`/`note.extra` get reported as lost though they were
// never addressable in `before`, red here. This is the mutation-killer board
// 7df896c9 asked for: the OLD pin (a default-added key) cannot catch this
// because it never puts a scalar on the `before` side of a type change.
// EXPECTED: GREEN today — board 7df896c9 measured the code already correct
// here, only unpinned.

test('a `before` array LONGER than `after` reports the extra trailing indices as lost', () => {
  const before = { list: [1, 2, 3, 4] };
  const after = { list: [1, 2] };
  const lost = droppedKeyPaths(before, after).slice().sort();
  assert.deepEqual(lost, ['list[2]', 'list[3]'].sort());
});
// SABOTAGE: bound the array comparison by `after.length` instead of
// `before.length` -> `list[2]`/`list[3]` never get checked, `lost` stays [],
// red here.
// EXPECTED: GREEN — confirmed by the review pair (roster reviewer + Codex)
// against the implementation: the array comparison bounds its loop by
// `before.length`, so the extra trailing indices are already reported
// correctly.

test('a subtree reachable through TWO container paths reports BOTH alias path sets — there is no visited set', () => {
  const shared = { secret: 'v' };
  const before = { left: shared, right: shared };
  const after = {}; // both containers dropped entirely
  const lost = droppedKeyPaths(before, after).slice().sort();
  assert.deepEqual(lost, ['left', 'left.secret', 'right', 'right.secret'].sort());
});
// SABOTAGE: add a visited-set / identity-memoized skip so `shared` is walked
// only once -> `right`/`right.secret` (whichever alias is visited second)
// silently missing from `lost`, red here. This is the exact semantic reason
// decision 961e4842 REJECTS a visited set as a budget fix.
// EXPECTED: GREEN today — aliasing without a visited set predates this slice.

test('a true self-referencing cycle throws the depth-bound error PROMPTLY, and it is NOT a bare stack-overflow RangeError', () => {
  const before: Record<string, unknown> = { name: 'x' };
  before.self = before;
  const after = {}; // `self` entirely dropped -> total-loss enumeration walks the cycle
  const start = Date.now();
  assert.throws(() => droppedKeyPaths(before, after), (err: unknown) => {
    const e = err as Error;
    assert.ok(
      !(e instanceof RangeError),
      `a raw call-stack RangeError satisfies a bare assert.throws but is NOT the depth bound firing — that is the one property the bound exists to provide. Got: ${e?.constructor?.name}: ${e?.message}`
    );
    // CONFIRMED, 2026-08-31 (measured run): the depth-bound error's message is
    // "record body nesting exceeds the depth bound of 64 levels, deeper than
    // any legal record shape" — contains "depth", matched below.
    assert.match(e.message ?? '', /depth/i);
    return true;
  });
  assert.ok(Date.now() - start < 2000, 'the depth bound must fire promptly, not hang');
});
// SABOTAGE: remove the `depth > MAX_BODY_COMPARE_DEPTH` check from the
// recursive walk -> the call stack overflows instead, throwing a bare
// `RangeError` with no depth-bound wording; both the `instanceof RangeError`
// and the `/depth/i` assertions go red (previously a bare `assert.throws`
// with no predicate was satisfied by that exact RangeError, which is the
// hollow shape both reviewers found independently).
// EXPECTED: GREEN — CONFIRMED, 2026-08-31 (measured run): the depth-bound
// error's message ("record body nesting exceeds the depth bound of 64
// levels, deeper than any legal record shape") contains "depth".

// ---------------------------------------------------------------------------
// BUDGETS — the core new surface of this slice. BENIGN CONTROLS FIRST: a
// verdict of "threw" has more than one cause (a correctly-firing budget, or a
// budget so tight it refuses everything), so the controls below must PASS,
// for the opposite reason, before the exhaustion pins are trusted.
// ---------------------------------------------------------------------------

test('BENIGN CONTROL: a realistic record-sized body (250 fields, depth 4, no sharing) with NO loss completes without a budget error', () => {
  const before = buildRealisticRecordBody();
  const after = JSON.parse(JSON.stringify(before));
  assert.deepEqual(droppedKeyPaths(before, after), []);
});
// SABOTAGE: lower the work/edge budget below what ~250x4 nodes need -> this
// legitimate, realistic comparison starts throwing, red here. Exists so the
// exhaustion pins below cannot be satisfied by an implementation that simply
// refuses every comparison.
// EXPECTED: GREEN — the budget has landed and correctly does not trip on this
// realistic body; this control is what keeps the exhaustion pins below honest.

test('BENIGN CONTROL: the same realistic body with ONE real dropped field reports it fully, without a budget error', () => {
  const before = buildRealisticRecordBody();
  const after = JSON.parse(JSON.stringify(before)) as Record<string, unknown>;
  delete after.field150;
  const lost = droppedKeyPaths(before, after).slice().sort();
  assert.deepEqual(
    lost,
    ['field150', 'field150.nested', 'field150.nested.value', 'field150.nested.deep', 'field150.nested.deep.deeper'].sort()
  );
});
// SABOTAGE: same as above (too-tight budget throws instead of reporting), or
// an under-walk that stops before `field150.nested.deep.deeper` -> red here
// either way.
// EXPECTED: GREEN, same basis as above.

test('BUDGET: structure-sharing depth-22 fixture throws the budget error PROMPTLY instead of enumerating ~2^22 paths', () => {
  const before = { field: buildSharedBinaryTree(22) };
  const after = {}; // field dropped entirely -> total-loss enumeration of the shared subtree
  const start = Date.now();
  assert.throws(() => droppedKeyPaths(before, after), (err: unknown) => {
    assert.match((err as Error).message ?? '', /budget/i);
    return true;
  });
  assert.ok(Date.now() - start < 2000, `expected a prompt budget failure, took ${Date.now() - start}ms`);
});
// SABOTAGE: remove the work/edge budget charge from the recursive walk -> the
// S2d probe measured this fixture at 3.6s pre-fix (timeout at depth 24); the
// throw either never happens (assert.throws fails) or arrives too late (the
// wall-clock assertion fails).
// EXPECTED: GREEN — the work/edge budget has landed; this is its first
// direct-unit witness against the exact fixture that motivated it.

test('BUDGET: fan-out-6 depth-9 breadth fixture throws the budget error PROMPTLY instead of emitting ~6^9 paths', () => {
  const before = { field: buildSharedFanoutChain(9, 6) };
  const after = {};
  const start = Date.now();
  assert.throws(() => droppedKeyPaths(before, after), (err: unknown) => {
    assert.match((err as Error).message ?? '', /budget/i);
    return true;
  });
  assert.ok(Date.now() - start < 2000, `expected a prompt budget failure, took ${Date.now() - start}ms`);
});
// SABOTAGE: remove the OUTPUT-path budget (as distinct from the work budget)
// -> the S2d probe measured this shape at 6.9s / 22M emitted paths at real
// depth 9; either the process balloons memory building the output array or
// the wall-clock assertion fails.
// EXPECTED: GREEN — the output-path budget has landed; this is its first
// direct-unit witness.

// CHARGE COUNT (measured by the review pair against the landed budget
// implementation): buildSharedBinaryTree(22) compared against itself visits
// 12,582,912 nodes/edges against a 10,000,000-edge work budget — a ~26%
// margin. A future budget raise that crosses ~12.6M silently UN-PINS this
// test (it would complete instead of throwing); if the budget is ever
// raised, raise this fixture's depth too to keep a real margin.
test('BUDGET: structurally-identical heavily-shared DAGs throw on the WORK budget even though almost nothing is lost', () => {
  const before = { field: buildSharedBinaryTree(22) };
  const after = { field: buildSharedBinaryTree(22) }; // built separately: reference-distinct, structurally identical
  const start = Date.now();
  assert.throws(() => droppedKeyPaths(before, after), (err: unknown) => {
    assert.match((err as Error).message ?? '', /budget/i);
    return true;
  });
  assert.ok(Date.now() - start < 2000, `expected a prompt budget failure, took ${Date.now() - start}ms`);
});
// SABOTAGE: charge the work budget only on EMITTED loss rather than on every
// comparison edge walked -> this fixture emits ~0 paths (before/after match
// structurally), so an output-only budget never fires and the matching-DAG
// case hangs/burns CPU uncharged. This is the pin for "the work budget is
// charged even when nothing is being emitted" (decision 961e4842).
// EXPECTED: GREEN — the work budget has landed and is charged independent of
// output, per the measured charge count above.

test('BUDGET IS PER-CALL, NOT A MODULE-LEVEL COUNTER: an ordinary comparison right after a pathological one still succeeds', () => {
  assert.throws(() => droppedKeyPaths({ field: buildSharedBinaryTree(22) }, {}), (err: unknown) => {
    assert.match((err as Error).message ?? '', /budget/i);
    return true;
  });
  // Same process, immediately after exhaustion — this must NOT still be
  // refusing. If the budget's counter were module-scoped rather than
  // call-scoped, it would already be spent and this ordinary comparison
  // would either throw the stale budget error or silently mis-report.
  const before = { note: 'hello' };
  const after = { note: 'hello world' };
  assert.deepEqual(droppedKeyPaths(before, after), []);
});
// SABOTAGE: move the work/edge or output-path counter to module scope
// (initialized once at import time, never reset per call) instead of scoping
// it to the call -> this ordinary comparison, run immediately after the
// pathological one exhausted the counter, either throws the stale budget
// error or returns a wrong (truncated) result, red here.
// EXPECTED: GREEN — pins that the budget is scoped to the call, not to the
// module/process.

function buildOversizedPathSegments(levels: number, segmentBytes: number): unknown {
  // Reviewer-observed shape: keys whose own string content is multi-hundred-KB,
  // nested a few levels deep, so the ACCUMULATED PATH STRING — not the node
  // count and not the output-path count — is what explodes. The chain reuses
  // one shared string reference at every level, so building this fixture
  // stays cheap (O(levels) allocations) even though segmentBytes is large.
  const bigSegment = 'k'.repeat(segmentBytes);
  let node: unknown = { leaf: true };
  for (let d = 0; d < levels; d++) {
    node = { [bigSegment]: node };
  }
  return node;
}

test('BUDGET: oversized path segments (multi-hundred-KB keys, nested a few levels) throw the budget-class error, never a raw string-length RangeError', () => {
  const before = { field: buildOversizedPathSegments(20, 400_000) }; // ~8MB of accumulated key text per path
  const after = {}; // field dropped entirely -> total-loss enumeration must build the full path string
  const start = Date.now();
  assert.throws(() => droppedKeyPaths(before, after), (err: unknown) => {
    const e = err as Error;
    assert.ok(
      !(e instanceof RangeError) || !/invalid string length/i.test(e.message ?? ''),
      `must fail closed on the BUDGET, not surface a raw string-length RangeError. Got: ${e?.constructor?.name}: ${e?.message}`
    );
    assert.match(e.message ?? '', /budget/i);
    return true;
  });
  assert.ok(Date.now() - start < 2000, `expected a prompt budget failure, took ${Date.now() - start}ms`);
});
// SABOTAGE: charge the budget on node/edge count only, never on accumulated
// path-STRING length -> this fixture's individual edges are cheap to visit
// (20 edges, well under any edge budget) so no edge/output guard fires, and
// building the full path string either throws a raw
// `RangeError: Invalid string length` (V8's own ceiling, not this code's) or
// succeeds slowly with a multi-MB output entry — either way this pin goes red.
// EXPECTED: GREEN — CONFIRMED, 2026-08-31 (measured run): the path-length cap
// this pin was written for has landed, and this fixture (20 levels x 400KB)
// throws the budget-class error promptly rather than a raw string-length
// RangeError.

test('the budget error and the depth-bound cycle error are DISTINGUISHABLE from each other', () => {
  let budgetErr: Error | undefined;
  try {
    droppedKeyPaths({ field: buildSharedBinaryTree(22) }, {});
  } catch (err) {
    budgetErr = err as Error;
  }
  assert.ok(budgetErr, 'expected the structure-sharing fixture to throw');
  assert.match(budgetErr!.message ?? '', /budget/i);

  const cyclic: Record<string, unknown> = { name: 'x' };
  cyclic.self = cyclic;
  let depthErr: Error | undefined;
  try {
    droppedKeyPaths(cyclic, {});
  } catch (err) {
    depthErr = err as Error;
  }
  assert.ok(depthErr, 'expected the cycle fixture to throw');
  assert.ok(
    !(depthErr instanceof RangeError),
    `a raw stack-overflow RangeError is not the depth bound firing. Got: ${depthErr?.constructor?.name}: ${depthErr?.message}`
  );
  assert.match(depthErr!.message ?? '', /depth/i);
  assert.doesNotMatch(depthErr!.message ?? '', /budget/i);
});
// SABOTAGE: throw one shared error class/message for both the budget and the
// depth-bound failures -> `depthErr.message` starts matching /budget/i too,
// red here. Pins decision 961e4842's DISTINCTNESS requirement: a caller must
// be able to tell which resource was exhausted, without pinning exact text.
// EXPECTED: GREEN for both halves — CONFIRMED, 2026-08-31 (measured run): the
// budget mechanism has landed, and the depth-bound error's message ("record
// body nesting exceeds the depth bound of 64 levels, deeper than any legal
// record shape") contains "depth" and never "budget".

// ---------------------------------------------------------------------------
// renderCappedPathList(dropped, cap=20) — shared by assertNoFieldLoss AND
// domain-doctor's migrate refusal (final-review advisory pin). Unpadded
// numeric labels would let e.g. "path1" substring-match "path10", so the
// fixtures below use fixed-width, delimited labels that cannot alias.
// ---------------------------------------------------------------------------
test('renderCappedPathList caps rendered paths at 20 and pluralizes the overflow suffix correctly', () => {
  const label = (i: number) => `PATH_${String(i).padStart(2, '0')}_END`;

  const under = Array.from({ length: 3 }, (_, i) => label(i));
  const renderedUnder = renderCappedPathList(under);
  for (const p of under) assert.ok(renderedUnder.includes(p), `${p} must render when under the cap`);
  assert.doesNotMatch(renderedUnder, /more lost path/i, 'no overflow suffix when the count is <= cap');

  const at21 = Array.from({ length: 21 }, (_, i) => label(i));
  const rendered21 = renderCappedPathList(at21);
  for (let i = 0; i < 20; i++) assert.ok(rendered21.includes(at21[i]), `${at21[i]} is within the cap and must render`);
  assert.ok(!rendered21.includes(at21[20]), 'the 21st path must not render directly, only via the suffix count');
  assert.match(rendered21, /1 more lost path\b/, 'exactly 1 overflow must be SINGULAR — "1 more lost path"');

  const at22 = Array.from({ length: 22 }, (_, i) => label(i));
  const rendered22 = renderCappedPathList(at22);
  for (let i = 0; i < 20; i++) assert.ok(rendered22.includes(at22[i]));
  assert.ok(!rendered22.includes(at22[20]) && !rendered22.includes(at22[21]));
  assert.match(rendered22, /2 more lost paths\b/, '2+ overflow must be PLURAL — "2 more lost paths"');
});
// SABOTAGE (cap value): change the cap from 20 to any other number (e.g. 10 or
// 25) -> the count of directly-rendered paths in the 21/22-path cases shifts,
// so either an expected-rendered path (index < 20) goes missing or an
// expected-capped path (index >= 20) starts rendering directly, red here.
// SABOTAGE (ternary flip): swap the singular/plural branches (or drop the
// ternary and always say "paths") -> the 21-path case's suffix reads "1 more
// lost paths" instead of "1 more lost path", failing the singular regex —
// this is the exact reviewed bug this pin exists to catch.
// EXPECTED: GREEN — the function shipped correct; this is its first
// discriminating pin.
