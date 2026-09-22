// THE ONE ASSEMBLER — contract pins (decision knowledge-delivery-target-
// design-no-delayed-delivery, 92088a62, delivery-migration step 3).
//
// A record marked "substance delivered" only when the assembler ACTUALLY
// emitted its substance into the final composed context — never because its
// UUID appeared in rendered text, and never because it was merely SELECTED.
// This file pins the pure `assembleDelivery`/`hazardParts` contract and the
// split substance/discovery guard directly (unit-level, no hook process);
// the last test is the cross-surface INTEGRATION regression the decision
// names explicitly: an H20 article pointer must not suppress a later H19
// full-article delivery for the same record.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import {
  assembleDelivery,
  hazardParts,
  recordRevision,
  emptyDeliveryGuard,
  isSubstanceDelivered,
  isDiscoveryDelivered,
  markSubstanceDelivered,
  markDiscoveryDelivered,
  DELIVERY_GUARD_VERSION,
  resolveTotalCap,
  DELIVERY_TOTAL_CAP_MIN,
  HAZARD_CAP,
  renderArticle,
  ownerPointer,
  hazardHeaderLine,
} from '../hooks/lib/delivery.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-09-20T12:00:00.000Z';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function envelope(type) {
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
  };
}

function antiPattern(title, paths, extra = {}) {
  return {
    ...envelope('anti_pattern'),
    title,
    trigger: `${title} trigger text`,
    guidance: `${title} guidance`,
    wrong_way: `${title} wrong way`,
    right_way: `${title} right way text`,
    source_evidence: `${title} evidence`,
    basis: 'codebase',
    file_keys: paths,
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

// ---------------------------------------------------------------------------
// full-field hazard equality — proves WHOLE, not prefix-truncated
// ---------------------------------------------------------------------------

test('assembler: a hazard beyond 2,400 chars renders whole under a tiny cap — full-field equality, not a prefix', () => {
  const startSentinel = 'TRIGGER_SENTINEL_START_7f3a';
  const endSentinel = 'TRIGGER_SENTINEL_END_9c1d';
  const rwStart = 'RIGHTWAY_SENTINEL_START_2b6e';
  const rwEnd = 'RIGHTWAY_SENTINEL_END_4d8f';
  const hazard = antiPattern('big-hazard', ['src/a.mjs'], {
    trigger: `${startSentinel} ${'t'.repeat(2500)} ${endSentinel}`,
    right_way: `${rwStart} ${'r'.repeat(2500)} ${rwEnd}`,
  });
  assert.ok(hazard.trigger.length > 2400 && hazard.right_way.length > 2400, 'fixture control: both fields exceed 2,400 chars');
  const parts = hazardParts([hazard], { fileKeys: ['src/a.mjs'] });
  // A 1-byte cap would clip any ORDINARY part to nothing — hazards are pinned
  // and unbudgeted, so the cap must never touch them.
  const assembled = assembleDelivery(parts, 1);
  assert.match(assembled.text, new RegExp(`${startSentinel}[\\s\\S]*${endSentinel}`), 'the trigger field is present in full, start to end');
  assert.match(assembled.text, new RegExp(`${rwStart}[\\s\\S]*${rwEnd}`), 'the right_way field is present in full, start to end');
  assert.deepEqual(assembled.emittedSubstance, [{ identity: hazard.id, revision: recordRevision(hazard) }]);
  assert.equal(assembled.emittedDiscovery.length, 0);
});

// A dropped local `const ELLIPSIS` once made every truncating byte clip throw.
// Hook catches swallowed that throw and lost the entire payload; node --check
// cannot detect the missing runtime binding, so this pins the exported surface.
test('clipToBytes regression: a truncating clip returns an ellipsis instead of throwing (the ELLIPSIS-not-defined class)', () => {
  const ascii = ownerPointer(`${'A'.repeat(400)}\nrest`, { id: 'ascii-owner' });
  const asciiHead = ascii.split('\n')[0];
  assert.equal(typeof ascii, 'string', 'a truncating owner pointer returns a value');
  assert.ok(asciiHead.endsWith('…'), 'the truncated ASCII owner line carries an ellipsis');

  const cjk = ownerPointer(`${'漢'.repeat(400)}\nrest`, { id: 'cjk-owner' });
  const cjkHead = cjk.split('\n')[0];
  assert.equal(typeof cjk, 'string', 'a truncating CJK owner pointer returns a value');
  assert.ok(!cjkHead.includes('�'), 'no replacement character — the clip never split a codepoint');
  assert.ok(Buffer.byteLength(cjkHead, 'utf8') <= 300, 'the clip respects its byte budget');
  assert.ok(cjkHead.endsWith('…'), 'the truncated CJK owner line carries an ellipsis');

  const tinyBudgetHeader = hazardHeaderLine({ id: 'tiny', title: 'long title', severity: 'warn' }, { clipTitleBytes: Buffer.byteLength('…', 'utf8') });
  assert.match(tinyBudgetHeader, /— '' \(full record:/, 'the ellipsis-sized title budget produces the original bare empty clip');
  assert.doesNotMatch(tinyBudgetHeader, /…/, 'the original small-budget branch deliberately omits the ellipsis');
});

// ---------------------------------------------------------------------------
// 0, 1, 3 and 4 hazards — HAZARD_CAP holds the line; 4 is the one that must
// state the omitted count.
// ---------------------------------------------------------------------------

test('assembler: hazardParts at 0, 1, 3 and 4 hazards — the cap holds and only 4 states an omitted count', () => {
  assert.equal(HAZARD_CAP, 3, 'fixture control: the pin below assumes the shipped cap');
  for (const count of [0, 1, 3]) {
    const hazards = Array.from({ length: count }, (_, i) => antiPattern(`hz-${count}-${i}`, ['src/a.mjs']));
    const parts = hazardParts(hazards, { fileKeys: ['src/a.mjs'] });
    assert.equal(parts.length, count, `${count} hazard(s): exactly ${count} part(s), no disclosure line`);
    assert.ok(parts.every((p) => p.contentClass === 'substance' && p.identity), `${count} hazard(s): every part carries a substance identity`);
  }
  const four = Array.from({ length: 4 }, (_, i) => antiPattern(`hz4-${i}`, ['src/a.mjs']));
  const fourParts = hazardParts(four, { fileKeys: ['src/a.mjs'] });
  assert.equal(fourParts.length, 4, '3 substance parts plus 1 chrome disclosure part');
  assert.equal(fourParts.filter((p) => p.contentClass === 'substance').length, 3, 'only HAZARD_CAP hazards are substance');
  const disclosure = fourParts.find((p) => p.contentClass === 'chrome');
  assert.ok(disclosure, 'the 4th hazard is disclosed, not silently dropped');
  assert.match(disclosure.text, /1 more hazard\(s\) NOT shown \(cap 3\)/);
  assert.ok(!disclosure.identity, 'the disclosure line itself earns no identity — it is chrome, not a record');
});

// ---------------------------------------------------------------------------
// discovery -> substance progression
// ---------------------------------------------------------------------------

test('guard: a record shown only as discovery still qualifies for substance later; a re-versioned record qualifies again', () => {
  const guard = emptyDeliveryGuard();
  assert.equal(guard.version, DELIVERY_GUARD_VERSION);
  const record = { id: randomUUID(), updated_at: NOW };

  markDiscoveryDelivered(guard, [{ identity: record.id, revision: recordRevision(record) }]);
  assert.ok(isDiscoveryDelivered(guard, record));
  assert.ok(!isSubstanceDelivered(guard, record), 'a discovery mark alone never counts as substance');

  markSubstanceDelivered(guard, [{ identity: record.id, revision: recordRevision(record) }]);
  assert.ok(isSubstanceDelivered(guard, record), 'the SAME record now qualifies for substance too');

  // Forward-fix: the record's content changes (updated_at bumps) without a
  // new id — decision 92088a62's STATE clause says it qualifies again.
  const revised = { id: record.id, updated_at: '2026-09-21T00:00:00.000Z' };
  assert.ok(!isSubstanceDelivered(guard, revised), 're-versioned content is not the same (id, revision) pair — it is fresh again');
});

// fix-round HIGH 3: recordRevision must key PRIMARILY on the store-managed
// `version`, not the caller-influenced `updated_at` — an in-place update that
// resubmits an EQUAL or a DECREASING timestamp must still be a fresh revision
// as long as `version` moved (which the store guarantees on every real write:
// `nextVersion = identity.version + 1`, packages/store/src/index.ts).
test('recordRevision: keyed on version, not updated_at — a same-id update with an EQUAL or DECREASING timestamp is still a fresh revision', () => {
  const base = { id: randomUUID(), version: 1, updated_at: '2026-09-20T12:00:00.000Z' };
  const sameTimestamp = { id: base.id, version: 2, updated_at: base.updated_at };
  const decreasingTimestamp = { id: base.id, version: 2, updated_at: '2020-01-01T00:00:00.000Z' };
  assert.notEqual(recordRevision(base), recordRevision(sameTimestamp), 'a version bump is a new revision even with an unchanged updated_at');
  assert.notEqual(recordRevision(base), recordRevision(decreasingTimestamp), 'a version bump is a new revision even with a DECREASING updated_at');

  const guard = emptyDeliveryGuard();
  markSubstanceDelivered(guard, [{ identity: base.id, revision: recordRevision(base) }]);
  assert.ok(!isSubstanceDelivered(guard, sameTimestamp), 'same updated_at, bumped version: NOT the marked revision — re-qualifies for delivery');
  assert.ok(!isSubstanceDelivered(guard, decreasingTimestamp), 'decreasing updated_at, bumped version: NOT the marked revision — re-qualifies for delivery');
});

// ---------------------------------------------------------------------------
// cap omission then later delivery
// ---------------------------------------------------------------------------

test('assembler: a record dropped for cap is NOT marked, and delivers in full on a later, larger-budget call', () => {
  const id = randomUUID();
  // No `pointer`/`suffix` fallback on purpose: with nothing to degrade to,
  // a part that does not fit is folded whole into the omission, exercising
  // `omitted`/`omittedCount` directly rather than the excerpt-then-pointer
  // degrade path (covered separately above).
  const bigPart = { kind: 'ordinary', contentClass: 'discovery', identity: id, revision: 'r1', text: `owner line ${'x'.repeat(2000)}` };
  const first = assembleDelivery([bigPart], 50);
  assert.equal(first.omittedCount, 1);
  assert.deepEqual(first.omitted, [{ identity: id, revision: 'r1' }]);
  assert.ok(!first.emittedDiscovery.some((e) => e.identity === id), 'omitted for cap: no mark spent');
  assert.ok(first.degraded);

  const second = assembleDelivery([bigPart], 3000);
  assert.deepEqual(second.emittedDiscovery, [{ identity: id, revision: 'r1' }], 'the SAME record delivers in full once the budget allows it');
  assert.equal(second.omittedCount, 0);
  assert.equal(second.degraded, false);
});

test('assembler: a record degraded to a bare pointer (fits, but not in full) is NOT marked either — pointer-only never spends a mark', () => {
  const id = randomUUID();
  const part = {
    kind: 'ordinary', contentClass: 'discovery', identity: id, revision: 'r1',
    text: `owner line ${'x'.repeat(2000)}`,
    pointer: `knowledge_get ${id}`,
  };
  const assembled = assembleDelivery([part], 50);
  assert.match(assembled.text, new RegExp(`knowledge_get ${id}`), 'the bare pointer still renders — the reader is not left with nothing');
  assert.equal(assembled.omittedCount, 0, 'this is a DEGRADE, not an omission');
  assert.ok(!assembled.emittedDiscovery.some((e) => e.identity === id), 'a pointer-only rendering never consumes a substance/discovery mark');
});

// ---------------------------------------------------------------------------
// chrome is never counted as a record
// ---------------------------------------------------------------------------

test('assembler: chrome never earns a delivery mark, even when it carries identity fields and record-shaped text', () => {
  const id = randomUUID();
  const chromePart = {
    kind: 'ordinary', pinned: true, contentClass: 'chrome',
    identity: id, revision: 'r1', // a caller mistake, or a framing line that happens to name an id
    text: `STERLING DEFAULT RETURN CONTRACT — mentions knowledge_get ${id} in passing`,
  };
  const assembled = assembleDelivery([chromePart], 3000);
  assert.match(assembled.text, /STERLING DEFAULT RETURN CONTRACT/, 'the chrome text itself still renders');
  assert.equal(assembled.emittedSubstance.length, 0);
  assert.equal(assembled.emittedDiscovery.length, 0);
});

// ---------------------------------------------------------------------------
// tiny cap, disabled cap, schema-minimum cap
// ---------------------------------------------------------------------------

// SUPERSEDED 2026-09-20 (fix-round HIGH 4): the old title/assertions here
// ("still renders hazards and pinned chrome whole") canonized exactly the bug
// the fix round names — pinned chrome was NEVER clipped or dropped, so an
// oversized pinned part could blow both the configured cap and the hard
// transport ceiling while reporting `degraded: false`. Hazards stay exempt
// from the CONFIGURED cap (`capBytes`, decision 301d8a0a) — that part of the
// old assertion survives — but pinned chrome is now bounded like any other
// content when it does not fit, and both are still bound by the separate,
// unwaivable transport ceiling (see the transport-overflow tests below).
test('assembler: a tiny capBytes leaves a hazard whole (exempt from the CONFIGURED cap) but degrades chrome and ordinary content that do not fit it', () => {
  const hazard = antiPattern('tiny-cap-hazard', ['src/a.mjs']);
  const chrome = { kind: 'ordinary', pinned: true, contentClass: 'chrome', text: 'RETURN CONTRACT LINE' };
  const owner = { kind: 'ordinary', contentClass: 'substance', identity: randomUUID(), revision: 'r1', text: `owner body ${'y'.repeat(500)}` };
  const assembled = assembleDelivery([...hazardParts([hazard]), chrome, owner], 5);
  assert.match(assembled.text, new RegExp(hazard.trigger), 'the hazard is exempt from the tiny CONFIGURED cap, unlike chrome/ordinary');
  assert.doesNotMatch(assembled.text, /RETURN CONTRACT LINE/, 'chrome no longer bypasses a cap it cannot fit (fix-round HIGH 4)');
  assert.equal(assembled.emittedSubstance.some((e) => e.identity === owner.identity), false, 'the owner body does not survive a 5-byte cap');
  assert.ok(assembled.degraded, 'dropping chrome and the owner body must be reported as degraded');
});

// ---------------------------------------------------------------------------
// fix-round HIGH 1 / HIGH 4 — the hard transport ceiling (decision 92088a62
// NOT GUARANTEED clause: "Claude Code persists hook output over 10,000 chars
// ... oversized hidden substance is a degraded notice and is not marked
// delivered"), independent of any CONFIGURED cap.
// ---------------------------------------------------------------------------

test('assembler: two 5,000-byte records under a DISABLED cap (0) together exceed the transport ceiling — the overflowed one is a degraded notice, unmarked', () => {
  const a = { kind: 'ordinary', contentClass: 'substance', identity: randomUUID(), revision: 'r1', text: 'A'.repeat(5000), pointer: 'knowledge_get a-overflow' };
  const b = { kind: 'ordinary', contentClass: 'substance', identity: randomUUID(), revision: 'r1', text: 'B'.repeat(5001), pointer: 'knowledge_get b-overflow' };
  const assembled = assembleDelivery([a, b], 0);
  assert.ok(Buffer.byteLength(assembled.text, 'utf8') <= 10000, `the composed text must never exceed the transport ceiling even under a disabled cap (was ${Buffer.byteLength(assembled.text, 'utf8')})`);
  const credited = new Set(assembled.emittedSubstance.map((e) => e.identity));
  assert.ok(credited.has(a.identity) !== credited.has(b.identity), 'exactly one of the two records survives whole — the other is a degraded notice, not a false mark');
  assert.ok(assembled.degraded);
});

test('assembler: a single 11,000-byte hazard exceeds the transport ceiling alone — it degrades to a notice and is NOT marked substance-delivered', () => {
  const hazard = antiPattern('oversize-hazard', ['src/a.mjs'], { trigger: 'T'.repeat(6000), right_way: 'R'.repeat(6000) });
  assert.ok(Buffer.byteLength(hazard.trigger, 'utf8') + Buffer.byteLength(hazard.right_way, 'utf8') > 10000, 'fixture control: the hazard block alone exceeds the transport ceiling');
  const assembled = assembleDelivery(hazardParts([hazard]), 0);
  assert.ok(Buffer.byteLength(assembled.text, 'utf8') <= 10000, `the degraded notice must fit the transport ceiling (was ${Buffer.byteLength(assembled.text, 'utf8')})`);
  assert.equal(assembled.emittedSubstance.length, 0, 'an oversized hazard earns NO substance mark — it stays eligible for a real delivery later');
  assert.match(assembled.text, /TOO LARGE to show/i, 'the reader gets a degraded notice, not silence');
  assert.ok(assembled.degraded);
});

// fix-round HIGH 1 (repair round) — the omitted-count disclosure itself must
// never silently vanish. Exact reviewer reproduction: a near-10KB whole
// hazard plus a small second hazard under a disabled cap left NO ordinary/
// chrome content to evict to make room for the "+N more" line, and the old
// eviction-only logic gave up rather than shrink the already-embedded whole
// hazard — the disclosure disappeared even though `omittedCount` correctly
// said 1.
test('assembler: with nothing ordinary to evict, a near-10KB hazard is degraded to its OWN notice so the omitted-count disclosure is never silently dropped', () => {
  const hazard1 = { kind: 'hazard', contentClass: 'substance', identity: 'h1', revision: 'r1', text: 'A'.repeat(9990), pointer: 'H1 TOO LARGE to show' };
  const hazard2 = { kind: 'hazard', contentClass: 'substance', identity: 'h2', revision: 'r1', text: 'B'.repeat(100), pointer: 'H2 held back' };
  const assembled = assembleDelivery([hazard1, hazard2], 0);
  assert.ok(Buffer.byteLength(assembled.text, 'utf8') <= 10000, `the composed text must still fit the transport ceiling (was ${Buffer.byteLength(assembled.text, 'utf8')})`);
  assert.equal(assembled.omittedCount, 1, 'hazard2 is omitted');
  assert.match(assembled.text, /\+1 more records/, 'the omission is DISCLOSED — the exact defect this test pins: the disclosure used to vanish entirely here');
  assert.equal(assembled.emittedSubstance.length, 0, 'neither hazard survives IN FULL — hazard1 was degraded to make room, hazard2 was omitted — so neither earns a false substance mark');
  assert.ok(assembled.degraded);
});

// SUPERSEDED 2026-09-20 (fix-round HIGH 1): the old body constructed two
// 5,000-byte records (10,000+ bytes together, before separators) under a
// disabled cap and asserted BOTH were credited whole — exactly the false-mark
// bug the fix round reports ("a disabled cap must still respect the hard
// transport ceiling"). Old assertions:
// `assert.equal(assembled.omittedCount, 0); assert.deepEqual(assembled.
// emittedSubstance, [{identity: a.identity, revision:'r1'}]); assert.
// deepEqual(assembled.emittedDiscovery, [{identity: b.identity,
// revision:'r1'}]);` — replaced below with a fixture that fits comfortably
// under the transport ceiling, so "disabled cap credits everything WHEN IT
// FITS" is still pinned; the over-ceiling case moved to its own dedicated
// test above (two 5,000-byte records... exceed the transport ceiling).
test('assembler: a disabled cap (0) emits everything whole and credits every record, WHEN it fits under the transport ceiling', () => {
  const a = { kind: 'ordinary', contentClass: 'substance', identity: randomUUID(), revision: 'r1', text: 'A'.repeat(2000) };
  const b = { kind: 'ordinary', contentClass: 'discovery', identity: randomUUID(), revision: 'r1', text: 'B'.repeat(2000) };
  const assembled = assembleDelivery([a, b], 0);
  assert.equal(assembled.omittedCount, 0);
  assert.deepEqual(assembled.emittedSubstance, [{ identity: a.identity, revision: 'r1' }]);
  assert.deepEqual(assembled.emittedDiscovery, [{ identity: b.identity, revision: 'r1' }]);
});

test('resolveTotalCap: a misconfigured tiny positive cap is floored to the schema minimum; 0 stays the unclamped disable sentinel', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-cap-min-'));
  try {
    mkdirSync(join(dir, '.sterling'), { recursive: true });
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ delivery: { total_cap_bytes: 1 } }));
    assert.equal(resolveTotalCap(dir), DELIVERY_TOTAL_CAP_MIN, 'a tiny misconfigured cap cannot degrade delivery to nothing while still spending marks');

    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ delivery: { total_cap_bytes: 0 } }));
    assert.equal(resolveTotalCap(dir), 0, '0 remains the documented, unclamped "no cap" sentinel');

    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ delivery: { total_cap_bytes: 20000 } }));
    assert.equal(resolveTotalCap(dir), 20000, 'a generous cap is never clamped DOWN');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// THE REGRESSION TEST FOR THIS WHOLE STEP: an H20 article POINTER must not
