// success_predicates schema pin (board babf3a9e) — decision
// 98549344-e355-42da-93dd-ce7c2dc4dfcb (slug toolchain-success-predicates-run-gate).
// SPEC ONLY, red-first. NEW file — packages/schemas/src/tests/config.test.ts
// is left untouched per the work order.
//
// toolchains[] gains an OPTIONAL success_predicates: a record keyed by the
// SAME run_command key (test/build/check/export/…), each value declaring at
// least one criterion: output_regex (string), output_regex_absent (string),
// artifact ({ path, min_bytes? }). It lives ALONGSIDE run_commands, never
// nested inside its string values — richer run_commands values were an
// alternative the governing decision explicitly rejected because they break
// H14's Object.values flatMap over run_commands as plain strings.
//
// RED DISCIPLINE: success_predicates does not exist on the schema yet, so
// every assertion that reads it back is expected to fail against TODAY's
// parseConfig — config schemas are non-strict objects (config.test.ts's own
// blast_radius_hard_threshold-rename test relies on exactly this: an unknown
// key is silently stripped, not rejected), so an unrecognized
// success_predicates key is dropped during parsing today and every
// assert.ok/assert.equal reading it back fails cleanly on `undefined`, never
// on a thrown/build error. The empty-object-refusal test is red for the
// mirror-image reason: nothing throws today, because there is no field to
// refuse in the first place. The run_commands-shape-rejection test pins an
// EXISTING invariant the decision deliberately leaves untouched (plain
// Record<string,string>) — it is a regression guard against the REJECTED
// {command, predicate}-object alternative and may already pass today; that
// is expected and reported honestly, not a defect in the test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../config.js';

// Cast-through-unknown for the not-yet-existing field, mirroring
// config.test.ts's pattern (CfgWithEvents / CfgWithCatalog / CfgWithSplit /
// CfgWithDelegationWatch) for fields parseConfig does not carry yet: referencing
// it here must not require the field to exist at compile time, so assertions
// fail cleanly on an AssertionError, never on a package build error.
type ToolchainWithPredicates = {
  adapter?: string;
  path_globs?: string[];
  test_globs?: string[];
  run_commands?: Record<string, string>;
  success_predicates?: Record<
    string,
    {
      output_regex?: string;
      output_regex_absent?: string;
      artifact?: { path?: string; min_bytes?: number };
    }
  >;
};
type CfgWithPredicates = { toolchains?: ToolchainWithPredicates[] };

function toolchain(overrides: Record<string, unknown> = {}) {
  return {
    adapter: 'node',
    path_globs: ['**/*.mjs'],
    test_globs: ['**/*.test.mjs'],
    run_commands: { build: 'node -e "process.exit(0)"' },
    ...overrides,
  };
}

test('toolchains[].success_predicates: a declared output_regex criterion for a run_command key survives parsing', () => {
  const cfg = parseConfig({
    toolchains: [toolchain({ success_predicates: { build: { output_regex: 'OK' } } })],
  }) as unknown as CfgWithPredicates;
  const tc = cfg.toolchains?.[0];
  assert.ok(tc, 'toolchains[0] survives parsing');
  assert.ok(tc?.success_predicates, 'success_predicates must be carried on the parsed toolchain entry');
  assert.deepEqual(
    tc?.success_predicates?.build,
    { output_regex: 'OK' },
    'the declared output_regex criterion round-trips exactly, keyed by the run_command key "build"'
  );
});

test('toolchains[].success_predicates: output_regex_absent and artifact{path,min_bytes} criteria both survive parsing', () => {
  const cfg = parseConfig({
    toolchains: [
      toolchain({
        run_commands: { export: 'node -e "process.exit(0)"' },
        success_predicates: {
          export: { output_regex_absent: 'Error:', artifact: { path: 'dist/out.bin', min_bytes: 1024 } },
        },
      }),
    ],
  }) as unknown as CfgWithPredicates;
  const predicate = cfg.toolchains?.[0]?.success_predicates?.export;
  assert.ok(predicate, 'the export predicate survives parsing');
  assert.equal(predicate?.output_regex_absent, 'Error:');
  assert.equal(predicate?.artifact?.path, 'dist/out.bin');
  assert.equal(predicate?.artifact?.min_bytes, 1024);
});

test('toolchains[].success_predicates: artifact.min_bytes is optional — a bare {path} criterion survives parsing', () => {
  const cfg = parseConfig({
    toolchains: [toolchain({ success_predicates: { build: { artifact: { path: 'dist/out.bin' } } } })],
  }) as unknown as CfgWithPredicates;
  const predicate = cfg.toolchains?.[0]?.success_predicates?.build;
  assert.ok(predicate, 'the build predicate survives parsing');
  assert.equal(predicate?.artifact?.path, 'dist/out.bin');
  assert.equal(predicate?.artifact?.min_bytes, undefined, 'min_bytes is optional and stays absent when not supplied');
});

test('toolchains[].success_predicates: an empty predicate object ({}) is refused — at least one criterion must be declared', () => {
  assert.throws(
    () =>
      parseConfig({
        toolchains: [toolchain({ success_predicates: { build: {} } })],
      }),
    'an empty predicate object carries no criterion at all — it must be rejected loud, never silently accepted as "nothing to check"'
  );
});

test('toolchains[].success_predicates is optional — a toolchain entry with no success_predicates key still parses, and it is not defaulted to {}', () => {
  const cfg = parseConfig({ toolchains: [toolchain()] }) as unknown as CfgWithPredicates;
  const tc = cfg.toolchains?.[0];
  assert.ok(tc, 'toolchains[0] survives parsing with no success_predicates declared at all');
  assert.equal(tc?.success_predicates, undefined, 'success_predicates stays absent when not supplied — it is not defaulted to {}');
});

test('run_commands stays a plain Record<string,string> — a {command, predicate} object value is rejected (the shape H14 depends on)', () => {
  assert.throws(
    () =>
      parseConfig({
        toolchains: [
          toolchain({
            run_commands: {
              build: { command: 'node -e "process.exit(0)"', predicate: { output_regex: 'OK' } },
            },
          }),
        ],
      }),
    'run_commands values must stay plain strings — an object value (even one carrying a predicate) is refused, not accepted as a richer shape (decision 98549344 rejected this alternative: it breaks H14\'s Object.values flatMap over run_commands as plain strings)'
  );
});

test('run_commands plain-string values and success_predicates coexist on one toolchain entry — the sibling-field layering the decision requires', () => {
  const cfg = parseConfig({
    toolchains: [
      toolchain({
        run_commands: { build: 'node -e "process.exit(0)"', test: 'node --test' },
        success_predicates: { build: { output_regex: 'OK' } },
      }),
    ],
  }) as unknown as CfgWithPredicates;
  const tc = cfg.toolchains?.[0];
  assert.equal(tc?.run_commands?.build, 'node -e "process.exit(0)"', 'run_commands.build stays a plain string');
  assert.equal(tc?.run_commands?.test, 'node --test', 'run_commands.test stays a plain string, untouched by the sibling field');
  assert.ok(tc?.success_predicates?.build, 'success_predicates lives alongside run_commands, not inside its values');
});
