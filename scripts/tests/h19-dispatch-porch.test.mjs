// H19 SubagentStart "FRONT PORCH" — frozen pins (spec-only).
//
// SPEC (the only source these pins were written from): decision
// `h19-subagentstart-front-porch-byte-budget-hazards-first-owner-pointers-no-overrun`
// (knowledge_get 0050a536-8b10-4732-a677-f9e9428e485b) at **version 2** —
// v2 corrected v1's unreadable-config sentence and added the degradation
// ladder (bounded skeleton / below-floor misconfiguration / minimal porch /
// pointers-only no-porch) pinned in section (p2) — whose `statement` IS the
// specification, plus the measured incident it answers
// (research_finding 518b7d21 — layer-3 live probe: one of six roster classes
// never USED the owning article because the harness spilled the >2KB
// additionalContext to a persisted file and the agent declined to open it).
//
// H4 READ WALL: the authoring dispatch offered a narrow read of
// scripts/hooks/lib/delivery.mjs for exact anchor strings. H4 DENIED it
// ("'scripts/hooks/lib/delivery.mjs' is implementation — the test-writer never
// reads code"), and the wall was NOT routed around. Consequence, disclosed
// here so a red is diagnosable: the literal anchors below come from the
// decision text and from hook OUTPUT observed in this session's own delivered
// context — never from the implementation. Two of them are exact quotes from
// the decision (`+N owners below`; the `▸ article '<slug>' (<id8>) (<state>`
// header and its `▸ FULL RECORD: knowledge_get <uuid>` companion). The
// PORCH-END line's wording is NOT fixed by the decision — the decision fixes
// only its CONTENT ("the porch byte count, what follows (K article bodies,
// M decision pointers, subject staging yes/no) and the instruction to OPEN
// the persisted file"). isPorchEndLine() below therefore matches that CONTENT
// tolerantly (a byte count + the word article + the word decision on one
// line) rather than a guessed sentence. A red on the detector itself means
// "the porch-end line does not state one of the three facts the ruling
// requires" — report the observed line, do not loosen the detector.
//
// CONTROL DISCIPLINE: two verdicts in this file are "no porch-end line"
// (budget 0; the tool-time hook's scope pin) and each has more than one
// possible cause — the porch really being absent, or the detector matching
// nothing anywhere. TEST 0 is the control arm, placed FIRST: on the SAME
// fixture with the default budget the detector MUST find a porch-end line.
// If TEST 0 is red, every "no porch" verdict in this file is uninformative.
//
// FIXTURE OWNERSHIP (anti_pattern a1b082d1): fixed record ids, an isolated
// temp store per test, an explicit config per test, and fixture prose
// deliberately free of the words "article", "decision" and "byte" so the
// porch-end detector can never match a body line. Every owner owns the SAME
// path (src/a.mjs) so the payload header line is byte-identical across cases
// and the budget arithmetic is not hostage to the path list.
//
// DISPATCH CLASS: `debugger` is used for the staging cases. It receives the
// bounded ACTIVE PLAN line (scoped to coder/debugger/test-writer, decision
// 96125184) but NOT the TDD posture line (scoped to coder/test-writer,
// decision 752caf98) — so the "prefix of the COMPLETE additionalContext"
// claim is exercised with exactly the one preceding line the ruling names.
// The LAST test in this file adds the `coder` class deliberately, because the
// ruling's invariant is about the COMPLETE prefix, not about the plan line
// alone.
//
// MUTATION DISCIPLINE: every pin names the one-line SABOTAGE that must turn
// it red. None is executed here (this role holds no Bash).
// ---------------------------------------------------------------------------

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-09-08T12:00:00.000Z';

// Owned by this test, not imported: PORCH_OWNER_CAP and the default budget are
// SPEC constants (decision 0050a536 §1/§2). Importing them from the
// implementation would let a sabotage of the constant move the oracle with it.
const DEFAULT_BUDGET = 1800;
const OWNER_CAP = 3;

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

// --- fixed record ids ------------------------------------------------------
const OWNER_IDS = [
  '0a111111-1111-4111-8111-111111111111',
  '0b222222-2222-4222-8222-222222222222',
  '0c333333-3333-4333-8333-333333333333',
  '0d444444-4444-4444-8444-444444444444',
  '0e555555-5555-4555-8555-555555555555',
  '0f666666-6666-4666-8666-666666666666',
];
const HAZARD_IDS = [
  '1a111111-1111-4111-8111-111111111111',
  '1b222222-2222-4222-8222-222222222222',
  '1c333333-3333-4333-8333-333333333333',
];
const RULING_IDS = [
  '2a111111-1111-4111-8111-111111111111',
  '2b222222-2222-4222-8222-222222222222',
];
const REF_ID = '3a111111-1111-4111-8111-111111111111';

// --- byte helpers (the invariant is measured in UTF-8 BYTES, never chars) ---
const bytes = (s) => Buffer.byteLength(s, 'utf8');
const bytePrefix = (s, n) => Buffer.from(s, 'utf8').subarray(0, n).toString('utf8');
const occurrences = (hay, needle) => hay.split(needle).length - 1;

// --- porch-end detection (CONTENT-based; see the header note) --------------
const BYTE_COUNT_RE = /\d+\s*(?:bytes|B)\b/;
function isPorchEndLine(line) {
  return BYTE_COUNT_RE.test(line) && /\barticle/i.test(line) && /\bdecision/i.test(line);
}
function porchEndLine(ctx) {
  return ctx.split('\n').find(isPorchEndLine) ?? null;
}
/** Byte offset of the END of the porch-end line within the COMPLETE context. */
function porchEndOffset(ctx) {
  let off = 0;
  for (const line of ctx.split('\n')) {
    if (isPorchEndLine(line)) return off + bytes(line);
    off += bytes(line) + 1;
  }
  return null;
}
function porchOf(ctx) {
  const end = porchEndOffset(ctx);
  return end === null ? null : bytePrefix(ctx, end);
}

// --- the porch ITSELF, and its self-report -------------------------------
// REVIEW FINDING (mechanically proven, 2026-09-08): isPorchEndLine() matches
// on the HEAD of the line, so a porch-end line whose TAIL was cut by the
// final hard clamp still satisfies every count/invariant pin above — the
// implementation did exactly that, emitting "▸ PORCH END (1803 bytes)" with
// the tail severed on an 1800-byte budget. The two helpers below and the
// P-series pins close it: the line must be COMPLETE, and its self-reported
// byte count must equal the porch actually emitted.
const H19_HEADER_RE = /^STERLING KNOWLEDGE DELIVERY \(H19\)/m;
/** Char index just past the porch-end line (char twin of porchEndOffset). */
function porchEndCharIndex(ctx) {
  let idx = 0;
  for (const line of ctx.split('\n')) {
    if (isPorchEndLine(line)) return idx + line.length;
    idx += line.length + 1;
  }
  return null;
}
/** THE PORCH: the H19 header line through the end of the porch-end line. */
function porchBody(ctx) {
  const endChar = porchEndCharIndex(ctx);
  const m = ctx.match(H19_HEADER_RE);
  if (endChar === null || !m) return null;
  return ctx.slice(m.index, endChar);
}
/** The byte count the porch-end line reports about itself. */
function reportedBytes(line) {
  const m = line.match(/(\d+)\s*(?:bytes|B)\b/);
  return m ? Number(m[1]) : null;
}
/** A count stated next to <word> on the porch-end line, either order. */
function countFor(line, word) {
  const before = line.match(new RegExp(`(\\d+)\\s+${word}`, 'i'));
  if (before) return Number(before[1]);
  const after = line.match(new RegExp(`${word}[^0-9]{0,16}(\\d+)`, 'i'));
  return after ? Number(after[1]) : null;
}

// A PORCH owner pointer line carries slug + id8 + the full uuid on ONE line
// (decision §2). renderArticle's own header (§6) puts `▸ FULL RECORD:
// knowledge_get <uuid>` on a SEPARATE line, so it can never match this.
const OWNER_PTR_RE = /^▸\s+(?:article|reference)\s+'([^']*)'\s*\(([0-9a-f]{8})[^\n]*knowledge_get\s+([0-9a-fA-F-]{36})/;
function ownerPointerLines(region) {
  return region
    .split('\n')
    .map((l) => l.match(OWNER_PTR_RE))
    .filter(Boolean)
    .map((m) => ({ slug: m[1], id8: m[2], uuid: m[3] }));
}
const DECISION_PTR_RE = /^\s*→ .*\(knowledge_get\s+[0-9a-fA-F-]{36}\)/;
const decisionPointerCount = (ctx) => ctx.split('\n').filter((l) => DECISION_PTR_RE.test(l)).length;