// suppress a later H19 FULL article delivery for the same record — the exact
// shape of the rejected UUID-scanning design's failure (an H20 pointer
// counted as delivery and suppressed the later full H19 article).
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

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h20-h19-regress-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ delivery: { injection_rung: 'read' } }));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

const conductorGuard = (dir) => join(dir, '.sterling', 'transient', 'delivery', 's1', 'guard-conductor.json');

test('REGRESSION: an H20 article pointer does NOT suppress the later full H19 article for the same record', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    // A subject match needs real, repeated, discriminating vocabulary — two
    // distinct terms that are central to the article's own narrow fields.
    const a = store.create(
      article('quokkaburst-widget', ['src/a.mjs'], {
        title: 'quokkaburst widget subsystem',
        what_it_does: 'quokkaburst widget subsystem handles quokkaburst widget rendering end to end',
      })
    );
    writeFileSync(join(dir, 'src', 'a.mjs'), 'x\n');

    // 1) H20 (dispatch) fires on the SUBJECT — delivers a POINTER only.
    const dispatch = runHook(
      'h20-mechanism-axis.mjs',
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Task',
        tool_input: { subagent_type: 'general-purpose', prompt: 'Please investigate the quokkaburst widget subsystem behavior.', description: 'x' },
        session_id: 's1',
        cwd: dir,
      },
      dir
    );
    assert.equal(dispatch.code, 0, dispatch.stderr);
    const dispatchCtx = dispatch.stdout.trim() ? JSON.parse(dispatch.stdout).hookSpecificOutput?.additionalContext ?? '' : '';
    assert.match(dispatchCtx, new RegExp(a.id), 'CONTROL: H20 matched the article and pointed at its id');
    assert.doesNotMatch(dispatchCtx, /WHAT IT DOES:/, 'CONTROL: H20 delivers a POINTER, never the article body');

    // 2) H19 Read of the article's OWNED file must still deliver the FULL
    // article — the H20 pointer must not have spent its substance mark.
    const read = runHook(
      'h19-knowledge-delivery.mjs',
      { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: join(dir, 'src/a.mjs') }, session_id: 's1', cwd: dir },
      dir
    );
    assert.equal(read.code, 0, read.stderr);
    const readCtx = JSON.parse(read.stdout).hookSpecificOutput.additionalContext;
    assert.match(readCtx, /quokkaburst widget subsystem handles quokkaburst widget rendering end to end/, 'the FULL article body still delivers — the H20 pointer did not suppress it');

    const guard = JSON.parse(readFileSync(conductorGuard(dir), 'utf8'));
    assert.ok(guard.discovery.some((e) => e.id === a.id), 'H20 recorded a DISCOVERY mark for the article');
    assert.ok(guard.substance.some((e) => e.id === a.id), 'H19 recorded a SUBSTANCE mark for the article — the two ledgers are independent');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// fix-round HIGH 2 — renderArticle used to pre-clip WHAT IT DOES/INTENDED
