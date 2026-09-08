// FROZEN PINS for the `config_set` MCP tool — spec-only, authored BLIND to the
// implementation (H4 read wall). The contract is decision
// [config-writes-get-a-config-set-mcp-tool-with-positive-key-allowlist-raw-edit-denial-stays]
// (knowledge_get 1dc3f9aa-dbd6-4448-b1ac-61b3a4dabde7), PINS paragraph +
// WHAT SHIPS.
//
// CONTRACT PINNED HERE
//   tool `config_set` {path: dotted key path, value, expected_digest?}
//   → receipt {path, previous_value, value, digest}
//   ALLOWLIST (positive, policy data, exported as CONFIG_SET_ALLOWLIST):
//     models.<key>, tdd.enabled, mutation_verification.enabled,
//     sparring_partner.enabled, sparring_partner.model,
//     delegation.max_concurrent, maintenance_queue.deep_threshold,
//     delivery.<key>, dispatch_register.stale_minutes, review_ledger.stale_days
//   Everything else is REFUSED naming the path and the allowlist.
//   Reads/writes the ACTIVE project's canonical .sterling/config.json (NO path
//   argument — a foreign project is unreachable by construction), refuses a
//   symlinked config.json, CAS on expected_digest (sha256 of the current
//   bytes), validates the WHOLE resulting document against the canonical zod
//   config schema, atomic 2-space-JSON write, unrelated keys byte-preserved.
//
// INTERFACE ASSUMPTIONS (the brief declared the TOOL contract, not the class
// surface; both follow the surface's existing snake→camel convention and are
// stated so a mismatch is a one-line rename, not a re-spec):
//   (1) SterlingTools exposes the handler as `configSet(args)` taking ONE
//       object {path, value, expected_digest?} and RETURNING the receipt;
//       refusals THROW (the surface's refusal shape — cf. tools.test.ts
//       `assert.throws(..., /unregistered record type/)`).
//   (2) CONFIG_SET_ALLOWLIST is exported (or re-exported) from
//       packages/mcp-server/src/tools.ts.
//
// WHY parseConfig CONTROLS APPEAR BELOW: the test-writer cannot read
// packages/schemas/src/config.ts (H4). Every fact this file needs ABOUT THE
// SCHEMA (that a key exists, that '' is a legal sparring_partner.model) is
// therefore established at test time through the canonical schema's own
// exported parser, as a CONTROL that must pass for the opposite reason before
// the pin's verdict is read. A control failure names the exact repoint needed.
//
// NO CHILD PROCESSES: every pin runs in-process (unit harness or the in-memory
// MCP transport), so there is no child stderr to flatten.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { parseConfig } from '@sterling/schemas';
import { SterlingStore } from '@sterling/store';
import { createSterlingServer } from '../server.js';
import { SterlingTools } from '../tools.js';
import * as toolsModule from '../tools.js';

const NOW = '2026-09-08T12:00:00.000Z';

// Deliberately free of every word used in a refusal regex below ('allowlist',
// 'digest', 'symlink', 'number', 'frobnicate', any config key path): a missing
// handler must never accidentally satisfy a refusal pin's message match.
const HANDLER_MSG =
  "SterlingTools must expose the config_set handler as configSet({ path, value, expected_digest? }) " +
  '— decision config-writes-get-a-config-set-mcp-tool-with-positive-key-allowlist-raw-edit-denial-stays. ' +
  'RED UNTIL THE TOOL EXISTS.';

type Receipt = { path: string; previous_value: unknown; value: unknown; digest: string };
type CallArgs = { path: string; value: unknown; expected_digest?: string };
type Call = (args: CallArgs) => Receipt;

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Schema-valid seed document, built BY the canonical schema so it cannot be a guess. */
function seedDoc(): Record<string, unknown> {
  let built: unknown;
  let err: unknown;
  try {
    built = parseConfig({
      tdd: { enabled: true },
      mutation_verification: { enabled: true },
      sparring_partner: { enabled: true, model: '' },
      delegation: { max_concurrent: 5 },
      maintenance_queue: { deep_threshold: 20 },
      delivery: { payload_char_cap: 12000 },
      review_ledger: { stale_days: 14 },
      generated_projections: ['architecture.md'],
    });
  } catch (e) {
    err = e;
  }
  assert.equal(
    err,
    undefined,
    'FIXTURE INTEGRITY: the canonical config schema must accept this seed document. ' +
      `parseConfig threw: ${String(err instanceof Error ? err.message : err).replace(/\s+/g, ' ')}`
  );
  const doc = built as Record<string, unknown>;
  // Every key path this file writes to must EXIST in the seed, or the pin is
  // aimed at a key the schema does not define and needs repointing.
  const required: [string, string][] = [
    ['tdd', 'enabled'],
    ['mutation_verification', 'enabled'],
    ['sparring_partner', 'model'],
    ['delegation', 'max_concurrent'],
    ['maintenance_queue', 'deep_threshold'],
    ['delivery', 'payload_char_cap'],
    ['review_ledger', 'stale_days'],
  ];
  for (const [parent, leaf] of required) {
    const holder = doc[parent] as Record<string, unknown> | undefined;
    assert.ok(
      holder !== undefined && Object.prototype.hasOwnProperty.call(holder, leaf),
      `FIXTURE INTEGRITY: the canonical config schema must define '${parent}.${leaf}' — if it does not, this pin ` +
        'needs repointing to a key the schema really has (the test-writer is blind to packages/schemas/src/config.ts, H4)'
    );
  }
  return doc;
}

/**
 * RAW seed text for the byte-preservation pin: schema-correct on every MODELED
 * key (it starts from seedDoc(), so it cannot be a guess), then deliberately
 * carrying what a parseConfig round-trip would destroy —
 *   · an UNMODELED TOP-LEVEL key ("zz_unmodeled"),
 *   · an UNMODELED NESTED key inside the very object the write touches,
 *   · and NO "maintenance_queue" at all, so a defaults-injecting writeback is
 *     visible as an ADDED key rather than having to be inferred.
 * A tool that re-serializes the PARSED document instead of the parsed FILE
 * silently eats all three.
 */
function rawSeedText(): string {
  const doc = seedDoc();
  delete doc.maintenance_queue;
  const tdd = { ...(doc.tdd as Record<string, unknown>), zz_unmodeled_leaf: 'keep-me' };
  return JSON.stringify({ ...doc, tdd, zz_unmodeled: { k: 1 } }, null, 2);
}

function harness(seedTextOverride?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-config-set-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const configPath = join(dir, '.sterling', 'config.json');
  const seedText = seedTextOverride ?? JSON.stringify(seedDoc(), null, 2);
  writeFileSync(configPath, seedText);
  // NO `config:` injection on purpose: config_set's subject is the FILE on
  // disk (it CASes over its bytes and byte-preserves its unrelated keys), so
  // handing the tool a pre-parsed config object would let a pin pass against
  // an in-memory document that was never written.
  const tools = new SterlingTools({ store, repoRoot: dir, now: () => NOW });
  const read = () => readFileSync(configPath, 'utf8');
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, tools, configPath, seedText, read, cleanup };
}

/** Resolves the handler as an ASSERTION (never a TypeError crash) before any assert.throws. */
function handler(tools: SterlingTools): Call {
  const fn = (tools as unknown as Record<string, unknown>).configSet;
  assert.equal(typeof fn, 'function', HANDLER_MSG);
  return (fn as (a: CallArgs) => Receipt).bind(tools) as Call;
}