// --- harness (idioms copied, never imported, from
//     scripts/tests/h19-dispatch-staging.test.mjs) -------------------------
function runHook(script, input, cwd) {
  const r = spawnSync(process.execPath, [join(HOOKS, script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

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

function makeProject(configOverride = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h19-porch-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(configOverride));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

/** budget === undefined -> the key is ABSENT from config (default applies). */
function budgetConfig(budget) {
  return budget === undefined ? {} : { delivery: { preview_budget_bytes: budget } };
}

function writeLockFile(dir) {
  writeFileSync(
    join(dir, '.sterling', 'plan-lock.json'),
    JSON.stringify({
      schema_version: 1,
      plan_path: '/p.md',
      title: 'P',
      approved_at: '2026-09-06T09:00:00.000Z',
      approved_sha256: 'a'.repeat(64),
      file_sha256_at_approval: 'a'.repeat(64),
      approved_session_id: 's0',
      approved_branch: 'main',
      approved_head: 'deadbeef',
      source: 'exit_plan_mode',
    })
  );
}

function writeTranscript(dir, prompt) {
  const p = join(dir, `transcript-${randomUUID()}.jsonl`);
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Task', input: { prompt } }] },
  });
  writeFileSync(p, `${line}\n`);
  return p;
}

const DISPATCH_PROMPT = 'Go work on src/a.mjs and report back.';

const subagentStart = (dir, transcriptPath, extra = {}) => ({
  hook_event_name: 'SubagentStart',
  session_id: 's1',
  transcript_path: transcriptPath,
  cwd: dir,
  prompt_id: 'p1',
  agent_id: 'agent-1',
  agent_type: 'debugger',
  ...extra,
});

// Filler prose with NO anchor word in it ("article", "decision", "byte") and
// no digits, so no fixture body line can ever satisfy isPorchEndLine().
const FILLER = 'zzz filler prose that carries no anchor words at all here. ';
const longBody = (n) => FILLER.repeat(Math.ceil(n / FILLER.length)).slice(0, n);

function seedOwners(store, count, { slugPad = 0, body = 1600 } = {}) {
  const slugs = [];
  for (let i = 0; i < count; i += 1) {
    const slug = `own-${i}${slugPad ? `-${'s'.repeat(slugPad)}` : ''}`;
    slugs.push(slug);
    store.create(
      article(slug, ['src/a.mjs'], {
        id: OWNER_IDS[i],
        what_it_does: `${slug} :: ${longBody(body)}`,
        intended_behavior: `${slug} intends :: ${longBody(400)}`,
      })
    );
  }
  return slugs;
}

const HAZARD_SEVERITIES = ['block', 'warn', 'info'];
function seedHazards(store, count, { tail = 600 } = {}) {
  const tokens = [];
  for (let i = 0; i < count; i += 1) {
    const tok = `HZ${i}`;
    tokens.push(tok);
    store.create({
      ...envelope('anti_pattern'),
      id: HAZARD_IDS[i],
      slug: `hazard-${i}`,
      title: `${tok} short title`,
      trigger: `TRG${i} first ${longBody(tail)}`,
      guidance: `GUI${i} ${longBody(200)}`,
      wrong_way: `WRO${i} ${longBody(200)}`,
      right_way: `RW${i} first ${longBody(tail)}`,
      source_evidence: `EV${i} measured`,
      file_keys: ['src/a.mjs'],
      severity: HAZARD_SEVERITIES[i % HAZARD_SEVERITIES.length],
    });
  }
  return tokens;
}

function seedRulings(store, count) {
  for (let i = 0; i < count; i += 1) {
    const statement = `zzz ruling ${'r'.repeat(i + 1)} holds and nothing else`;
    store.create({
      ...envelope('decision'),
      id: RULING_IDS[i],
      slug: `ruling-${i}`,
      title: statement,
      statement,
      alternatives_rejected: [],
      rationale: `${statement} rationale`,
      file_keys: ['src/a.mjs'],
      authority: 'standing',
    });
  }
}

/** One staged SubagentStart dispatch into governed territory. */
function stage({ budget, owners = 4, hazards = 3, rulings = 2, lock = true, agentType = 'debugger', slugPad = 0, seed, prompt = DISPATCH_PROMPT } = {}) {
  const { dir, store, cleanup } = makeProject(budgetConfig(budget));
  const facts = { slugs: [], tokens: [] };
  if (seed) seed(store, facts);
  else {
    facts.slugs = seedOwners(store, owners, { slugPad });
    facts.tokens = seedHazards(store, hazards);
    seedRulings(store, rulings);
  }
  if (lock) writeLockFile(dir);
  const transcript = writeTranscript(dir, prompt);
  const r = runHook('h19-dispatch-staging.mjs', subagentStart(dir, transcript, { agent_type: agentType }), dir);
  const ctx = r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : '';
  return { ...facts, dir, store, cleanup, r, ctx };
}

const CLEAN_STDERR = /TypeError|ReferenceError|Cannot read propert|undefined is not|^\s+at /m;

// ===========================================================================
// TEST 0 — CONTROL ARM, FIRST. Must pass for the OPPOSITE reason to every
// "no porch-end line" verdict below: on this exact fixture, with the budget
// at its default, the detector FINDS a porch-end line. A red here makes the
// budget-0 pin and the scope pin uninformative, so read it first.
// ===========================================================================
test('CONTROL: default budget on the standard fixture — the porch-end detector finds a line (so a later "no porch" verdict means something)', () => {
  const s = stage({ budget: undefined });
  try {
    assert.equal(s.r.code, 0, s.r.stderr);
    const line = porchEndLine(s.ctx);
    assert.ok(
      line,
      `CONTROL FAILED: no line states a byte count + article bodies + decision pointers. Every "no porch" pin in this file is now uninformative. ctx head=${bytePrefix(s.ctx, 2200)}`
    );
  } finally {
    s.cleanup();
  }
});
// SABOTAGE: never call renderPorch from h19-dispatch-staging.mjs (emit today's
// payload unchanged) — this control goes red, which is exactly the signal that
// the negative pins cannot be trusted.

// ===========================================================================
// (a) THE HEADLINE CASE — 3 hazards + 4 long-bodied owners + a plan lock,
// budget 1800. Split into one concern per test: an early assertion masks the
// later ones (anti_pattern f1d66bef).
// ===========================================================================

test('A1: every rendered hazard\'s (clipped) TRIGGER and RIGHT WAY text is inside the first 1800 UTF-8 bytes of the COMPLETE additionalContext', () => {
  const s = stage({ budget: DEFAULT_BUDGET });
  try {
    assert.equal(s.r.code, 0, s.r.stderr);
    const prefix = bytePrefix(s.ctx, DEFAULT_BUDGET);
    for (let i = 0; i < 3; i += 1) {
      assert.ok(prefix.includes(`TRG${i}`), `hazard ${i} trigger text missing from the 1800-byte prefix; prefix=${prefix}`);
      assert.ok(prefix.includes(`RW${i}`), `hazard ${i} right_way text missing from the 1800-byte prefix; prefix=${prefix}`);
    }
  } finally {
    s.cleanup();
  }
});
// SABOTAGE: drop hazards from the porch (render them only in the remainder,
// as the pre-porch order did) — the trigger tokens fall past byte 1800 behind
// the owner pointer lines and this pin goes red. Second sabotage, same pin:
// clip hazards to the LABEL only ("TRIGGER:" with no text) — red too, which is
// why the tokens sit at character 0 of each fixture trigger.

test('A2: the prefix carries exactly 3 owner pointer lines (PORCH_OWNER_CAP), each with slug + id8 + the full uuid on one line', () => {
  const s = stage({ budget: DEFAULT_BUDGET });
  try {
    const prefix = bytePrefix(s.ctx, DEFAULT_BUDGET);
    const ptrs = ownerPointerLines(prefix);
    assert.equal(ptrs.length, OWNER_CAP, `expected ${OWNER_CAP} owner pointer lines in the prefix, got ${ptrs.length}; prefix=${prefix}`);
    for (const p of ptrs) {
      assert.ok(s.slugs.includes(p.slug), `unknown slug '${p.slug}' in an owner pointer line`);
      const expected = OWNER_IDS[s.slugs.indexOf(p.slug)];
      assert.equal(p.uuid.toLowerCase(), expected, `pointer for '${p.slug}' names the wrong uuid`);
      assert.equal(p.id8, expected.slice(0, 8), `pointer for '${p.slug}' carries an id8 that is not the uuid's first 8 chars`);
    }
  } finally {
    s.cleanup();
  }
});
// SABOTAGE: render the porch owner line without its `knowledge_get <uuid>`
// tail (slug + id8 only, the pre-ruling shape the six probes complained
// about) — OWNER_PTR_RE stops matching and the count assertion goes red.
// Second sabotage: raise PORCH_OWNER_CAP to 4 — the count goes to 4, red.

test('A3: with 4 owners and a cap of 3, the prefix discloses the cut as "+1 owners below"', () => {
  const s = stage({ budget: DEFAULT_BUDGET });
  try {
    const prefix = bytePrefix(s.ctx, DEFAULT_BUDGET);
    assert.match(prefix, /\+1 owners below/, `expected the capped-owners disclosure in the prefix; prefix=${prefix}`);
  } finally {
    s.cleanup();
  }
});
// SABOTAGE: cap the owners silently (slice(0,3) with no "+N owners below"
// line) — this pin goes red. That silence is the exact failure the ruling
// forbids: "every cut is named with a count, nothing is omitted silently".

test('A4: the porch-end line states the count of article bodies below — 4, every owner, not only the 3 admitted to the porch', () => {
  const s = stage({ budget: DEFAULT_BUDGET });
  try {
    const line = porchEndLine(s.ctx);
    assert.ok(line, 'no porch-end line found (see the CONTROL test)');
    assert.equal(countFor(line, 'article'), 4, `porch-end line states the wrong article-body count: ${line}`);
  } finally {
    s.cleanup();
  }
});
// SABOTAGE: render the remainder for only the porch-admitted owners and count
// 3 (decision §3 requires EVERY owner below) — red. Second sabotage: count
// the porch's admitted owners instead of the bodies actually rendered — red.

test('A5: the porch-end line\'s decision-pointer count equals the pointers actually rendered below, and that is the 2 seeded rulings', () => {
  const s = stage({ budget: DEFAULT_BUDGET });
  try {
    const line = porchEndLine(s.ctx);
    assert.ok(line, 'no porch-end line found (see the CONTROL test)');
    const rendered = decisionPointerCount(s.ctx);
    assert.equal(countFor(line, 'decision'), rendered, `porch-end promises a decision-pointer count that disagrees with what is rendered below (${rendered}); line=${line}`);
    assert.equal(rendered, 2, 'the isolated store holds exactly the 2 seeded rulings for this path');
  } finally {
    s.cleanup();
  }
});
// SABOTAGE: hardcode the decision count (or count candidates before the cap
// instead of the pointers actually emitted) — the self-consistency assertion
// goes red. The second assertion is the fixture's own control: if only IT is
// red, the store delivered more pointers than the two seeded rulings and the
// finding is about staging's candidate set, not about the porch.

test('A6: INVARIANT — the porch ends at or before byte 1800 of the COMPLETE additionalContext (plan-lock line included)', () => {
  const s = stage({ budget: DEFAULT_BUDGET });
  try {
    const end = porchEndOffset(s.ctx);
    assert.ok(end !== null, 'no porch-end line found (see the CONTROL test)');
    assert.ok(
      end <= DEFAULT_BUDGET,
      `porch overruns its budget: ends at byte ${end} of the complete context, budget ${DEFAULT_BUDGET}; porch=${porchOf(s.ctx)}`
    );
    assert.ok(s.ctx.startsWith('ACTIVE PLAN: P (/p.md)'), 'fixture control: the plan-lock line really does precede the payload here');
  } finally {
    s.cleanup();
  }
});
// SABOTAGE: budget the PAYLOAD alone instead of the complete context (skip
// subtracting the activePlanLine + separator bytes — the alternative the
// ruling records as FATAL) — the porch-end line slides past byte 1800 and
// this pin goes red. The trailing assertion is the fixture control that keeps
// the verdict from being satisfied by "there was no plan line anyway".

test('A7: hazards appear ONCE in the whole context — the porch IS the hazard rendering, renderHazards is not repeated below', () => {
  const s = stage({ budget: DEFAULT_BUDGET });
  try {
    for (let i = 0; i < 3; i += 1) {
      assert.equal(occurrences(s.ctx, `TRG${i}`), 1, `hazard ${i} trigger text appears ${occurrences(s.ctx, `TRG${i}`)} times; it must appear exactly once`);
      assert.equal(occurrences(s.ctx, `RW${i}`), 1, `hazard ${i} right_way text appears ${occurrences(s.ctx, `RW${i}`)} times; it must appear exactly once`);
    }
  } finally {
    s.cleanup();
  }
});
// SABOTAGE: leave renderHazards in the remainder while the porch also renders
// them (decision §3: "the remainder is today's rendering MINUS renderHazards")
// — the occurrence counts become 2 and this pin goes red.

// ===========================================================================
// (b) BUDGET 0 DISABLES THE PORCH — the Part-2-only control. Three concerns,
// three tests.
// ===========================================================================

test('B1: budget 0 — no porch-end line anywhere in the context', () => {
  const s = stage({ budget: 0 });
  try {
    assert.equal(s.r.code, 0, s.r.stderr);
    assert.equal(porchEndLine(s.ctx), null, `budget 0 must disable the porch entirely; found: ${porchEndLine(s.ctx)}`);
    assert.doesNotMatch(s.ctx, /\+\d+ owners below/, 'budget 0 renders no capped-owner disclosure either');
  } finally {
    s.cleanup();
  }
});
// SABOTAGE: treat 0 as falsy-therefore-absent and fall through to the default
// 1800 (`budget || 1800`) — a porch appears and this pin goes red. Read the
// CONTROL test first: it proves the detector does fire on this fixture.

test('B2: budget 0 — the hazards are still rendered (delivery is not silenced by disabling the porch)', () => {
  const s = stage({ budget: 0 });
  try {
    for (let i = 0; i < 3; i += 1) {
      assert.ok(s.ctx.includes(`TRG${i}`), `hazard ${i} must still be delivered with the porch disabled; ctx head=${bytePrefix(s.ctx, 1200)}`);
    }
  } finally {
    s.cleanup();
  }
});
// SABOTAGE: route hazard rendering exclusively through renderPorch, so
// budget 0 drops hazards altogether — this pin goes red. 0 disables the
// PORCH, never the delivery.

test('B3: budget 0 — renderArticle headers still carry the (id8) that all six probes asked for (Part 2 is independent of the porch)', () => {
  const s = stage({ budget: 0 });
  try {
    assert.match(
      s.ctx,
      new RegExp(`▸ article 'own-0' \\(${OWNER_IDS[0].slice(0, 8)}\\) \\(`),
      `expected the id8-bearing article header with the porch disabled; ctx head=${bytePrefix(s.ctx, 1500)}`
    );
  } finally {
    s.cleanup();
  }
});
// SABOTAGE: gate the §6 header change behind the porch being enabled (only
// add the id8 when a porch is rendered) — this pin goes red. §6 says "on
// every surface", which includes the budget-0 surface.

// ===========================================================================
// (c) THE OVERRUN PATH — 3 hazards, 6 owners with very long slugs, a small
// budget, no plan lock (so the whole 700 bytes belongs to the porch).
// ===========================================================================

const TIGHT = 700;

test('C1: INVARIANT under pressure — a 700-byte budget with 6 long-slug owners still ends the porch at or before byte 700', () => {
  const s = stage({ budget: TIGHT, owners: 6, slugPad: 150, lock: false });
  try {
    const end = porchEndOffset(s.ctx);
    assert.ok(end !== null, `expected a porch even under pressure (owners reduced, digests shrunk, hazards clipped, hard clamp last); ctx head=${bytePrefix(s.ctx, 1200)}`);
    assert.ok(end <= TIGHT, `porch overruns: ends at byte ${end}, budget ${TIGHT}; porch=${porchOf(s.ctx)}`);
  } finally {
    s.cleanup();
  }
});
// SABOTAGE: let the fixed lines (header + owner lines + porch-end) overrun and
// merely disclose the overrun — the alternative the ruling records as FATAL —
// and this pin goes red.

test('C2: under pressure the porch admits FEWER owners than the cap, and the shortfall is disclosed with an exact count', () => {
  const s = stage({ budget: TIGHT, owners: 6, slugPad: 150, lock: false });
  try {
    const porch = porchOf(s.ctx);
    assert.ok(porch, 'no porch-end line found — see C1');
    const admitted = ownerPointerLines(porch).length;
    assert.ok(admitted < OWNER_CAP, `expected owners to be REDUCED below the cap of ${OWNER_CAP} at a ${TIGHT}-byte budget, got ${admitted}; porch=${porch}`);
    const m = porch.match(/\+(\d+) owners below/);
    assert.ok(m, `the reduction must be named with a count; porch=${porch}`);
    assert.equal(Number(m[1]), 6 - admitted, `disclosed shortfall (${m[1]}) must equal owners not admitted (${6 - admitted})`);
  } finally {
    s.cleanup();
  }
});
// SABOTAGE: hardcode the disclosure at the cap ("+3 owners below") instead of
// deriving it from how many were actually admitted — the equality goes red.
// Second sabotage: drop owners for budget without disclosing — the match on
// "+N owners below" goes red.

test('C3: the overrun path throws nothing, exits 0, and still delivers (no silent collapse of the staging half)', () => {
  const s = stage({ budget: TIGHT, owners: 6, slugPad: 150, lock: false });
  try {
    assert.equal(s.r.code, 0, s.r.stderr);
    assert.doesNotMatch(s.r.stderr, CLEAN_STDERR, `a porch exception must never surface as a stack trace: ${s.r.stderr}`);
    assert.match(s.ctx, /STERLING KNOWLEDGE DELIVERY/, 'the staged payload survives the tight budget');
  } finally {
    s.cleanup();
  }
});
// SABOTAGE: let renderPorch throw on the reduce-to-zero-owners path (e.g.
// index owners[0] unconditionally) — the staging half disappears and the
// KNOWLEDGE DELIVERY match goes red while stderr carries the trace.

test('C4: ORDERING — owners are sacrificed before hazards; every hazard survives a budget too small for the owner lines', () => {
  const s = stage({ budget: 1300, owners: 6, slugPad: 150, lock: false });
  try {
    const porch = porchOf(s.ctx);
    assert.ok(porch, `expected a porch at 1300 bytes; ctx head=${bytePrefix(s.ctx, 1500)}`);
    assert.ok(ownerPointerLines(porch).length < OWNER_CAP, `owners must be reduced first; porch=${porch}`);
    for (let i = 0; i < 3; i += 1) {
      assert.ok(porch.includes(`TRG${i}`), `hazard ${i} was DROPPED for budget — the ruling clips hazards harder but never drops them; porch=${porch}`);
    }
  } finally {
    s.cleanup();
  }
});
// SABOTAGE: invert the reduction order (drop hazards to keep the owner
// pointers) — the hazard-token assertions go red. This is the pin that makes
// "hazards first" mechanical rather than a comment.

// ===========================================================================
// (d) MULTIBYTE — the invariant is bytes, not characters. The fixture is
// built so a chars-based measurement would ADMIT more than the byte budget.
// ===========================================================================

const CJK = '日本語テキストの詰め物です。';
const cjkBody = (n) => CJK.repeat(Math.ceil(n / CJK.length)).slice(0, n);

function seedMultibyte(store, facts) {
  facts.slugs = [];
  for (let i = 0; i < 4; i += 1) {
    const slug = `øwner-日本語-${i}`;
    facts.slugs.push(slug);
    store.create(
      article(slug, ['src/a.mjs'], {
        id: OWNER_IDS[i],
        what_it_does: `${slug} :: ${cjkBody(1200)}`,
        intended_behavior: `${slug} intends :: ${cjkBody(300)}`,
      })
    );
  }
  facts.tokens = [];
  for (let i = 0; i < 3; i += 1) {
    facts.tokens.push(`TRG${i}`);
    store.create({
      ...envelope('anti_pattern'),
      id: HAZARD_IDS[i],
      slug: `hazard-ø-${i}`,
      title: `HZ${i} ▸ 危険 tîtle`,
      trigger: `TRG${i} ▸ ${cjkBody(400)}`,
      guidance: `GUI${i} ${cjkBody(100)}`,
      wrong_way: `WRO${i} ${cjkBody(100)}`,
      right_way: `RW${i} ▸ ${cjkBody(400)}`,
      source_evidence: `EV${i} measured`,
      file_keys: ['src/a.mjs'],
      severity: HAZARD_SEVERITIES[i % HAZARD_SEVERITIES.length],
    });
  }
  seedRulings(store, 2);
}

test('D1: INVARIANT in BYTES with 3-byte UTF-8 content — the porch fits 1800 BYTES, and it is byte-dense enough that a chars-based measure would have overrun', () => {
  const s = stage({ budget: DEFAULT_BUDGET, lock: false, seed: seedMultibyte });
  try {
    assert.equal(s.r.code, 0, s.r.stderr);
    const porch = porchOf(s.ctx);
    assert.ok(porch, `expected a porch on the multibyte fixture; ctx head=${bytePrefix(s.ctx, 1800)}`);
    assert.ok(
      bytes(porch) <= DEFAULT_BUDGET,
      `porch is ${bytes(porch)} bytes (${porch.length} chars) against a ${DEFAULT_BUDGET}-BYTE budget — a chars-based measurement would have passed here; porch=${porch}`
    );
    // Discrimination control: a nearly-empty porch would satisfy the byte
    // budget for reasons having nothing to do with how it was measured.
    assert.ok(bytes(porch) > porch.length + 200, `the porch must actually be multibyte-dense for this pin to discriminate: ${bytes(porch)} bytes vs ${porch.length} chars`);
    assert.ok(bytes(porch) >= DEFAULT_BUDGET / 2, `the porch must be near-full for this pin to discriminate; got ${bytes(porch)} bytes`);
  } finally {
    s.cleanup();
  }
});
// SABOTAGE: measure the budget with String#length instead of
// Buffer.byteLength — the rejected "chars" alternative — and the porch grows
// past 1800 bytes while still under 1800 chars; the byte assertion goes red.
// The two discrimination assertions are the control arm: if only they are red,
// the fixture stopped being dense/full and the byte pin proved nothing.

test('D2: multibyte hazards and slugs still reach the reader — the clip does not corrupt or drop them', () => {
  const s = stage({ budget: DEFAULT_BUDGET, lock: false, seed: seedMultibyte });
  try {
    const porch = porchOf(s.ctx);
    assert.ok(porch, 'no porch-end line found — see D1');
    for (let i = 0; i < 3; i += 1) assert.ok(porch.includes(`TRG${i}`), `multibyte hazard ${i} missing from the porch; porch=${porch}`);
    const ptrs = ownerPointerLines(porch);
    assert.ok(ptrs.length > 0, `expected at least one owner pointer line on the multibyte fixture; porch=${porch}`);
    for (const p of ptrs) assert.ok(s.slugs.includes(p.slug), `owner pointer slug '${p.slug}' is not one of the seeded multibyte slugs (clipped or mangled)`);
  } finally {
    s.cleanup();
  }
});
// SABOTAGE: clip the porch by slicing a Buffer at a byte boundary and
// decoding (splitting a 3-byte character) — a slug gains U+FFFD, stops
// matching the seeded set, and this pin goes red.

// ===========================================================================
// (p) THE PORCH-END LINE IS ITSELF LOAD-BEARING — added after the independent
// review proved the blind spot: every pin above reads the HEAD of that line
// (a byte count, "article", "decision"), so the final hard clamp could sever
// its TAIL and stay green. MEASURED at the time of review: the
// implementation emitted "▸ PORCH END (1803 bytes)" with the tail cut on an
// 1800-byte budget — the instruction the whole ruling exists to deliver
// (decision 0050a536 §2: "the instruction to OPEN the persisted file when
// the block is shown truncated, with normal instruction precedence") was
// the very text being thrown away, and the self-reported count was three
// bytes over the budget it claimed to respect.
//
// Both pins run on all four fixtures — the standard one, the two pressure
// ones (where the clamp actually fires) and the multibyte one (where a
// byte/char confusion in the clamp shows up). Wording stays tolerant, as
// everywhere else in this file: completeness is judged by "ends in a
// sentence terminator" + "states precedence", never by a guessed sentence.
// ===========================================================================

const PORCH_END_FIXTURES = [
  ['standard (budget 1800, plan lock, 4 owners, 3 hazards)', () => stage({ budget: DEFAULT_BUDGET }), DEFAULT_BUDGET],
  ['tight (budget 700, 6 long-slug owners, no lock)', () => stage({ budget: TIGHT, owners: 6, slugPad: 150, lock: false }), TIGHT],
  ['pressure (budget 1300, 6 long-slug owners, no lock)', () => stage({ budget: 1300, owners: 6, slugPad: 150, lock: false }), 1300],
  ['multibyte (budget 1800, CJK owners and hazards)', () => stage({ budget: DEFAULT_BUDGET, lock: false, seed: seedMultibyte }), DEFAULT_BUDGET],
];

for (const [label, build] of PORCH_END_FIXTURES) {
  test(`P1 [${label}]: the porch-end line is COMPLETE — it reaches its terminator and still carries the persisted-file instruction's precedence clause`, () => {
    const s = build();
    try {
      const line = porchEndLine(s.ctx);
      assert.ok(line, `no porch-end line found (see the CONTROL test); ctx head=${bytePrefix(s.ctx, 2200)}`);
      const trimmed = line.replace(/\s+$/, '');
      assert.match(
        trimmed,
        /[.!]$/,
        `the porch-end line was CUT — its last non-space character is not a sentence terminator, so the clamp severed the instruction the porch exists to deliver: ${JSON.stringify(trimmed)}`
      );
      assert.match(
        trimmed,
        /precedence/i,
        `the porch-end line must state normal instruction precedence alongside the open-the-persisted-file instruction (decision 0050a536 §2): ${JSON.stringify(trimmed)}`
      );
    } finally {
      s.cleanup();
    }
  });
  // SABOTAGE (the measured one): let the final hard clamp cut the last 3
  // bytes off the porch — the terminator assertion goes red while every
  // count/invariant pin above stays green, which is exactly why this pin
  // exists. Second sabotage: drop the "normal instruction precedence
  // applies" clause from the porch-end wording (the phrasing Codex insisted
  // on over "trusted continuation of your brief") — the second assertion
  // goes red.
}

for (const [label, build, budget] of PORCH_END_FIXTURES) {
  test(`P2 [${label}]: the porch-end line's self-reported byte count EQUALS the porch actually emitted, and that count is within budget`, () => {
    const s = build();
    try {
      const line = porchEndLine(s.ctx);
      assert.ok(line, `no porch-end line found (see the CONTROL test); ctx head=${bytePrefix(s.ctx, 2200)}`);
      const reported = reportedBytes(line);
      assert.ok(reported !== null, `the porch-end line states no byte count: ${line}`);
      const body = porchBody(s.ctx);
      assert.ok(body, `could not locate the H19 header line that starts the porch; ctx head=${bytePrefix(s.ctx, 2200)}`);
      const actual = bytes(body);
      assert.equal(
        reported,
        actual,
        `porch self-report disagrees with the porch emitted: says ${reported} bytes, measured ${actual} bytes (from the H19 header line through the end of the porch-end line). For diagnosis, the complete-context prefix through that same point is ${porchEndOffset(s.ctx)} bytes — if THAT is the number reported, the count is being taken over the wrong span; if the reported number exceeds the budget (${budget}), the clamp ran after the count was formatted.`
      );
      assert.ok(
        reported <= budget,
        `the porch reports ${reported} bytes against a budget of ${budget} — a self-report that admits an overrun is the overrun the ruling forbids`
      );
    } finally {
      s.cleanup();
    }
  });
  // SABOTAGE (the measured one): format the porch-end line's byte count
  // BEFORE the final clamp runs (or clamp 3 bytes off the tail afterwards)
  // — the equality goes red, and on an at-budget fixture the second
  // assertion goes red too. Second sabotage: count the span from the start
  // of the COMPLETE context (including the ACTIVE PLAN line) instead of from
  // the H19 header line — the equality goes red and the failure message
  // names the alternative span so the cause is readable off the output.
}

// ===========================================================================
// (p2) THE DEGRADATION LADDER, per decision 0050a536 **version 2** (re-read
// after the Codex review; v1's "unreadable config -> default" sentence was
// itself corrected there). v2 adds four rungs this file must pin:
//   - every byte of the skeleton that comes from RECORD DATA (hazard title
//     AND slug, owner slug) is clipped, so the skeleton is BOUNDED;
//   - a positive budget below PORCH_MIN_BUDGET_BYTES is MISCONFIGURED: no
//     porch, one stderr line naming budget and floor;
//   - a valid budget too small for the full skeleton degrades to the MINIMAL
//     porch (header + porch-end line naming the budget and the counts
//     rendered below) — never a clamped fragment;
//   - zero owners + zero hazards (decision pointers only) gets no porch by
//     design, because a handful of pointer lines cannot spill.
// ===========================================================================

const HUGE_CJK_SLUG = '界'.repeat(1000); // 3000 UTF-8 bytes in 1000 chars
function seedHugeHazard(store, facts) {
  facts.slugs = seedOwners(store, 4);
  facts.tokens = ['TRG0'];
  store.create({
    ...envelope('anti_pattern'),
    id: HAZARD_IDS[0],
    slug: HUGE_CJK_SLUG,
    title: `HZ0 ${'T'.repeat(996)}`,
    trigger: `TRG0 first ${longBody(600)}`,
    guidance: `GUI0 ${longBody(200)}`,
    wrong_way: `WRO0 ${longBody(200)}`,
    right_way: `RW0 first ${longBody(600)}`,
    source_evidence: 'EV0 measured',
    file_keys: ['src/a.mjs'],
    severity: 'block',
  });
  seedRulings(store, 2);
}

test('P3a: BOUNDED SKELETON — a hazard whose slug is 1000 CJK chars (3000 bytes) and whose title is 1000 chars cannot push the porch past 1800 bytes', () => {
  const s = stage({ budget: DEFAULT_BUDGET, lock: false, seed: seedHugeHazard });
  try {
    assert.equal(s.r.code, 0, s.r.stderr);
    const end = porchEndOffset(s.ctx);
    assert.ok(end !== null, `oversize record data must be CLIPPED, not degrade the porch away; ctx head=${bytePrefix(s.ctx, 2200)}`);
    assert.ok(end <= DEFAULT_BUDGET, `porch overruns on oversize record data: ends at byte ${end}; porch=${porchOf(s.ctx)}`);
  } finally {
    s.cleanup();
  }
});
// SABOTAGE: interpolate the hazard SLUG raw (clip only the title, which is
// what the pre-v2 skeleton did) — 3000 bytes of one slug blows the 1800-byte
// budget and this pin goes red.

test('P3b: BOUNDED SKELETON — nothing from the fixed skeleton is lost to the oversize record: the +N owners line and a COMPLETE porch-end line both survive, and the 1000-char slug appears nowhere in full', () => {
  const s = stage({ budget: DEFAULT_BUDGET, lock: false, seed: seedHugeHazard });
  try {
    const porch = porchOf(s.ctx);
    assert.ok(porch, 'no porch-end line found — see P3a');
    const admitted = ownerPointerLines(porch).length;
    const m = porch.match(/\+(\d+) owners below/);
    assert.ok(m, `the owners not admitted must still be disclosed with a count; porch=${porch}`);
    assert.equal(Number(m[1]), 4 - admitted, `disclosed shortfall (${m[1]}) must equal owners not admitted (${4 - admitted})`);
    const line = porchEndLine(s.ctx);
    assert.match(line.replace(/\s+$/, ''), /[.!]$/, `the porch-end line was cut by the oversize record: ${JSON.stringify(line)}`);
    assert.match(line, /precedence/i, `the porch-end line lost its precedence clause: ${JSON.stringify(line)}`);
    assert.ok(!s.ctx.includes(HUGE_CJK_SLUG), 'the full 1000-char slug must never be interpolated raw anywhere in the context');
  } finally {
    s.cleanup();
  }
});
// SABOTAGE: spend the budget on record data first and let the skeleton lines
// (+N owners, porch-end) be whatever fits afterwards — the +N assertion or
// the terminator assertion goes red. The skeleton is fixed; the record data
// is what yields.

const TINY = 10;

test('P4: MISCONFIGURED BUDGET — a positive budget below the floor (10) renders NO porch, keeps delivering, exits 0, and says so on stderr naming both numbers', () => {
  const s = stage({ budget: TINY, lock: false });
  try {
    assert.equal(s.r.code, 0, s.r.stderr);
    assert.equal(porchEndLine(s.ctx), null, `a budget below the floor must not produce a porch; found: ${porchEndLine(s.ctx)}`);
    for (let i = 0; i < 3; i += 1) {
      assert.ok(s.ctx.includes(`TRG${i}`), `hazard ${i} must still be rendered in today's position; ctx head=${bytePrefix(s.ctx, 1500)}`);
    }
    assert.match(s.r.stderr, /budget/i, `the misconfiguration must be disclosed on stderr naming the budget: ${JSON.stringify(s.r.stderr)}`);
    assert.match(s.r.stderr, /floor|minimum/i, `the disclosure must also name the floor so the operator can fix the value: ${JSON.stringify(s.r.stderr)}`);
  } finally {
    s.cleanup();
  }
});
// SABOTAGE: treat a below-floor budget as if it were valid — the clamp then
// emits a 10-byte fragment and the "no porch-end line" assertion goes red;
// or silence the stderr line (the P5-fail-loud half) and the /budget/ and
// /floor/ assertions go red. Note the CONTROL test above: it proves the
// detector fires on a comparable fixture, so "no porch" here is a verdict
// about the budget and not about the detector.

const SMALL = 600;

test('P5a: MINIMAL PORCH — a valid-but-small budget (600) still yields a porch that fits and whose porch-end line is COMPLETE, never a clamped fragment', () => {
  const s = stage({ budget: SMALL, owners: 6, slugPad: 150, lock: false });
  try {
    assert.equal(s.r.code, 0, s.r.stderr);
    const end = porchEndOffset(s.ctx);
    assert.ok(
      end !== null,
      `expected the MINIMAL porch at ${SMALL} bytes, not the below-floor path. If stderr names a floor above ${SMALL}, this fixture's budget is the thing to raise — the ruling's floor value is PORCH_MIN_BUDGET_BYTES and this file deliberately does not import it. stderr=${JSON.stringify(s.r.stderr)}`
    );
    assert.ok(end <= SMALL, `porch overruns the small budget: ends at byte ${end}; porch=${porchOf(s.ctx)}`);
    const line = porchEndLine(s.ctx);
    assert.match(line.replace(/\s+$/, ''), /[.!]$/, `the minimal porch must be a COMPLETE porch-end line, not a fragment: ${JSON.stringify(line)}`);
    assert.match(line, /precedence/i, `the minimal porch keeps the precedence clause — it is the only sentence left: ${JSON.stringify(line)}`);
  } finally {
    s.cleanup();
  }
});
// SABOTAGE: keep hard-clamping at small budgets instead of degrading to the
// minimal porch — the terminator/precedence assertions go red on the
// fragment. This is the v2 rung: below the full skeleton the porch shrinks to
// a complete sentence, it never becomes a cut one.

test('P5b: MINIMAL PORCH shape — header + porch-end line only: it names its budget and what is below, carries no owner pointer lines, and the hazards it defers still arrive', () => {
  const s = stage({ budget: SMALL, owners: 6, slugPad: 150, lock: false });
  try {
    const porch = porchOf(s.ctx);
    assert.ok(porch, 'no porch-end line found — see P5a');
    assert.equal(ownerPointerLines(porch).length, 0, `the minimal porch carries no owner pointer lines; porch=${porch}`);
    assert.ok(porch.includes(String(SMALL)), `the minimal porch must name the budget it degraded to (${SMALL}); porch=${porch}`);
    assert.match(porch, /hazard/i, `the minimal porch must state that the hazards are rendered below; porch=${porch}`);
    for (let i = 0; i < 3; i += 1) {
      assert.ok(s.ctx.includes(`TRG${i}`), `hazard ${i} is deferred below, never dropped; ctx head=${bytePrefix(s.ctx, 1600)}`);
    }
  } finally {
    s.cleanup();
  }
});
// SABOTAGE: degrade to a header-only porch that says nothing about what was
// deferred — the budget/hazard assertions go red. Second sabotage: defer the
// hazards without rendering them below — the TRG assertions go red, which is
// the difference between deferring and losing.

test('P6: DECISION-ONLY payload (zero owners, zero hazards, one ruling) gets NO porch by design, and the decision pointers are delivered anyway', () => {
  const s = stage({
    budget: DEFAULT_BUDGET,
    lock: false,
    seed: (store, facts) => {
      facts.slugs = [];
      facts.tokens = [];
      seedRulings(store, 1);
    },
  });
  try {
    assert.equal(s.r.code, 0, s.r.stderr);
    assert.equal(porchEndLine(s.ctx), null, `a pointers-only payload cannot spill, so it gets no porch; found: ${porchEndLine(s.ctx)}`);
    assert.ok(decisionPointerCount(s.ctx) >= 1, `the ruling must still be delivered without a porch; ctx=${bytePrefix(s.ctx, 1600)}`);
    assert.ok(s.ctx.includes('zzz ruling r holds'), 'the seeded ruling arrives by its statement text');
  } finally {
    s.cleanup();
  }
});
// SABOTAGE: build the porch unconditionally whenever the payload is non-empty
// — a porch appears over two pointer lines and the "no porch" assertion goes
// red. Second sabotage: make the no-porch branch return before rendering the
// pointers — the delivery assertions go red, which separates "no porch" from
// "no delivery".

// ===========================================================================
// (p3) TWO MORE UNBOUNDED INPUTS, from the Codex re-check of the FIXED
// implementation. Both are skeleton bytes that do not come from a record's
// title or slug, so decision 0050a536 §1's "every byte ... that comes from
// record data is clipped" does not by itself cover them:
//   - THE GOVERNED PATH, which the H19 header line interpolates. The path is
//     caller data (a dispatch prompt names it), not record data, and the
//     header is the porch's FIRST skeleton line — an unclipped 1.6 KB path
//     eats an 1800-byte budget on its own.
//   - A SEVEN-DIGIT BUDGET, where the porch's own byte count grows a digit
//     and a >1 MB owner body makes any pre-clamp arithmetic visible.
// ===========================================================================

// ~1.6 KB, ASCII multi-segment (the alternative the review offered). ASCII
// deliberately: the pin is header BOUNDEDNESS, and a CJK filename would also
// be testing whether the prompt path-scraper recognises one — a different
// question, already covered for bytes by D1 and P3.
const LONG_REL = `src/${Array.from({ length: 60 }, (_, i) => `seg${String(i).padStart(2, '0')}-longdirectorysegment`).join('/')}/target.mjs`;
const LONG_REL_PROMPT = `Go work on ${LONG_REL} and report back.`;

function seedLongPath(store, facts) {
  facts.slugs = [];
  for (let i = 0; i < 4; i += 1) {
    const slug = `own-${i}`;
    facts.slugs.push(slug);
    store.create(
      article(slug, [LONG_REL], {
        id: OWNER_IDS[i],
        what_it_does: `${slug} :: ${longBody(1600)}`,
        intended_behavior: `${slug} intends :: ${longBody(400)}`,
      })
    );
  }
  facts.tokens = ['TRG0'];
  store.create({
    ...envelope('anti_pattern'),
    id: HAZARD_IDS[0],
    slug: 'hazard-longpath',
    title: 'HZ0 short title',
    trigger: `TRG0 first ${longBody(600)}`,
    guidance: `GUI0 ${longBody(200)}`,
    wrong_way: `WRO0 ${longBody(200)}`,
    right_way: `RW0 first ${longBody(600)}`,
    source_evidence: 'EV0 measured',
    file_keys: [LONG_REL],
    severity: 'block',
  });
  seedRulings(store, 2);
}

test('P7a: BOUNDED HEADER — a ~1.6 KB governed path cannot spend the 1800-byte budget: the porch fits, the +N owners line and a COMPLETE porch-end line both survive', () => {
  const s = stage({ budget: DEFAULT_BUDGET, lock: false, prompt: LONG_REL_PROMPT, seed: seedLongPath });
  try {
    assert.equal(s.r.code, 0, s.r.stderr);
    assert.match(s.ctx, /STERLING KNOWLEDGE DELIVERY/, 'fixture control: the long path was scraped from the prompt and its territory really was staged');
    const end = porchEndOffset(s.ctx);
    assert.ok(end !== null, `an oversize PATH must be clipped, not degrade the porch away; ctx head=${bytePrefix(s.ctx, 2200)}`);
    assert.ok(end <= DEFAULT_BUDGET, `porch overruns on an oversize governed path: ends at byte ${end}; porch=${porchOf(s.ctx)}`);
    const porch = porchOf(s.ctx);
    const m = porch.match(/\+(\d+) owners below/);
    assert.ok(m, `the capped owners must still be disclosed; porch=${porch}`);
    assert.equal(Number(m[1]), 4 - ownerPointerLines(porch).length, 'disclosed shortfall must equal the owners not admitted');
    const line = porchEndLine(s.ctx);
    assert.match(line.replace(/\s+$/, ''), /[.!]$/, `the porch-end line was cut by the long path: ${JSON.stringify(line)}`);
    assert.match(line, /precedence/i, `the porch-end line lost its precedence clause: ${JSON.stringify(line)}`);
  } finally {
    s.cleanup();
  }
});
// SABOTAGE: interpolate the governed path into the header line raw (clip only
// record-sourced bytes, which is exactly the gap the fixed implementation
// left) — 1.6 KB of path consumes the budget, the skeleton lines fall off the
// end, and the invariant/+N/terminator assertions go red. The fixture control
// on the first line keeps a red from being satisfiable by "nothing was
// staged at all".

test('P7b: BOUNDED HEADER — the porch shows a CLIPPED form of the path; the raw 1.6 KB path never appears inside the porch (the remainder may still carry it)', () => {
  const s = stage({ budget: DEFAULT_BUDGET, lock: false, prompt: LONG_REL_PROMPT, seed: seedLongPath });
  try {
    const porch = porchOf(s.ctx);
    assert.ok(porch, 'no porch-end line found — see P7a');
    assert.ok(!porch.includes(LONG_REL), `the raw ${bytes(LONG_REL)}-byte path must never be interpolated whole inside the porch; porch=${porch}`);
    assert.ok(porch.includes('src/seg00-'), `the porch must still NAME the territory in clipped form, not drop it; porch=${porch}`);
  } finally {
    s.cleanup();
  }
});
// SABOTAGE: clip the header by dropping the path entirely (a porch that names
// no territory) — the second assertion goes red; keep it raw — the first goes
// red. The pin is "clipped", not "absent". The remainder is deliberately
// exempt: it is below the preview boundary and carries no byte claim.

test('P7c: BOUNDED HEADER under a MINIMAL-porch budget (600) — still a complete porch-end sentence, never a fragment, and never the raw path', () => {
  const s = stage({ budget: SMALL, lock: false, prompt: LONG_REL_PROMPT, seed: seedLongPath });
  try {
    assert.equal(s.r.code, 0, s.r.stderr);
    const end = porchEndOffset(s.ctx);
    assert.ok(
      end !== null,
      `expected the MINIMAL porch at ${SMALL} bytes with a long path, not the below-floor path; if stderr names a floor above ${SMALL} raise this fixture's budget. stderr=${JSON.stringify(s.r.stderr)}`
    );
    assert.ok(end <= SMALL, `porch overruns the small budget with a long path: ends at byte ${end}; porch=${porchOf(s.ctx)}`);
    const line = porchEndLine(s.ctx);
    assert.match(line.replace(/\s+$/, ''), /[.!]$/, `the minimal porch must be a complete sentence: ${JSON.stringify(line)}`);
    assert.match(line, /precedence/i, `the minimal porch keeps the precedence clause: ${JSON.stringify(line)}`);
    assert.ok(!porchOf(s.ctx).includes(LONG_REL), 'the raw path must not appear inside the minimal porch either');
  } finally {
    s.cleanup();
  }
});
// SABOTAGE: let the header's path push the minimal porch over its budget, or
// clamp the minimal porch's sentence to fit around an unclipped path — the
// invariant or the terminator assertion goes red.

const BIG_BUDGET = 1_000_000;

function seedSevenDigit(store, facts) {
  facts.slugs = ['own-0'];
  store.create(
    article('own-0', ['src/a.mjs'], {
      id: OWNER_IDS[0],
      what_it_does: `own-0 :: ${longBody(1_100_000)}`,
      intended_behavior: `own-0 intends :: ${longBody(2000)}`,
    })
  );
  facts.tokens = ['TRG0'];
  store.create({
    ...envelope('anti_pattern'),
    id: HAZARD_IDS[0],
    slug: 'hazard-big',
    title: 'HZ0 short title',
    trigger: `TRG0 first ${longBody(2000)}`,
    guidance: `GUI0 ${longBody(200)}`,
    wrong_way: `WRO0 ${longBody(200)}`,
    right_way: `RW0 first ${longBody(40_000)}`,
    source_evidence: 'EV0 measured',
    file_keys: ['src/a.mjs'],
    severity: 'block',
  });
  seedRulings(store, 2);
}

test('P8: SEVEN-DIGIT BUDGET — at 1,000,000 bytes with a >1 MB owner body the porch self-report still equals the porch emitted, stays within budget, and ends in a complete sentence', () => {
  const s = stage({ budget: BIG_BUDGET, lock: false, seed: seedSevenDigit });
  try {
    assert.equal(s.r.code, 0, s.r.stderr);
    const line = porchEndLine(s.ctx);
    assert.ok(line, `expected a porch at a seven-digit budget; ctx head=${bytePrefix(s.ctx, 1200)}`);
    const reported = reportedBytes(line);
    assert.ok(reported !== null, `the porch-end line states no byte count: ${line}`);
    const body = porchBody(s.ctx);
    assert.ok(body, 'could not locate the H19 header line that starts the porch');
    assert.equal(
      reported,
      bytes(body),
      `porch self-report disagrees with the porch emitted at a seven-digit budget: says ${reported}, measured ${bytes(body)} (complete-context prefix through the same point: ${porchEndOffset(s.ctx)}). porch head=${body.slice(0, 400)}`
    );
    assert.ok(reported <= BIG_BUDGET, `the porch reports ${reported} bytes against a budget of ${BIG_BUDGET}`);
    assert.match(line.replace(/\s+$/, ''), /[.!]$/, `the porch-end line was cut at a seven-digit budget: ${JSON.stringify(line)}`);
    assert.match(line, /precedence/i, `the porch-end line lost its precedence clause: ${JSON.stringify(line)}`);
  } finally {
    s.cleanup();
  }
});
// SABOTAGE: format the byte count with locale grouping or a fixed width, or
// compute it before the digest expands to fill a large budget — the equality
// goes red (a count that grows a digit is exactly where a pre-clamp
// arithmetic bug shows). Second sabotage: cap the digest at a hardcoded size
// instead of the budget so the porch never uses what it claims — the
// equality still holds but the P2/P8 pair plus A6 keep the invariant honest.

// ===========================================================================
// (e) SHAPES — zero hazards, zero owners, and a reference_material owner.
// ===========================================================================

test('E1: zero hazards, owners present — the porch still fits and names the 3 article bodies below', () => {
  const s = stage({ budget: DEFAULT_BUDGET, owners: 3, hazards: 0, lock: false });
  try {
    assert.equal(s.r.code, 0, s.r.stderr);
    const line = porchEndLine(s.ctx);
    assert.ok(line, `a hazard-free payload still gets a porch; ctx head=${bytePrefix(s.ctx, 1800)}`);
    assert.ok(porchEndOffset(s.ctx) <= DEFAULT_BUDGET, `porch overruns on the hazard-free shape; porch=${porchOf(s.ctx)}`);
    assert.equal(countFor(line, 'article'), 3, `porch-end line states the wrong article-body count: ${line}`);
  } finally {
    s.cleanup();
  }
});
// SABOTAGE: build the porch only when hazards exist (an `if (hazards.length)`
// guard around renderPorch) — the porch-end assertion goes red.

test('E2: hazards but ZERO owners (unowned territory) — hazards still arrive, nothing throws, and no porch claims a body that is not there', () => {
  const s = stage({
    budget: DEFAULT_BUDGET,
    lock: false,
    seed: (store, facts) => {
      facts.tokens = seedHazards(store, 3);
      facts.slugs = [];
    },
  });
  try {
    assert.equal(s.r.code, 0, s.r.stderr);
    assert.doesNotMatch(s.r.stderr, CLEAN_STDERR, `no stack trace on the zero-owner shape: ${s.r.stderr}`);
    for (let i = 0; i < 3; i += 1) assert.ok(s.ctx.includes(`TRG${i}`), `hazard ${i} must arrive even with no owning article; ctx=${bytePrefix(s.ctx, 1500)}`);
    const line = porchEndLine(s.ctx);
    if (line) {
      assert.equal(countFor(line, 'article'), 0, `no owner exists, so the porch-end line must promise 0 article bodies: ${line}`);
      assert.ok(porchEndOffset(s.ctx) <= DEFAULT_BUDGET, `porch overruns on the zero-owner shape; porch=${porchOf(s.ctx)}`);
    }
    assert.doesNotMatch(s.ctx, /\+\d+ owners below/, 'nothing was cut, so nothing is disclosed as cut');
  } finally {
    s.cleanup();
  }
});
// SABOTAGE: index the owner list unconditionally in renderPorch
// (owners[0].slug) — the hook throws mid-staging, the hazard tokens vanish
// from the context, and this pin goes red. Second sabotage: render a constant
// "+3 owners below" whenever the cap logic runs — the last assertion goes red.
// NOTE the deliberate conditional: whether an unowned-but-hazardous payload
// gets a porch at all is NOT fixed by decision 0050a536, so this pin refuses
// to invent it; what it does pin unconditionally is arrival, exit code, a
// clean stderr, and the absence of a false claim.

test('E3: a reference_material owner — the porch fits and names the reference it found', () => {
  const s = stage({
    budget: DEFAULT_BUDGET,
    lock: false,
    seed: (store, facts) => {
      store.create({
        ...envelope('reference_material'),
        id: REF_ID,
        title: 'REFTITLE-one',
        kind: 'doc',
        location: 'src/a.mjs',
        summary: `REFSUM-one ${longBody(600)}`,
        source_date: '2026-09-01',
        capture_date: '2026-09-01',
      });
      facts.tokens = seedHazards(store, 1);
      facts.slugs = [];
    },
  });
  try {
    assert.equal(s.r.code, 0, s.r.stderr);
    const porch = porchOf(s.ctx);
    assert.ok(porch, `a reference_material owner still gets a porch; ctx head=${bytePrefix(s.ctx, 1800)}`);
    assert.ok(bytes(porch) <= DEFAULT_BUDGET, `porch overruns on the reference shape; porch=${porch}`);
    assert.ok(porch.includes('REFTITLE-one'), `the porch must name the reference owner it found; porch=${porch}`);
    assert.ok(porch.includes(REF_ID) || porch.includes(REF_ID.slice(0, 8)), `the reference pointer must carry its id; porch=${porch}`);
  } finally {
    s.cleanup();
  }
});
// SABOTAGE: build porch owner lines from feature_articles only (skip
// reference_material owners) — the reference is silently absent from the
// preview and this pin goes red.

// ===========================================================================
// (f) SCOPE — SubagentStart only. The tool-time hook and the drain emit NO
// porch. Both verdicts are negatives, so each names a positive control in the
// same body (the payload really was delivered) on top of TEST 0.
// ===========================================================================

test('F1: SCOPE — h19-knowledge-delivery.mjs on a Read of the same governed path delivers, and emits NO porch-end line', () => {
  const { dir, store, cleanup } = makeProject({ delivery: { injection_rung: 'read', preview_budget_bytes: DEFAULT_BUDGET } });
  try {
    seedOwners(store, 4);
    seedHazards(store, 3);
    seedRulings(store, 2);
    const r = runHook(
      'h19-knowledge-delivery.mjs',
      { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: join(dir, 'src/a.mjs') }, cwd: dir },
      dir
    );
    assert.equal(r.code, 0, r.stderr);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /own-0/, 'positive control: the tool-time hook really did deliver this territory');
    assert.equal(porchEndLine(ctx), null, `tool-time delivery must emit no porch; found: ${porchEndLine(ctx)}`);
    assert.doesNotMatch(ctx, /\+\d+ owners below/, 'and no porch owner-cap disclosure');
  } finally {
    cleanup();
  }
});
// SABOTAGE: move renderPorch into the shared payload builder both hooks call
// (instead of the SubagentStart hook only) — the tool-time output grows a
// porch and this pin goes red. The ruling scope-pins this deliberately: the
// spill was measured on SubagentStart, tool-time was UNMEASURED.

