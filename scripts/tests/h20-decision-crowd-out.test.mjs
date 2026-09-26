// REGRESSION: H20 reduced the governing decision to a bare id (Dome Farmer
// issue 2026-09-23, "H20 pushed the governing credits decision only as a bare
// id, below three unrelated anti-patterns"). Measured shape of the incident
// payload: header 1048, prior answers 731, articles 1000, three WHOLE hazards
// (2629, 2940, 1346 bytes as composed), the hazard-overflow line 162 — and the
// decision block, the one record that answered the question, survived only as
// `+5 more records: knowledge_query; knowledge_get e01732d5 …`.
//
// Decision delivery-total-cap-and-axis-generic-floor (301d8a0a) promises
// "Each later block's pointer is reserved up front so an early large block
// cannot crowd it out"; the assembler had no such reservation. User ruling
// 2026-09-24 ("Restore + rank"): restore the reserved pointer, title the
// '+N more' line, trim H20's header term list, and put decisions before
// hazards on a question-shaped brief. Hazards stay whole and at most 3
// (92088a62) — nothing here touches that.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { assembleDelivery, DELIVERY_TRANSPORT_VISIBLE_BYTES, decisionBlockPointer, decisionPointerPart, renderDecisionPointers } from '../hooks/lib/delivery.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-09-24T12:00:00.000Z';
const bytes = (s) => Buffer.byteLength(s, 'utf8');

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

