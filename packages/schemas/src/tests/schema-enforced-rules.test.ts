import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RECORD_TYPES,
  schemaFor,
  exampleRecordFor,
  fieldShapeAt,
  repoPath,
  objectShapeFor,
  ARTICLE_KINDS,
  NOT_APPLICABLE_EXEMPT_KINDS,
  ARTICLE_STATE_REQUIRES,
  OPEN_QUESTION_CLOSED,
  OPEN_QUESTION_TERMINUS_FIELD,
  TODO_SYSTEM_SOURCE,
  TODO_SYSTEM_REQUIRES,
  TODO_USER_ONLY_FIELDS,
  todoBlocksItself,
  undeclaredPhaseInterfaces,
  REPO_PATH_FORMAT,
  REPO_PATH_REFUSALS,
} from '../index.js';
import type { FieldShape } from '../index.js';

// Finding knowledge-schema-describes-field-shapes-only-enforced-rules-undescribed-october-2026:
// knowledge_schema printed field shapes only, so a writer who read it first was
// still refused by rules it never stated. Each test below runs the validator as
// the oracle and checks that the describer's text names the same rule, reading
// the constant or predicate both of them share.

type Rec = Record<string, unknown>;

const UUID = '11111111-1111-4111-8111-111111111111';

function fieldsOf(type: string): FieldShape[] {
  const described = schemaFor(type);
  assert.ok(described, `${type} is described`);
  return described.fields;
}

function conditionAt(type: string, path: string): string {
  const condition = fieldShapeAt(fieldsOf(type), path)?.condition;
  assert.equal(typeof condition, 'string', `${type}.${path} carries a condition`);
  return condition!;
}

/** The type's own examples as one record: valid by the all-examples test below. */
function base(type: string): Rec {
  const record = exampleRecordFor(type);
  assert.ok(record, `${type} has an example record`);
  return structuredClone(record);
}

function accepts(type: string, record: Rec): boolean {
  return RECORD_TYPES[type].schema.safeParse(record).success;
}

function enumValues(type: string, field: string): string[] {
  const values = fieldShapeAt(fieldsOf(type), field)?.enum_values;
  assert.ok(values && values.length > 1, `${type}.${field} reports its enum`);
  return values;
}

function quoted(text: string, candidates: readonly string[]): string[] {
  return candidates.filter((c) => text.includes(`'${c}'`));
}

function withoutKeys(record: Rec, keys: readonly string[]): Rec {
  const copy = { ...record };
  for (const key of keys) delete copy[key];
  return copy;
}

test('every type: the examples knowledge_schema prints validate together as one record', () => {
  for (const type of Object.keys(RECORD_TYPES)) {
    const record: Rec = {};
    for (const field of fieldsOf(type)) {
      if (field.example === undefined) continue;
      // Scalars print bare and composites as JSON text; ask the field's own
      // node which reading it accepts.
      const node = objectShapeFor(type)![field.name] as { safeParse: (v: unknown) => { success: boolean } };
      let value: unknown = field.example;
      if (!node.safeParse(value).success) value = JSON.parse(field.example);
      record[field.name] = value;
    }
    const result = RECORD_TYPES[type].schema.safeParse(record);
    assert.ok(result.success, `${type}: ${result.success ? '' : JSON.stringify(result.error.issues.map((i) => [i.path.join('.'), i.message]))}`);
    assert.deepEqual(Object.keys(record).sort(), Object.keys(exampleRecordFor(type)!).sort(), `${type}: exampleRecordFor carries the same fields`);
  }
});

test('open_question: the printed examples no longer pair an open status with a terminus', () => {
  const record = base('open_question');
  assert.equal(record[OPEN_QUESTION_TERMINUS_FIELD] !== undefined, record.resolution_status === OPEN_QUESTION_CLOSED);
});

test('feature_article state: the condition names exactly the states the validator makes conditional, and each companion field says so', () => {
  const states = enumValues('feature_article', 'state');
  const complete = { ...base('feature_article'), state_reason: 'switched off', wiring_todo_id: UUID };
  const conditional = states.filter((state) => {
    assert.ok(accepts('feature_article', { ...complete, state }), `state '${state}' is accepted with both companion fields`);
    return !accepts('feature_article', withoutKeys({ ...complete, state }, ['state_reason', 'wiring_todo_id']));
  });
  assert.ok(conditional.length > 0 && conditional.length < states.length, 'some states are conditional and some are not');
  assert.deepEqual(conditional.sort(), Object.keys(ARTICLE_STATE_REQUIRES).sort(), 'the exported constant is what the validator enforces');
  assert.deepEqual(quoted(conditionAt('feature_article', 'state'), states).sort(), conditional.sort());

  for (const state of conditional) {
    for (const field of ARTICLE_STATE_REQUIRES[state]) {
      assert.ok(!accepts('feature_article', withoutKeys({ ...complete, state }, [field])), `state '${state}' without ${field} is refused`);
      assert.match(conditionAt('feature_article', 'state'), new RegExp(`\\b${field}\\b`));
      assert.deepEqual(quoted(conditionAt('feature_article', field), states), [state], `${field} names the state that requires it`);
    }
  }
});

