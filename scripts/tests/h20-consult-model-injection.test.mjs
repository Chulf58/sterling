// H20 consult MODEL INJECTION — config.sparring_partner.model is filled in
// MECHANICALLY on every codex consult that omits a model (board 7423f7a2 slice 5;
// decision 8b329d57 'codex-resumed-pinned-gpt-5-6-sol-server-side' as CORRECTED
// FORWARD — the server-side `-c model=` pin was REJECTED and reverted, the
// per-call `model` parameter filled by H20's PreToolUse arm is the mechanism that
// ships; decision ea68735d 'sparring-partner-partnership-shape' points 3/7/8;
// decision 2d19ac0c 'consult-carriage-h20-codex-seam'; research_finding be284452
// 'sparring-partner-model-and-enabled-are-prose-only...').
//
// SPEC-ONLY ORACLE. Written blind, from the board item + the decisions above.
// No implementation file was read; the harness idiom (spawnSync the hook with a
// PreToolUse JSON payload on stdin, a fixture project dir carrying .sterling/ +
// a SterlingStore, stdout parsed as one JSON envelope, context delivered on
// hookSpecificOutput.additionalContext) is copied from the SIBLING TEST
// scripts/tests/h20-consult-carriage.test.mjs — conventions only, no assertions.
//
// THE ORACLE, restated as the behaviour these pins own:
//   • config.sparring_partner.model is the SOURCE. Nothing read it before
//     (be284452: zero files under scripts/hooks/ read sparring_partner), which
//     IS the defect — "it just says default and doesn't work".
//   • On mcp__codex__codex, when the call OMITS model, H20 returns
//     hookSpecificOutput.updatedInput = the tool_input with model filled from
//     config. An explicit call-site model WINS and is never overwritten.
//   • NEVER on mcp__codex__codex-reply — that tool's schema has no model field;
//     a thread inherits its opener's model (be284452, tool contract).
//   • The value is a FREE non-empty string, injected VERBATIM — no validation,
//     no quoting (codex validates server-side with a loud 400; no shell/TOML
//     boundary exists on this route).
//   • enabled:false is ADVISORY (ea68735d point 3) — a loud disclosure line,
//     NEVER a deny, and it does NOT suppress the model (enablement and model
//     selection are separate axes).
//   • Config absent / malformed / model empty → inject nothing, disclose,
//     exit 0, never deny (P5 degraded-loud).
//   • THE PLACEMENT PIN (M-6, the Codex-flagged risk): the injection is the
//     FIRST step, ahead of every one of H20's relevance early-exits, and is
//     composed into EVERY output path. A consult whose prompt is empty/absent
//     or carries too few axis terms is exactly the shape that exits early with
//     no context today — and it must STILL be pinned to the configured model.
//
// KNOWN COLLISION, for the conductor (this file does not and may not fix it):
// scripts/tests/h20-consult-carriage.test.mjs:229 'INERT: a codex tool_name with
// no prompt field at all is ignored — exit 0, no crash, no context' asserts
// stdout === '' for the absent-prompt shape. M-6 below asserts the OPPOSITE for
// that same shape, deliberately — board 7423f7a2 states that pin "legitimately
// inverts to 'exit 0 + only the pin line'". The implementation lane must update
// that sibling assertion; it is not weakened or touched from here.
//
// SABOTAGE DISCIPLINE (decision 'a-ruling-change-is-verified-by-mutation-not-by-
// a-green-suite'): every test carries the ONE-LINE implementation change that
// must turn it RED. Absence-shaped verdicts ("no model injected") carry an
// in-test CONTROL arm that must pass for the OPPOSITE reason, so a green never
// means "injection is broken everywhere".
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