test('F2: SCOPE — the drain (h19-delivery-drain.mjs) injects the queued payload with NO porch-end line', () => {
  const { dir, store, cleanup } = makeProject({ delivery: { injection_rung: 'prompt', preview_budget_bytes: DEFAULT_BUDGET } });
  try {
    seedOwners(store, 4);
    seedHazards(store, 3);
    seedRulings(store, 2);
    const enqueue = runHook(
      'h19-knowledge-delivery.mjs',
      { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: join(dir, 'src/a.mjs') }, cwd: dir },
      dir
    );
    assert.equal(enqueue.code, 0, enqueue.stderr);
    const drain = runHook('h19-delivery-drain.mjs', { hook_event_name: 'UserPromptSubmit', cwd: dir }, dir);
    assert.equal(drain.code, 0, drain.stderr);
    const ctx = JSON.parse(drain.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /own-0/, 'positive control: the drain really did inject the queued payload');
    assert.equal(porchEndLine(ctx), null, `the drain must emit no porch; found: ${porchEndLine(ctx)}`);
  } finally {
    cleanup();
  }
});
// SABOTAGE: render the porch inside the queued payload at enqueue time (so
// the drain carries it) — this pin goes red.

// ===========================================================================
// (g) renderArticle's header, on every surface (decision §6).
// ===========================================================================