test('feature_article current_ac and live_test_refs: an empty array is refused on exactly the kinds the condition says', () => {
  const article = base('feature_article');
  const refusing = ARTICLE_KINDS.filter((article_kind) => !accepts('feature_article', { ...article, article_kind, current_ac: [], live_test_refs: [] }));
  assert.deepEqual([...refusing].sort(), [...NOT_APPLICABLE_EXEMPT_KINDS].sort());
  for (const field of ['current_ac', 'live_test_refs']) {
    const [exemptClause] = conditionAt('feature_article', field).split(/other kinds/i);
    assert.match(exemptClause, /empty array is refused/);
    assert.deepEqual(
      ARTICLE_KINDS.filter((k) => new RegExp(`\\b${k}\\b`).test(exemptClause)).sort(),
      [...refusing].sort(),
      `${field}: the clause that refuses [] names exactly the refusing kinds`
    );
  }
});

test('todo source: the conditions name the fields the validator requires and refuses on a system item', () => {
  const sources = enumValues('todo', 'source');
  const userOnly = Object.keys(TODO_USER_ONLY_FIELDS);
  const samples: Rec = { blocked_by: ['another-item'], needs: 'user' };
  const plain = withoutKeys(base('todo'), [...TODO_SYSTEM_REQUIRES, ...userOnly]);

  const requiring = sources.filter((source) => !accepts('todo', { ...plain, source }));
  assert.deepEqual(requiring, [TODO_SYSTEM_SOURCE], 'only a system item is refused without its required fields');
  const system = { ...base('todo'), source: TODO_SYSTEM_SOURCE };
  assert.ok(accepts('todo', withoutKeys(system, userOnly)), 'a system item with its required fields and no user-only field is accepted');

  const sourceCondition = conditionAt('todo', 'source');
  assert.deepEqual(quoted(sourceCondition, sources), [TODO_SYSTEM_SOURCE]);
  for (const field of TODO_SYSTEM_REQUIRES) {
    assert.ok(!accepts('todo', withoutKeys(system, [...userOnly, field])), `a system item without ${field} is refused`);
    assert.match(sourceCondition, new RegExp(`requires.*\\b${field}\\b`));
    assert.match(conditionAt('todo', field), /Required when source is 'system'/);
  }
  for (const field of userOnly) {
    for (const source of sources) {
      const refused = !accepts('todo', { ...withoutKeys(base('todo'), userOnly), source, [field]: samples[field] });
      assert.equal(refused, source === TODO_SYSTEM_SOURCE, `${field} on source '${source}'`);
    }
    assert.match(sourceCondition, new RegExp(`refuses.*\\b${field}\\b`));
    assert.match(conditionAt('todo', field), /Refused when source is 'system'/);
  }
});

test('todo blocked_by: an item listing its own slug is refused, and the condition says so', () => {
  const item = { ...withoutKeys(base('todo'), ['needs']), source: 'user', slug: 'this-item' };
  for (const blocked_by of [['another-item'], ['this-item'], ['another-item', 'this-item']]) {
    const self = todoBlocksItself({ slug: 'this-item', blocked_by });
    assert.equal(accepts('todo', { ...item, blocked_by }), !self, `blocked_by ${JSON.stringify(blocked_by)}`);
  }
  assert.match(conditionAt('todo', 'blocked_by'), /cannot list its own slug/);
});

test('open_question: closed requires the terminus and every other status refuses it, as both conditions say', () => {
  const statuses = enumValues('open_question', 'resolution_status');
  const bare = withoutKeys(base('open_question'), [OPEN_QUESTION_TERMINUS_FIELD]);
  const requiring = statuses.filter((resolution_status) => !accepts('open_question', { ...bare, resolution_status }));
  const refusing = statuses.filter((resolution_status) => !accepts('open_question', { ...bare, resolution_status, [OPEN_QUESTION_TERMINUS_FIELD]: 'a-finding' }));
  assert.deepEqual(requiring, [OPEN_QUESTION_CLOSED]);
  assert.deepEqual(refusing.sort(), statuses.filter((s) => s !== OPEN_QUESTION_CLOSED).sort());

  const statusCondition = conditionAt('open_question', 'resolution_status');
  assert.deepEqual(quoted(statusCondition, statuses), requiring);
  assert.match(statusCondition, new RegExp(`requires ${OPEN_QUESTION_TERMINUS_FIELD}; any other value refuses it`));
  const terminusCondition = conditionAt('open_question', OPEN_QUESTION_TERMINUS_FIELD);
  assert.deepEqual(quoted(terminusCondition, statuses), requiring);
  assert.match(terminusCondition, /Required when .* refused otherwise/);
});