// BEHAVIOR to `payload_char_cap` (2400) BEFORE the assembler ever saw the
// field, so a body between that cap and ARTICLE_BODY_FLOOR (4096) was
// silently cut with no disclosure and still credited as fully-emitted
// substance. `renderArticle` now renders the field whole and lets the
// assembler own degradation.
// ---------------------------------------------------------------------------

test('HIGH 2: an article body between payload_char_cap (2400) and ARTICLE_BODY_FLOOR (4096) delivers WHOLE and earns a real substance mark — no more silent pre-clip', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    // total_cap_bytes is raised so this fixture can test complete field
    // delivery rather than cap degradation.
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ delivery: { injection_rung: 'read', total_cap_bytes: 8000 } }));
    const bodyEndSentinel = 'BODY_END_SENTINEL_7f3a2b';
    const body = `BODY_START_SENTINEL ${'w'.repeat(3400)} ${bodyEndSentinel}`;
    assert.ok(body.length > 2400 && body.length <= 4096, 'fixture control: body sits strictly between the old charCap and the digest floor');
    const a = store.create(article('mid-size-article', ['src/a.mjs'], { what_it_does: body }));
    writeFileSync(join(dir, 'src', 'a.mjs'), 'x\n');
    const r = runHook('h19-knowledge-delivery.mjs', { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: join(dir, 'src/a.mjs') }, session_id: 's1', cwd: dir }, dir);
    assert.equal(r.code, 0, r.stderr);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, new RegExp(bodyEndSentinel), 'the tail of the body — past the OLD 2400-char clip point — must arrive: the field is no longer pre-truncated');
    const guard = JSON.parse(readFileSync(conductorGuard(dir), 'utf8'));
    assert.ok(guard.substance.some((e) => e.id === a.id), 'the whole body earns a genuine substance mark');
  } finally {
    cleanup();
  }
});

