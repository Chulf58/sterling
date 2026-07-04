import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeRepoPath,
  toRepoRelative,
  matchesGlob,
  decisionSchema,
  featureArticleSchema,
  todoSchema,
  noteSchema,
  briefSchema,
  handoffSchema,
  runRecordSchema,
  RECORD_TYPES,
  validateRecord,
  SPINE_SIGNALS,
  SYSTEM_REASONS,
  DRAIN_VERBS,
} from '../index.js';
import { parseConfig } from '../config.js';

const NOW = '2026-06-10T12:00:00.000Z';

export function envelope(type: string) {
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

export function validDecision() {
  return {
    ...envelope('decision'),
    title: 'Use SQLite',
    statement: 'SQLite via node:sqlite is the storage substrate.',
    alternatives_rejected: [{ option: 'JSON files', reason: 'no file-key joins, no FTS rank' }],
    rationale: 'Satisfies all six §3.1 criteria with zero native dependencies.',
    file_keys: ['packages/store/src/index.ts'],
  };
}

test('path invariant: normalization and rejections (§3.2)', () => {
  assert.equal(normalizeRepoPath('src\\auth\\login.ts'), 'src/auth/login.ts');
  assert.equal(normalizeRepoPath('./src//x/./y.ts'), 'src/x/y.ts');
  assert.equal(normalizeRepoPath('a/b/'), 'a/b');
  assert.throws(() => normalizeRepoPath('C:\\repo\\src\\a.ts'), /drive-prefixed/);
  assert.throws(() => normalizeRepoPath('/abs/path.ts'), /absolute/);
  assert.throws(() => normalizeRepoPath('../escape.ts'), /parent-escaping/);
  assert.throws(() => normalizeRepoPath(''), /empty/);
  assert.throws(() => normalizeRepoPath('./.'), /empty/);
});

test('matchesGlob: ** crosses segments, * stays within, ? single char', () => {
  assert.equal(matchesGlob('tests/a/b.test.ts', 'tests/**'), true);
  assert.equal(matchesGlob('src/x.test.ts', '**/*.test.ts'), true);
  assert.equal(matchesGlob('x.test.ts', '**/*.test.ts'), true);
  assert.equal(matchesGlob('src/x.ts', '**/*.test.ts'), false);
  assert.equal(matchesGlob('src/a/b.ts', 'src/*.ts'), false);
  assert.equal(matchesGlob('src/b.ts', 'src/*.ts'), true);
  assert.equal(matchesGlob('src\\b.ts', 'src/*.ts'), true, 'backslash input normalized');
  assert.equal(matchesGlob('axts', 'a?ts'), true);
  assert.equal(matchesGlob('a/ts', 'a?ts'), false, '? never matches a separator');
});

test('toRepoRelative relativizes against repo root', () => {
  assert.equal(toRepoRelative('C:\\repo\\src\\a.ts', 'C:\\repo'), 'src/a.ts');
  assert.equal(toRepoRelative('C:/repo/src/a.ts', 'C:/repo/'), 'src/a.ts');
  assert.throws(() => toRepoRelative('C:/elsewhere/a.ts', 'C:/repo'), /not under repo root/);
});

test('record schemas normalize file paths at the boundary', () => {
  const d = decisionSchema.parse({ ...validDecision(), file_keys: ['src\\store\\db.ts'] });
  assert.deepEqual(d.file_keys, ['src/store/db.ts']);
});

test('supersession field pairing is enforced both ways (§3.2)', () => {
  assert.throws(() => decisionSchema.parse({ ...validDecision(), status: 'superseded' }), /requires superseded_by/);
  assert.throws(
    () => decisionSchema.parse({ ...validDecision(), superseded_by: randomUUID() }),
    /forbids superseded_by/
  );
  const ok = decisionSchema.parse({ ...validDecision(), status: 'superseded', superseded_by: randomUUID() });
  assert.equal(ok.status, 'superseded');
});

test('todo: system source requires system_reason; no done status exists (§3.2.7)', () => {
  const base = { ...envelope('todo'), text: 'reconcile auth article', source: 'system' };
  assert.throws(() => todoSchema.parse(base), /requires system_reason/);
  const ok = todoSchema.parse({ ...base, system_reason: 'reconcile_needed' });
  assert.equal(ok.system_reason, 'reconcile_needed');
  assert.ok(!('done' in ok));
  todoSchema.parse({ ...envelope('todo'), text: 'user item', source: 'user' });
  const prio = todoSchema.parse({ ...envelope('todo'), text: 'user item', source: 'user', priority: 'high' });
  assert.equal(prio.priority, 'high');
  assert.throws(() => todoSchema.parse({ ...envelope('todo'), text: 'x', source: 'user', priority: 'urgent' }), /invalid/i);
});

test('feature_article: dormant requires state_reason + wiring_todo_id (§3.2.3)', () => {
  const art = {
    ...envelope('feature_article'),
    slug: 'csv-export',
    title: 'CSV export',
    what_it_does: 'Exports the board as CSV.',
    intended_behavior: 'User clicks Export and receives a CSV file.',
    files: [{ path: 'src\\export\\csv.ts', role: 'serializer' }],
    current_ac: [{ ac_id: 'AC1', text: 'export downloads a file', verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'dormant',
    version: 1,
    history: [{ date: NOW, event: 'originating brief' }],
    live_test_refs: [{ ac_id: 'AC1', test_paths: ['tests\\export.test.ts'] }],
  };
  assert.throws(() => featureArticleSchema.parse(art), /dormant/);
  const ok = featureArticleSchema.parse({ ...art, state_reason: 'wired in next phase', wiring_todo_id: randomUUID() });
  assert.equal(ok.files[0].path, 'src/export/csv.ts');
  assert.equal(ok.live_test_refs[0].test_paths[0], 'tests/export.test.ts');
  assert.throws(() => featureArticleSchema.parse({ ...art, state: 'built', version: 0 }), /version/i);
});

test('brief: attribution sections and verifiable_at syntax (§4)', () => {
  const brief = {
    ...envelope('brief'),
    slug: 'csv-export',
    title: 'CSV export',
    problem: 'No way to get data out.',
    feature: 'Export the board as CSV.',
    user_stated: { criteria: ['user said: must be Excel-openable'], constraints: [] },
    conductor_proposals: [{ text: 'stream rather than buffer', status: 'unconfirmed' }],
    acceptance_criteria: [
      { ac_id: 'AC1', text: 'user clicks Export and gets a file', verifiable_at: 'final' },
      { ac_id: 'AC2', text: 'header row present', verifiable_at: 'phase:1' },
    ],
    technical_design: { approach: 'serializer module', interfaces: [], shared_structures: [] },
    blast_radius: { files: [{ path: 'src\\export\\csv.ts', owning_articles: [] }], reconcile_list: [] },
    incidental_scope: ['src/board/types.ts'],
    out_of_scope: ['changing board storage'],
    phases: [
      {
        phase_id: 'p1',
        goal: 'serializer',
        subtasks: ['write serializer'],
        ac_ids: ['AC2'],
        difficulty: { level: 'normal', reasons: [] },
        model_hint: 'sonnet',
      },
    ],
    decisions_made: [],
  };
  const ok = briefSchema.parse(brief);
  assert.equal(ok.blast_radius.files[0].path, 'src/export/csv.ts');
  assert.throws(
    () => briefSchema.parse({ ...brief, acceptance_criteria: [{ ac_id: 'AC1', text: 'x', verifiable_at: 'phase1' }] }),
    /invalid/i
  );

  // §7.1/§7.6 risk flags: closed set, frozen into data before the run
  const flagged = briefSchema.parse({ ...brief, risk_flags: ['security_relevant'] });
  assert.deepEqual(flagged.risk_flags, ['security_relevant']);
  assert.throws(() => briefSchema.parse({ ...brief, risk_flags: ['urgent'] }), /invalid/i);

  // §8.1 per-phase interface slice: names must exist in technical_design.interfaces
  const withInterfaces = {
    ...brief,
    technical_design: { approach: 'a', interfaces: [{ name: 'exportBoard', contract: '(todos) -> csv' }], shared_structures: [] },
    phases: [{ ...brief.phases[0], interfaces: ['exportBoard'] }],
  };
  briefSchema.parse(withInterfaces);
  assert.throws(
    () => briefSchema.parse({ ...withInterfaces, phases: [{ ...brief.phases[0], interfaces: ['ghostInterface'] }] }),
    /undeclared interface 'ghostInterface'/
  );
});

test('note schema and handoff/run-record transient shapes', () => {
  noteSchema.parse({
    ...envelope('note'),
    raw_text: 'genesys api rate limits are per-org not per-token',
    captured_at: NOW,
    capture_source: 'tui',
    derived: [],
  });
  const h = handoffSchema.parse({
    phase_id: 'p1',
    agent_role: 'coder',
    what_changed: [{ path: 'src\\a.ts', change_role: 'implemented serializer' }],
    wired: [],
    deferred: [],
    decisions_made: [],
    tests_produced: ['tests/a.test.ts'],
    exit_signal: 'complete',
    unresolved: [],
  });
  assert.equal(h.what_changed[0].path, 'src/a.ts');
  assert.throws(
    () => handoffSchema.parse({ ...h, exit_signal: 'victory' }),
    /invalid/i,
    'non-enum exit signal must be rejected'
  );
  runRecordSchema.parse({
    id: 'r-0001',
    brief_ref: randomUUID(),
    branch: 'sterling/run-r-0001',
    machine_state: 'running',
    phases: [{ id: 'p1', status: 'in_progress', signals: [], commits: [] }],
    dispatch_counts: { coder: 1 },
    escalations: [],
    started_at: NOW,
  });
});

test('full §3.2 record set: anti_pattern, research_finding, reference_material, disconfirmed_hypothesis', () => {
  const ap = validateRecord({
    ...envelope('anti_pattern'),
    title: 'No raw SQL concat',
    trigger: 'when building queries from user input',
    guidance: 'use parameterized queries, not string concat',
    wrong_way: '"SELECT * FROM x WHERE id=" + id',
    right_way: 'db.prepare("... WHERE id = ?").get(id)',
    source_evidence: 'run r-0042, src/db.ts:88',
    file_keys: ['src\\db.ts'],
    severity: 'block',
  });
  assert.equal((ap as { basis: string }).basis, 'codebase', 'basis defaults to codebase');
  assert.deepEqual((ap as { file_keys: string[] }).file_keys, ['src/db.ts']);

  const rf = validateRecord({
    ...envelope('research_finding'),
    question: 'genesys rate limit scope?',
    answer: 'per-org, not per-token',
    source_urls: ['https://developer.genesys.cloud/x'],
    source_date: '2026-01-15',
    capture_date: '2026-06-01',
    volatility_hint: 'medium',
  });
  assert.equal(rf.type, 'research_finding');
  // research adds flagged_stale to the status enum (§3.2.4)
  validateRecord({ ...(rf as unknown as Record<string, unknown>), id: randomUUID(), status: 'flagged_stale' });
  assert.throws(() => validateRecord({ ...(envelope('decision') as object), status: 'flagged_stale', title: 't', statement: 's', alternatives_rejected: [], rationale: 'r' }), /invalid/i);

  validateRecord({
    ...envelope('reference_material'),
    title: 'Genesys API guide',
    kind: 'url',
    location: 'https://developer.genesys.cloud',
    summary: 'platform API reference',
    source_date: '2025-11-01',
    capture_date: '2026-06-01',
    basis: 'platform',
  });

  validateRecord({
    ...envelope('disconfirmed_hypothesis'),
    question: 'is the cache stale?',
    rejected_answer: 'no — TTL was correct; root cause was clock skew',
    evidence: 'debug run r-0099, traces at src/cache.ts:40',
    file_keys: ['src/cache.ts'],
  });
});

test('registry: full record set registered 1:1, unregistered type rejected loudly (invariant 3)', () => {
  assert.deepEqual(Object.keys(RECORD_TYPES).sort(), [
    'anti_pattern',
    'brief',
    'decision',
    'disconfirmed_hypothesis',
    'feature_article',
    'note',
    'reference_material',
    'research_finding',
    'todo',
  ]);
  for (const [name, entry] of Object.entries(RECORD_TYPES)) {
    assert.equal(typeof entry.fts, 'function', `${name} needs an fts extractor`);
    assert.equal(typeof entry.fileKeys, 'function', `${name} needs a fileKeys extractor`);
  }
  assert.equal(RECORD_TYPES.decision.immutable, true);
  const validated = validateRecord(validDecision());
  assert.equal(validated.type, 'decision');
  assert.throws(() => validateRecord({ ...envelope('escalation_log'), title: 'x' }), /unregistered record type 'escalation_log'/);
  assert.throws(() => validateRecord({ no_type: true }), /no record type/);
});

test('the signal enum is closed at the full nine §5.1 members', () => {
  assert.deepEqual(
    [...SPINE_SIGNALS],
    ['complete', 'research-needed', 'review-unresolved', 'blocked', 'tests-invalid', 'contract-violated', 'bug-found', 'phase-overflow', 'agent-died']
  );
});

test('§3.2.5: reference_material fileKeys — repo-located docs only', () => {
  const fk = RECORD_TYPES.reference_material.fileKeys;
  assert.deepEqual(fk({ kind: 'doc', location: 'docs\\spec.md' }), ['docs/spec.md'], 'doc location normalizes and doubles as a file_key');
  assert.deepEqual(fk({ kind: 'url', location: 'https://example.com/x' }), [], 'external locations carry no file_keys');
  assert.deepEqual(fk({ kind: 'pdf', location: 'C:/refs/spec.pdf' }), []);
  assert.deepEqual(fk({ kind: 'doc', location: 'C:/abs/spec.md' }), [], 'absolute doc location is not repo-located');
});

test('§11 drain verbs: every maintenance lane has its completed-section verb (totality)', () => {
  for (const reason of SYSTEM_REASONS) {
    const verb = DRAIN_VERBS[reason];
    assert.equal(typeof verb, 'string', `SYSTEM_REASON '${reason}' is missing a DRAIN_VERBS entry`);
    assert.ok(verb.length > 0, `verb for '${reason}' must not be blank`);
  }
  assert.deepEqual(Object.keys(DRAIN_VERBS).sort(), [...SYSTEM_REASONS].sort(), 'no orphan verbs for unregistered reasons');
});

// ------------------- session-event register (run r-0501: session-event-register) -------------------

test('sessionEventSchema: the three register kinds parse; unknown kind + missing fields rejected (interface slice 1)', async () => {
  // dynamic import + cast: sessionEventSchema does not exist until this phase ships, so a
  // missing export must fail an ASSERTION below — never a compile-time reference to a
  // not-yet-declared symbol (that would break the package build; a crash-red proves nothing).
  const mod = (await import('../index.js')) as unknown as Record<string, unknown>;
  const s = mod.sessionEventSchema as { parse: (v: unknown) => { kind: string; detail: string; at: string } } | undefined;
  assert.ok(s, 'sessionEventSchema must be exported from the schemas index (defined once in transient.ts)');

  const research = s.parse({ kind: 'research_tool', detail: 'WebSearch: genesys rate limit scope', at: NOW });
  assert.equal(research.kind, 'research_tool');
  assert.equal(research.detail, 'WebSearch: genesys rate limit scope');
  assert.equal(research.at, NOW);

  assert.equal(s.parse({ kind: 'agent_dispatch', detail: 'researcher', at: NOW }).kind, 'agent_dispatch');
  assert.equal(s.parse({ kind: 'debug_scope', detail: 'src/a.mjs', at: NOW }).kind, 'debug_scope');

  // kind is a closed enum of exactly the three register writers
  assert.throws(() => s.parse({ kind: 'file_touch', detail: 'x', at: NOW }), 'kind outside the three writers is rejected');
  // detail is a required string; at is required
  assert.throws(() => s.parse({ kind: 'research_tool', at: NOW }), 'detail is required');
  assert.throws(() => s.parse({ kind: 'research_tool', detail: 42, at: NOW }), 'detail must be a string');
  assert.throws(() => s.parse({ kind: 'research_tool', detail: 'x' }), 'at is required');
});

test('research_owed is a registered SYSTEM_REASONS member draining under "captured"; 1:1 totality holds (AC7, interface slice 4)', () => {
  const reasons = SYSTEM_REASONS as readonly string[];
  const verbs = DRAIN_VERBS as Record<string, string>;
  assert.ok(reasons.includes('research_owed'), 'research_owed must join SYSTEM_REASONS');
  assert.equal(verbs['research_owed'], 'captured', 'research_owed drains under the "captured" verb (interface slice 4)');
  for (const reason of reasons) {
    assert.equal(typeof verbs[reason], 'string', `SYSTEM_REASON '${reason}' is missing a DRAIN_VERBS entry`);
    assert.ok(verbs[reason].length > 0, `verb for '${reason}' must not be blank`);
  }
  assert.deepEqual(Object.keys(DRAIN_VERBS).sort(), [...reasons].sort(), 'DRAIN_VERBS and SYSTEM_REASONS stay 1:1');
});

// ------------------- mid-run scope amendment (run r-1417) -------------------

test('runRecordSchema: scope_amendments — optional {path,reason,at}[] ; legacy round-trips; paths normalized (interface slice 1)', () => {
  const base = {
    id: 'r-1417',
    brief_ref: randomUUID(),
    branch: 'sterling/run-r-1417',
    machine_state: 'running',
    phases: [{ id: 'p1', status: 'in_progress', signals: [], commits: [] }],
    dispatch_counts: {},
    escalations: [],
    started_at: NOW,
  };

  // legacy run record (no scope_amendments) round-trips WITHOUT the field being invented
  const legacy = runRecordSchema.parse(base) as { scope_amendments?: unknown[] };
  assert.ok(
    legacy.scope_amendments === undefined || (Array.isArray(legacy.scope_amendments) && legacy.scope_amendments.length === 0),
    'a legacy run record without scope_amendments round-trips unchanged'
  );

  // a run record carrying scope_amendments must PARSE (assertion-red now if the field is
  // stripped or rejected — never a thrown crash) and each path normalizes at the boundary (repoPath)
  let parsed: { scope_amendments?: { path: string; reason: string; at: string }[] } | undefined;
  assert.doesNotThrow(() => {
    parsed = runRecordSchema.parse({
      ...base,
      scope_amendments: [
        { path: 'src\\amended.ts', reason: 'adjudicated mid-run', at: NOW },
        { path: 'src/two.ts', reason: 'second amendment', at: NOW },
      ],
    }) as typeof parsed;
  }, 'a run record carrying scope_amendments must parse');
  assert.ok(Array.isArray(parsed!.scope_amendments), 'scope_amendments survives parsing as an array');
  assert.equal(parsed!.scope_amendments!.length, 2);
  assert.equal(parsed!.scope_amendments![0].path, 'src/amended.ts', 'repoPath normalizes the amendment path (backslash -> POSIX)');
  assert.equal(parsed!.scope_amendments![0].reason, 'adjudicated mid-run');
  assert.equal(parsed!.scope_amendments![0].at, NOW);

  // reason is z.string().min(1); at is z.string().min(1); path is required
  assert.throws(() => runRecordSchema.parse({ ...base, scope_amendments: [{ path: 'src/a.ts', reason: '', at: NOW }] }), /invalid|min|reason|empty/i,
    'empty reason is rejected');
  assert.throws(() => runRecordSchema.parse({ ...base, scope_amendments: [{ path: 'src/a.ts', reason: 'r', at: '' }] }), /invalid|min|at|empty/i,
    'empty at is rejected');
  assert.throws(() => runRecordSchema.parse({ ...base, scope_amendments: [{ reason: 'r', at: NOW }] }), /invalid|path|required/i,
    'path is required on each amendment');
});

// ------------------- TUI System tab: AGENT_MODEL_KEY + models catalog (run r-ea9e, AC7) -------------------

// packages/schemas/src/tests -> src -> schemas -> packages -> repo root
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

test('AGENT_MODEL_KEY: totality over agent-templates/registry.json — every registered agent maps to a config.models key (AC7, interface slice 2)', async () => {
  // dynamic import + cast: AGENT_MODEL_KEY does not exist until this phase ships, so a missing
  // export must fail an ASSERTION below — never a compile-time reference (a crash-red proves nothing).
  const mod = (await import('../index.js')) as unknown as Record<string, unknown>;
  const map = mod.AGENT_MODEL_KEY as Record<string, string> | undefined;
  assert.ok(map, 'AGENT_MODEL_KEY must be exported from the schemas index (defined once, invariant 1)');

  // the totality oracle: read the registry the map must be total over
  const registry = JSON.parse(readFileSync(join(REPO_ROOT, 'agent-templates', 'registry.json'), 'utf8')) as {
    agents: { name: string }[];
  };
  const registeredNames = registry.agents.map((a) => a.name).sort();

  // DIRECTION (knowledge slice): totality is over REGISTERED AGENTS -> keys, not keys -> agents.
  // Every registered agent has a non-blank mapping...
  for (const name of registeredNames) {
    assert.equal(typeof map![name], 'string', `registered agent '${name}' is missing an AGENT_MODEL_KEY entry`);
    assert.ok(map![name].length > 0, `AGENT_MODEL_KEY['${name}'] must not be blank`);
  }
  // ...and there are no orphan keys: the map's keys are EXACTLY the registered agents.
  assert.deepEqual(
    Object.keys(map!).sort(),
    registeredNames,
    'AGENT_MODEL_KEY keys are exactly the registered agents — none missing, none orphaned'
  );

  // the exact expected mapping (interface slice 2). reviewers is many-to-one and CORRECT.
  assert.deepEqual(map, {
    'test-writer': 'test_writer',
    coder: 'coder',
    'reviewer-correctness': 'reviewers',
    'reviewer-security': 'reviewers',
    'reviewer-skeptic': 'reviewers',
    'reviewer-performance': 'reviewers',
    'implementation-architect': 'implementation_architect',
    researcher: 'researcher',
    explorer: 'explorer',
  });

  // many-to-one asserted head-on: all four reviewer agents resolve to the single 'reviewers' key.
  // (map re-cast to Record<string,string> at the string-indexed lookup: the preceding deepEqual
  // unifies `map` to its inferred 9-literal-key shape, which otherwise trips TS7053 on map![r].)
  const lookup = map as Record<string, string>;
  const reviewerAgents = registeredNames.filter((n) => n.startsWith('reviewer-'));
  assert.equal(reviewerAgents.length, 4, 'the registry carries four reviewer agents');
  for (const r of reviewerAgents) {
    assert.equal(lookup[r], 'reviewers', `reviewer agent '${r}' is governed by the single 'reviewers' config key`);
  }

  // config-only keys have NO installed/registered agent, so they are NOT keys of AGENT_MODEL_KEY.
  assert.ok(!('coder_hard' in lookup), 'coder_hard is a config-only key — never a registered-agent key');
  assert.ok(!('classifiers' in lookup), 'classifiers is a config-only key — never a registered-agent key');

  // every VALUE the map yields must be a real config.models key (cross-check against parseConfig defaults).
  const cfg = parseConfig({}) as unknown as { models: Record<string, unknown> };
  const configKeys = Object.keys(cfg.models);
  for (const value of Object.values(lookup)) {
    assert.ok(configKeys.includes(value), `AGENT_MODEL_KEY value '${value}' must be an actual config.models key`);
  }
});

test('modelsCatalogSchema: {entries:[{id,label,tier,status}]} round-trips; malformed entries fail loud (AC7, interface slice 3)', async () => {
  const mod = (await import('../index.js')) as unknown as Record<string, unknown>;
  const schema = mod.modelsCatalogSchema as
    | { parse: (v: unknown) => { entries: { id: string; label: string; tier: string; status: string }[] } }
    | undefined;
  assert.ok(schema, 'modelsCatalogSchema must be exported from the schemas index (defined once, invariant 1)');

  const valid = {
    entries: [
      { id: 'claude-opus-4-8', label: 'Opus 4.8', tier: 'opus', status: 'active' },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', tier: 'sonnet', status: 'active' },
    ],
  };
  const parsed = schema!.parse(valid);
  assert.deepEqual(parsed.entries, valid.entries, 'catalog entries round-trip unchanged (id, label, tier, status all preserved)');

  // boundary: an empty catalog (zero entries) is a well-formed shape.
  assert.deepEqual(schema!.parse({ entries: [] }).entries, [], 'a catalog with no entries still parses');

  // entries is required and must be an array.
  assert.throws(() => schema!.parse({}), 'entries is a required field');
  assert.throws(() => schema!.parse({ entries: 'claude-opus-4-8' }), 'entries must be an array, not a string');
  assert.throws(() => schema!.parse({ entries: {} }), 'entries must be an array, not an object');

  // every entry requires id, label, tier, status — each present and a string.
  const good = { id: 'claude-opus-4-8', label: 'Opus 4.8', tier: 'opus', status: 'active' };
  for (const field of ['id', 'label', 'tier', 'status'] as const) {
    const { [field]: _omitted, ...missing } = good;
    assert.throws(() => schema!.parse({ entries: [missing] }), `entry field '${field}' is required`);
    assert.throws(() => schema!.parse({ entries: [{ ...good, [field]: 42 }] }), `entry field '${field}' must be a string`);
  }
});

test('referenceMaterialSchema: optional typed catalog field — legacy round-trips; catalog persists; malformed catalog fails loud (AC7, file_baselines precedent 57d9a52d)', () => {
  // a LEGACY reference_material WITHOUT a catalog must round-trip untouched — the field is never
  // invented (same optional-field precedent as file_baselines / scope_amendments).
  const legacy = validateRecord({
    ...envelope('reference_material'),
    title: 'Genesys API guide',
    kind: 'url',
    location: 'https://developer.genesys.cloud',
    summary: 'platform API reference',
    source_date: '2025-11-01',
    capture_date: '2026-06-01',
    basis: 'platform',
  }) as { catalog?: unknown };
  assert.ok(
    !('catalog' in legacy) || legacy.catalog === undefined,
    'a legacy reference_material without catalog round-trips with no invented catalog field'
  );

  // a reference_material CARRYING a catalog must parse and preserve the typed entries.
  const withCatalog = validateRecord({
    ...envelope('reference_material'),
    title: 'Sterling models catalog',
    kind: 'url',
    location: 'https://docs.anthropic.com/models',
    summary: 'KB-maintained model choices for the System tab',
    source_date: '2026-07-01',
    capture_date: '2026-07-01',
    basis: 'platform',
    catalog: {
      entries: [{ id: 'claude-opus-4-8', label: 'Opus 4.8', tier: 'opus', status: 'active' }],
    },
  }) as { catalog?: { entries: { id: string; label: string; tier: string; status: string }[] } };
  assert.ok(withCatalog.catalog, 'the catalog field survives parsing on a reference_material record');
  assert.equal(withCatalog.catalog!.entries.length, 1);
  assert.deepEqual(withCatalog.catalog!.entries[0], { id: 'claude-opus-4-8', label: 'Opus 4.8', tier: 'opus', status: 'active' });

  // the catalog field is TYPED, not free-form: a malformed catalog entry is rejected loud.
  assert.throws(
    () =>
      validateRecord({
        ...envelope('reference_material'),
        title: 'bad catalog',
        kind: 'url',
        location: 'https://example.com/bad',
        summary: 's',
        source_date: '2026-07-01',
        capture_date: '2026-07-01',
        basis: 'platform',
        catalog: { entries: [{ id: 'claude-opus-4-8' }] },
      }),
    /invalid|required/i,
    'a catalog entry missing label/tier/status is rejected'
  );
});

// ------------------- reviewer knowledge loop v2 (run r-d630, phase 1 — AC1) -------------------

test('handoffSchema.dispositions: optional array; not_applicable_because requires a NON-empty reason; addressed reason optional; legacy round-trips (AC1)', () => {
  const base = {
    phase_id: 'p1',
    agent_role: 'reviewer-correctness',
    what_changed: [{ path: 'src\\a.ts', change_role: 'reviewed' }],
    wired: [],
    deferred: [],
    decisions_made: [],
    tests_produced: [],
    exit_signal: 'complete',
    unresolved: [],
  };

  // LEGACY handoff (no dispositions field) round-trips WITHOUT the field being invented
  const legacy = handoffSchema.parse(base) as { dispositions?: unknown[] };
  assert.ok(
    legacy.dispositions === undefined || (Array.isArray(legacy.dispositions) && legacy.dispositions.length === 0),
    'a legacy handoff without dispositions round-trips unchanged (field never invented)'
  );

  // an EMPTY dispositions array is a well-formed shape (boundary)
  const empty = handoffSchema.parse({ ...base, dispositions: [] }) as { dispositions?: unknown[] };
  assert.ok(Array.isArray(empty.dispositions), 'dispositions survives parsing as an array when supplied');
  assert.equal(empty.dispositions!.length, 0, 'an empty dispositions array parses to an empty array');

  // 'addressed' WITHOUT a reason is allowed (reason optional for addressed) and preserves fields.
  // Front-load the array assertion so a STRIPPED field yields an AssertionError, not a TypeError.
  let parsed: { dispositions?: { record_id: string; disposition: string; reason?: string }[] } | undefined;
  assert.doesNotThrow(() => {
    parsed = handoffSchema.parse({
      ...base,
      dispositions: [{ record_id: 'rec-1', disposition: 'addressed' }],
    }) as typeof parsed;
  }, "'addressed' without a reason must parse");
  assert.ok(Array.isArray(parsed!.dispositions), 'dispositions survives parsing as an array (never stripped)');
  assert.equal(parsed!.dispositions!.length, 1);
  assert.equal(parsed!.dispositions![0].record_id, 'rec-1');
  assert.equal(parsed!.dispositions![0].disposition, 'addressed');

  // 'addressed' WITH a reason is also allowed (reason is optional, not forbidden, for addressed)
  assert.doesNotThrow(
    () => handoffSchema.parse({ ...base, dispositions: [{ record_id: 'rec-1', disposition: 'addressed', reason: 'folded into the fix' }] }),
    "'addressed' with a reason is allowed"
  );

  // 'not_applicable_because' WITH a non-empty reason parses and preserves the reason.
  let na: { dispositions?: { record_id: string; disposition: string; reason?: string }[] } | undefined;
  assert.doesNotThrow(() => {
    na = handoffSchema.parse({
      ...base,
      dispositions: [{ record_id: 'rec-2', disposition: 'not_applicable_because', reason: 'out of this phase scope' }],
    }) as typeof na;
  }, 'not_applicable_because with a non-empty reason must parse');
  assert.ok(Array.isArray(na!.dispositions), 'dispositions survives parsing as an array');
  assert.equal(na!.dispositions![0].disposition, 'not_applicable_because');
  assert.equal(na!.dispositions![0].reason, 'out of this phase scope');

  // REFINE: 'not_applicable_because' WITHOUT a reason is rejected loud
  assert.throws(
    () => handoffSchema.parse({ ...base, dispositions: [{ record_id: 'rec-2', disposition: 'not_applicable_because' }] }),
    /invalid|reason/i,
    'not_applicable_because requires a reason'
  );
  // REFINE: an EMPTY reason does not satisfy not_applicable_because (must be NON-empty)
  assert.throws(
    () => handoffSchema.parse({ ...base, dispositions: [{ record_id: 'rec-2', disposition: 'not_applicable_because', reason: '' }] }),
    /invalid|reason|empty|min/i,
    'not_applicable_because requires a NON-empty reason'
  );

  // disposition is a closed enum of exactly the two verbs
  assert.throws(
    () => handoffSchema.parse({ ...base, dispositions: [{ record_id: 'rec-3', disposition: 'ignored' }] }),
    /invalid/i,
    'a disposition outside {addressed, not_applicable_because} is rejected'
  );
  // record_id is required on each disposition
  assert.throws(
    () => handoffSchema.parse({ ...base, dispositions: [{ disposition: 'addressed' }] }),
    /invalid|record_id|required/i,
    'record_id is required on each disposition'
  );
});

test('runRecordSchema.review_mandatory: optional {phase_id, record_id, reason}[]; legacy round-trips; each field required (AC1)', () => {
  const base = {
    id: 'r-d630',
    brief_ref: randomUUID(),
    branch: 'sterling/run-r-d630',
    machine_state: 'running',
    phases: [{ id: 'p1', status: 'in_progress', signals: [], commits: [] }],
    dispatch_counts: {},
    escalations: [],
    started_at: NOW,
  };

  // LEGACY run record (no review_mandatory) round-trips WITHOUT the field being invented
  const legacy = runRecordSchema.parse(base) as { review_mandatory?: unknown[] };
  assert.ok(
    legacy.review_mandatory === undefined || (Array.isArray(legacy.review_mandatory) && legacy.review_mandatory.length === 0),
    'a legacy run record without review_mandatory round-trips unchanged'
  );

  // a run record CARRYING review_mandatory must parse (assertion-red if stripped, never a crash)
  // and survive as an array of the shared mandatory tuple {phase_id, record_id, reason}.
  let parsed: { review_mandatory?: { phase_id: string; record_id: string; reason: string }[] } | undefined;
  assert.doesNotThrow(() => {
    parsed = runRecordSchema.parse({
      ...base,
      review_mandatory: [
        { phase_id: 'p1', record_id: 'rec-1', reason: 'governing design decision' },
        { phase_id: 'p2', record_id: 'rec-2', reason: 'anti-pattern to avoid' },
      ],
    }) as typeof parsed;
  }, 'a run record carrying review_mandatory must parse');
  assert.ok(Array.isArray(parsed!.review_mandatory), 'review_mandatory survives parsing as an array');
  assert.equal(parsed!.review_mandatory!.length, 2);
  assert.deepEqual(parsed!.review_mandatory![0], { phase_id: 'p1', record_id: 'rec-1', reason: 'governing design decision' });

  // each field of the mandatory tuple is required (fail loud on omission — P5)
  assert.throws(() => runRecordSchema.parse({ ...base, review_mandatory: [{ record_id: 'rec-1', reason: 'r' }] }), /invalid|phase_id|required/i, 'phase_id is required on each mandatory item');
  assert.throws(() => runRecordSchema.parse({ ...base, review_mandatory: [{ phase_id: 'p1', reason: 'r' }] }), /invalid|record_id|required/i, 'record_id is required on each mandatory item');
  assert.throws(() => runRecordSchema.parse({ ...base, review_mandatory: [{ phase_id: 'p1', record_id: 'rec-1' }] }), /invalid|reason|required/i, 'reason is required on each mandatory item');
});

test('REVIEWER_ROLES: registry-derived set resolving exactly the four reviewer-* names; totality vs AGENT_MODEL_KEY and the roster (AC1)', async () => {
  // dynamic import + cast: REVIEWER_ROLES does not exist until this phase ships, so a missing
  // export must fail an ASSERTION below — never a compile-time reference (a crash-red proves nothing).
  const mod = (await import('../index.js')) as unknown as Record<string, unknown>;
  const rolesRaw = mod.REVIEWER_ROLES as Set<string> | string[] | undefined;
  assert.ok(rolesRaw, 'REVIEWER_ROLES must be exported from the schemas index (defined once, invariant 1)');

  // coerce the set (Set or array) to a sorted member list — the oracle tests membership, not the container type
  const members = (Array.isArray(rolesRaw) ? [...rolesRaw] : [...(rolesRaw as Set<string>)]).slice().sort();
  const expected = ['reviewer-correctness', 'reviewer-performance', 'reviewer-security', 'reviewer-skeptic'];
  assert.deepEqual(members, expected, 'REVIEWER_ROLES resolves EXACTLY the four reviewer-* names');

  // the is-a-reviewer predicate: reviewers are members, non-reviewers are not
  const has = (n: string) =>
    typeof (rolesRaw as Set<string>).has === 'function' ? (rolesRaw as Set<string>).has(n) : members.includes(n);
  for (const r of expected) assert.ok(has(r), `${r} is a reviewer role`);
  assert.ok(!has('coder'), 'coder is not a reviewer role');
  assert.ok(!has('test-writer'), 'test-writer is not a reviewer role');
  assert.ok(!has('implementation-architect'), 'implementation-architect is not a reviewer role');

  // DERIVATION (single source of truth): REVIEWER_ROLES is EXACTLY the AGENT_MODEL_KEY keys that
  // map to 'reviewers' — a hardcoded list was explicitly REJECTED as a second source (decision 628c4b7f).
  const map = mod.AGENT_MODEL_KEY as Record<string, string> | undefined;
  assert.ok(map, 'AGENT_MODEL_KEY must be exported — REVIEWER_ROLES derives from it');
  const derivedFromMap = Object.keys(map!).filter((k) => map![k] === 'reviewers').sort();
  assert.deepEqual(members, derivedFromMap, "REVIEWER_ROLES is exactly AGENT_MODEL_KEY's 'reviewers' keys — no drift from the map");

  // TOTALITY vs the roster (invariant 3): read agent-templates/registry.json at runtime; its
  // reviewer-* agents are EXACTLY REVIEWER_ROLES — none missing, none orphaned.
  const registry = JSON.parse(readFileSync(join(REPO_ROOT, 'agent-templates', 'registry.json'), 'utf8')) as {
    agents: { name: string }[];
  };
  const rosterReviewers = registry.agents.map((a) => a.name).filter((n) => n.startsWith('reviewer-')).sort();
  assert.deepEqual(members, rosterReviewers, 'REVIEWER_ROLES matches the reviewer-* agents in the roster (totality vs registry.json)');
});