test('brief phases[].interfaces: a name technical_design.interfaces does not declare is refused, and the condition names that field', () => {
  const brief = base('brief') as { technical_design: { interfaces: { name: string }[] }; phases: Rec[] };
  const declared = brief.technical_design.interfaces[0].name;
  for (const interfaces of [[declared], ['not-declared'], [declared, 'not-declared']]) {
    const candidate = { ...brief, phases: [{ ...brief.phases[0], interfaces }] };
    const dangling = undeclaredPhaseInterfaces(candidate as unknown as Parameters<typeof undeclaredPhaseInterfaces>[0]);
    assert.equal(accepts('brief', candidate), dangling.length === 0, `interfaces ${JSON.stringify(interfaces)}`);
  }
  assert.match(conditionAt('brief', 'phases[].interfaces'), /technical_design\.interfaces/);
});

const PATH_FIELDS: [type: string, path: string][] = [
  ['decision', 'file_keys'],
  ['anti_pattern', 'file_keys'],
  ['research_finding', 'file_keys'],
  ['disconfirmed_hypothesis', 'file_keys'],
  ['open_question', 'file_keys'],
  ['attestation', 'file_keys'],
  ['todo', 'file_keys'],
  ['feature_article', 'files[].path'],
  ['feature_article', 'live_test_refs[].test_paths'],
  ['brief', 'incidental_scope'],
  ['brief', 'phases[].files'],
  ['brief', 'blast_radius.files[].path'],
];

test('repo path fields: each prints the path format and names every refusal the path boundary raises', () => {
  for (const { label, sample } of REPO_PATH_REFUSALS) {
    assert.equal(repoPath.safeParse(sample).success, false, `a ${label} path ('${sample}') is refused`);
  }
  for (const fine of ['src/a.ts', 'src\\a.ts', './src/a.ts', 'a']) {
    assert.ok(repoPath.safeParse(fine).success, `'${fine}' is accepted`);
  }
  for (const [type, path] of PATH_FIELDS) {
    const shape = fieldShapeAt(fieldsOf(type), path);
    assert.equal(shape?.format, REPO_PATH_FORMAT, `${type}.${path} prints the path format`);
    for (const { label } of REPO_PATH_REFUSALS) {
      assert.ok(shape?.condition?.includes(label), `${type}.${path} names the ${label} refusal`);
    }
  }
});

test('repo path fields: no other field claims the path format', () => {
  const formatted: string[] = [];
  const walk = (type: string, fields: FieldShape[], prefix: string): void => {
    for (const f of fields) {
      if (f.format !== undefined) formatted.push(`${type}:${prefix}${f.name}`);
      if (f.element_fields) walk(type, f.element_fields, `${prefix}${f.name}[].`);
      if (f.member_fields) walk(type, f.member_fields, `${prefix}${f.name}.`);
    }
  };
  for (const type of Object.keys(RECORD_TYPES)) walk(type, fieldsOf(type), '');
  assert.deepEqual(formatted.sort(), PATH_FIELDS.map(([type, path]) => `${type}:${path}`).sort());
});

test('non-empty strings print min_length, and an unconstrained string does not', () => {
  for (const [type, path] of [
    ['decision', 'title'],
    ['feature_article', 'concept_family'],
    ['feature_article', 'files[].role'],
    ['open_question', 'hypotheses'],
    ['brief', 'phases[].phase_id'],
  ]) {
    assert.equal(fieldShapeAt(fieldsOf(type), path)?.min_length, 1, `${type}.${path}`);
  }
  assert.ok(!accepts('decision', { ...base('decision'), title: '' }), 'the validator refuses an empty title');
  for (const [type, path] of [
    ['feature_article', 'state_reason'],
    ['decision', 'alternatives_rejected[].option'],
    ['brief', 'technical_design.approach'],
  ]) {
    assert.equal(fieldShapeAt(fieldsOf(type), path)?.min_length, undefined, `${type}.${path}`);
  }
  assert.ok(accepts('feature_article', { ...base('feature_article'), state_reason: '' }), 'the validator accepts an empty state_reason');
});