test('HIGH 2: an OVERSIZE article (past ARTICLE_BODY_FLOOR) renders as a DIGEST and earns a DISCOVERY mark, never substance', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    // total_cap_bytes is raised — see the identical note in the mid-size-article
    // test above.
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ delivery: { injection_rung: 'read', total_cap_bytes: 8000 } }));
    const bigBody = `BODY_START ${'z'.repeat(5000)} BODY_END`;
    assert.ok(bigBody.length > 4096, 'fixture control: body exceeds ARTICLE_BODY_FLOOR');
    const a = store.create(article('oversize-article', ['src/a.mjs'], { what_it_does: bigBody }));
    writeFileSync(join(dir, 'src', 'a.mjs'), 'x\n');
    const r = runHook('h19-knowledge-delivery.mjs', { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: join(dir, 'src/a.mjs') }, session_id: 's1', cwd: dir }, dir);
    assert.equal(r.code, 0, r.stderr);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /digested — full body is/, 'CONTROL: the digest branch actually rendered');
    const guard = JSON.parse(readFileSync(conductorGuard(dir), 'utf8'));
    assert.ok(!guard.substance.some((e) => e.id === a.id), 'a DIGEST is never substance — it is explicitly a partial, disclosed view');
    assert.ok(guard.discovery.some((e) => e.id === a.id), 'a digest earns a discovery mark instead');
  } finally {
    cleanup();
  }
});

