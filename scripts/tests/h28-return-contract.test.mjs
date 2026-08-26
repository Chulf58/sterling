// H28 RETURN CONTRACT — SubagentStart hook that injects a static "STERLING
// DEFAULT RETURN CONTRACT" block into a spawned subagent's context, unless
// the spawned agent_type is exempt (e.g. 'statusline-setup'), and NEVER
// blocks a spawn (fail-open on malformed/absent stdin).
//
// Spec pinned here (given by the launching agent, hook already implemented —
// these pins are expected to PASS; a FAIL is a real bug to report):
//   1. non-exempt agent_type -> exit 0, additionalContext contains the
//      literal "STERLING DEFAULT RETURN CONTRACT" (POSITIVE CONTROL, first).
//   2. exempt agent_type ('statusline-setup') -> exit 0, no injection at all.
//   3. fail-open guarantee: exit != 2 (never denies a spawn) across (a)
//      MALFORMED stdin (empty string, non-JSON — readStdin throws, caught) —
//      no injection either; and (b) VALID JSON simply missing agent_type —
//      the hook's design is "always inject EXCEPT statusline-setup", so an
//      undefined agent_type is not in the exempt set and DEFAULT-ON
//      injection still fires (exit 0, marker present).
//   4. the injected block carries a self-subordination clause (/take[s]?
//      precedence/i) — proving it is worded to yield to a brief/role
//      contract, not a bare directive.
//
// Harness follows scripts/tests/h19-delivery.test.mjs / h22-dispatch-register
// .test.mjs (spawnSync piping JSON stdin into scripts/hooks/hNN-*.mjs,
// asserting on stdout/exit code only — never on the hook's source, per H4).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const SCRIPT = 'h28-return-contract.mjs';

