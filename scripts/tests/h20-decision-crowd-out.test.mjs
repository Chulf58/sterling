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
import { assembleDelivery as assembleDelivery8965c63 } from './fixtures/assemble-delivery-8965c63.mjs';

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
    // UPDATED 2026-09-30 for decision h20-dispatch-surface-lead-hazard-whole-rest-as-trigger-lines
    // (a4912f91): the dispatch surface renders rank 1 whole and ranks 2-3 as
    // trigger lines, so the three selected hazards are one block plus two
    // lines. The byte pressure of three whole hazards is pinned at the
    // assembler level in this file's unit tests above.
    assert.equal((ctx.match(/^⚠ ANTI-PATTERN \[/gm) || []).length, 1, 'control: the lead hazard renders whole');
    assert.equal((ctx.match(/^ {2}→ .* \([0-9a-f]{8}\) — HAZARD: /gm) || []).length, 2, 'control: ranks 2-3 render as trigger lines');
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

// Fix round (Sol review of 652bd5d, MEDIUM): credit and disclosure are
// separate. A decision block the ceiling omits entirely earns no mark, and its
// '+N more' line and omission metadata cover EVERY decision it represents, not
// only the capped rendered slice.
for (const [label, total, cap] of [['H20 shape', 6, 5], ['H19 shape', 9, 8]]) {
  test(`fix round (${label}): a decisionPointerPart omitted by the ceiling discloses all ${total} decisions and credits none`, () => {
    const ds = Array.from({ length: total }, (_, i) => ({ id: `${i}${'d'.repeat(7)}-${randomUUID()}`, slug: `dec-${i}`, statement: `statement ${i}`, alternatives_rejected: [], updated_at: NOW }));
    const part = decisionPointerPart('(subject match)', ds, { widen: 'W'.repeat(700), cap, remedy: 'WIDEN', matchLabel: 'for this subject' });
    // Pinned chrome leaves too little room for even the block's pointer.
    const filler = { kind: 'ordinary', pinned: true, contentClass: 'chrome', text: 'f'.repeat(2900) };
    const assembled = assembleDelivery([filler, part], 3000);
    assert.doesNotMatch(assembled.text, /DECISIONS/, 'control: the whole block is omitted');
    assert.deepEqual(assembled.emittedDiscovery, [], 'an omitted block credits nothing');
    assert.match(assembled.text, new RegExp(`\\+${total} more records`), `the disclosure counts every decision: ${assembled.text.slice(2900)}`);
    assert.equal(assembled.omittedCount, total, 'omittedCount covers every decision');
    assert.deepEqual(assembled.omitted.map((e) => e.identity).sort(), ds.map((d) => d.id).sort(), 'omission metadata covers every represented identity');
  });
}

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

// ---------------------------------------------------------------------------
// 3. Named hold-back waste (board 6c0c848f sub-item 4, decision
// delivery-total-cap-and-axis-generic-floor, "Known residual"). The room held
// back from excerpts for the '+N more' line was sized from the line carrying
// EVERY name, though the aggregate sheds names lowest-ranked first to fit what
// is left, so a line that could not hold even one name still starved the
// excerpts. "An omitted record's name outranks another block's extra excerpt
// lines" holds only while a name FITS; otherwise the room belongs to the excerpt.
// ---------------------------------------------------------------------------

const LONG_NAME = 'an-omitted-record-whose-slug-is-long-enough-to-hit-the-eighty-byte-name-clip-xxxxx';
const excerptLines = (text) => (text.match(/^ {2}line \d/gm) || []).length;

// Chrome of `h` bytes; block A (8 excerpt lines + pointer); block B (5000 B,
// unpointered, carrying an 80-byte name) that can only be omitted.
function holdBackParts(h) {
  return [
    { kind: 'ordinary', pinned: true, contentClass: 'chrome', text: 'H'.repeat(h) },
    {
      kind: 'ordinary', contentClass: 'discovery', identity: 'aaaaaaaa-1', revision: 'r', name: 'excerpted',
      text: ['BLOCK A', ...Array.from({ length: 8 }, (_, i) => `  line ${i} ${'a'.repeat(20)}`)].join('\n'),
      pointer: 'PTR A knowledge_get aaaaaaaa',
    },
    { kind: 'ordinary', contentClass: 'discovery', identity: 'bbbbbbbb-1', revision: 'r', name: LONG_NAME, text: 'b'.repeat(5000) },
  ];
}

test('hold-back: room reserved for a named line that cannot fit even one name goes to the excerpt lines instead', () => {
  const assembled = assembleDelivery(holdBackParts(330), 500);
  assert.ok(bytes(assembled.text) <= 500, `the cap holds (was ${bytes(assembled.text)})`);
  assert.ok(excerptLines(assembled.text) >= 1, `block A keeps at least one excerpt line:\n${assembled.text.slice(330)}`);
  assert.match(assembled.text, /\+1 more records: knowledge_query; knowledge_get bbbbbbbb\b/, 'the omission is still disclosed by id8');
});

test('hold-back: when one name fits, the name renders and the excerpt room does not crowd it out', () => {
  const assembled = assembleDelivery(holdBackParts(300), 500);
  assert.ok(bytes(assembled.text) <= 500, `the cap holds (was ${bytes(assembled.text)})`);
  assert.match(assembled.text, /\+1 more records: knowledge_query; knowledge_get an-omitted-record-whose-slug-is-long-enough-to-hit-the-eighty-byte-name-clip-… \(bbbbbbbb\)/, `the name renders:\n${assembled.text.slice(300)}`);
});

test('hold-back: names are shed lowest-ranked first, and a name that fits is held back from the excerpt', () => {
  const parts = [
    { kind: 'ordinary', pinned: true, contentClass: 'chrome', text: 'H'.repeat(360) },
    {
      kind: 'ordinary', contentClass: 'discovery', identity: 'aaaaaaaa-1', revision: 'r', name: 'excerpted',
      text: ['BLOCK A', ...Array.from({ length: 8 }, (_, i) => `  line ${i} ${'a'.repeat(20)}`)].join('\n'),
      pointer: 'PTR A knowledge_get aaaaaaaa',
    },
    { kind: 'ordinary', contentClass: 'discovery', identity: 'bbbbbbbb-1', revision: 'r', name: 'first-omitted-record-name', text: 'b'.repeat(5000) },
    { kind: 'ordinary', contentClass: 'discovery', identity: 'cccccccc-1', revision: 'r', name: 'second-omitted-record-name', text: 'c'.repeat(5000) },
  ];
  const assembled = assembleDelivery(parts, 500);
  assert.ok(bytes(assembled.text) <= 500, `the cap holds (was ${bytes(assembled.text)})`);
  assert.match(assembled.text, /\+2 more records: knowledge_query; knowledge_get first-omitted-record-name \(bbbbbbbb\) cccccccc\b/, `the higher-ranked name survives, the lower sheds first:\n${assembled.text.slice(360)}`);
});

test('hold-back: a decision part whose disclosureIdentities outnumber its shown identities is held back from the FULL list', () => {
  const decisions = Array.from({ length: 10 }, (_, i) => ({ id: `dddddd0${i}-aaaa-bbbb`, slug: `decision-${i}-slug`, title: `Decision ${i}`, rationale: 'r'.repeat(300), status: 'active' }));
  const block = decisionPointerPart('some/file.mjs', decisions, { widen: 'knowledge_query x' });
  assert.equal(block.identities.length, 8, 'the renderer shows only DECISION_POINTER_CAP');
  assert.equal(block.disclosureIdentities.length, 10, 'the disclosure carries every decision');
  // Unpointered, so the block can only render whole or be omitted and named.
  const omittedBlock = { ...block, pointer: undefined };
  // Block A's excerpt lines are tiny (4 bytes each) so the room held back for the
  // omission line is measured to the byte: an excerpt may take only what is left
  // after the line, so its presence never changes the names the line carries.
  const tiny = ['BLOCK A', ...Array.from({ length: 40 }, () => '  x')].join('\n');
  const pointer = 'PTR A knowledge_get aaaaaaaa';
  const a = (text) => ({ kind: 'ordinary', contentClass: 'discovery', identity: 'aaaaaaaa-1', revision: 'r', name: 'excerpted', text, pointer });
  const chrome = (h) => ({ kind: 'ordinary', pinned: true, contentClass: 'chrome', text: 'H'.repeat(h) });
  const namesOf = (text) => (text.match(/ \(dddddd0\d\)/g) || []).length;
  let sawNames = 0;
  for (let h = 100; h <= 340; h += 3) {
    const withExcerpts = assembleDelivery([chrome(h), a(tiny), omittedBlock], 500);
    const pointerOnly = assembleDelivery([chrome(h), a(`BLOCK A\n${pointer}`), omittedBlock], 500);
    assert.ok(bytes(withExcerpts.text) <= 500, `the cap holds at h=${h} (was ${bytes(withExcerpts.text)})`);
    const line = withExcerpts.text.split('\n').find((l) => l.startsWith('+') && / more records/.test(l));
    if (!line) continue;
    const count = Number(line.match(/^\+(\d+) /)[1]);
    assert.ok(count >= 10, `the count covers all ten decisions at h=${h} (was ${count})`);
    assert.equal(withExcerpts.omittedCount, count);
    assert.ok(namesOf(withExcerpts.text) >= namesOf(pointerOnly.text), `excerpt lines never cost the omission line a name at h=${h}:\n${withExcerpts.text.slice(h)}`);
    sawNames += namesOf(withExcerpts.text);
  }
  assert.ok(sawNames > 0, 'the sweep reached an omission line that carries names');
});


// SEEDED FUZZ PIN: never over the cap, and the top-ranked omitted name is never
// shed while it fits in the room left (no hazards, so every byte is ordinary and the cap binds).
test('hold-back fuzz pin: 4000 seeded cases never exceed the cap and never leave room the top omitted name would fit in', () => {
  let seed = 20260930;
  const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const ri = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const hex = () => Array.from({ length: 8 }, () => '0123456789abcdef'[ri(0, 15)]).join('');
  const nameCost = (n) => bytes(n) + 3;
  let idsOnlyLines = 0;
  let wasted = 0;
  for (let k = 0; k < 4000; k++) {
    const cap = ri(500, 3000);
    const parts = [];
    if (rnd() < 0.5) parts.push({ kind: 'ordinary', pinned: true, contentClass: 'chrome', text: blockOf('HEADER', ri(100, Math.floor(cap / 3)), 'h') });
    const names = new Map();
    const n = ri(2, 8);
    for (let i = 0; i < n; i++) {
      const identity = `${hex()}-0000-0000`;
      const name = rnd() < 0.85 ? `record-name-${i}-${'n'.repeat(ri(5, 70))}` : undefined;
      if (name) names.set(identity, name);
      const part = { kind: 'ordinary', contentClass: 'discovery', identity, revision: 'r', name, text: blockOf(`BLOCK ${i}`, ri(200, 6000), 'x') };
      if (rnd() < 0.7) part.pointer = `PTR ${i} knowledge_get ${identity} ${'p'.repeat(ri(0, 150))}`;
      if (rnd() < 0.3) part.suffix = `  … rest of ${i} held back`;
      parts.push(part);
    }
    const assembled = assembleDelivery(parts, cap);
    assert.ok(bytes(assembled.text) <= cap, `case ${k}: ${bytes(assembled.text)} > cap ${cap}`);
    const line = assembled.text.split('\n').find((l) => /^\+\d+ more records/.test(l));
    if (!line || / \([0-9a-f]{8}\)/.test(line)) continue;
    idsOnlyLines++;
    // Names shed lowest-ranked first, so the one that must survive room for it is
    // the HIGHEST-ranked named record, first in `omitted`.
    const top = assembled.omitted.map((e) => names.get(e.identity)).find(Boolean);
    if (top && cap - bytes(assembled.text) >= nameCost(top)) wasted++;
  }
  assert.ok(idsOnlyLines > 100, `the fuzz exercised the ids-only omission line (${idsOnlyLines} cases)`);
  assert.equal(wasted, 0, 'no case leaves free room that the top omitted name would fit in');
});

// ---------------------------------------------------------------------------
// 4. The reduced hold-back never costs a name (review of 4e1c6d9). The hold
// sized against what one placement pass predicts was too small in two ways: a
// reserved pointer is a ceiling, so a part rendering shorter than its pointer
// gives room back that the aggregate then has; and the omission set a pass
// predicts can differ from the one the final placement discloses. Either way
// names were shed so an excerpt line could take their room. The assembler now
// keeps the reduced placement only when it renders at least as many names and
// omits no more records than the hold at 8965c63 (the frozen fixture).
// ---------------------------------------------------------------------------

const omissionLine = (text) => text.split('\n').find((l) => /^\+\d+ more records/.test(l));
const namesIn = (text) => { const line = omissionLine(text); return line ? (line.match(/ \([0-9a-f]{8}\)/g) || []).length : 0; };

test('reduced hold-back (review repro 1, cap 562): a part shorter than its reserved pointer gives room back, and the name still renders', () => {
  const parts = [
    { kind: 'ordinary', pinned: true, contentClass: 'chrome', text: 'H'.repeat(269) },
    { kind: 'ordinary', contentClass: 'discovery', identity: 'ae36dab2-0000-0000', revision: 'r',
      text: `BLOCK 0\n  line 0 ${'x'.repeat(12)}\n  line 1 ${'x'.repeat(37)}\n${'x'.repeat(1100)}`,
      pointer: `PTR 0 knowledge_get ae36dab2-0000-0000${' p'.repeat(24)}`, suffix: '  … rest of 0' },
    { kind: 'ordinary', contentClass: 'discovery', identity: '3c17a0e9-0000-0000', revision: 'r', name: `n1-${'x'.repeat(19)}`,
      text: `BLOCK 1\n${'x'.repeat(1233)}`, pointer: `PTR 1 knowledge_get 3c17a0e9-0000-0000${' p'.repeat(32)}` },
    { kind: 'ordinary', contentClass: 'discovery', identity: 'e8c2b330-0000-0000', revision: 'r', name: `long-2-${'y'.repeat(66)}`, text: 'z'.repeat(145) },
  ];
  const assembled = assembleDelivery(parts, 562);
  assert.ok(bytes(assembled.text) <= 562, `the cap holds (was ${bytes(assembled.text)})`);
  assert.equal(omissionLine(assembled.text), `+1 more records: knowledge_query; knowledge_get long-2-${'y'.repeat(66)} (e8c2b330)`);
  assert.ok(namesIn(assembled.text) >= namesIn(assembleDelivery8965c63(parts, 562).text), 'no fewer names than 8965c63');
});

test('reduced hold-back (review repro 2, cap 406): the hold is never sized from an omission set the final placement does not disclose', () => {
  const parts = [
    { kind: 'ordinary', pinned: true, contentClass: 'chrome', text: 'H'.repeat(241) },
    { kind: 'ordinary', contentClass: 'discovery', identity: 'd6ea1d3d-0000-0000', revision: 'r', name: 'n0-xxxxxxx',
      text: `BLOCK 0\n  line 0 xxxxx\n${'x'.repeat(559)}`, suffix: '  … rest of 0',
      disclosureIdentities: [
        { identity: 'd6ea1d3d-0000-0000', revision: 'r', name: 'n0-xxxxxxx' }, { identity: '3d2de929-dd-0', revision: 'r' },
        { identity: '6c848e9e-dd-1', revision: 'r', name: `extra-1-${'q'.repeat(34)}` }, { identity: '4043c324-dd-2', revision: 'r', name: `extra-2-${'q'.repeat(30)}` },
        { identity: '1bc67470-dd-3', revision: 'r', name: `extra-3-${'q'.repeat(47)}` }, { identity: 'cc7930ad-dd-4', revision: 'r', name: 'extra-4-qqqqqqqqqqqq' }] },
    { kind: 'ordinary', contentClass: 'discovery', identity: '745dadcc-0000-0000', revision: 'r', name: `long-1-${'y'.repeat(90)}`, text: `BLOCK 1\n${'x'.repeat(328)}` },
  ];
  const assembled = assembleDelivery(parts, 406);
  assert.ok(bytes(assembled.text) <= 406, `the cap holds (was ${bytes(assembled.text)})`);
  assert.ok(namesIn(assembled.text) >= 1, `the omission line keeps a name:\n${omissionLine(assembled.text)}`);
  assert.ok(namesIn(assembled.text) >= namesIn(assembleDelivery8965c63(parts, 406).text), 'no fewer names than 8965c63');
});

// Every record credited at 8965c63 (rendered whole) is still credited.
const creditKeys = (r) => [...r.emittedSubstance.map((e) => `s:${e.identity}:${e.revision}`), ...r.emittedDiscovery.map((e) => `d:${e.identity}:${e.revision}`)];
const lostCredits = (now, then) => { const kept = new Set(creditKeys(now)); return creditKeys(then).filter((key) => !kept.has(key)); };

test('reduced hold-back (review repro 3, cap 728): a smaller hold never pushes a part that rendered whole at 8965c63 down to an excerpt', () => {
  const parts = [
    { kind: 'ordinary', pinned: true, contentClass: 'chrome', text: 'H'.repeat(391) },
    { kind: 'ordinary', contentClass: 'discovery', identity: '4700042a-0000-0000', revision: 'r', name: `long-0-${'y'.repeat(60)}`,
      text: `BLOCK 0\n  line 0 ${'x'.repeat(19)}\n  line 1 ${'x'.repeat(20)}\n  line 2 ${'x'.repeat(28)}\n  line 3 ${'x'.repeat(8)}\n  line 4 ${'x'.repeat(34)}\n${'x'.repeat(1000)}`,
      pointer: `PTR 0 knowledge_get 4700042a-0000-0000${' p'.repeat(38)}`, suffix: '  … rest of 0' },
    { kind: 'ordinary', contentClass: 'discovery', identity: '27be7025-0000-0000', revision: 'r', name: 'n1-xxxx',
      text: `BLOCK 1\n  line 0 xxxxx\n  line 1 ${'x'.repeat(17)}\n  line 2 ${'x'.repeat(36)}\n  line 3 ${'x'.repeat(22)}`,
      pointer: `PTR 1 knowledge_get 27be7025-0000-0000${' p'.repeat(18)}`, suffix: '  … rest of 1' },
    { kind: 'ordinary', contentClass: 'discovery', identity: '79283600-0000-0000', revision: 'r', name: `long-2-${'y'.repeat(110)}`, text: `BLOCK 2\n${'x'.repeat(1252)}` },
    { kind: 'ordinary', contentClass: 'discovery', identity: '6b5f0719-0000-0000', revision: 'r', name: `long-3-${'y'.repeat(70)}`, text: `BLOCK 3\n${'x'.repeat(804)}` },
  ];
  const assembled = assembleDelivery(parts, 728);
  assert.ok(bytes(assembled.text) <= 728, `the cap holds (was ${bytes(assembled.text)})`);
  assert.deepEqual(assembled.emittedDiscovery.map((e) => e.identity), ['27be7025-0000-0000'], 'block 1 renders whole and is credited');
  assert.deepEqual(lostCredits(assembled, assembleDelivery8965c63(parts, 728)), [], 'no credit lost against 8965c63');
});

// DIFFERENTIAL FUZZ against the frozen 8965c63 assembler. The generator mixes
// suffix-bearing parts, parts whose disclosureIdentities outnumber what they
// show, parts shorter than their own pointer, unpointered parts that can only
// render whole or be omitted (so the omission set moves between placement
// passes), hazards, and a custom aggregateLabel.
test('reduced hold-back differential fuzz: 3000 seeded cases never render fewer names, never omit more records, never lose a credit, never exceed the cap', () => {
  let seed = 20261001;
  const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const ri = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const hex = () => Array.from({ length: 8 }, () => '0123456789abcdef'[ri(0, 15)]).join('');
  const lines = (head, n) => [head, ...Array.from({ length: n }, (_, i) => `  line ${i} ${'x'.repeat(ri(5, 60))}`)].join('\n');
  const label = (count, ids) => `+${count} more pointer line(s) held back: ${ids.join(' ')}`;
  // Ordinary bytes only: hazards are uncharged against the configured cap.
  const ordinaryBytes = (text, hazards) => hazards.reduce((sum, h) => sum - (text.includes(h.text) ? bytes(h.text) : text.includes(h.pointer) ? bytes(h.pointer) : 0), bytes(text));
  const seen = { hazards: 0, suffixes: 0, disclosureLists: 0, labels: 0, differs: 0, namedLines: 0, credits: 0, substanceCredits: 0 };
  for (let k = 0; k < 3000; k++) {
    const cap = ri(300, 1500);
    const parts = [];
    const hazards = [];
    if (rnd() < 0.7) parts.push({ kind: 'ordinary', pinned: true, contentClass: 'chrome', text: 'H'.repeat(ri(50, Math.floor(cap * 0.8))) });
    if (rnd() < 0.2) {
      const hazard = { kind: 'hazard', contentClass: 'substance', identity: `${hex()}-hz`, revision: 'r', text: `HAZARD ${k} ${'h'.repeat(ri(20, 300))}`, pointer: `HZ ${k} pointer` };
      hazards.push(hazard);
      parts.push(hazard);
    }
    for (let i = 0, n = ri(1, 7); i < n; i++) {
      const identity = `${hex()}-0000-0000`;
      const name = rnd() < 0.8 ? (rnd() < 0.5 ? `n${i}-${'x'.repeat(ri(1, 20))}` : `long-${i}-${'y'.repeat(ri(60, 120))}`) : undefined;
      const shape = rnd();
      const text = shape < 0.25 ? 'z'.repeat(ri(30, 200)) : shape < 0.45 ? `BLOCK ${i}\n  line 0 ${'x'.repeat(ri(3, 15))}\n${'x'.repeat(ri(100, 1200))}` : lines(`BLOCK ${i}`, ri(1, 30));
      const part = { kind: 'ordinary', contentClass: rnd() < 0.3 ? 'substance' : 'discovery', identity, revision: 'r', name, text };
      if (rnd() < 0.6) part.pointer = `PTR ${i} knowledge_get ${identity}${' p'.repeat(ri(0, 40))}`;
      if (rnd() < 0.35) part.suffix = `  … rest of ${i}`;
      if (rnd() < 0.2) part.disclosureIdentities = [{ identity, revision: 'r', name }, ...Array.from({ length: ri(1, 6) }, (_, j) => ({ identity: `${hex()}-dd-${j}`, revision: 'r', name: rnd() < 0.7 ? `extra-${j}-${'q'.repeat(ri(3, 50))}` : undefined }))];
      if (part.suffix) seen.suffixes++;
      if (part.disclosureIdentities) seen.disclosureLists++;
      parts.push(part);
    }
    const options = rnd() < 0.15 ? { aggregateLabel: label } : {};
    const now = assembleDelivery(parts, cap, options);
    const then = assembleDelivery8965c63(parts, cap, options);
    if (hazards.length) seen.hazards++;
    if (options.aggregateLabel) seen.labels++;
    if (now.text !== then.text) seen.differs++;
    if (namesIn(then.text)) seen.namedLines++;
    const at = `case ${k} (cap ${cap})`;
    assert.ok(namesIn(now.text) >= namesIn(then.text), `${at}: ${namesIn(now.text)} names < ${namesIn(then.text)} at 8965c63\nnow:  ${omissionLine(now.text)}\nthen: ${omissionLine(then.text)}`);
    assert.ok(now.omittedCount <= then.omittedCount, `${at}: omits ${now.omittedCount} records, 8965c63 omitted ${then.omittedCount}`);
    assert.deepEqual(lostCredits(now, then), [], `${at}: records credited at 8965c63 are no longer credited`);
    if (creditKeys(then).length) seen.credits++;
    if (then.emittedSubstance.length) seen.substanceCredits++;
    assert.ok(ordinaryBytes(now.text, hazards) <= Math.max(cap, ordinaryBytes(then.text, hazards)), `${at}: ${ordinaryBytes(now.text, hazards)} ordinary bytes > cap`);
    if (!hazards.length) assert.ok(bytes(now.text) <= cap, `${at}: ${bytes(now.text)} > cap`);
  }
  for (const [what, count] of Object.entries(seen)) assert.ok(count > 50, `the fuzz exercised ${what} (${count} cases)`);
  // The waste the reduced hold recovers is kept: test (a)'s shape still gains its excerpt line.
  assert.ok(excerptLines(assembleDelivery(holdBackParts(330), 500).text) > excerptLines(assembleDelivery8965c63(holdBackParts(330), 500).text), 'the demo shape gains an excerpt line over 8965c63');
});