test('defaults are printed, and are what the validator fills in', () => {
  for (const [type, field, expected] of [
    ['feature_article', 'article_kind', 'feature'],
    ['anti_pattern', 'basis', 'codebase'],
    ['reference_material', 'basis', 'codebase'],
    ['open_question', 'resolution_status', 'open'],
    ['open_question', 'hypotheses', '[]'],
    ['research_finding', 'source_urls', '[]'],
  ] as const) {
    const shape = fieldShapeAt(fieldsOf(type), field);
    assert.equal(shape?.default, expected, `${type}.${field}`);
    assert.equal(shape?.required, false, `${type}.${field} is optional`);
    // Dropping resolution_status falls back to 'open', which refuses the example's terminus.
    const dropped = field === 'resolution_status' ? [field, OPEN_QUESTION_TERMINUS_FIELD] : [field];
    const parsed = RECORD_TYPES[type].schema.safeParse(withoutKeys(base(type), dropped));
    assert.ok(parsed.success, `${type} validates without ${field}`);
    const filled = (parsed.data as Rec)[field];
    assert.equal(typeof filled === 'string' ? filled : JSON.stringify(filled), expected);
  }
  assert.equal(fieldShapeAt(fieldsOf('decision'), 'title')?.default, undefined, 'a field without a default prints none');
});

test('ISO datetime fields say the UTC Z form, which is the only one the validator accepts', () => {
  for (const [type, path] of [
    ['decision', 'created_at'],
    ['feature_article', 'history[].date'],
    ['feature_article', 'last_executed'],
  ]) {
    assert.match(fieldShapeAt(fieldsOf(type), path)!.type, /ISO datetime, UTC Z form/, `${type}.${path}`);
  }
  const article = base('feature_article');
  assert.ok(accepts('feature_article', { ...article, last_executed: '2026-08-24T00:00:00.000Z' }));
  assert.ok(!accepts('feature_article', { ...article, last_executed: '2026-08-24T02:00:00.000+02:00' }), 'an offset form is refused');
  assert.ok(!accepts('feature_article', { ...article, last_executed: '2026-08-24T00:00:00.000' }), 'a local form is refused');
});

test('plain objects print their members with requiredness', () => {
  const members = (type: string, path: string): Record<string, boolean> => {
    const shape = fieldShapeAt(fieldsOf(type), path);
    assert.ok(shape?.member_fields, `${type}.${path} prints member_fields`);
    return Object.fromEntries(shape.member_fields.map((m) => [m.name, m.required]));
  };
  assert.deepEqual(members('feature_article', 'dependencies'), { relies_on: true, relied_by: true });
  assert.deepEqual(members('brief', 'user_stated'), { criteria: true, constraints: true });
  assert.deepEqual(members('brief', 'technical_design'), { approach: true, interfaces: true, shared_structures: true });
  assert.deepEqual(members('brief', 'blast_radius'), { files: true, reconcile_list: true });
  assert.deepEqual(members('brief', 'phases[].difficulty'), { level: true, reasons: true });
  assert.deepEqual(members('reference_material', 'catalog'), { entries: true });
  assert.deepEqual(members('feature_article', 'current_ac[].untestable_because'), { reason: true, blocking_record_id: true });
  for (const field of ['current_ac', 'live_test_refs']) {
    assert.deepEqual(members('feature_article', field), { not_applicable: true });
    assert.deepEqual(members('feature_article', `${field}.not_applicable`), { reason: true, ruling_record_id: false });
    assert.match(conditionAt('feature_article', field), /\{not_applicable: \{reason, ruling_record_id\?\}\}/);
  }
  // Nested arrays keep their element fields, and nested enums their values.
  assert.deepEqual(
    fieldShapeAt(fieldsOf('brief'), 'technical_design.interfaces')?.element_fields?.map((f) => f.name),
    ['name', 'contract']
  );
  assert.deepEqual(fieldShapeAt(fieldsOf('brief'), 'phases[].difficulty.level')?.enum_values, ['normal', 'hard']);
});

test('a record map prints the type of its values', () => {
  assert.equal(fieldShapeAt(fieldsOf('feature_article'), 'file_baselines')?.type, 'record<string, string>');
  assert.equal(
    fieldShapeAt(fieldsOf('feature_article'), 'baseline_attestations')?.type,
    'record<string, {attested_at, item_id, head_commit, sha256}>'
  );
  assert.equal(fieldShapeAt(fieldsOf('reference_material'), 'absence_attestations')?.type, 'record<string, {attested_at, item_id, head_commit}>');
});