test('HIGH 2: a reference_material owner (renderReference — a pointer only) earns a DISCOVERY mark, never substance', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    // reference_material has NO file_keys field (packages/schemas/src/
    // records.ts:1568) — for kind:'doc' its own `location` doubles as the
    // file key (§3.2.5), so a repo-relative location is what joins it to
    // 'src/a.mjs' here.
    const ref = store.create({
      id: randomUUID(), type: 'reference_material', created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active',
      superseded_by: null, links: [], scope: 'project', stack_tags: [],
      title: 'External API doc', kind: 'doc', location: 'src/a.mjs', summary: 'a pointer, not the content',
      source_date: '2026-09-20', capture_date: '2026-09-20',
    });
    writeFileSync(join(dir, 'src', 'a.mjs'), 'x\n');
    const r = runHook('h19-knowledge-delivery.mjs', { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: join(dir, 'src/a.mjs') }, session_id: 's1', cwd: dir }, dir);
    assert.equal(r.code, 0, r.stderr);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /▸ reference 'External API doc'/, 'CONTROL: the reference pointer actually rendered');
    const guard = JSON.parse(readFileSync(conductorGuard(dir), 'utf8'));
    assert.ok(!guard.substance.some((e) => e.id === ref.id), 'a reference_material pointer is never substance');
    assert.ok(guard.discovery.some((e) => e.id === ref.id), 'a reference_material pointer earns a discovery mark instead');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// fix-round MEDIUM 5 — an early `.slice(0, HAZARD_CAP)`/`cappedHazards(...)`
// call ahead of `hazardParts` hands it an already-≤3 list, so its own
// internal cap becomes a no-op and the "N more hazard(s) NOT shown"
// disclosure never fires even when the true candidate count was higher.
// Fixture: the SAME boolean/modifier/mesh/manifold/topology/solver
// centrality-proven vocabulary h20-centrality.test.mjs pins, on 4 distinct
// anti_pattern records so H20's subject-match axis floors clear reliably.
// ---------------------------------------------------------------------------

test('MEDIUM 5: H20 subject-matched hazards beyond HAZARD_CAP (4) state the omitted count, never silently truncate to 3', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const title = 'Boolean modifier mesh manifold topology solver stability failure';
    const trigger =
      'boolean modifier boolean modifier mesh manifold mesh manifold topology solver topology solver ' +
      'recur constantly though this bug rarely touches a game field cell during setup work';
    const ids = [];
    for (let i = 0; i < 4; i++) {
      ids.push(store.create(antiPattern(`${title} case ${i}`, [], { trigger: `${trigger} case ${i}`, severity: 'warn' })).id);
    }
    const prompt =
      'Investigate why the boolean operation corrupts the mesh: check whether the modifier stack introduces non-manifold geometry that breaks downstream processing.';
    const r = runHook(
      'h20-mechanism-axis.mjs',
      { hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { subagent_type: 'general-purpose', prompt, description: 'x' }, session_id: 's1', cwd: dir },
      dir
    );
    assert.equal(r.code, 0, r.stderr);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    const shownCount = ids.filter((id) => ctx.includes(id)).length;
    assert.equal(shownCount, 3, `expected exactly HAZARD_CAP (3) hazards rendered whole; ctx=${ctx}`);
    assert.match(ctx, /1 more hazard\(s\) NOT shown \(cap 3\)/, 'the 4th matched hazard is disclosed as an omitted count, not silently dropped');
  } finally {
    cleanup();
  }
});