test('G1: the article header carries name-then-id — ▸ article \'<slug>\' (<id8>) (<state>', () => {
  const s = stage({ budget: DEFAULT_BUDGET });
  try {
    assert.match(
      s.ctx,
      new RegExp(`▸ article 'own-0' \\(${OWNER_IDS[0].slice(0, 8)}\\) \\(active`),
      `expected the id8-bearing header for own-0; ctx=${bytePrefix(s.ctx, 4000)}`
    );
  } finally {
    s.cleanup();
  }
});
// SABOTAGE: revert the header to `▸ article '<slug>' (<state>)` — the shape
// all six probes reported as uncitable — and this pin goes red. Second
// sabotage: print the id BEFORE the name (violating decision
// human-readable-ids-for-board-items) — the regex order goes red.

test('G2: a NON-OVERSIZE article body ends with the full-record pointer — ▸ FULL RECORD: knowledge_get <uuid>', () => {
  const s = stage({
    budget: DEFAULT_BUDGET,
    lock: false,
    seed: (store, facts) => {
      facts.slugs = ['own-0'];
      store.create(article('own-0', ['src/a.mjs'], { id: OWNER_IDS[0], what_it_does: 'own-0 is small and whole', intended_behavior: 'own-0 intends plainly' }));
      facts.tokens = [];
    },
  });
  try {
    assert.ok(
      s.ctx.includes(`▸ FULL RECORD: knowledge_get ${OWNER_IDS[0]}`),
      `expected the non-oversize FULL RECORD line with the full uuid; ctx=${bytePrefix(s.ctx, 4000)}`
    );
  } finally {
    s.cleanup();
  }
});
// SABOTAGE: emit the FULL RECORD line only on the oversize/withheld branch —
// a small article stays uncitable by id and this pin goes red.