/** The value pinned on this machine by decision 8b329d57. */
const PINNED = 'gpt-5.6-sol';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function runHook(input, cwd) {
  const r = spawnSync(process.execPath, [join(HOOKS, 'h20-mechanism-axis.mjs')], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * Fixture project. `config` may be an object (JSON-stringified), a raw string
 * (written verbatim — used for the malformed-JSON arm), or null (no
 * .sterling/config.json written at all — the absent arm).
 */
function makeProject(config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h20-model-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  if (config !== null) {
    writeFileSync(join(dir, '.sterling', 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  }
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  return { dir, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** config.json body carrying a sparring_partner block; `model` omitted when undefined. */
function cfg({ enabled = true, model } = {}) {
  const sparring_partner = { enabled };
  if (model !== undefined) sparring_partner.model = model;
  return { sparring_partner };
}

function consult(dir, tool_input, tool_name = 'mcp__codex__codex') {
  return { hook_event_name: 'PreToolUse', tool_name, tool_input, session_id: 's1', cwd: dir };
}

/**
 * Universal output contract, asserted on EVERY arm (M-9): exit 0, never a
 * block/deny, and stdout is either empty or exactly one JSON envelope.
 * Returns the parsed envelope, or null when stdout is empty.
 */
function envelopeOf(r, what) {
  assert.equal(r.code, 0, `${what}: H20 must never deny a consult — exit ${r.code}; stderr: ${r.stderr.slice(0, 400)}`);
  if (r.stdout.trim() === '') return null;
  let obj;
  try {
    obj = JSON.parse(r.stdout);
  } catch {
    assert.fail(`${what}: stdout must be a single valid JSON envelope, got: ${r.stdout.slice(0, 400)}`);
  }
  assert.notEqual(obj.decision, 'block', `${what}: a consult is never blocked (ea68735d point 3 — advisory, never gating)`);
  assert.notEqual(
    obj?.hookSpecificOutput?.permissionDecision,
    'deny',
    `${what}: a consult is never denied (ea68735d point 3 — advisory, never gating)`,
  );
  return obj;
}

/** The injected model, or undefined when no `model` key was written into updatedInput. */
function injectedModel(obj) {
  const ui = obj?.hookSpecificOutput?.updatedInput;
  if (!ui || typeof ui !== 'object') return undefined;
  return Object.prototype.hasOwnProperty.call(ui, 'model') ? ui.model : undefined;
}

/**
 * The user-visible disclosure text. The harness convention (sibling carriage
 * test, and decision 2d19ac0c) is hookSpecificOutput.additionalContext; the
 * top-level systemMessage is folded in so a disclosure routed to the other
 * user-visible channel is not a false red. The CHANNEL itself is pinned once,
 * in the CONTROL arm below.
 */
function disclosure(obj) {
  const h = obj?.hookSpecificOutput ?? {};
  return [h.additionalContext, obj?.systemMessage].filter((s) => typeof s === 'string').join('\n');
}

// ===========================================================================
// M-C0 — CONTROL ARM, FIRST. Everything below asserts against a baseline of
// "injection demonstrably works in this fixture"; without this arm, an absence
// verdict ("no model injected") has two possible causes and cannot tell the
// intended rule apart from an injection path that never runs at all.
// ===========================================================================

// SABOTAGE: in the injection step, read `sp.modelId` instead of `sp.model`
// (one identifier) — nothing is injected and this arm goes red.
test('M-C0 CONTROL: a codex consult that omits model gets config.sparring_partner.model injected via updatedInput, prompt preserved, and the disclosure names config as the source', () => {
  const { dir, cleanup } = makeProject(cfg({ enabled: true, model: PINNED }));
  try {
    const r = runHook(consult(dir, { prompt: 'x' }), dir);
    const obj = envelopeOf(r, 'M-C0');
    assert.ok(obj, 'M-C0: the pin line is always emitted for a codex consult — stdout must not be empty');

    assert.equal(
      obj.hookSpecificOutput?.hookEventName,
      'PreToolUse',
      'the envelope declares the PreToolUse event (the only shape Claude Code applies updatedInput from)',
    );
    const ui = obj.hookSpecificOutput?.updatedInput;
    assert.ok(ui && typeof ui === 'object', 'hookSpecificOutput.updatedInput is returned for a model-less codex consult');
    assert.equal(ui.model, PINNED, 'the configured model is filled into the call — this is the whole defect: nothing consumed the value before (be284452)');
    assert.equal(ui.prompt, 'x', 'updatedInput REPLACES the tool input, so every original field survives — a dropped prompt would send an empty consult');

    // The disclosure CHANNEL is pinned here once (harness convention:
    // hookSpecificOutput.additionalContext — sibling carriage test, 2d19ac0c).
    const ctx = obj.hookSpecificOutput?.additionalContext;
    assert.equal(typeof ctx, 'string', 'the disclosure rides additionalContext, the same channel H20 already uses for consult carriage');
    assert.match(ctx, /gpt-5\.6-sol/, 'the disclosure names the model actually being used, so the conductor can see it in the transparency summary (ea68735d point 9)');
    assert.match(ctx, /config/i, 'the disclosure names WHERE the model came from — config, not a call-site argument and not the CLI default');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// M-1 — an explicit call-site model WINS; config never overwrites it.
// ===========================================================================

// SABOTAGE: drop the "call omits model" guard (`if (callModel == null)` →
// unconditional assignment) — the config value overwrites 'gpt-5.5' and this
// arm goes red on the updatedInput assertion.
test('M-1: an explicit call-site model wins over the configured one — never overwritten — and the disclosure says the call-site value won', () => {
  const { dir, cleanup } = makeProject(cfg({ enabled: true, model: PINNED }));
  try {
    // CONTROL (opposite reason, same fixture): the SAME config, with the model
    // omitted from the call, DOES inject — so a green below means "explicit
    // wins", never "this fixture never injects anything".
    const ctl = envelopeOf(runHook(consult(dir, { prompt: 'x' }), dir), 'M-1 control');
    assert.equal(injectedModel(ctl), PINNED, 'M-1 control: with model omitted, config still injects in this very fixture');

    const r = runHook(consult(dir, { prompt: 'x', model: 'gpt-5.5' }), dir);
    const obj = envelopeOf(r, 'M-1');
    const injected = injectedModel(obj);
    assert.ok(
      injected === undefined || injected === 'gpt-5.5',
      `an explicit call-site model is left alone: either no updatedInput.model at all, or the caller's own value — got ${JSON.stringify(injected)}`,
    );
    assert.notEqual(injected, PINNED, 'the configured model must NEVER clobber an explicit call-site model');

    const ctx = disclosure(obj);
    assert.match(ctx, /gpt-5\.5/, 'the disclosure names the model that actually goes out — the call-site one');
    assert.match(
      ctx,
      /explicit|call-site|call site|caller|already|overrid|wins/i,
      'the disclosure says WHICH source won, so a conductor reading it can tell an override apart from a config pin',
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// M-2 — no model configured: nothing injected, and the CLI default is disclosed.
// ===========================================================================

// SABOTAGE: replace the config read with a literal (`const model = 'gpt-5.6-sol'`)
// — an unconfigured project starts injecting and this arm goes red.
test('M-2: sparring_partner with no model key injects nothing and discloses that the Codex CLI default applies', () => {
  const { dir, cleanup } = makeProject(cfg({ enabled: true }));
  const set = makeProject(cfg({ enabled: true, model: PINNED }));
  try {
    const obj = envelopeOf(runHook(consult(dir, { prompt: 'x' }), dir), 'M-2');
    assert.equal(injectedModel(obj), undefined, 'an unset model injects NOTHING — Sterling never invents a model id the user did not choose');

    // CONTROL (opposite reason): an otherwise identical project WITH a model
    // set does inject, so the absence above is the rule and not a dead path.
    const ctl = envelopeOf(runHook(consult(set.dir, { prompt: 'x' }), set.dir), 'M-2 control');
    assert.equal(injectedModel(ctl), PINNED, 'M-2 control: the only difference is the config value, and it does inject');

    assert.match(
      disclosure(obj),
      /CLI default/i,
      "the unset state is disclosed in the same words the System tab shows ('(CLI default)', state.ts row placeholder) — silence here is how 'it just says default and doesn't work' happened",
    );
  } finally {
    cleanup();
    set.cleanup();
  }
});

// ===========================================================================
// M-3 — an EMPTY-STRING model is the TUI's clear-to-unset signal, not a value.
// ===========================================================================

// SABOTAGE: test the config value for presence rather than non-emptiness
// (`sp.model !== undefined` instead of a non-empty-string check) — '' gets
// injected as a model id and this arm goes red.
test("M-3: model:'' is treated as UNSET (the System tab's clear-to-unset commit) — nothing injected, CLI default disclosed", () => {
  const { dir, cleanup } = makeProject(cfg({ enabled: true, model: '' }));
  const set = makeProject(cfg({ enabled: true, model: PINNED }));
  try {
    const obj = envelopeOf(runHook(consult(dir, { prompt: 'x' }), dir), 'M-3');
    const injected = injectedModel(obj);
    assert.notEqual(injected, '', "an empty string is never sent as a model id — codex would 400 on it; '' is the clear signal (sparring-partner.test.ts item 6)");
    assert.equal(injected, undefined, 'no model key is written into updatedInput at all for an empty configured value');

    // CONTROL (opposite reason): same shape, non-empty value, injects.
    const ctl = envelopeOf(runHook(consult(set.dir, { prompt: 'x' }), set.dir), 'M-3 control');
    assert.equal(injectedModel(ctl), PINNED, 'M-3 control: a non-empty value in the same field does inject');

    assert.match(disclosure(obj), /CLI default/i, "an empty model discloses exactly like an absent one — the two are one state");
  } finally {
    cleanup();
    set.cleanup();
  }
});

// ===========================================================================
// M-4 — enabled:false is ADVISORY and is a SEPARATE AXIS from model selection.
// ===========================================================================

// SABOTAGE: gate the injection on the toggle (`if (!sp.enabled) return;` above
// the injection step) — the model disappears while OFF and this arm goes red on
// the updatedInput assertion. Second sabotage for the other half: return exit 2
// / a deny when enabled is false — red on the exit-code assertion.
test('M-4: sparring_partner.enabled:false stays ADVISORY — exit 0, never a deny, a loud OFF disclosure, AND the configured model is still injected (enablement and model selection are not conflated)', () => {
  const { dir, cleanup } = makeProject(cfg({ enabled: false, model: PINNED }));
  try {
    const r = runHook(consult(dir, { prompt: 'x' }), dir);
    assert.equal(r.code, 0, 'ea68735d point 3: ADVISORY, NEVER GATING — an OFF toggle must not become exit 2 (decision 8b329d57 rejected the hard-deny option by name)');
    const obj = envelopeOf(r, 'M-4');
    assert.ok(obj, 'M-4: an OFF project still gets the disclosure envelope — the toggle becomes VISIBLE, which is the point');

    const ctx = disclosure(obj);
    assert.match(ctx, /\bOFF\b|disabled|not enabled|turned off/i, 'the OFF state is stated LOUDLY at consult time (be284452 measured eleven consults under enabled:false with nothing said)');
    assert.match(ctx, /sparring|codex/i, 'the OFF line names WHAT is off, so the reader can act on it');

    assert.equal(
      injectedModel(obj),
      PINNED,
      'the model is STILL injected while OFF: the toggle governs whether Sterling initiates consults, not which model an explicit user-asked consult lands on (ea68735d point 7 — an explicit user ask still works)',
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// M-5 — codex-reply carries no `model` field in its tool schema.
// ===========================================================================

// SABOTAGE: widen the tool-name guard to the whole matcher (`startsWith
// ('mcp__codex__')` instead of the exact 'mcp__codex__codex') — codex-reply
// gets a model it has no schema slot for and this arm goes red.
test('M-5: mcp__codex__codex-reply NEVER gets a model injected (its schema has none — a thread keeps its opener\'s model), exit 0', () => {
  const { dir, cleanup } = makeProject(cfg({ enabled: true, model: PINNED }));
  try {
    const r = runHook(consult(dir, { prompt: 'x', threadId: 't' }, 'mcp__codex__codex-reply'), dir);
    const obj = envelopeOf(r, 'M-5');
    assert.equal(
      injectedModel(obj),
      undefined,
      'codex-reply accepts only {threadId, prompt} (be284452, tool schema) — injecting model there sends an argument the tool does not define',
    );

    // CONTROL (opposite reason, same project + same config): the OPENER tool
    // name DOES get the model, so this green means "reply is excluded", never
    // "the config was not readable in this fixture".
    const ctl = envelopeOf(runHook(consult(dir, { prompt: 'x' }, 'mcp__codex__codex'), dir), 'M-5 control');
    assert.equal(injectedModel(ctl), PINNED, 'M-5 control: the same config, on the opener tool, injects');

    const ctx = disclosure(obj);
    if (ctx) {
      assert.doesNotMatch(
        ctx,
        /injected|pinned to gpt-5\.6-sol/i,
        'a reply must not CLAIM an injection it did not make — a false disclosure is worse than none',
      );
    }
  } finally {
    cleanup();
  }
});

// ===========================================================================
// M-6 — FIRST-STEP PLACEMENT (the Codex-flagged risk, and the discriminating
// pin of this file). The relevance path exits early on exactly these shapes;
// injection must happen BEFORE those exits and be composed into every output.
// ===========================================================================

// SABOTAGE: move the injection step below H20's relevance early-exits (the
// no-prompt / no-candidate returns) — every arm here loses its model and the
// test goes red while every other pin in this file stays green.
test('M-6 PLACEMENT: a consult that hits H20\'s relevance early-exits (absent prompt, empty prompt, too few axis terms) STILL gets the model injected and disclosed', () => {
  const { dir, cleanup } = makeProject(cfg({ enabled: true, model: PINNED }));
  try {
    const shapes = [
      ['absent prompt', {}],
      ['empty prompt', { prompt: '' }],
      ['too few axis terms', { prompt: 'x' }],
    ];
    for (const [label, tool_input] of shapes) {
      const obj = envelopeOf(runHook(consult(dir, tool_input), dir), `M-6 ${label}`);
      assert.ok(obj, `M-6 ${label}: stdout must carry the pin envelope — this is the shape that produces NO context today, and the model pin must not ride on relevance`);
      assert.equal(
        injectedModel(obj),
        PINNED,
        `M-6 ${label}: the model pin is unconditional for a codex opener — it is the FIRST step, ahead of every relevance early-exit (board 7423f7a2; Codex-flagged risk)`,
      );
      assert.match(disclosure(obj), /gpt-5\.6-sol/, `M-6 ${label}: the disclosure travels with the injection on every output path, not only the record-carrying one`);
    }
  } finally {
    cleanup();
  }
});

// ===========================================================================
// M-7 — an unreadable config degrades LOUD: no injection, no crash, no deny.
// ===========================================================================

// SABOTAGE: remove the try/catch around the config read (or fall back to a
// hardcoded default model on parse failure) — the malformed arm either exits
// non-zero / emits non-JSON, or starts injecting; both go red here.
test('M-7: a malformed .sterling/config.json degrades loud — exit 0, nothing injected, the config problem named; an ABSENT config behaves the same', () => {
  const bad = makeProject('{ "sparring_partner": { "enabled": true, "model": ');
  const missing = makeProject(null);
  const good = makeProject(cfg({ enabled: true, model: PINNED }));
  try {
    const rBad = runHook(consult(bad.dir, { prompt: 'x' }), bad.dir);
    assert.equal(rBad.code, 0, 'a broken config never turns a consult into a denial (P5: degraded-loud, not fail-shut)');
    const objBad = envelopeOf(rBad, 'M-7 malformed');
    assert.equal(injectedModel(objBad), undefined, 'nothing is injected from a config that could not be parsed — no guessing');
    assert.ok(objBad, 'M-7 malformed: the problem is DISCLOSED, not swallowed');
    const ctxBad = disclosure(objBad);
    assert.match(ctxBad, /config/i, 'the disclosure names the config file as the problem');
    assert.match(
      ctxBad,
      /unreadable|malformed|invalid|parse|could not|couldn't|failed/i,
      'the disclosure says the config could not be READ — distinguishable from a project that simply set no model',
    );

    const rMissing = runHook(consult(missing.dir, { prompt: 'x' }), missing.dir);
    assert.equal(rMissing.code, 0, 'a project with no config.json is never denied a consult');
    const objMissing = envelopeOf(rMissing, 'M-7 absent');
    assert.equal(injectedModel(objMissing), undefined, 'no config, no injection');
    if (objMissing) {
      assert.match(
        disclosure(objMissing),
        /config|CLI default/i,
        'when the absent-config case does disclose, it names the config or the CLI default it fell back to',
      );
    }

    // CONTROL (opposite reason): the same hook, same payload, against a VALID
    // config injects — so the two absences above are config-driven, not "this
    // hook never injects".
    const ctl = envelopeOf(runHook(consult(good.dir, { prompt: 'x' }), good.dir), 'M-7 control');
    assert.equal(injectedModel(ctl), PINNED, 'M-7 control: a readable config in the same harness injects');
  } finally {
    bad.cleanup();
    missing.cleanup();
    good.cleanup();
  }
});

// ===========================================================================
// M-8 — the model is a FREE string, passed VERBATIM.
// ===========================================================================

// SABOTAGE: add an id-shaped validation before the injection
// (`if (!/^[a-z0-9.\-]+$/.test(model)) return;`) or wrap the value in quotes —
// the free-form value is dropped or altered and this arm goes red.
test('M-8: a free-form non-empty model string is injected BYTE-FOR-BYTE — no validation, no quoting, no trimming beyond what the TUI already committed', () => {
  const weird = 'gpt-5.6-sol/custom name with spaces';
  const { dir, cleanup } = makeProject(cfg({ enabled: true, model: weird }));
  try {
    const obj = envelopeOf(runHook(consult(dir, { prompt: 'x' }), dir), 'M-8');
    assert.equal(
      injectedModel(obj),
      weird,
      'the schema declares a free string with no enum (config.ts: "codex validates model names server-side with a loud 400"); there is no shell or TOML boundary on this route, so the value crosses verbatim',
    );
    assert.match(disclosure(obj), /gpt-5\.6-sol\/custom name with spaces/, 'the disclosure shows the exact value being sent, so a typo is visible to the human before the 400 comes back');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// M-9 — OUTPUT VALIDITY across every arm: one parseable JSON envelope, exit 0,
// never a block/deny. Includes payloads whose text would break a hand-built
// envelope (quotes, braces, newlines) on both the prompt and the model side.
// ===========================================================================

// SABOTAGE: emit the disclosure as bare text on stdout (a console.log outside
// the JSON envelope) or string-concatenate the model into the JSON instead of
// serializing it — stdout stops parsing and this test goes red.
test('M-9: every arm emits exit 0 and at most one valid JSON envelope, never decision:block / permissionDecision:deny — including quote/brace/newline-bearing prompts and model ids', () => {
  const matrix = [
    ['configured', cfg({ enabled: true, model: PINNED }), { prompt: 'x' }, 'mcp__codex__codex'],
    ['off', cfg({ enabled: false, model: PINNED }), { prompt: 'x' }, 'mcp__codex__codex'],
    ['unset', cfg({ enabled: true }), { prompt: 'x' }, 'mcp__codex__codex'],
    ['reply', cfg({ enabled: true, model: PINNED }), { prompt: 'x', threadId: 't' }, 'mcp__codex__codex-reply'],
    ['no prompt', cfg({ enabled: true, model: PINNED }), {}, 'mcp__codex__codex'],
    ['explicit', cfg({ enabled: true, model: PINNED }), { prompt: 'x', model: 'gpt-5.5' }, 'mcp__codex__codex'],
    [
      'hostile prompt',
      cfg({ enabled: true, model: PINNED }),
      { prompt: 'line1\n"quoted" }{ ${x} \\ end' },
      'mcp__codex__codex',
    ],
    ['hostile model', cfg({ enabled: true, model: 'gpt-"5.6"\\sol' }), { prompt: 'x' }, 'mcp__codex__codex'],
    ['malformed config', '{ not json', { prompt: 'x' }, 'mcp__codex__codex'],
  ];
  for (const [label, config, tool_input, tool_name] of matrix) {
    const { dir, cleanup } = makeProject(config);
    try {
      const r = runHook(consult(dir, tool_input, tool_name), dir);
      // envelopeOf asserts exit 0, JSON parseability, and the no-block/no-deny
      // contract for this arm.
      const obj = envelopeOf(r, `M-9 ${label}`);
      if (obj) {
        assert.equal(
          typeof obj,
          'object',
          `M-9 ${label}: the envelope is a JSON object, not a bare string or a stream of lines`,
        );
      }
    } finally {
      cleanup();
    }
  }
});

// ===========================================================================
// M-10 fixture — an anti_pattern record + matching prompt so the envelope
// under test also carries the KNOWLEDGE CARRIAGE half of the claim, not only
// the model pin. Copied verbatim (record + prompt pair) from the sibling
// scripts/tests/h20-consult-carriage.test.mjs, which documents it as "already
// known to fire" — reused here rather than invented, so a miss on carriage
// cannot be blamed on an untested fixture.
// ===========================================================================
function envelope(type) {
  const now = '2026-08-03T12:00:00.000Z';
  return {
    id: randomUUID(),
    type,
    created_at: now,
    updated_at: now,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: [],
  };
}

function antiPattern(title, trigger, paths = []) {
  return {
    ...envelope('anti_pattern'),
    title,
    trigger,
    guidance: 'guidance',
    wrong_way: 'wrong way',
    right_way: 'right way text',
    source_evidence: 'evidence',
    basis: 'codebase',
    file_keys: paths,
  };
}

const M10_PROMPT =
  'Wire the harvester so it connects its ready signal in _ready(), then finishes initialising the crew later in the boot sequence.';

function seedMotivatingRecord(store) {
  store.create(
    antiPattern(
      'Signal connected at boot but emitter initialises later',
      'whenever a node connects a signal in _ready() but finishes initialising LATER',
      ['game/run/worker_crew.gd'],
    ),
  );
}

// ===========================================================================
// M-10 — POST-ENVELOPE BOOKKEEPING FAILURE never corrupts stdout. The
// envelope (model pin + knowledge carriage) is written to stdout FIRST; a
// LATER bookkeeping step (the delivery dedup guard-file write) throwing must
// not turn stdout into two concatenated JSON blobs. THE DEFECT THIS PINS: the
// old code wrote a SECOND envelope from its catch block, producing
// `{...}{...}` — JSON.parse fails with "Unexpected non-whitespace character
// after JSON" — silently corrupting an already-good first envelope because of
// a failure in UNRELATED bookkeeping.
// ===========================================================================

// CONTROL, first (opposite reason, same fixture minus the planted directory):
// the guard-file write succeeds normally, so exactly one envelope is produced
// and NOTHING is disclosed about a bookkeeping failure. Without this arm, a
// green M-10 below has two possible causes — "bookkeeping failure is handled
// correctly" or "this fixture never disclosed anything to begin with" — and
// cannot tell them apart.
test('M-10 CONTROL: same fixture, guard path is a normal writable file — one envelope, no bookkeeping-failure disclosure', () => {
  const { dir, store, cleanup } = makeProject(cfg({ enabled: true, model: PINNED }));
  try {
    seedMotivatingRecord(store);
    const r = runHook(consult(dir, { prompt: M10_PROMPT }), dir);
    const obj = envelopeOf(r, 'M-10 CONTROL');
    assert.ok(obj, 'M-10 CONTROL: the pin envelope is still emitted for a codex consult');
    assert.equal(injectedModel(obj), PINNED, 'M-10 CONTROL: model injection is unaffected when bookkeeping succeeds');
    assert.doesNotMatch(
      r.stderr,
      /bookkeeping failed AFTER the envelope was written/,
      'M-10 CONTROL: with a healthy guard path, nothing is disclosed about a bookkeeping failure — proves the disclosure asserted below is CAUSED by the planted directory, not a standing fixture artifact',
    );
  } finally {
    cleanup();
  }
});

// SABOTAGE (layer 1): make the bookkeeping step's own try/catch RE-THROW
// instead of swallowing-and-disclosing (delete the catch, or replace its body
// with `catch (e) { throw e; }`). If some OTHER, coarser guard (e.g. a
// module-level top-level try/catch wrapping the whole hook body) still emits
// a single valid envelope but without this specific bookkeeping-failure
// wording, THIS TEST's stderr assertion goes RED while the JSON.parse
// assertion keeps passing. A green result under layer 1 ALONE is not proof
// this pin is hollow — per the layered-mutation rule (CLAUDE.md: "a pin that
// survives a single-guard mutation may be defense in depth, not hollowness"),
// it would mean the coarser module-level guard is the one actually carrying
// the "exactly one valid envelope" half of the verdict, and it is the
// disclosure-wording assertion that failed, not the whole test trivially
// passing — check which of the two assertions actually reddened, never treat
// this test as one atomic unit when reasoning about which guard is load-
// bearing.
//
// SABOTAGE (layer 2): layer 1 PLUS make that coarser/outer catch write a
// SECOND stdout envelope directly, instead of relying on the envelope that
// was already flushed before bookkeeping ran. This reproduces the literal
// historical defect (`{...}{...}` on stdout) and MUST redden the JSON.parse
// assertion below — the load-bearing assertion of this whole pin. If layer 2
// does not redden JSON.parse, this pin is not testing what it claims to test.
test('M-10: a post-envelope bookkeeping failure (guard-file write EISDIR) never corrupts stdout — exactly one parseable envelope, model still pinned, knowledge carriage still present, failure disclosed on stderr only', () => {
  const { dir, store, cleanup } = makeProject(cfg({ enabled: true, model: PINNED }));
  try {
    seedMotivatingRecord(store);
    // Force the bookkeeping step's renameSync to throw EISDIR: plant a
    // DIRECTORY at the exact path the guard-file write targets.
    mkdirSync(join(dir, '.sterling', 'transient', 'delivery', 's1', 'guard-conductor.json'), { recursive: true });

    const r = runHook(consult(dir, { prompt: M10_PROMPT }), dir);

    assert.equal(r.code, 0, 'M-10: a bookkeeping-only failure must never turn a consult into a non-zero exit');

    // Load-bearing: EXACTLY ONE parseable JSON envelope on stdout — the whole
    // point of this pin. A `{...}{...}` double-envelope (the historical
    // defect) fails this exact assertion.
    let parsed;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      assert.fail(
        `M-10: stdout must be EXACTLY ONE valid JSON envelope even when bookkeeping throws — got: ${r.stdout.slice(0, 500)}`,
      );
    }
    assert.equal(typeof parsed, 'object', 'M-10: the single parsed value is a JSON object, not a scalar or a fragment');

    assert.equal(
      parsed?.hookSpecificOutput?.updatedInput?.model,
      PINNED,
      'M-10: the model pin is written into the envelope BEFORE bookkeeping runs, so a downstream bookkeeping failure must not erase it',
    );

    const ctx = parsed?.hookSpecificOutput?.additionalContext;
    assert.equal(typeof ctx, 'string', 'M-10: additionalContext is present and a string');
    assert.ok(ctx.length > 0, 'M-10: additionalContext is non-empty — the knowledge carriage rides in the SAME envelope bookkeeping cannot touch');

    assert.match(
      r.stderr,
      /bookkeeping failed AFTER the envelope was written/,
      'M-10: the bookkeeping failure is disclosed on stderr, in words that say the envelope was ALREADY WRITTEN — distinguishing this from a failure that PREVENTED the envelope',
    );
  } finally {
    cleanup();
  }
});