// A multi-line block of exactly `n` bytes whose first line is `head`.
function blockOf(head, n, fill = 'x') {
  const lines = [head];
  let size = bytes(head);
  while (size < n) {
    const room = n - size - 1;
    const line = `  ${fill.repeat(Math.max(0, Math.min(118, room - 2)))}`.slice(0, room);
    lines.push(line);
    size += 1 + bytes(line);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 1. Pure assembler, the incident's exact byte shape.
// ---------------------------------------------------------------------------

function incidentParts() {
  const decisionIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const topSlug = 'coop-credits-farm-treasury-plus-personal-wallets-half-split';
  const decisionText = blockOf('▸ DECISIONS for this path (5) — why it is this way and what was rejected. Pointers only; follow one before contradicting it:', 1500, 'd');
  const part = (text, pointer, ids, names = []) => ({
    kind: 'ordinary', contentClass: 'discovery', text, pointer,
    identities: ids.map((identity, i) => ({ identity, revision: 'r1', name: names[i] })),
  });
  const hazard = (n, i) => ({ kind: 'hazard', contentClass: 'substance', identity: randomUUID(), revision: 'r1', name: `hazard-${i}`, text: blockOf(`⚠ ANTI-PATTERN [WARN] hazard ${i}`, n, 'h'), pointer: `⚠ hazard ${i} TOO LARGE` });
  return {
    decisionIds,
    topSlug,
    parts: [
      { kind: 'ordinary', contentClass: 'chrome', text: blockOf('STERLING MECHANISM-AXIS DELIVERY (H20) header', 1048, 'c') },
      part(blockOf('▸ PRIOR ANSWERS in the store (2)', 731, 'p'), '▸ held back by the delivery cap — knowledge_query types:["research_finding"] cap:2', [randomUUID(), randomUUID()], ['prior-one', 'prior-two']),
      part(blockOf('▸ ARTICLES matching this prompt\'s SUBJECT (10)', 1000, 'a'), '▸ held back by the delivery cap — knowledge_query types:["feature_article"] cap:10', [randomUUID(), randomUUID(), randomUUID()], ['farm-actor-sync', 'farm-commands', 'join-menu-and-lobby']),
      part(
        decisionText,
        `▸ DECISIONS (5) held back by the delivery cap — top: '${topSlug}' (knowledge_get ${decisionIds[0]}) — knowledge_query types:["decision"] rank_terms:["credits","wallet"] cap:5`,
        decisionIds,
        [topSlug, 'd-two', 'd-three', 'd-four', 'd-five'],
      ),
      hazard(2629, 1),
      hazard(2940, 2),
      hazard(1346, 3),
      { kind: 'hazard', contentClass: 'chrome', text: blockOf('… 2 more hazard(s) NOT shown (cap 3)', 162, 'o') },
    ],
  };
}

test('assembler (incident byte shape): the later decision block keeps its RESERVED pointer instead of being crowded out by earlier blocks', () => {
  const { parts, topSlug, decisionIds } = incidentParts();
  const assembled = assembleDelivery(parts, 3000);
  const total = bytes(assembled.text);
  assert.ok(total <= DELIVERY_TRANSPORT_VISIBLE_BYTES, `the composed payload stays under the transport ceiling (was ${total})`);
  const omittedIds = new Set(assembled.omitted.map((e) => e.identity));
  assert.ok(!omittedIds.has(decisionIds[0]), 'the top decision is NOT folded into the ids-only omission line');
  assert.ok(assembled.text.includes(topSlug), 'the top decision is named — never a bare id');
  for (let i = 1; i <= 3; i++) assert.match(assembled.text, new RegExp(`hazard ${i}\\n`), `hazard ${i} still renders whole (301d8a0a)`);
});

test('assembler: an early block that would fit alone is degraded so a later reserved pointer still fits (the pointer is reserved up front)', () => {
  const early = { kind: 'ordinary', contentClass: 'discovery', identity: 'early', revision: 'r1', text: blockOf('EARLY', 985, 'e'), pointer: 'EARLY POINTER' };
  const late = { kind: 'ordinary', contentClass: 'discovery', identity: 'late', revision: 'r1', text: blockOf('LATE', 400, 'l'), pointer: 'LATE POINTER — top: late-slug' };
  const assembled = assembleDelivery([early, late], 1000);
  assert.match(assembled.text, /LATE POINTER — top: late-slug/, 'the later block degrades to its pointer, it is not dropped');
  assert.equal(assembled.omittedCount, 0, 'nothing is omitted: every part is at least a pointer');
  assert.ok(bytes(assembled.text) <= 1000, 'the configured cap still holds');
});

test('assembler: the reservation never makes the ceiling lie — reserved pointers that cannot all fit are disclosed deterministically, in rank order', () => {
  const mk = (i) => ({ kind: 'ordinary', contentClass: 'discovery', identity: `id-${i}-000000`, revision: 'r1', name: `name-${i}`, text: blockOf(`BLOCK ${i}`, 400, 'b'), pointer: `POINTER ${i} ${'p'.repeat(200)}` });
  const parts = [0, 1, 2, 3, 4, 5].map(mk);
  const a = assembleDelivery(parts, 600);
  const b = assembleDelivery(parts, 600);
  assert.equal(a.text, b.text, 'deterministic');
  assert.ok(bytes(a.text) <= 600, `the configured cap holds (was ${bytes(a.text)})`);
  assert.ok(a.degraded, 'degradation is reported');
  assert.ok(a.omittedCount > 0, 'what could not fit is counted');
  assert.match(a.text, /\+\d+ more records/, 'and disclosed, never silently dropped');
  assert.match(a.text, /BLOCK 0|POINTER 0/, 'the highest-ranked part is kept (whole, excerpted or as its pointer), not the lowest');
});

// ---------------------------------------------------------------------------
// 2. Titled aggregate line.
// ---------------------------------------------------------------------------

test('aggregate line: each omitted record is named `name (id8)`, name first', () => {
  const parts = [['alpha', 500], ['beta', 2000]].map(([name, n]) => ({ kind: 'ordinary', contentClass: 'discovery', identity: `${name}00000000-0000`, revision: 'r1', name, text: 'x'.repeat(n) }));
  const assembled = assembleDelivery(parts, 1000);
  assert.match(assembled.text, /\+1 more records/);
  assert.match(assembled.text, /beta \(beta0000\)/, 'the omitted record carries its name beside its id8');
});

test('aggregate line: titles are dropped before ids, lowest-ranked first, when the line cannot hold them all', () => {
  const names = ['first-ranked-record-slug', 'second-ranked-record-slug', 'third-ranked-record-slug'];
  const omittedParts = names.map((name, i) => ({ kind: 'ordinary', contentClass: 'discovery', identity: `${i}${'0'.repeat(7)}-rest`, revision: 'r1', name, text: 'z'.repeat(3000) }));
  const filler = { kind: 'ordinary', contentClass: 'chrome', text: 'f'.repeat(500 - 120) };
  const assembled = assembleDelivery([filler, ...omittedParts], 500);
  assert.ok(bytes(assembled.text) <= 500, `fits the cap (was ${bytes(assembled.text)})`);
  assert.match(assembled.text, /\+3 more records/);
  for (let i = 0; i < 3; i++) assert.match(assembled.text, new RegExp(`${i}0000000`), `id8 ${i} survives`);
  assert.match(assembled.text, /first-ranked-record-slug \(00000000\)/, 'the highest-ranked record keeps its title');
  assert.doesNotMatch(assembled.text, /third-ranked-record-slug/, 'the lowest-ranked title is shed first');
});

// ---------------------------------------------------------------------------
// 3. End to end through H20: a question-shaped brief with the incident's shape.
// ---------------------------------------------------------------------------

function envelope(type) {
  return { id: randomUUID(), type, created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [] };
}
const PAD = 'Unrelated procedural padding sentence that only adds bulk to the right way field. ';
function antiPattern(title, trigger, rightWayBytes) {
  return {
    ...envelope('anti_pattern'), title, trigger, guidance: 'guidance', wrong_way: 'wrong way',
    right_way: PAD.repeat(Math.ceil(rightWayBytes / PAD.length)).slice(0, rightWayBytes),
    source_evidence: 'evidence', basis: 'codebase', file_keys: [],
  };
}
function decision(slug, title, statement) {
  return { ...envelope('decision'), slug, title, statement, alternatives_rejected: [{ option: 'Share one quorumite treasury wallet', reason: 'r' }], rationale: 'rationale', file_keys: [] };
}
function article(slug, title) {
  return {
    ...envelope('feature_article'), slug, title, what_it_does: `${title} does it`, intended_behavior: `${slug} intends`,
    files: [{ path: `game/${slug}.gd`, role: 'owner' }], current_ac: [{ ac_id: 'AC1', text: 'works', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] }, state: 'active', version: 1, history: [], live_test_refs: [],
  };
}
function finding(question) {
  return { ...envelope('research_finding'), question, answer: 'answer', source_urls: [], source_date: '2026-09-01', capture_date: '2026-09-02' };
}

const TOP_SLUG = 'quorumite-treasury-credits-half-split-per-ledger-wallet';
const TOP_TITLE = 'Quorumite treasury credits split half to each ledger wallet when the ledger settles';
const BRIEF =
  'How are the quorumite treasury credits split between each ledger wallet when a quorumite ledger settles? ' +
  'Explain where the treasury wallet split is decided and how the ledger credits reach each wallet.';

function seedIncident(store) {
  const top = store.create(decision(TOP_SLUG, TOP_TITLE,
    'Quorumite treasury credits split half to the shared treasury and half to each ledger wallet when a quorumite ledger settles; the wallet split is decided on the host.'));
  store.create(decision('quorumite-ledger-settles-nightly', 'Quorumite ledger settles treasury credits nightly', 'The quorumite ledger settles treasury credits once per night cycle.'));
  store.create(decision('quorumite-wallet-credits-carry', 'Quorumite wallet credits carry across ledger resets', 'Quorumite wallet credits carry across a ledger reset.'));
  store.create(decision('quorumite-treasury-ledger-audit', 'Quorumite treasury ledger keeps an audit trail', 'Every quorumite treasury ledger entry keeps an audit trail of credits.'));
  store.create(decision('quorumite-wallet-split-rounding', 'Quorumite wallet split rounds credits down', 'A quorumite wallet split rounds odd treasury credits down.'));
  store.create(antiPattern('Quorumite ledger settles the treasury wallet twice', 'A quorumite ledger settle path that credits the treasury wallet twice when the ledger settles.', 2700));
  store.create(antiPattern('Quorumite wallet credits read before the ledger settles', 'Reading quorumite wallet credits before the ledger settles the treasury split.', 3000));
  store.create(antiPattern('Quorumite treasury split measured against the wrong ledger', 'Measuring a quorumite treasury split against the wrong ledger wallet credits.', 1500));
  for (const [slug, title] of [
    ['quorumite-ledger-sync', 'Quorumite ledger sync — treasury wallet credits on the wire'],
    ['quorumite-wallet-commands', 'Quorumite wallet commands — credits split requests to the treasury ledger'],
    ['quorumite-treasury-panel', 'Quorumite treasury panel — shows ledger wallet credits split'],
    ['quorumite-ledger-lobby', 'Quorumite ledger lobby — treasury wallet credits at join'],
  ]) store.create(article(slug, title));
  store.create(finding('How many quorumite ledger wallet credits drifted from the treasury split after the ledger settles?'));
  store.create(finding('Is the quorumite treasury wallet split still authoritative for ledger credits?'));
  return top;
}

function runH20(dir, prompt) {
  const input = { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'researcher', prompt }, session_id: 's1', cwd: dir };
  const r = spawnSync(process.execPath, [join(HOOKS, 'h20-mechanism-axis.mjs')], { input: JSON.stringify(input), encoding: 'utf8', cwd: dir, timeout: 60_000 });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

test('H20 E2E (incident shape, question-shaped brief): the top decision arrives with its name, ahead of the hazards, under the transport ceiling', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h20-crowd-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({}));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  try {
    const top = seedIncident(store);
    const r = runH20(dir, BRIEF);
    assert.equal(r.code, 0, r.stderr);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;

    // Fixture controls: the incident's shape really is reproduced.
    assert.equal((ctx.match(/^⚠ ANTI-PATTERN \[/gm) || []).length, 3, 'control: three whole hazards render');
    assert.match(ctx, /PRIOR ANSWERS in the store/, 'control: prior answers render');
    assert.match(ctx, /ARTICLES matching this prompt's SUBJECT/, 'control: article pointers render');

    assert.ok(bytes(ctx) <= DELIVERY_TRANSPORT_VISIBLE_BYTES, `the payload stays under the transport ceiling (was ${bytes(ctx)})`);
    const topLine = ctx.split('\n').find((l) => l.includes(top.id.slice(0, 8)) && !/more records/.test(l));
    assert.ok(topLine, 'the top decision is not reduced to the ids-only overflow line');
    assert.ok(topLine.includes(TOP_SLUG) || topLine.includes(TOP_TITLE), `the top decision is named beside its id: ${topLine}`);

    const decisionsAt = ctx.indexOf('DECISIONS');
    const hazardAt = ctx.indexOf('⚠ ANTI-PATTERN');
    assert.ok(decisionsAt >= 0 && decisionsAt < hazardAt, 'question-shaped brief: decisions come before hazards');

    const headerLine = ctx.split('\n').find((l) => l.includes('matched on:'));
    const central = /central to the record: ([^)]*?) \(\+\d+ more\)\)/.exec(headerLine);
    assert.ok(central, `the header keeps an honest, bounded central clause that COUNTS what it left out: ${headerLine}`);
    assert.ok(central[1].split(', ').length <= 6, `the central term list is bounded (${central[1]})`);

    assert.doesNotMatch(ctx, /ANTI-PATTERN \[[A-Z]+\] for this path/, 'a subject-matched hazard is not labelled as matching a path');
    assert.match(ctx, /ANTI-PATTERN \[[A-Z]+\] for this subject/);
    assert.doesNotMatch(ctx, /DECISIONS for this path/, 'subject-matched decisions are not labelled as matching a path either');
  } finally {
    store.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Fix round (independent review 2026-09-24): holes that reproduced the
//    incident's own symptom.
// ---------------------------------------------------------------------------

const PAD_PTR = 'q'.repeat(250);

test('review P1: the "+N more" line never evicts a RESERVED decision pointer, and every omitted record keeps its name', () => {
  const parts = [
    { kind: 'ordinary', pinned: true, contentClass: 'chrome', text: blockOf('HEADER', 2500, 'c') },
    { kind: 'ordinary', contentClass: 'discovery', identity: 'nopointer-aaaa', revision: 'r', name: 'no-pointer-part', text: blockOf('NOPTR', 800, 'n') },
    {
      kind: 'ordinary', contentClass: 'discovery',
      identities: [{ identity: 'dec00000-1111', revision: 'r', name: 'the-answering-decision' }],
      text: blockOf('▸ DECISIONS (1)', 900, 'd'),
      pointer: `▸ DECISIONS (1) held back — top: 'the-answering-decision' (knowledge_get dec00000-1111) — knowledge_query types:["decision"] cap:1 ${PAD_PTR}`, // not-a-citation: fixture id
      suffix: '  … rest held back',
    },
  ];
  const assembled = assembleDelivery(parts, 3000);
  assert.ok(bytes(assembled.text) <= 3000, `cap holds (was ${bytes(assembled.text)})`);
  assert.match(assembled.text, /▸ DECISIONS \(1\)/, 'the decision block survives the disclosure line (it used to be its eviction victim)');
  assert.ok(!assembled.omitted.some((e) => e.identity === 'dec00000-1111'), 'the decision is not an omission');
  assert.match(assembled.text, /\+1 more records: knowledge_query; knowledge_get no-pointer-part \(nopointe\)/, 'the omitted part is named');
});

// The fixture FORCES the eviction (board 6c0c848f item 6: the previous
// fixture never evicted, so its guarded assertion never ran). The first part
// can only render as its 100 B pointer, and the pointer stage holds back no
// room for the '+N more' line, so the line cannot fit beside it and the
// eviction loop must take it. Its name after the first omission's proves it
// was evicted, not omitted during placement (placement omits in caller order).
test('review P3: a part evicted to make room for the "+N more" line is named in it, like any other omission', () => {
  const parts = [
    { kind: 'ordinary', pinned: true, contentClass: 'chrome', text: blockOf('HEADER', 2850, 'c') },
    { kind: 'ordinary', contentClass: 'discovery', identity: 'keep0000-1', revision: 'r', name: 'evicted-but-named', text: 'k'.repeat(2000), pointer: 'P'.repeat(100) },
    { kind: 'ordinary', contentClass: 'discovery', identity: 'omit0000-1', revision: 'r', name: 'omitted-first', text: blockOf('BIG', 2000) },
  ];
  const assembled = assembleDelivery(parts, 3000);
  assert.ok(bytes(assembled.text) <= 3000);
  assert.doesNotMatch(assembled.text, /PPPP/, 'the part was evicted to make room for the disclosure');
  assert.match(assembled.text, /omitted-first \(omit0000\) evicted-but-named \(keep0000\)/, 'the evicted record is disclosed WITH its name, after the placement omission');
});

function p6Parts(headerBytes) {
  const decId = 'e01732d5-aaaa-bbbb-cccc-000000000001';
  const widen = 'knowledge_query types:["decision"] rank_terms:["credits","wallet","treasury"] cap:5';
  const priorWiden = `knowledge_query types:["research_finding","disconfirmed_hypothesis","open_question"] rank_terms:[${Array.from({ length: 14 }, (_, i) => `"term${i}"`).join(',')}] cap:3`;
  return [
    { kind: 'ordinary', pinned: true, contentClass: 'chrome', text: blockOf('STERLING MECHANISM-AXIS DELIVERY (H20) header', headerBytes, 'c') },
    { kind: 'ordinary', contentClass: 'discovery', identities: [{ identity: 'prior000-1', revision: 'r', name: 'prior-question-one' }], text: blockOf('▸ PRIOR ANSWERS in the store (2)', 731, 'p'), pointer: `▸ held back by the delivery cap — ${priorWiden}` },
    { kind: 'ordinary', contentClass: 'discovery', identities: [{ identity: decId, revision: 'r', name: 'coop-credits-half-split' }], text: blockOf('▸ DECISIONS (5)', 1500, 'd'), pointer: decisionBlockPointer(5, widen, { id: decId, slug: 'coop-credits-half-split' }), suffix: `  … the rest held back by the delivery cap — ${widen}` },
    { kind: 'hazard', contentClass: 'substance', identity: 'hz', revision: 'r', text: blockOf('⚠ HZ', 2600, 'h'), pointer: 'hz ptr' },
  ];
}

// Named at every header size where the name can fit at all. At 2680 the
// room left beside the higher-ranked prior-answers pointer (257 B) is 56 B:
// the '+N more' line fits only as ids, so the decision is disclosed by id —
// never silently, and never as a nameless heading.
for (const [headerBytes, named] of [[2520, true], [2600, true], [2680, false], [2780, true]]) {
  test(`review p6 (header ${headerBytes}): a decision block never renders as a nameless heading — it is ${named ? 'named' : 'disclosed by id'}`, () => {
    const assembled = assembleDelivery(p6Parts(headerBytes), 3000);
    assert.ok(bytes(assembled.text) - 2602 <= 3000, 'ordinary bytes within the cap');
    assert.match(assembled.text, /e01732d5/, 'the decision is never silently dropped');
    if (named) assert.match(assembled.text, /coop-credits-half-split/, 'the decision is named');
    assert.doesNotMatch(assembled.text, /▸ DECISIONS \(5\)\n {2}… the rest held back/, 'never the heading alone over the "rest held back" suffix');
  });
}

test('review #4: a part with NO separate suffix keeps its heading line above its pointer (H20 asPart shape, as HEAD rendered it)', () => {
  const ptr = '▸ held back by the delivery cap — knowledge_query types:["feature_article"] rank_terms:["a"] cap:4';
  const parts = [
    { kind: 'ordinary', pinned: true, contentClass: 'chrome', text: blockOf('HEADER', 2800, 'c') },
    { kind: 'ordinary', contentClass: 'discovery', identities: [{ identity: 'art00000-1', revision: 'r', name: 'art' }], text: `▸ ARTICLES matching this prompt's SUBJECT (4)\n  ${'a'.repeat(300)}`, pointer: ptr },
  ];
  const assembled = assembleDelivery(parts, 3000);
  assert.match(assembled.text, /▸ ARTICLES matching this prompt's SUBJECT \(4\)\n▸ held back by the delivery cap/, 'heading + pointer');
});

test('review #4: a part whose first line IS its pointer never renders the pointer twice (H19 Bash shape)', () => {
  const ptr = 'POINTER LINE knowledge_get abcdef01-0000';
  const parts = [
    { kind: 'ordinary', pinned: true, contentClass: 'chrome', text: blockOf('HEADER', 900, 'c') },
    { kind: 'ordinary', contentClass: 'discovery', identity: 'abcdef01-0000', revision: 'r', text: `${ptr}\n${blockOf('  body', 800, 'b')}`, pointer: ptr },
  ];
  const assembled = assembleDelivery(parts, 1000);
  assert.equal(assembled.text.split(ptr).length - 1, 1, `the pointer renders exactly once: ${JSON.stringify(assembled.text.slice(900))}`);
});

test('review #5: the first reserved pointer is not charged a separator that will never render', () => {
  const px = `PX${'p'.repeat(50)}`;
  const py = `PY${'q'.repeat(50)}`;
  const x = { kind: 'ordinary', contentClass: 'discovery', identity: 'x', revision: 'r', text: `${'A'.repeat(60)}\n${'B'.repeat(40)}\n${'C'.repeat(500)}`, pointer: px, suffix: 'SX' };
  const y = { kind: 'ordinary', contentClass: 'discovery', identity: 'y', revision: 'r', text: 'Y'.repeat(500), pointer: py };
  const cap = bytes(px) + 2 + bytes(py) + 1;
  const assembled = assembleDelivery([x, y], cap);
  assert.ok(bytes(assembled.text) <= cap);
  assert.equal(assembled.omittedCount, 0, 'both pointers fit exactly, so both are reserved and neither is omitted');
  assert.match(assembled.text, /PY/);
});

test('review #7: the "+N more" line uses ONE format — space-separated, `name (id8)` when named — whether names render, are shed, or never existed', () => {
  const unnamed = [0, 1].map((i) => ({ kind: 'ordinary', contentClass: 'discovery', identity: `${i}${'0'.repeat(7)}-u`, revision: 'r', text: 'z'.repeat(3000) }));
  const plain = assembleDelivery(unnamed, 500);
  assert.match(plain.text, /\+2 more records: knowledge_query; knowledge_get 00000000 10000000$/, plain.text);

  const named = [0, 1].map((i) => ({ kind: 'ordinary', contentClass: 'discovery', identity: `${i}${'0'.repeat(7)}-n`, revision: 'r', name: `a-very-long-record-name-${'n'.repeat(60)}`, text: 'z'.repeat(3000) }));
  const filler = { kind: 'ordinary', pinned: true, contentClass: 'chrome', text: 'f'.repeat(500 - 80) };
  const shed = assembleDelivery([filler, ...named], 500);
  assert.ok(bytes(shed.text) <= 500);
  assert.match(shed.text, /\+2 more records: knowledge_query; knowledge_get 00000000 10000000$/, `all names shed, same format: ${shed.text.slice(420)}`);
  const kept = assembleDelivery(named, 500);
  assert.match(kept.text, /knowledge_get a-very-long-record-name-n+… \(00000000\) a-very-long-record-name-n+… \(10000000\)$/, `named, same separator: ${kept.text}`);
});

test('review #8: renderDecisionPointers honours the subject case in its heading', () => {
  const d = { id: randomUUID(), slug: 's', statement: 'stmt', alternatives_rejected: [] };
  assert.match(renderDecisionPointers('(subject match)', [d], 5, { matchLabel: 'for this subject' }), /^▸ DECISIONS for this subject \(1\)/);
  assert.match(renderDecisionPointers('src/a.mjs', [d]), /^▸ DECISIONS for this path \(1\)/, 'the path case is unchanged');
});

// ---------------------------------------------------------------------------
// 5. Residuals (board 6c0c848f, Codex Sol review 2026-09-26).
// ---------------------------------------------------------------------------

test('residual 2: a custom aggregateLabel larger than the cap falls back to the generic line instead of overrunning it', () => {
  // Each part exceeds even the transport ceiling and has no pointer, so both
  // are omitted under either budget.
  const omittedParts = [0, 1].map((i) => ({ kind: 'ordinary', contentClass: 'discovery', identity: `${i}${'0'.repeat(7)}-l`, revision: 'r', text: 'z'.repeat(DELIVERY_TRANSPORT_VISIBLE_BYTES + 1) }));
  const capped = assembleDelivery(omittedParts, 500, { aggregateLabel: () => 'L'.repeat(501) });
  assert.ok(bytes(capped.text) <= 500, `cap 500 holds (was ${bytes(capped.text)})`);
  assert.match(capped.text, /^\+2 more records: knowledge_query; knowledge_get/, 'the count is still stated, in the generic form');
  const uncapped = assembleDelivery(omittedParts, 0, { aggregateLabel: () => 'L'.repeat(DELIVERY_TRANSPORT_VISIBLE_BYTES + 1) });
  assert.ok(bytes(uncapped.text) <= DELIVERY_TRANSPORT_VISIBLE_BYTES, `the transport ceiling holds with no configured cap (was ${bytes(uncapped.text)})`);
  assert.match(uncapped.text, /^\+2 more records: knowledge_query; knowledge_get/);
  const fitting = assembleDelivery(omittedParts, 500, { aggregateLabel: (n) => `(+${n} held back by the caller's own wording)` });
  assert.equal(fitting.text, "(+2 held back by the caller's own wording)", 'a label that fits is kept verbatim');
});

test('residual 1/5: decisionPointerPart credits exactly the rendered slice, each identity named, and names the top record in its pointer', () => {
  const ds = Array.from({ length: 6 }, (_, i) => ({ id: randomUUID(), slug: `slug-${i}`, statement: `statement ${i}`, alternatives_rejected: [], updated_at: NOW }));
  const part = decisionPointerPart('(subject match)', ds, { widen: 'WIDEN', cap: 5, remedy: 'WIDEN', matchLabel: 'for this subject' });
  assert.deepEqual(part.identities.map((e) => e.identity), ds.slice(0, 5).map((d) => d.id), 'only the five rendered decisions are identities');
  assert.deepEqual(part.identities.map((e) => e.name), ds.slice(0, 5).map((d) => d.slug), 'each identity carries its name');
  assert.match(part.text, /^▸ DECISIONS for this subject \(6\)/, 'the heading counts all six');
  assert.match(part.text, /1 more NOT shown \(cap 5\) — WIDEN/, 'the sixth is disclosed, not silently dropped');
  assert.doesNotMatch(part.text, /statement 5/);
  assert.match(part.pointer, new RegExp(`top: 'slug-0' \\(knowledge_get ${ds[0].id}\\)`), 'the pointer names the top decision');
  assert.equal(part.contentClass, 'discovery');
});

test('residual 3 (H20 E2E): a sixth matching decision is counted and disclosed, never silently dropped before the renderer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h20-crowd-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ delivery: { total_cap_bytes: 0 } }));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  try {
    store.create(decision(TOP_SLUG, TOP_TITLE,
      'Quorumite treasury credits split half to the shared treasury and half to each ledger wallet when a quorumite ledger settles; the wallet split is decided on the host.'));
    store.create(decision('quorumite-ledger-settles-nightly', 'Quorumite ledger settles treasury credits nightly', 'The quorumite ledger settles treasury credits once per night cycle.'));
    store.create(decision('quorumite-wallet-credits-carry', 'Quorumite wallet credits carry across ledger resets', 'Quorumite wallet credits carry across a ledger reset.'));
    store.create(decision('quorumite-treasury-ledger-audit', 'Quorumite treasury ledger keeps an audit trail', 'Every quorumite treasury ledger entry keeps an audit trail of credits.'));
    store.create(decision('quorumite-wallet-split-rounding', 'Quorumite wallet split rounds credits down', 'A quorumite wallet split rounds odd treasury credits down.'));
    store.create(decision('quorumite-treasury-wallet-ledger-cap', 'Quorumite treasury wallet credits cap per ledger', 'Quorumite treasury wallet credits are capped per ledger settle.'));
    const r = runH20(dir, BRIEF);
    assert.equal(r.code, 0, r.stderr);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /▸ DECISIONS for this subject \(6\)/, 'all six matches are counted');
    assert.match(ctx, /1 more NOT shown \(cap 5\)/, 'the sixth is disclosed');
  } finally {
    store.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});