// ===========================================================================
// (h) INVALID BUDGETS — negative, non-integer, non-numeric, unreadable: all
// behave as the default 1800. One test per malformed value: a shared body
// would let the first failure mask the rest.
// ===========================================================================

for (const [label, value] of [['negative (-1)', -1], ['non-integer (1.5)', 1.5], ['non-numeric ("abc")', 'abc']]) {
  test(`H1: an invalid preview_budget_bytes — ${label} — behaves as the default 1800 (porch present, invariant at 1800)`, () => {
    const s = stage({ budget: value });
    try {
      assert.equal(s.r.code, 0, s.r.stderr);
      const end = porchEndOffset(s.ctx);
      assert.ok(end !== null, `an invalid budget must fall back to the default, not disable the porch; ctx head=${bytePrefix(s.ctx, 2000)}`);
      assert.ok(end <= DEFAULT_BUDGET, `porch overruns the default budget: ends at byte ${end}; porch=${porchOf(s.ctx)}`);
    } finally {
      s.cleanup();
    }
  });
  // SABOTAGE: accept the raw config value (Number(cfg) with no
  // integer/negative guard) — for -1 nothing fits and the porch disappears
  // (first assertion red); for 1.5 the same; for "abc" the arithmetic goes
  // NaN and the clamp silently admits everything (second assertion red).
}