/** Captures a refusal's message; a call that does NOT throw fails on the missing-exception assertion. */
function refusalMessage(call: Call, args: CallArgs): string {
  let msg: string | undefined;
  assert.throws(
    () => call(args),
    (err: unknown) => {
      msg = err instanceof Error ? err.message : String(err);
      return true;
    },
    `config_set('${args.path}') must REFUSE by throwing — nothing was thrown`
  );
  return (msg ?? '').replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// CS-20 — FORWARD-COMPATIBILITY CONTROL, and it must stay GREEN FOREVER.
// Two later pins rest on it: CS-1 seeds a config.json carrying UNMODELED keys
// (an older Sterling must be able to read a newer machine's config), and
// CS-19's ruling that an unknown delivery leaf is refused by a MEMBERSHIP
// CHECK IN THE TOOL only makes sense while the schema itself tolerates the
// key. If this pin ever goes RED the canonical config schema has become
// strict — that is a FINDING about packages/schemas, not a config_set defect,
// and CS-1/CS-19 must then be re-specified rather than "fixed".
// ---------------------------------------------------------------------------
test('CS-20 CONTROL: the canonical config schema PARSES a config.json carrying unmodeled keys (forward compatibility) — unknown keys never make a config unreadable', () => {
  let parsed: unknown;
  let err: unknown;
  try {
    parsed = parseConfig({
      tdd: { enabled: true, zz_unmodeled_leaf: 'keep-me' },
      delivery: { payload_char_cap: 12000, zz_future_delivery_key: 3 },
      zz_unmodeled: { k: 1 },
    });
  } catch (e) {
    err = e;
  }
  assert.equal(
    err,
    undefined,
    'CONTROL: an unmodeled key anywhere in config.json must not make the document unparseable — a newer machine\'s config has to stay readable by an older clone. ' +
      `parseConfig threw: ${String(err instanceof Error ? err.message : err).replace(/\s+/g, ' ')}`
  );
  assert.equal(
    (parsed as { tdd?: { enabled?: unknown } }).tdd?.enabled,
    true,
    'CONTROL: and the modeled keys beside the unmodeled one still parse to their real values'
  );
});
// NAMED SABOTAGE (CS-20): add `.strict()` to the config schema's root object
// (or to `delivery`) → parseConfig throws on the unmodeled key and this pin
// goes RED. That sabotage is also the one that would make CS-19's mechanism
// ruling unnecessary, which is why the two are pinned together.

// ---------------------------------------------------------------------------
// CS-1 — CONTROL, FIRST for every refusal pin. Each of those has two possible
// causes: "the tool refused THIS path" and "the tool refuses / cannot do
// anything at all". This pin rules out the second: an allowlisted write must
// actually land, byte-exactly, with a receipt digest computed over the NEW
// bytes. It is ALSO the byte-preservation pin, and it is deliberately seeded
// from RAW TEXT (never from a parseConfig round-trip) because a fixture built
// by the schema cannot detect a writeback that re-serializes the SCHEMA'S
// view of the document: defaults injected, unmodeled keys stripped.
// ---------------------------------------------------------------------------
test('CS-1 CONTROL: config_set tdd.enabled=false lands — receipt digest is sha256 of the NEW bytes, 2-space JSON, and unmodeled/absent keys survive byte-for-byte', () => {
  const h = harness(rawSeedText());
  try {
    const call = handler(h.tools);
    const beforeText = h.read();
    assert.ok(beforeText.includes('"zz_unmodeled"'), 'FIXTURE: the seed carries an unmodeled top-level key');
    assert.ok(beforeText.includes('"zz_unmodeled_leaf"'), 'FIXTURE: and an unmodeled leaf inside the object the write touches');
    assert.ok(!beforeText.includes('"maintenance_queue"'), 'FIXTURE: and omits a MODELED key, so an injected default shows up as an added key');
    const before = JSON.parse(beforeText) as Record<string, unknown>;
    assert.equal(
      (before.tdd as { enabled?: unknown }).enabled,
      true,
      'CONTROL PRECONDITION: the seed must start at tdd.enabled=true so the write is a real change, not a no-op'
    );

    const receipt = call({ path: 'tdd.enabled', value: false });

    assert.equal(receipt.path, 'tdd.enabled', 'the receipt names the path it wrote');
    assert.equal(receipt.previous_value, true, 'the receipt carries the PREVIOUS value, read from the file');
    assert.equal(receipt.value, false, 'the receipt carries the new value');

    const afterText = h.read();
    const after = JSON.parse(afterText) as Record<string, unknown>;
    assert.equal((after.tdd as { enabled?: unknown }).enabled, false, 'the change is on disk, not only in the receipt');

    assert.match(receipt.digest, /^[0-9a-f]{64}$/, 'the receipt digest is sha256 hex');
    assert.equal(
      receipt.digest,
      sha256(readFileSync(h.configPath)),
      'the receipt digest is computed over the bytes that were WRITTEN (a pre-write digest is a stale CAS token for the next caller)'
    );

    assert.equal(
      afterText.replace(/\n$/, ''),
      JSON.stringify(after, null, 2),
      'the file is canonical 2-space JSON (a minified or 4-space writeback rewrites the whole document)'
    );

    assert.deepEqual(
      Object.keys(after),
      Object.keys(before),
      'no top-level key is added, dropped or reordered by a one-key write'
    );
    for (const key of Object.keys(before)) {
      if (key === 'tdd') continue;
      assert.equal(
        JSON.stringify(after[key]),
        JSON.stringify(before[key]),
        `unrelated top-level key '${key}' must be preserved exactly — config_set sets ONE key, it never re-derives the document`
      );
    }
    assert.deepEqual(
      { ...(after.tdd as Record<string, unknown>), enabled: true },
      before.tdd,
      'inside the touched parent, only the addressed leaf changed'
    );

    // The three things a schema-shaped writeback destroys, asserted on the
    // BYTES rather than on parsed values:
    assert.equal(
      JSON.stringify(after.zz_unmodeled),
      '{"k":1}',
      'an UNMODELED top-level key survives the write — config_set edits the parsed FILE, never re-serializes the schema\'s view of it'
    );
    assert.equal(
      (after.tdd as Record<string, unknown>).zz_unmodeled_leaf,
      'keep-me',
      'an UNMODELED leaf inside the touched object survives — the write replaces one leaf, not the parent'
    );
    assert.ok(
      !Object.prototype.hasOwnProperty.call(after, 'maintenance_queue'),
      'a MODELED-but-absent key stays absent: validating the document must not materialize schema DEFAULTS into the file ' +
        '(that is how a formerly-inert field silently reverts recorded policy — anti_pattern 94f16632)'
    );
    assert.ok(
      afterText.includes('"zz_unmodeled_leaf": "keep-me"'),
      'and the unmodeled leaf is present in the TEXT at 2-space depth, not merely reachable after a re-parse'
    );
  } finally {
    h.cleanup();
  }
});
// NAMED SABOTAGE (CS-1): compute the receipt digest BEFORE the write
// (`const digest = sha256(currentBytes)` returned as-is) → the
// receipt.digest === sha256(new bytes) assertion goes RED while every earlier
// assertion stays green, proving the harness drives a real write.
// SECOND, INDEPENDENT SABOTAGE: write with `JSON.stringify(doc)` (no indent)
// → the canonical-2-space assertion goes RED alone.
// THIRD: rebuild the written document from parseConfig's defaulted output
// instead of the parsed file (`writeFileSync(p, JSON.stringify(parseConfig(doc), null, 2))`
// — the single most plausible implementation, since the tool must call
// parseConfig anyway to validate) → the unmodeled-top-level-key, unmodeled-leaf
// and maintenance-queue-absent assertions ALL go RED, and the key-set
// deepEqual with them. This is the sabotage the old parseConfig-seeded
// fixture could not see at all: with a schema-round-tripped seed the written
// document equals the seed and every assertion stayed green.
// Each assertion carries its own verdict; none is defence in depth for another.

// ---------------------------------------------------------------------------
// CS-12 (added) — THE ALLOWLIST IS POLICY DATA, AND ITS CONTENT IS THE PIN.
// CS-2/3/4 pin the RUNTIME refusals one path at a time; a WIDENED constant
// behind an intact check is invisible to them (nobody writes a pin for a key
// nobody thought of), so this pin is EXACT SET EQUALITY against the decision's
// list: any entry added later — `context_watch.mode`, a second delivery
// namespace, anything — reddens it, and growing the allowlist therefore
// requires a decision plus a visible pin edit, which is exactly the intended
// cost ("the allowlist is policy data and grows by decision, never by a caller
// flag"). The ONLY latitude is notation: the decision writes `models.*` and
// the build brief `models.<key>` for the same namespace, so a trailing
// `.<key>` is normalized to `.*` before comparing. Nothing else is tolerated.
// ---------------------------------------------------------------------------
const EXPECTED_ALLOWLIST = [
  'delegation.max_concurrent',
  'delivery.*',
  'dispatch_register.stale_minutes',
  'maintenance_queue.deep_threshold',
  'models.*',
  'mutation_verification.enabled',
  'review_ledger.stale_days',
  'sparring_partner.enabled',
  'sparring_partner.model',
  'tdd.enabled',
].sort();

test('CS-12: CONFIG_SET_ALLOWLIST is exported policy data EQUAL to the decision\'s list — no entry added, none missing, never a gate-defining key', () => {
  const allowlist = (toolsModule as unknown as Record<string, unknown>).CONFIG_SET_ALLOWLIST;
  assert.ok(
    Array.isArray(allowlist),
    'CONFIG_SET_ALLOWLIST must be exported from packages/mcp-server/src/tools.ts as an array (the allowlist is policy data, one constant beside the tool). RED UNTIL THE TOOL EXISTS.'
  );
  const entries = (allowlist as unknown[]).map((e) => String(e));
  assert.ok(entries.length > 0, 'an empty allowlist would refuse everything and pass every refusal pin vacuously');

  const normalized = entries.map((e) => e.replace(/\.<key>$/, '.*')).sort();
  assert.deepEqual(
    normalized,
    EXPECTED_ALLOWLIST,
    'the shipped allowlist must be EXACTLY the decision\'s namespaces (decision 1dc3f9aa WHAT SHIPS; `.<key>` normalized to `.*`). ' +
      'An entry here that is not in the decision is an ungoverned widening of a write surface that reaches H14/H5/H18 territory; ' +
      'a missing entry is relief the consumer report asked for and did not get. Either way: change the decision first, then this pin.'
  );

  // Defence in depth: even if the set-equality above is ever re-specified,
  // these six can never appear — they are the two-step-bypass keys.
  const text = normalized.join(' ');
  for (const forbidden of ['store_guard', 'toolchains', 'machine_role', 'backup_path', 'store_authority', 'code_globs']) {
    assert.ok(
      !text.includes(forbidden),
      `'${forbidden}' must NEVER be allowlisted — these keys define H14's run_commands, H5/H18's test_globs, the store authority and the machine role; ` +
        'admitting one is the two-step enforcement bypass the whole design exists to prevent'
    );
  }
});
// NAMED SABOTAGE (CS-12): append ONE benign-looking entry —
// `'context_watch.mode'` — to CONFIG_SET_ALLOWLIST → the set-equality
// assertion goes RED. It is the *benign* entry that matters: the forbidden-
// fragment arm below would not have caught it, and no runtime pin exists for a
// path nobody anticipated.
// SECOND SABOTAGE: append 'store_guard.allow_scripts' → set-equality AND the
// forbidden-fragment arm both fire (two layers, deliberately).
// THIRD: delete an entry, e.g. drop 'delivery.*' → RED here only; CS-2/3/4
// cannot see a MISSING entry at all, and CS-11's positive half would then fail
// for a misleading reason ("delivery is not allowlisted"), which is why this
// pin states the set rather than sampling it.
// LOAD-BEARING NOTE: under the store_guard sabotage CS-2 also goes red — that
// is defence in depth, not redundancy. The verdict this pin uniquely carries
// is EVERY entry the runtime pins do not name.

// ---------------------------------------------------------------------------
// CS-2 / CS-3 / CS-4 — the negative arm of the allowlist. Each asserts THREE
// things a generic "everything is refused" implementation would not satisfy
// together: refusal, a message naming BOTH the offending path and the
// allowlist, and byte-identical config bytes.
// ---------------------------------------------------------------------------
test('CS-2: store_guard.allow_scripts is refused naming the path and the allowlist — the file is byte-unchanged', () => {
  const h = harness();
  try {
    const call = handler(h.tools);
    const before = h.read();
    const msg = refusalMessage(call, { path: 'store_guard.allow_scripts', value: ['scripts/evil.mjs'] });
    assert.match(msg, /store_guard\.allow_scripts/, 'the refusal NAMES the offending path so the caller can self-correct');
    assert.match(msg, /allowlist/i, 'the refusal names the ALLOWLIST as the reason — the positive-list rule, not a schema failure');
    assert.equal(h.read(), before, 'a refused write leaves the config byte-identical');
  } finally {
    h.cleanup();
  }
});
// NAMED SABOTAGE (CS-2): make the allowlist membership test pass through
// (`if (false) refuse(...)`, or invert the predicate) → the refusal is gone,
// refusalMessage's missing-exception assertion goes RED. The message-content
// assertions are the second, independent guard: dropping the path from the
// text (a bare "not permitted") leaves the throw intact and still goes RED.

test('CS-3: toolchains.0.run_commands is refused naming the path and the allowlist — the file is byte-unchanged', () => {
  const h = harness();
  try {
    const call = handler(h.tools);
    const before = h.read();
    const msg = refusalMessage(call, { path: 'toolchains.0.run_commands', value: ['node --test dist/**/*.test.js'] });
    assert.match(msg, /toolchains\.0\.run_commands/, 'the refusal names the indexed path verbatim');
    assert.match(msg, /allowlist/i, 'refused BY THE ALLOWLIST — run_commands defines H14\'s executable allowance');
    assert.equal(h.read(), before, 'nothing written');
  } finally {
    h.cleanup();
  }
});
// NAMED SABOTAGE (CS-3): make membership a LOOSE match instead of an exact
// key-path match — `allowlist.some((entry) => path.includes(entry.split('.')[0]))`
// (the [unanchored-substring-allowlist-in-command-guard] shape, one line) →
// 'toolchains.0.run_commands' contains no allowlisted first segment today, so
// harden the sabotage to the equivalent inverse: `allowlist.some((entry) =>
// entry.split('.')[0].length > 0)`, i.e. any non-empty allowlist admits every
// path → the refusal is lost and this pin goes RED on the missing exception.
// SECOND, INDEPENDENT: normalise indexed segments away before matching
// (`path.replace(/\.\d+\./g, '.')`, a plausible array-path convenience) →
// 'toolchains.run_commands' is still not allowlisted so the throw survives,
// but the message then quotes the NORMALISED path and the
// /toolchains\.0\.run_commands/ assertion goes RED alone — a refusal that
// misquotes what the caller sent.

test('CS-4: an unknown key (frobnicate.x) is refused naming the path and the allowlist — the file is byte-unchanged', () => {
  const h = harness();
  try {
    const call = handler(h.tools);
    const before = h.read();
    const msg = refusalMessage(call, { path: 'frobnicate.x', value: 1 });
    assert.match(msg, /frobnicate\.x/, 'the refusal names the unknown path');
    assert.match(
      msg,
      /allowlist/i,
      'an unknown key is refused by the POSITIVE list (fails closed when the schema gains a key) — not by the schema'
    );
    assert.equal(h.read(), before, 'nothing written');
  } finally {
    h.cleanup();
  }
});
// NAMED SABOTAGE (CS-4): replace the positive allowlist with a blacklist of
// gate-defining keys (the rejected alternative) → 'frobnicate.x' is no longer
// in the deny set, the call proceeds, and this pin goes RED on the missing
// exception. CS-2/CS-3 would stay GREEN under that sabotage — this pin is the
// one that discriminates positive-list from blacklist.

// ---------------------------------------------------------------------------
// CS-5 — sparring_partner.model. The CONTROL establishes, through the
// canonical schema's own parser, that '' is a legal value (empty = CLI
// default) BEFORE the pin reads config_set's verdict; if that control fails,
// its message names the repoint instead of leaving a mystery red.
// ---------------------------------------------------------------------------
test("CS-5: sparring_partner.model accepts a non-empty model AND '' (empty = CLI default) — the resulting document still validates", () => {
  const h = harness();
  try {
    // CONTROL, opposite reason: the SCHEMA must permit ''.
    let probe: unknown;
    let probeErr: unknown;
    try {
      probe = parseConfig({ sparring_partner: { enabled: true, model: '' } });
    } catch (e) {
      probeErr = e;
    }
    assert.equal(
      probeErr,
      undefined,
      "CONTROL: the canonical config schema must accept sparring_partner.model === '' (empty = CLI default). " +
        `If it refuses '' this pin must be repointed to a non-empty model only. parseConfig threw: ${String(
          probeErr instanceof Error ? probeErr.message : probeErr
        ).replace(/\s+/g, ' ')}`
    );
    assert.equal(
      (probe as { sparring_partner?: { model?: unknown } }).sparring_partner?.model,
      '',
      "CONTROL: '' must survive parsing as '' (not be defaulted away), or the pin below cannot mean what it says"
    );

    const call = handler(h.tools);
    const first = call({ path: 'sparring_partner.model', value: 'gpt-5.6-sol' });
    assert.equal(first.previous_value, '', 'previous_value is the seed value');
    assert.equal(
      (JSON.parse(h.read()) as { sparring_partner: { model: unknown } }).sparring_partner.model,
      'gpt-5.6-sol',
      'a non-empty model lands on disk'
    );

    const back = call({ path: 'sparring_partner.model', value: '' });
    assert.equal(back.previous_value, 'gpt-5.6-sol', 'the second write reads the FIRST write back off disk');
    assert.equal(back.value, '', "'' is a legal value, not a missing-argument refusal");
    const doc = JSON.parse(h.read()) as { sparring_partner: { model: unknown } };
    assert.equal(doc.sparring_partner.model, '', "'' is written, not dropped and not coerced to a default string");
    assert.ok(
      Object.prototype.hasOwnProperty.call(doc.sparring_partner, 'model'),
      "setting '' must keep the key present — deleting it is a different document"
    );
    assert.equal(back.digest, sha256(readFileSync(h.configPath)), 'the receipt digest tracks the new bytes');
  } finally {
    h.cleanup();
  }
});
// NAMED SABOTAGE (CS-5): guard the write with a truthiness check on the value
// (`if (!value) refuse('empty value')`) — a plausible input-validation
// reflex → the `back` call throws and this pin goes RED on the missing
// exception, while CS-1 (value `false`) ALSO goes red, which is the point:
// falsy-but-legal values are one class. A sabotage red only here: `delete`
// the key when the value is '' → the hasOwnProperty assertion fires alone.

// ---------------------------------------------------------------------------
// CS-6 — whole-document schema validation. 'ten' is used rather than -1
// because a type violation is certain without reading the schema, while a
// negative-integer constraint is not (see the report's ambiguity note).
// ---------------------------------------------------------------------------
test('CS-6: a schema-invalid value on an ALLOWLISTED path is refused with a validation issue — nothing written', () => {
  const h = harness();
  try {
    const call = handler(h.tools);
    const before = h.read();
    const msg = refusalMessage(call, { path: 'delegation.max_concurrent', value: 'ten' });
    assert.match(msg, /max_concurrent/, 'the refusal names the offending key');
    assert.match(
      msg,
      /number|invalid_type/i,
      'the refusal carries the zod ISSUE (what was expected), not a bare "invalid config" — the caller has to be able to self-correct'
    );
    assert.doesNotMatch(
      msg,
      /allowlist/i,
      'this path IS allowlisted — refusing it as an allowlist violation would misreport the cause'
    );
    assert.equal(h.read(), before, 'validation happens BEFORE the write: the file is byte-identical');
  } finally {
    h.cleanup();
  }
});
// NAMED SABOTAGE (CS-6): drop the whole-document parse (write the mutated
// object straight out) → no throw, RED on the missing exception AND on the
// byte-identity assertion. SECOND, INDEPENDENT: validate but write anyway
// (validate-then-write out of order) → the throw is still absent OR the
// byte-identity assertion fires alone, distinguishing "did not validate" from
// "validated too late". THIRD: swallow the zod issues into a generic message
// → the /number|invalid_type/ assertion fires alone.

// ---------------------------------------------------------------------------
// CS-7 / CS-8 — CAS on expected_digest. CS-8 is CS-7's control arm: it must
// pass for the OPPOSITE reason (a MATCHING token writes), so CS-7's green
// cannot be satisfied by "expected_digest always refuses".
// ---------------------------------------------------------------------------
test('CS-7: a stale expected_digest is refused naming BOTH digests — nothing written', () => {
  const h = harness();
  try {
    const call = handler(h.tools);
    const before = h.read();
    const current = sha256(readFileSync(h.configPath));
    const stale = 'deadbeef'.repeat(8);
    assert.notEqual(stale, current, 'the stale token must differ from the real one for this pin to mean anything');

    const msg = refusalMessage(call, { path: 'tdd.enabled', value: false, expected_digest: stale });
    assert.match(msg, new RegExp(stale), 'the refusal quotes the digest the caller SUPPLIED');
    assert.match(msg, new RegExp(current), 'and the digest actually on disk — both, so the caller can re-read and retry');
    assert.equal(h.read(), before, 'a lost CAS writes nothing');
  } finally {
    h.cleanup();
  }
});
// NAMED SABOTAGE (CS-7): ignore expected_digest (never compare it) → no
// throw, RED on the missing exception and on byte-identity. SECOND: compare
// but report only one side ("digest mismatch") → the two digest-quoting
// assertions fire alone.

test('CS-8 CONTROL: a MATCHING expected_digest succeeds, and the receipt returns a NEW digest (never the token it was handed)', () => {
  const h = harness();
  try {
    const call = handler(h.tools);
    const expected = sha256(readFileSync(h.configPath));

    const receipt = call({ path: 'mutation_verification.enabled', value: false, expected_digest: expected });

    assert.equal(receipt.previous_value, true, 'the receipt reports what was replaced');
    assert.equal(receipt.value, false, 'and what replaced it');
    assert.notEqual(
      receipt.digest,
      expected,
      'the receipt digest is the POST-write digest — echoing expected_digest back makes the receipt a useless CAS token for the next write'
    );
    assert.equal(receipt.digest, sha256(readFileSync(h.configPath)), 'and it matches the bytes now on disk');
    assert.equal(
      (JSON.parse(h.read()) as { mutation_verification: { enabled: unknown } }).mutation_verification.enabled,
      false,
      'the write landed'
    );
  } finally {
    h.cleanup();
  }
});
// NAMED SABOTAGE (CS-8): make the digest comparison strict-unequal
// (`if (expected_digest === current) refuse(...)`, an inverted CAS) → this
// pin goes RED on the missing-write while CS-7 stays GREEN — which is exactly
// why the control exists: CS-7 alone is satisfied by an
// "expected_digest always refuses" implementation.
// SECOND: return the expected digest in the receipt → the notEqual assertion
// fires alone.

// ---------------------------------------------------------------------------
// CS-9 — a symlinked config.json is refused, target untouched. The atomic
// tmp+rename write is exactly the shape that turns a planted link into an
// arbitrary-file clobber, so the pin checks the TARGET's bytes AND that the
// link itself was not replaced by a regular file.
// ---------------------------------------------------------------------------
test('CS-9: a symlinked .sterling/config.json is refused — the link target is untouched and the link is not replaced', {
  skip:
    process.platform === 'win32'
      ? 'win32: creating a symlink requires Developer Mode or elevation, so the fixture cannot be built reliably — the destination-must-be-a-regular-file rule is pinned on POSIX only'
      : false,
}, () => {
  const h = harness();
  try {
    const call = handler(h.tools);
    const target = join(h.dir, '.sterling', 'config-real.json');
    const targetText = h.seedText;
    writeFileSync(target, targetText);
    rmSync(h.configPath);
    symlinkSync(target, h.configPath);
    assert.ok(lstatSync(h.configPath).isSymbolicLink(), 'FIXTURE: config.json is a symlink for this pin');

    const msg = refusalMessage(call, { path: 'tdd.enabled', value: false });
    assert.match(
      msg,
      /symlink|symbolic link/i,
      'the refusal states WHY: the destination must be a regular, non-symlink file'
    );
    assert.equal(readFileSync(target, 'utf8'), targetText, 'the link TARGET is byte-untouched — no write-through');
    assert.ok(
      lstatSync(h.configPath).isSymbolicLink(),
      'and the link itself is still a link — the atomic rename must not have replaced it with a regular file'
    );
  } finally {
    h.cleanup();
  }
});
// NAMED SABOTAGE (CS-9): drop the lstat/isSymbolicLink check before the write
// → the write follows (or clobbers) the link, RED on the missing exception
// and on the target-bytes assertion. SECOND, INDEPENDENT: keep the check but
// stat() instead of lstat() (which follows the link and sees a regular file)
// → same red, and it is the realistic form of this bug.

// ---------------------------------------------------------------------------
// CS-10 — registration. The served surface is the registry that matters; a
// handler nobody can call is not shipped. Both assertions here are
// repoRoot-independent: registration is static, and strict-param rejection
// happens in the SDK's schema parse before the handler runs.
// ---------------------------------------------------------------------------
test('CS-10: config_set is served on the MCP tool surface, and its params are STRICT — an extra project/path argument is rejected in-band (no foreign-project target exists)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-config-set-wire-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const { server, store } = createSterlingServer(join(dir, '.sterling', 'sterling.db'));
  const client = new Client({ name: 'config-set-test-client', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const listed = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(
      listed.includes('config_set'),
      `the §10 surface must serve 'config_set' — served: ${listed.sort().join(', ')}`
    );

    // The decision's "foreign-project target impossible" guarantee is
    // structural: there is NO path/root argument to point elsewhere, and the
    // strict-params rule (decision b47889b7) means offering one is refused
    // BY NAME rather than silently ignored.
    const bogus = await client.callTool({
      name: 'config_set',
      arguments: { path: 'tdd.enabled', value: false, project_root: '/some/other/project' },
    });
    assert.equal(bogus.isError, true, 'config_set takes NO project/path argument — offering one is rejected, never stripped');
    const text = (bogus.content as { text: string }[])[0].text;
    assert.match(text, /unrecognized_keys/, 'the refusal is a parameter-validation error, not tool logic');
    assert.match(text, /project_root/, 'and it NAMES the offending parameter');
  } finally {
    await client.close();
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
// NAMED SABOTAGE (CS-10): omit the server.registerTool/setRequestHandler entry
// for config_set (keep the class method) → the listTools assertion goes RED
// and the wire call returns a tool-not-found error, so the
// /unrecognized_keys/ assertion fires too. SECOND, INDEPENDENT: register it
// with a NON-strict zod object (drop .strict()) → listTools stays green and
// only the unrecognized-key assertions go RED.

// ---------------------------------------------------------------------------
// CS-11 — the two refusal CAUSES must stay distinguishable. delivery.* is
// allowlisted as a NAMESPACE, so an unknown delivery leaf sails past the
// allowlist and must be stopped further in.
// MECHANISM RULED (review round 2, and it CHANGED): the leaf is refused by a
// KNOWN-DELIVERY-KEY MEMBERSHIP CHECK IN THE TOOL — not by a strict schema.
// The schema must stay permissive so a newer machine's config.json still
// parses on an older clone (pinned as CS-20), which leaves strictness
// unavailable as the mechanism here. CS-19 pins the message content that
// ruling implies: the refusal ENUMERATES the known delivery keys.
// This pin keeps the verdict + the distinct cause; CS-19 carries the wording.
// ---------------------------------------------------------------------------
test('CS-11: a known delivery key is written; an UNKNOWN delivery leaf is refused by the tool\'s known-key check, not by the allowlist (the causes stay distinct)', () => {
  const h = harness();
  try {
    // CONTROL, opposite reason: the schema really does define this leaf.
    let probe: unknown;
    let probeErr: unknown;
    try {
      probe = parseConfig({ delivery: { payload_char_cap: 4321 } });
    } catch (e) {
      probeErr = e;
    }
    assert.equal(
      probeErr,
      undefined,
      'CONTROL: the canonical config schema must define delivery.payload_char_cap (decision 1dc3f9aa names it). ' +
        `parseConfig threw: ${String(probeErr instanceof Error ? probeErr.message : probeErr).replace(/\s+/g, ' ')}`
    );
    assert.equal(
      (probe as { delivery?: { payload_char_cap?: unknown } }).delivery?.payload_char_cap,
      4321,
      'CONTROL: the value survives parsing, so delivery.payload_char_cap is a real settable key'
    );

    const call = handler(h.tools);
    const okReceipt = call({ path: 'delivery.payload_char_cap', value: 4321 });
    assert.equal(okReceipt.value, 4321, 'an allowlisted delivery.<defined key> is written');
    assert.equal(
      (JSON.parse(h.read()) as { delivery: { payload_char_cap: unknown } }).delivery.payload_char_cap,
      4321,
      'and it lands on disk'
    );
    const allowedMsgFree = h.read();

    const msg = refusalMessage(call, { path: 'delivery.not_a_real_delivery_key', value: 1 });
    assert.match(msg, /not_a_real_delivery_key/, 'the refusal names the offending leaf');
    assert.doesNotMatch(
      msg,
      /allowlist/i,
      "delivery.* IS allowlisted — this refusal must come from the tool's KNOWN-DELIVERY-KEY check, and its message must not blame the allowlist " +
        '(two causes, two messages: a caller told "not allowlisted" would stop trying delivery keys altogether)'
    );
    assert.equal(h.read(), allowedMsgFree, 'the unknown-key refusal wrote nothing — the prior valid write is intact');
  } finally {
    h.cleanup();
  }
});
// NAMED SABOTAGE (CS-11): delete the known-delivery-key membership check and
// rely on the schema (which CS-20 pins as permissive) → the unknown leaf is
// written, RED on the missing exception. SECOND, INDEPENDENT: refuse it from
// the allowlist arm instead (enumerate delivery leaves IN
// CONFIG_SET_ALLOWLIST and report 'allowlist') → the throw stays, the first
// half of this pin stays green, and only the doesNotMatch(/allowlist/i)
// assertion goes RED — the cause-conflation this pin exists to catch. Note
// that second sabotage ALSO reddens CS-12 (the set would no longer equal the
// decision's); the verdict CS-11 uniquely carries is the MESSAGE'S CAUSE.

const SKIP_SYMLINK =
  process.platform === 'win32'
    ? 'win32: creating a symlink requires Developer Mode or elevation, so the fixture cannot be built reliably — this containment rule is pinned on POSIX only'
    : false;
const SKIP_MODE =
  process.platform === 'win32' ? 'win32: POSIX mode bits are not modelled by the filesystem' : false;

function rx(literal: string): RegExp {
  return new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

// ---------------------------------------------------------------------------
// CS-13 — PROTOTYPE POISONING. `delivery.__proto__` passes the allowlist as a
// delivery namespace path, and `models.<key>` admits ARBITRARY key names by
// design, so `models.constructor` cannot be refused by a known-key list at
// all. A dotted-path setter written as a reduce-and-assign walk turns both
// into prototype writes.
// ---------------------------------------------------------------------------
test('CS-13: __proto__ / constructor key paths are refused on every namespace — no receipt, no bytes changed, no prototype touched', () => {
  const h = harness();
  try {
    const call = handler(h.tools);
    const before = h.read();
    for (const path of ['delivery.__proto__', 'tdd.__proto__', 'models.constructor']) {
      const msg = refusalMessage(call, { path, value: { polluted: true } });
      const segment = path.split('.')[1];
      assert.match(msg, rx(segment), `the refusal names the poisoning segment ('${segment}') for path '${path}'`);
      assert.equal(h.read(), before, `'${path}' wrote nothing — the file is byte-identical`);
    }
    const probe = {} as Record<string, unknown>;
    assert.equal(
      probe.polluted,
      undefined,
      'no Object.prototype pollution happened even in memory — a refusal AFTER the assignment is not a refusal'
    );
    assert.equal(({}).constructor, Object, 'Object.prototype.constructor is intact');
    assert.ok(!h.read().includes('__proto__'), 'and no literal "__proto__" key was materialized in the document');
  } finally {
    h.cleanup();
  }
});
// NAMED SABOTAGE (CS-13): implement the setter as the obvious walk —
// `const segs = path.split('.'); let o = doc; for (const s of segs.slice(0,-1)) o = o[s];
// o[segs.at(-1)] = value;` with no unsafe-segment guard → `delivery.__proto__`
// no longer throws (RED on the missing exception) and the in-memory pollution
// assertion fires too. LOAD-BEARING NOTE: the `models.constructor` arm is the
// one no other guard can carry — the allowlist admits `models.<any key>` and a
// known-key list is impossible there, so ONLY an unsafe-segment check saves
// it. Guarding just `__proto__` (a common half-fix) leaves that arm RED.

// ---------------------------------------------------------------------------
// CS-14 — AN OMITTED VALUE MUST NOT DELETE THE KEY. `JSON.stringify` drops a
// property whose value is `undefined`, so a setter that assigns args.value
// without a presence check turns a malformed call into SILENT DATA LOSS that
// still validates (the key is optional) and still reports success.
// ---------------------------------------------------------------------------
test('CS-14: an omitted / undefined `value` is refused — the addressed key stays present with its old value', () => {
  const h = harness();
  try {
    const call = handler(h.tools);
    const before = h.read();
    // Both shapes are distinguishable on the class surface; over the MCP wire
    // the strict param schema refuses the omission before the handler runs
    // (CS-10's arm), so this pin lives at the unit surface deliberately.
    const shapes: CallArgs[] = [
      { path: 'sparring_partner.model' } as unknown as CallArgs,
      { path: 'sparring_partner.model', value: undefined },
    ];
    for (const args of shapes) {
      const msg = refusalMessage(call, args);
      assert.match(msg, /value/i, 'the refusal names the missing/undefined parameter');
      assert.equal(h.read(), before, 'nothing written');
    }
    const doc = JSON.parse(h.read()) as { sparring_partner: Record<string, unknown> };
    assert.ok(
      Object.prototype.hasOwnProperty.call(doc.sparring_partner, 'model'),
      'the key is STILL PRESENT — assigning undefined would erase it at serialization time while the document still validates'
    );
    assert.equal(doc.sparring_partner.model, '', 'and keeps its previous value');
  } finally {
    h.cleanup();
  }
});
// NAMED SABOTAGE (CS-14): drop the presence check —
// `parent[leaf] = args.value;` unconditionally → no throw (RED on the missing
// exception) and the hasOwnProperty assertion fires as well, which is the
// pin's point: the two reds together say "accepted AND destroyed", not merely
// "accepted". A refusal that reports success without writing would redden
// only the first assertion.

// ---------------------------------------------------------------------------
// CS-15 — review_ledger: ONE allowlisted leaf beside a FORBIDDEN sibling
// under the same parent. Value validation and allowlist scope are different
// axes and this pin exercises both on one object.
// ---------------------------------------------------------------------------
test('CS-15: review_ledger.stale_days validates its value (30 lands, \'ten\' refused) while its sibling review_ledger.code_globs stays allowlist-refused', () => {
  const h = harness();
  try {
    const call = handler(h.tools);
    const before = h.read();

    const badValue = refusalMessage(call, { path: 'review_ledger.stale_days', value: 'ten' });
    assert.match(badValue, /stale_days/, 'the refusal names the key');
    assert.match(badValue, /number|invalid_type/i, 'and carries the zod issue');
    assert.doesNotMatch(badValue, /allowlist/i, 'this leaf IS allowlisted — blaming the allowlist would misreport the cause');
    assert.equal(h.read(), before, 'nothing written');

    // Same parent, NON-allowlisted leaf: review_ledger.code_globs governs which
    // commits the merge gate treats as code-touching — gate-defining, excluded
    // by decision 1dc3f9aa.
    const forbidden = refusalMessage(call, { path: 'review_ledger.code_globs', value: ['**/*.ts'] });
    assert.match(forbidden, rx('review_ledger.code_globs'), 'the refusal names the path');
    assert.match(forbidden, /allowlist/i, 'and blames the ALLOWLIST — a different cause from the value refusal above');
    assert.equal(h.read(), before, 'nothing written');

    const receipt = call({ path: 'review_ledger.stale_days', value: 30 });
    assert.equal(receipt.previous_value, 14, 'the seed value is reported back');
    assert.equal(
      (JSON.parse(h.read()) as { review_ledger: { stale_days: unknown } }).review_ledger.stale_days,
      30,
      'a valid numeric value lands'
    );
    assert.equal(receipt.digest, sha256(readFileSync(h.configPath)), 'and the receipt digest tracks the new bytes');
  } finally {
    h.cleanup();
  }
});
// NAMED SABOTAGE (CS-15): allowlist the PARENT namespace instead of the leaf
// (`'review_ledger.*'`) → the code_globs arm loses its refusal, RED on the
// missing exception, and CS-12's set-equality fires too (defence in depth).
// A sabotage RED ONLY HERE: skip validation when the value is a primitive
// (`if (typeof value !== 'object') writeWithoutValidating()`) → 'ten' lands,
// this pin's first arm goes red while CS-6 (also a primitive) goes red too —
// so the arm unique to this pin is the sibling-leaf discrimination.
// NOT PINNED: `stale_days: -1`. Whether the schema constrains it to a
// positive integer is unverifiable from behind the H4 read wall; 'ten' is a
// certain type violation. If -1 should be refused, that is schema hardening
// and needs its own pin plus a schema change.

// ---------------------------------------------------------------------------
// CS-16 — models.<key> is allowlisted, so the VALUE is the only thing left to
// check. A malformed model entry that lands silently is the
// [94f16632] shape: recorded policy reverted by a write that reported success.
// ---------------------------------------------------------------------------
test('CS-16: models.coder with a malformed value (an extra key on the entry) is refused by document validation — nothing written', () => {
  const h = harness();
  try {
    const malformed = { model: 'sonnet', effort: 'high', junk: 1 };
    // CONTROL, opposite reason: the SCHEMA must consider this value invalid,
    // whatever the real shape of a models entry is (object-with-effort or a
    // bare string — both refuse this).
    let controlErr: unknown;
    try {
      parseConfig({ models: { coder: malformed } });
    } catch (e) {
      controlErr = e;
    }
    assert.ok(
      controlErr !== undefined,
      'CONTROL: the canonical config schema must REFUSE a models entry carrying an unmodeled key. If it accepts it, models is a ' +
        'free-form record and this pin must be repointed (the value would then be the schema\'s business, not config_set\'s) — ' +
        'the test-writer cannot read packages/schemas/src/config.ts (H4)'
    );

    const call = handler(h.tools);
    const before = h.read();
    const msg = refusalMessage(call, { path: 'models.coder', value: malformed });
    assert.match(msg, /coder/, 'the refusal names the entry it refused');
    assert.doesNotMatch(msg, /allowlist/i, 'models.<key> IS allowlisted — the cause here is the VALUE, and the message must say so');
    assert.equal(h.read(), before, 'nothing written');
  } finally {
    h.cleanup();
  }
});
// NAMED SABOTAGE (CS-16): validate only the SET LEAF against a per-key schema
// instead of re-validating the WHOLE resulting document (`modelEntrySchema
// .partial().parse(value)`, or no value check at all) → the malformed entry
// lands, RED on the missing exception and on the byte-identity assertion.
// LOAD-BEARING NOTE vs CS-6: CS-6's bad value is a PRIMITIVE on a scalar
// field, which almost any check catches; this pin's value is a well-shaped
// OBJECT with one extra key, which only whole-document validation catches.

// ---------------------------------------------------------------------------
// CS-17 — A DANGLING SYMLINK IS THE HOLE IN THE SPEC'S OWN WORDING. The
// destination must be "a regular non-symlink file, OR ABSENT beneath an
// existing .sterling" — and a dangling symlink LOOKS ABSENT to
// existsSync()/stat(), which follow the link. A tmp+rename write then creates
// the attacker-chosen target.
// ---------------------------------------------------------------------------
test('CS-17: a DANGLING symlinked config.json is refused — no file is created at the link target and the link is not replaced', { skip: SKIP_SYMLINK }, () => {
  const h = harness();
  try {
    const call = handler(h.tools);
    const target = join(h.dir, 'planted-target.json');
    rmSync(h.configPath);
    symlinkSync(target, h.configPath);
    assert.ok(lstatSync(h.configPath).isSymbolicLink(), 'FIXTURE: config.json is a symlink');
    assert.ok(!existsSync(target), 'FIXTURE: and its target does not exist — the link dangles, so stat() reports "absent"');

    const msg = refusalMessage(call, { path: 'tdd.enabled', value: false });
    assert.match(msg, /symlink|symbolic link/i, 'the refusal states the containment reason, not "config.json not found"');
    assert.ok(
      !existsSync(target),
      'THE PIN: nothing was created at the link target — "absent beneath an existing .sterling" must be decided by lstat, ' +
        'never by a call that follows the link'
    );
    assert.ok(lstatSync(h.configPath).isSymbolicLink(), 'and the dangling link itself is untouched');
  } finally {
    h.cleanup();
  }
});
// NAMED SABOTAGE (CS-17): implement the destination check as
// `if (existsSync(p) && !lstatSync(p).isFile()) refuse()` — i.e. only
// validate what EXISTS, taking the absent branch for a dangling link → the
// write proceeds through the link, RED on the missing exception AND on the
// no-file-at-target assertion. CS-9 stays GREEN under that sabotage (its link
// resolves to a real file), which is precisely why this pin exists beside it.

// ---------------------------------------------------------------------------
// CS-18 — CONTAINMENT ONE LEVEL UP: the ANCESTOR .sterling directory is a
// symlink. Checking only config.json's own lstat leaves the whole "never a
// foreign project" guarantee resting on a directory the tool never inspected
// (cf. [two-predicates-two-name-grammars-path-containment-drifts-apart]).
// ---------------------------------------------------------------------------
test('CS-18: a symlinked .sterling DIRECTORY is refused — nothing is written into the link target', { skip: SKIP_SYMLINK }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-config-set-dirlink-'));
  const storeDir = mkdtempSync(join(tmpdir(), 'sterling-config-set-dirlink-store-'));
  const store = new SterlingStore(join(storeDir, 'sterling.db'));
  try {
    const realSterling = join(dir, 'elsewhere-sterling');
    mkdirSync(realSterling, { recursive: true });
    const targetConfig = join(realSterling, 'config.json');
    const targetText = JSON.stringify(seedDoc(), null, 2);
    writeFileSync(targetConfig, targetText);
    symlinkSync(realSterling, join(dir, '.sterling'), 'dir');
    assert.ok(lstatSync(join(dir, '.sterling')).isSymbolicLink(), 'FIXTURE: .sterling is a directory symlink');

    const tools = new SterlingTools({ store, repoRoot: dir, now: () => NOW });
    const call = handler(tools);
    const msg = refusalMessage(call, { path: 'tdd.enabled', value: false });
    assert.match(
      msg,
      /symlink|symbolic link|outside|contain/i,
      'the refusal states a CONTAINMENT reason — the canonical .sterling must resolve inside the active project, not through a link'
    );
    assert.equal(readFileSync(targetConfig, 'utf8'), targetText, 'the link target is byte-untouched');
    assert.ok(lstatSync(join(dir, '.sterling')).isSymbolicLink(), 'and the directory link is intact');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(storeDir, { recursive: true, force: true });
  }
});
// NAMED SABOTAGE (CS-18): check only the FILE (`lstatSync(configPath)`) and
// not its ancestor — the shipped-in-CS-9 guard, unextended → the write lands
// inside the foreign directory, RED on the missing exception and on the
// target-bytes assertion. CS-9 and CS-17 both stay GREEN under it.
// SPEC NOTE: decision 1dc3f9aa names the FILE ("the destination must be a
// regular non-symlink file"); the DIRECTORY case is this review round's
// extension of the same "never a foreign project" guarantee, and it needs a
// realpath containment check on the .sterling ancestor rather than one more
// lstat. Flagged to the conductor as a spec extension, not an inference.

// ---------------------------------------------------------------------------
// CS-19 — THE REFUSAL TEACHES. Because the unknown delivery leaf is stopped
// by an in-tool membership check (CS-11's ruling) rather than by the schema,
// the tool is the only thing that knows the legal set — so it must SAY it.
// ---------------------------------------------------------------------------
test('CS-19: the unknown-delivery-leaf refusal ENUMERATES the known delivery keys and never says \'allowlist\'', () => {
  const h = harness();
  try {
    const call = handler(h.tools);
    const before = h.read();
    const msg = refusalMessage(call, { path: 'delivery.not_a_real_delivery_key', value: 1 });

    assert.match(msg, /not_a_real_delivery_key/, 'the refusal names what was asked for');
    assert.match(
      msg,
      /payload_char_cap/,
      'and ENUMERATES the known delivery keys — the caller cannot discover them from the schema (CS-20: unknown keys parse fine), ' +
        'so a refusal that does not list them leaves the caller guessing'
    );
    assert.match(msg, /injection_rung/, 'the enumeration is the real set, not one example key');
    assert.doesNotMatch(
      msg,
      /allowlist/i,
      'delivery.* IS allowlisted — naming the allowlist here would send the caller to a decision record instead of to the key list'
    );
    assert.equal(h.read(), before, 'nothing written');
  } finally {
    h.cleanup();
  }
});
// NAMED SABOTAGE (CS-19): shorten the refusal to
// `unknown delivery key '<leaf>'` (drop the enumeration) → the throw and the
// leaf-naming assertion stay GREEN and only the two enumeration assertions go
// RED. That is the whole verdict this pin carries; CS-11 covers the refusal
// itself and the cause, and stays green under this sabotage.
// ASSUMPTION STATED: `payload_char_cap` and `injection_rung` are named as
// delivery keys by decision 1dc3f9aa and by CLAUDE.md's delivery section
// respectively. If the schema has since renamed one, this pin repoints to the
// shipped names — it is asserting THAT the set is enumerated, using two keys
// known from the spec as the probe.

// ---------------------------------------------------------------------------
// CS-21 — the atomic tmp+rename write must not silently RELAX permissions. A
// config.json a consumer deliberately closed to 0600 coming back 0644 is a
// disclosure regression no functional pin would notice.
// ---------------------------------------------------------------------------
test('CS-21: a successful config_set preserves the existing file mode (0o600 stays 0o600)', { skip: SKIP_MODE }, () => {
  const h = harness();
  try {
    const call = handler(h.tools);
    chmodSync(h.configPath, 0o600);
    assert.equal(statSync(h.configPath).mode & 0o777, 0o600, 'FIXTURE: the config starts at 0o600');

    const receipt = call({ path: 'tdd.enabled', value: false });
    assert.equal(receipt.value, false, 'CONTROL: the write actually succeeded — a refusal would preserve the mode trivially');
    assert.equal(
      statSync(h.configPath).mode & 0o777,
      0o600,
      'the replacement file carries the ORIGINAL mode — a tmp file written at the default 0o644 and renamed over the target ' +
        'silently widens who can read the config'
    );
  } finally {
    h.cleanup();
  }
});
// NAMED SABOTAGE (CS-21): write the temp file with plain
// `writeFileSync(tmp, text)` and rename it, without carrying the original
// mode (`chmodSync(tmp, statSync(target).mode & 0o777)` or
// `{ mode }`) → the file comes back 0o644 and this pin goes RED on the mode
// assertion alone; every other pin in this file stays green, since the bytes
// and the receipt are correct. The `receipt.value` assertion is the control
// arm: it distinguishes "mode preserved because nothing was written" from
// "mode preserved across a real replacement".

// ---------------------------------------------------------------------------
// CS-22 — THE RESIDUAL RACE IS DISCLOSED, NOT CLOSED. expected_digest is CAS
// over a read-then-write window; a writer landing INSIDE that window is not
// prevented by it. The tool exposes no injectable seam between its read and
// its write, so TRUE INTERLEAVING IS NOT PINNED HERE — what is pinned is
// (a) the control that a matching token succeeds, and (b) that the tool's own
// DESCRIPTION discloses the window, so a caller building on config_set is
// never told it has a lock it does not have (disclose-limitations).
// ---------------------------------------------------------------------------
test('CS-22: expected_digest is CAS over a read-then-write window — a matching token succeeds, and the served tool DESCRIPTION discloses the residual race', async () => {
  // (a) CONTROL, in-process: a token matching the CURRENT bytes writes.
  const h = harness();
  try {
    const call = handler(h.tools);
    const receipt = call({
      path: 'delivery.payload_char_cap',
      value: 4321,
      expected_digest: sha256(readFileSync(h.configPath)),
    });
    assert.equal(receipt.value, 4321, 'CONTROL: a matching expected_digest is accepted, not treated as a conflict');
    assert.equal(receipt.digest, sha256(readFileSync(h.configPath)), 'and the receipt hands the NEXT caller a usable token');
  } finally {
    h.cleanup();
  }

  // (b) THE DISCLOSURE, on the served surface where a caller actually reads it.
  const dir = mkdtempSync(join(tmpdir(), 'sterling-config-set-race-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  const { server, store } = createSterlingServer(join(dir, '.sterling', 'sterling.db'));
  const client = new Client({ name: 'config-set-race-client', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const tool = (await client.listTools()).tools.find((t) => t.name === 'config_set');
    assert.ok(tool, "config_set must be served for its description to be readable (see CS-10)");
    const description = tool?.description ?? '';
    assert.match(
      description,
      /expected_digest/,
      'the description names the CAS parameter — a caller cannot use a concurrency control it is not told about'
    );
    assert.match(
      description,
      /rac|concurrent|interleav|between the read|window|last write wins/i,
      'and DISCLOSES that expected_digest narrows but does not eliminate the read-then-write window — an undisclosed residual ' +
        'race reads to the caller as a lock (disclose-limitations, and the TUI writes this same file via config-writeback.ts)'
    );
  } finally {
    await client.close();
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
// NAMED SABOTAGE (CS-22): delete the race sentence from the tool's
// description string (leave the behaviour untouched) → the disclosure
// assertion goes RED alone, while the CAS control and every other pin stay
// green. SECOND: describe the parameter as a "lock" and drop
// 'expected_digest' from the text → the first description assertion fires.
// WHAT THIS PIN DOES NOT PIN, stated so nobody reads it as more than it is:
// an actual interleaved write. Closing that needs either an injectable seam
// (a `now`-style hook between read and write) or an O_EXCL/flock write path;
// both are implementation changes, and if either ships, replace this pin's
// (b) arm with a real interleaving test rather than adding to it.