/** Standard path: JSON-encode the stdin object ourselves. */
function runHook(input, cwd) {
  const r = spawnSync(process.execPath, [join(HOOKS, SCRIPT)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Raw path: pipe an arbitrary (possibly non-JSON, possibly empty) string. */
function runRaw(rawInput, cwd) {
  const r = spawnSync(process.execPath, [join(HOOKS, SCRIPT)], {
    input: rawInput,
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h28-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({}));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { dir, cleanup };
}

function subagentStart(dir, over = {}) {
  return {
    hook_event_name: 'SubagentStart',
    session_id: 's1',
    transcript_path: join(dir, 't', 's1.jsonl'),
    cwd: dir,
    agent_id: 'sub-1',
    agent_type: 'reviewer-correctness',
    ...over,
  };
}

// ===========================================================================
// PIN 1 (POSITIVE CONTROL, placed first): a non-exempt agent_type gets the
// contract injected. Every later "silence" pin (2) is read against this: if
// this one fails, the hook is globally broken and pin 2's silence would be
// meaningless rather than evidence of a real exemption.
// Sabotage: comment out / null-out the additionalContext injection (e.g.
// return {} instead of the contract block) — the literal-string match below
// goes red.
// ===========================================================================

test('H28 PIN 1 (control): non-exempt agent_type gets STERLING DEFAULT RETURN CONTRACT injected, exit 0', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(subagentStart(dir, { agent_type: 'reviewer-correctness' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.match(
      out.hookSpecificOutput.additionalContext,
      /STERLING DEFAULT RETURN CONTRACT/,
      'the literal contract marker must be present for a non-exempt agent'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN 2: an exempt agent_type ('statusline-setup') is allowed through with NO
// injection at all — read against PIN 1's positive control above.
// Sabotage: remove/invert the exemption check so every agent_type (including
// 'statusline-setup') gets the contract injected — this pin goes red.
// ===========================================================================

test('H28 PIN 2: exempt agent_type (statusline-setup) is allowed with no injection', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(subagentStart(dir, { agent_type: 'statusline-setup' }), dir);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(
      r.stdout,
      /STERLING DEFAULT RETURN CONTRACT/,
      'an exempt agent_type must never receive the contract block'
    );
    if (r.stdout.trim()) {
      const out = JSON.parse(r.stdout);
      const ctx = out?.hookSpecificOutput?.additionalContext;
      assert.ok(!ctx, 'no additionalContext at all for an exempt agent — allow with no injection');
    }
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN 3a: fail-open on MALFORMED stdin (readStdin itself throws — caught) —
// never exit 2, no injection. Two malformed shapes: empty stdin, non-JSON
// stdin. This is the parse-failure path, distinct from 3b below.
// Sabotage: change the catch branch to `process.exit(2)` (or otherwise deny
// the spawn) instead of allowing/warning without injecting — the
// `assert.notEqual(r.code, 2)` line goes red.
// ===========================================================================

test('H28 PIN 3a: empty stdin never blocks (exit != 2), no injection (parse failure)', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runRaw('', dir);
    assert.notEqual(r.code, 2, `empty stdin must never deny a spawn: stderr=${r.stderr}`);
    assert.doesNotMatch(r.stdout, /STERLING DEFAULT RETURN CONTRACT/, 'no injection on malformed (unparseable) stdin');
  } finally {
    cleanup();
  }
});

test('H28 PIN 3a: non-JSON stdin never blocks (exit != 2), no injection (parse failure)', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runRaw('this is not { json at all', dir);
    assert.notEqual(r.code, 2, `non-JSON stdin must never deny a spawn: stderr=${r.stderr}`);
    assert.doesNotMatch(r.stdout, /STERLING DEFAULT RETURN CONTRACT/, 'no injection on malformed (unparseable) stdin');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN 3b: VALID JSON that simply lacks an agent_type field is NOT a parse
// failure — it parses fine, agent_type is just undefined. Per the chosen
// design ("always inject EXCEPT statusline-setup", Codex-approved), undefined
// is not in the exempt set, so this is the DEFAULT-ON path: exit 0 AND the
// contract block IS injected. This is the opposite polarity of 3a on
// purpose — the fail-open guarantee (exit != 2) holds across BOTH, but only
// 3a is silent; 3b still delivers the default contract.
// Sabotage: treat a missing/undefined agent_type as exempt (suppress
// injection) instead of default-on — the `assert.match(... CONTRACT)` line
// goes red. A second, opposite sabotage — make the missing-field branch
// exit 2 — is already covered by the shared exit-!=2 assertion.
// ===========================================================================

test('H28 PIN 3b: valid JSON stdin missing agent_type never blocks (exit != 2) AND still injects (default-on, not exempt)', () => {
  const { dir, cleanup } = makeProject();
  try {
    const { agent_type, ...withoutType } = subagentStart(dir);
    const r = runHook(withoutType, dir);
    assert.notEqual(r.code, 2, `missing agent_type must never deny a spawn: stderr=${r.stderr}`);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.match(
      out.hookSpecificOutput.additionalContext,
      /STERLING DEFAULT RETURN CONTRACT/,
      'undefined agent_type is not in the exempt set — default-on injection still fires'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN 4: the injected block is self-subordinating — it carries wording that a
// brief/role contract takes precedence over it, proving it is not a bare
// override command. Reuses the PIN-1 fixture shape.
// Sabotage: reword the injected text to drop the precedence clause (e.g.
// delete "takes precedence over this default" from the block) — the regex
// match below goes red.
// ===========================================================================

test('H28 PIN 4: the injected contract block is self-subordinating (a brief/role contract takes precedence)', () => {
  const { dir, cleanup } = makeProject();
  try {
    const r = runHook(subagentStart(dir, { agent_type: 'coder' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /STERLING DEFAULT RETURN CONTRACT/, 'sanity: this is the injected block');
    assert.match(ctx, /take[s]? precedence/i, 'the block must state that a brief/role contract takes precedence over it');
  } finally {
    cleanup();
  }
});