test('H2: an UNREADABLE config (corrupt JSON) never overruns and never throws — the porch falls back to the default, it does not invent a budget', () => {
  const s = stage({ budget: DEFAULT_BUDGET });
  try {
    // Corrupt AFTER project setup so only the hook's own config read fails.
    writeFileSync(join(s.dir, '.sterling', 'config.json'), '{ not valid json');
    const transcript = writeTranscript(s.dir, DISPATCH_PROMPT);
    const r = runHook('h19-dispatch-staging.mjs', subagentStart(s.dir, transcript, { agent_id: 'agent-2' }), s.dir);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stderr, CLEAN_STDERR, `an unreadable config must not surface as a stack trace: ${r.stderr}`);
    const ctx = r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : '';
    const end = porchEndOffset(ctx);
    if (end !== null) {
      assert.ok(end <= DEFAULT_BUDGET, `porch overruns the default budget on the unreadable-config path: ends at byte ${end}; porch=${porchOf(ctx)}`);
    }
    // RESOLVED, and this conditional shape is now the CORRECT one. The
    // tension this pin was written around (v1 of decision 0050a536 said
    // "unreadable config -> default 1800", while the frozen pin in
    // scripts/tests/h19-dispatch-staging.test.mjs — "H19+H28 shared-fate" —
    // requires a corrupt config to suppress the whole staging payload) was
    // adjudicated in v2 of that decision after the Codex review: "An
    // UNREADABLE config.json is NOT a porch question: the pre-existing
    // H19+H28 shared-fate ruling makes the staging hook emit nothing at all
    // on a corrupt config ... so the porch never runs there — corrected
    // 2026-09-08; the first draft of this sentence wrongly claimed
    // 'unreadable -> default'." So the porch has NOTHING to say here, and
    // this pin correctly asserts only the fail-open floor (exit 0, no trace)
    // plus "no overrun if a porch is somehow rendered". The absent/non-
    // integer/negative VALUE rungs — which DO default to 1800 — are pinned
    // by the H1 arms above; below-floor is P4; that is the whole ladder.
  } finally {
    s.cleanup();
  }
});
// SABOTAGE: let the config read throw out of the porch path (no try/catch and
// no fallback) — the hook exits non-zero or prints a trace and this pin goes
// red.