test('MEDIUM 5: dispatch staging discloses hazards beyond HAZARD_CAP too', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    // hazardParts must receive the full candidate list, not a pre-capped slice.
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ delivery: { injection_rung: 'read' } }));
    const ids = [];
    const expectedTriggers = [];
    const expectedRightWays = [];
    for (let i = 0; i < 4; i++) {
      const trigger = `TRG${i} first ${'t'.repeat(2501)} TRIGGER_END_${i}`;
      const rightWay = `RW${i} first ${'r'.repeat(2501)} RIGHT_WAY_END_${i}`;
      expectedTriggers.push(trigger);
      expectedRightWays.push(rightWay);
      ids.push(store.create(antiPattern(`hazard-${i}`, ['src/a.mjs'], { severity: 'warn', trigger, right_way: rightWay })).id);
    }
    writeFileSync(join(dir, 'src', 'a.mjs'), 'x\n');
    const transcript = spawnSync(process.execPath, [join(HOOKS, 'h22-dispatch-register.mjs')], {
      input: JSON.stringify({
        hook_event_name: 'PreToolUse', tool_name: 'Task', tool_use_id: `toolu_${randomUUID().slice(0, 8)}`,
        tool_input: { subagent_type: 'general-purpose', prompt: 'Go work on src/a.mjs and report back.', description: 'x' },
        session_id: 's1', cwd: dir, transcript_path: join(dir, 'no-such-transcript.jsonl'), prompt_id: 'p1',
      }),
      encoding: 'utf8', cwd: dir, timeout: 60_000,
    });
    assert.notEqual(transcript.status, 2, transcript.stderr);
    const r = runHook(
      'h19-dispatch-staging.mjs',
      { hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'agent-1', agent_type: 'general-purpose', cwd: dir, transcript_path: join(dir, 'no-such-transcript.jsonl') },
      dir
    );
    assert.equal(r.code, 0, r.stderr);
    const ctx = r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput?.additionalContext ?? '' : '';
    const shownCount = ids.filter((id) => ctx.includes(id)).length;
    assert.equal(shownCount, 3, `expected exactly HAZARD_CAP (3) path hazards selected and named on the staging surface; ctx=${ctx}`);
    assert.match(ctx, /1 more hazard\(s\) NOT shown \(cap 3\)/, 'the 4th path hazard is disclosed as an omitted count, not silently dropped');
    // delivery-floor-and-transport-ceiling-constants: the 10,000-byte
    // transport ceiling applies even when hazards are exempt from the configured
    // cap. These >5KB whole hazards therefore cannot all coexist. Pin the
    // behavior — at least one whole field pair, the rest named by a degraded
    // pointer — rather than an incidental exact count that fixture sizes could
    // change.
    let admitted = 0;
    for (let i = 0; i < 4; i++) {
      if (!ctx.includes(ids[i])) continue;
      if (ctx.includes(`TRG${i}`)) {
        admitted += 1;
        assert.equal(ctx.split(`TRG${i}`).length - 1, 1, `hazard ${i} trigger renders exactly once`);
        assert.equal(ctx.split(`RW${i}`).length - 1, 1, `hazard ${i} right way renders exactly once`);
        assert.ok(ctx.includes(expectedTriggers[i]), `hazard ${i} trigger arrives whole, beyond 2,400 chars`);
        assert.ok(ctx.includes(expectedRightWays[i]), `hazard ${i} right way arrives whole, beyond 2,400 chars`);
      } else {
        assert.match(
          ctx,
          new RegExp(`TOO LARGE to show in full \\(exceeds the transport limit\\) · knowledge_get ${ids[i]}`),
          `selected hazard ${i} is named by the transport-overflow pointer`
        );
        assert.ok(!ctx.includes(`TRG${i}`), `selected hazard ${i} never renders a partial trigger`);
        assert.ok(!ctx.includes(`RW${i}`), `selected hazard ${i} never renders a partial right way`);
      }
    }
    assert.ok(admitted >= 1, 'at least one >2,400-char hazard field pair arrives whole');
    assert.ok(admitted < 3, 'the transport ceiling degrades at least one selected oversized hazard to a pointer');
  } finally {
    cleanup();
  }
});

test('MEDIUM 5: dispatch staging delivers all HAZARD_CAP hazards whole when their combined fields fit the transport ceiling', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ delivery: { injection_rung: 'read' } }));
    const expectedTriggers = [];
    for (let i = 0; i < HAZARD_CAP; i++) {
      const trigger = `WHOLE_TRG${i} first ${'t'.repeat(2501)} WHOLE_TRIGGER_END_${i}`;
      expectedTriggers.push(trigger);
      store.create(antiPattern(`whole-hazard-${i}`, ['src/a.mjs'], { severity: 'warn', trigger, right_way: `RW${i} short` }));
    }
    writeFileSync(join(dir, 'src', 'a.mjs'), 'x\n');
    const transcript = spawnSync(process.execPath, [join(HOOKS, 'h22-dispatch-register.mjs')], {
      input: JSON.stringify({
        hook_event_name: 'PreToolUse', tool_name: 'Task', tool_use_id: `toolu_${randomUUID().slice(0, 8)}`,
        tool_input: { subagent_type: 'general-purpose', prompt: 'Go work on src/a.mjs and report back.', description: 'x' },
        session_id: 's1', cwd: dir, transcript_path: join(dir, 'no-such-transcript.jsonl'), prompt_id: 'p1',
      }),
      encoding: 'utf8', cwd: dir, timeout: 60_000,
    });
    assert.notEqual(transcript.status, 2, transcript.stderr);
    const r = runHook(
      'h19-dispatch-staging.mjs',
      { hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'agent-1', agent_type: 'general-purpose', cwd: dir, transcript_path: join(dir, 'no-such-transcript.jsonl') },
      dir
    );
    assert.equal(r.code, 0, r.stderr);
    const ctx = r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput?.additionalContext ?? '' : '';
    assert.ok(Buffer.byteLength(ctx, 'utf8') < 10000, `fixture control: composed context fits the transport ceiling (${Buffer.byteLength(ctx, 'utf8')} bytes)`);
    for (const trigger of expectedTriggers) assert.ok(ctx.includes(trigger), 'each >2,400-char trigger arrives whole');
    assert.doesNotMatch(ctx, /TOO LARGE to show/, 'no hazard degrades when all three whole fields fit the transport ceiling');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// The assembler credits structured part metadata, never UUIDs found in text.
// ---------------------------------------------------------------------------

test('MEDIUM 6: hazardParts and assembleDelivery retain the source hazard identity when its rendered text names another record', () => {
  const mentioned = '33333333-3333-4333-8333-333333333333';
  const hazard = {
    id: '11111111-1111-4111-8111-111111111111', title: 'SM1', slug: null, severity: 'warn',
    trigger: `T references ${mentioned}`,
    right_way: 'R',
  };
  const [part] = hazardParts([hazard]);
  assert.equal(part.identity, hazard.id, 'the hazard part keeps its structured source identity');
  const assembled = assembleDelivery([part], 0);
  assert.match(assembled.text, new RegExp(mentioned), 'CONTROL: rendered hazard text contains a different record id');
  assert.deepEqual(
    assembled.emittedSubstance,
    [{ identity: hazard.id, revision: recordRevision(hazard) }],
    'only the structured source identity is credited; no rendered-text scan can credit the mentioned id'
  );
});

test('non-porch: a disabled configured cap still renders whole hazards before owner bodies', () => {
  const hazards = Array.from({ length: 3 }, (_, i) => antiPattern(`hazard-${i}`, ['src/a.mjs'], { trigger: `TRG${i}` }));
  const owner = article('own-0', ['src/a.mjs']);
  const assembled = assembleDelivery([
    { kind: 'ordinary', contentClass: 'chrome', text: 'payload header' },
    ...hazardParts(hazards, { fileKeys: ['src/a.mjs'] }),
    { kind: 'ordinary', contentClass: 'substance', identity: owner.id, revision: recordRevision(owner), text: renderArticle(null, owner) },
  ], 0);
  for (let i = 0; i < 3; i += 1) assert.ok(assembled.text.includes(`TRG${i}`), `hazard ${i} remains delivered when cap is disabled`);
  assert.ok(assembled.text.indexOf('TRG0') < assembled.text.indexOf("▸ article 'own-0'"), 'hazards stay ahead of owner bodies');
});