// ===========================================================================
// EXTRA (not in the dispatch list): the same INVARIANT for the `coder`
// dispatch class, which is the class that receives the most delivery.
//
// CORRECTED after the independent review: an earlier version of this comment
// claimed the TDD posture line was a SECOND block ahead of the payload. That
// premise is FALSE — combinedContext() orders activePlanLine, payload,
// tddPostureLine, RETURN_CONTRACT (h19-dispatch-staging.mjs ~:214-221), so
// the posture line FOLLOWS the payload and costs the porch nothing. What this
// pin actually covers is therefore CLASS COVERAGE, not a second preceding
// block: on a coder dispatch the plan line is ahead of the porch, the posture
// line and the return contract are behind it, and the byte invariant still
// holds. Kept because every other staging fixture in this file dispatches as
// `debugger` (chosen to isolate A1-A7 from the posture line), so without X1
// the busiest dispatch class would be unpinned. The assertions are unchanged
// by the correction: the fixture control asserts the posture line's PRESENCE,
// never its precedence, so nothing here depended on the wrong premise.
// ===========================================================================

test('X1: the CODER dispatch class (plan line ahead of the porch, TDD posture line and return contract behind it) still ends its porch within the 1800-byte budget', () => {
  const s = stage({ budget: DEFAULT_BUDGET, agentType: 'coder' });
  try {
    assert.equal(s.r.code, 0, s.r.stderr);
    assert.match(s.ctx, /TDD posture:/, 'fixture control: this really is the coder class (the posture line is scoped to coder/test-writer)');
    const end = porchEndOffset(s.ctx);
    assert.ok(end !== null, `expected a porch on a coder dispatch; ctx head=${bytePrefix(s.ctx, 2200)}`);
    assert.ok(
      end <= DEFAULT_BUDGET,
      `porch ends at byte ${end} of the complete context (budget ${DEFAULT_BUDGET}) — the ACTIVE PLAN line ahead of the payload counts against the budget; porch=${porchOf(s.ctx)}`
    );
  } finally {
    s.cleanup();
  }
});
// SABOTAGE: subtract only the activePlanLine's bytes and ignore every other
// preceding block — the porch-end line slides past byte 1800 for a coder
// dispatch and this pin goes red. The fixture control keeps the verdict
// honest: if the posture line ever stops preceding the payload, the control
// assertion fails first and says so.