test('non-porch: every emitted article header carries that article’s own id8', () => {
  const owners = Array.from({ length: 3 }, (_, i) => article(`own-${i}`, [`src/${i}.mjs`]));
  const assembled = assembleDelivery(
    owners.map((owner) => ({ kind: 'ordinary', contentClass: 'substance', identity: owner.id, revision: recordRevision(owner), text: renderArticle(null, owner) })),
    0
  );
  const headers = [...assembled.text.matchAll(/▸ article '(own-\d+)' \(([0-9a-f]{8})\) \(/g)];
  assert.equal(headers.length, owners.length, 'CONTROL: every owner header was emitted');
  for (const [, slug, id8] of headers) {
    const owner = owners.find((candidate) => candidate.slug === slug);
    assert.equal(id8, owner.id.slice(0, 8), `article header '${slug}' carries its own id8`);
  }
  assert.match(renderArticle(null, owners[0]), new RegExp(`▸ FULL RECORD: knowledge_get ${owners[0].id}`), 'a normal article keeps its full-id citability line');
});

// ---------------------------------------------------------------------------
// fix-round HIGH 4 (remaining half) — the migration notice used to be string-
// prepended AFTER assembly at the final stdout write on both the Read and
// Bash rungs, so its bytes escaped the total cap entirely. It is now a
// leading, charged chrome part of the SAME assembleDelivery call.
// ---------------------------------------------------------------------------

test('HIGH 4: the legacy injection_rung migration notice is charged on the total cap on the Read rung, not appended after capping', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    writeFileSync(
      join(dir, '.sterling', 'config.json'),
      JSON.stringify({ delivery: { injection_rung: 'prompt', total_cap_bytes: 600 } })
    );
    store.create(article('notice-article', ['src/a.mjs'], { what_it_does: `A ${'w'.repeat(2000)}` }));
    writeFileSync(join(dir, 'src', 'a.mjs'), 'x\n');
    const r = runHook('h19-knowledge-delivery.mjs', { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: join(dir, 'src/a.mjs') }, session_id: 's1', cwd: dir }, dir);
    assert.equal(r.code, 0, r.stderr);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /injection_rung 'prompt' is obsolete/, 'CONTROL: the migration notice actually rendered');
    assert.ok(
      Buffer.byteLength(ctx, 'utf8') <= 600,
      `the total cap must hold even WITH the migration notice folded in (was ${Buffer.byteLength(ctx, 'utf8')} bytes against a 600-byte cap)`
    );
  } finally {
    cleanup();
  }
});

test('HIGH 4: the legacy injection_rung migration notice is charged on the total cap on the Bash rung too', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ delivery: { injection_rung: 'prompt', total_cap_bytes: 600 } }));
    for (let i = 0; i < 8; i++) store.create(article(`notice-owner-${i}-${'segment-'.repeat(5)}`, [`src/f${i}.mjs`], { title: `Owner ${i} ${'with a long descriptive title '.repeat(2)}` }));
    for (let i = 0; i < 8; i++) writeFileSync(join(dir, `src/f${i}.mjs`), 'x\n');
    const r = runHook('h19-bash-delivery.mjs', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: `wc -l src/f0.mjs src/f1.mjs src/f2.mjs src/f3.mjs src/f4.mjs src/f5.mjs src/f6.mjs src/f7.mjs` }, session_id: 's1', cwd: dir }, dir);
    assert.equal(r.code, 0, r.stderr);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /injection_rung 'prompt' is obsolete/, 'CONTROL: the migration notice actually rendered');
    assert.ok(
      Buffer.byteLength(ctx, 'utf8') <= 600,
      `the total cap must hold even WITH the migration notice folded in (was ${Buffer.byteLength(ctx, 'utf8')} bytes against a 600-byte cap)`
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// test-integrity requirement (fix round) — "side effect first, guard second"
// pinned for ALL FOUR callers, not only h19-knowledge-delivery.mjs (which
// already has "ordering: a delivery that FAILS leaves the guard unwritten...").
// RENAMED 2026-09-20 (repair round, test-honesty finding): these were named
// `stdout-failure-leaves-marks-unspent`, which claims something they do not
// exercise — stdout SUCCEEDS here; the guard WRITE (inside `onWritten`,
// AFTER stdout) is what fails, via the same proven technique as the existing
// h19-knowledge-delivery.mjs pin: a DIRECTORY sits where the guard FILE must
// be written. What they prove is real and distinct from stdout-failure
// suppression (covered separately by common-exit-after-write.test.mjs): a
// LOST guard update must never leave a false mark behind — the delivery
// itself still succeeds (AC7: never a gate), and a retry (after clearing the
// collision) delivers again rather than silently skipping the record forever.
// ---------------------------------------------------------------------------

test('guard-write-failure-leaves-marks-unspent: h19-bash-delivery.mjs — a failed guard write persists NO mark; the retry delivers again', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const hazard = store.create(antiPattern('bash-fail-hazard', ['src/a.mjs']));
    writeFileSync(join(dir, 'src', 'a.mjs'), 'x\n');
    const dDir = join(dir, '.sterling', 'transient', 'delivery', 's1');
    mkdirSync(join(dDir, 'guard-conductor.json'), { recursive: true }); // collide: a directory where the guard FILE must go
    const r = runHook('h19-bash-delivery.mjs', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'cat src/a.mjs' }, session_id: 's1', cwd: dir }, dir);
    assert.notEqual(r.code, 2, 'a delivery failure must never deny the tool call (AC7)');
    assert.match(r.stderr, /H19/, 'the failure is loud, not swallowed (P5)');
    rmSync(join(dDir, 'guard-conductor.json'), { recursive: true, force: true });
    const retry = runHook('h19-bash-delivery.mjs', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'cat src/a.mjs' }, session_id: 's1', cwd: dir }, dir);
    const retryCtx = retry.stdout.trim() ? JSON.parse(retry.stdout).hookSpecificOutput?.additionalContext ?? '' : '';
    assert.match(retryCtx, new RegExp(hazard.id), 'the retry delivers the hazard again — no false mark survived the failed write');
  } finally {
    cleanup();
  }
});

test('guard-write-failure-leaves-marks-unspent: h20-mechanism-axis.mjs — a failed guard write persists NO mark; the retry delivers again', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const title = 'Boolean modifier mesh manifold topology solver stability failure';
    const trigger =
      'boolean modifier boolean modifier mesh manifold mesh manifold topology solver topology solver ' +
      'recur constantly though this bug rarely touches a game field cell during setup work';
    const hazard = store.create(antiPattern(title, [], { trigger }));
    const prompt =
      'Investigate why the boolean operation corrupts the mesh: check whether the modifier stack introduces non-manifold geometry that breaks downstream processing.';
    const dDir = join(dir, '.sterling', 'transient', 'delivery', 's1');
    mkdirSync(join(dDir, 'guard-conductor.json'), { recursive: true });
    const dispatchInput = { hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: { subagent_type: 'general-purpose', prompt, description: 'x' }, session_id: 's1', cwd: dir };
    const r = runHook('h20-mechanism-axis.mjs', dispatchInput, dir);
    assert.notEqual(r.code, 2, 'a delivery failure must never deny the tool call (AC7)');
    assert.match(r.stderr, /H20/, 'the failure is loud, not swallowed (P5)');
    rmSync(join(dDir, 'guard-conductor.json'), { recursive: true, force: true });
    const retry = runHook('h20-mechanism-axis.mjs', dispatchInput, dir);
    const retryCtx = retry.stdout.trim() ? JSON.parse(retry.stdout).hookSpecificOutput?.additionalContext ?? '' : '';
    assert.match(retryCtx, new RegExp(hazard.id), 'the retry delivers the hazard again — no false mark survived the failed write');
  } finally {
    cleanup();
  }
});

test('guard-write-failure-leaves-marks-unspent: h19-dispatch-staging.mjs — a failed guard write persists NO mark; the retry delivers again', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const a = store.create(article('stage-fail-article', ['src/a.mjs']));
    writeFileSync(join(dir, 'src', 'a.mjs'), 'x\n');
    const noTranscript = join(dir, 'no-such-transcript.jsonl');
    const stage = () => {
      const reg = spawnSync(process.execPath, [join(HOOKS, 'h22-dispatch-register.mjs')], {
        input: JSON.stringify({
          hook_event_name: 'PreToolUse', tool_name: 'Task', tool_use_id: `toolu_${randomUUID().slice(0, 8)}`,
          tool_input: { subagent_type: 'general-purpose', prompt: 'Go work on src/a.mjs and report back.', description: 'x' },
          session_id: 's1', cwd: dir, transcript_path: noTranscript, prompt_id: 'p1',
        }),
        encoding: 'utf8', cwd: dir, timeout: 60_000,
      });
      assert.notEqual(reg.status, 2, reg.stderr);
      return runHook('h19-dispatch-staging.mjs', { hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'agent-1', agent_type: 'general-purpose', cwd: dir, transcript_path: noTranscript }, dir);
    };
    const dDir = join(dir, '.sterling', 'transient', 'delivery', 's1');
    mkdirSync(join(dDir, 'guard-agent-agent-1.json'), { recursive: true });
    const r = stage();
    assert.notEqual(r.code, 2, 'a delivery failure must never deny the tool call (AC7)');
    assert.match(r.stderr, /H19/, 'the failure is loud, not swallowed (P5)');
    rmSync(join(dDir, 'guard-agent-agent-1.json'), { recursive: true, force: true });
    const retry = stage();
    const retryCtx = retry.stdout.trim() ? JSON.parse(retry.stdout).hookSpecificOutput?.additionalContext ?? '' : '';
    assert.match(retryCtx, new RegExp(a.id), 'the retry stages the article again — no false mark survived the failed write');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// fix-round MEDIUM 3 — a discovery-only owner (reference_material, or an
// oversize/digested article) was filtered against ONLY the substance ledger,
// which it can never earn a mark on, so it re-delivered on EVERY touch,
// forever — a deterministic once-per-context guard failure. Pinned in both
// directions: the discovery-only owner now stops repeating, and the original
// invariant ("a discovery mark must never suppress a later full-substance
// rendering") still holds when an owner's classification later changes.
// ---------------------------------------------------------------------------

test('MEDIUM 3: an unchanged reference_material owner does not repeat on a second touch', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create({
      id: randomUUID(), type: 'reference_material', created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active',
      superseded_by: null, links: [], scope: 'project', stack_tags: [],
      title: 'External API doc', kind: 'doc', location: 'src/a.mjs', summary: 'a pointer, not the content',
      source_date: '2026-09-20', capture_date: '2026-09-20',
    });
    writeFileSync(join(dir, 'src', 'a.mjs'), 'x\n');
    const readInput = { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: join(dir, 'src/a.mjs') }, session_id: 's1', cwd: dir };
    const first = runHook('h19-knowledge-delivery.mjs', readInput, dir);
    assert.equal(first.code, 0, first.stderr);
    assert.match(JSON.parse(first.stdout).hookSpecificOutput.additionalContext, /External API doc/, 'CONTROL: the first touch delivers the reference pointer');
    const second = runHook('h19-knowledge-delivery.mjs', readInput, dir);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(second.stdout, '', 'the SAME unchanged reference must not repeat — it earned a discovery mark, and freshness must consult the DISCOVERY ledger for a discovery-only owner, not the substance ledger it can never satisfy');
  } finally {
    cleanup();
  }
});

test('MEDIUM 3: an owner that transitions from discovery (digest) to substance (shrunk below the floor) still delivers its FULL body — a prior discovery mark never suppresses it', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    // total_cap_bytes is raised so the digest transition, rather than ordinary
    // cap degradation, is the behavior under test.
    writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ delivery: { injection_rung: 'read', total_cap_bytes: 8000 } }));
    const a = store.create(article('transition-article', ['src/a.mjs'], { what_it_does: `BIG ${'z'.repeat(5000)}` }));
    writeFileSync(join(dir, 'src', 'a.mjs'), 'x\n');
    const readInput = { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: join(dir, 'src/a.mjs') }, session_id: 's1', cwd: dir };
    const first = runHook('h19-knowledge-delivery.mjs', readInput, dir);
    assert.equal(first.code, 0, first.stderr);
    assert.match(JSON.parse(first.stdout).hookSpecificOutput.additionalContext, /digested — full body is/, 'CONTROL: the oversize article renders as a digest (discovery) first');

    // Shrink the body below ARTICLE_BODY_FLOOR — a genuine edit, new revision.
    store.updateRecord(a.id, { ...a, what_it_does: 'SMALL_BODY_SENTINEL now fits' });

    const second = runHook('h19-knowledge-delivery.mjs', readInput, dir);
    assert.equal(second.code, 0, second.stderr);
    const secondCtx = JSON.parse(second.stdout).hookSpecificOutput.additionalContext;
    assert.match(secondCtx, /SMALL_BODY_SENTINEL now fits/, 'the FULL body now delivers — the earlier discovery mark did not suppress this substance rendering');
    const guard = JSON.parse(readFileSync(conductorGuard(dir), 'utf8'));
    assert.ok(guard.discovery.some((e) => e.id === a.id), 'the FIRST (digest) delivery is still recorded as discovery');
    assert.ok(guard.substance.some((e) => e.id === a.id), 'the SECOND (shrunk) delivery is recorded as substance — the two ledgers coexist');
  } finally {
    cleanup();
  }
});
