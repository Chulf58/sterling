// R1 PIN RE-CUT — H10's CONSUMER POLICY over the tri-state dispatch status.
//
// CONTRACT SOURCE: decision `review-receipt-rebuild-invariant-three-owner-modules-tri-state-liveness-receipt-bound-supersession`
// + contract sheet §1.1 (consumer policies) / §6 A1, A2, A6, A9.
//
// THE POLICY, in one line each:
//   presumed-active  -> the owned files are EXCLUDED from H10's demands (a live
//                       lane legitimately owes nothing yet).
//   unknown          -> NOTHING is excluded; H10 discloses "ownership uncertain
//                       (dispatch <ref>)" carrying [dispatch_status_unknown] and
//                       names the settle path. An expired lease is not a death
//                       certificate, and it is not a licence to defer either.
//   inactive-confirmed -> IGNORED entirely: no exclusion, and no uncertainty
//                       line (the round is over; there is nothing to settle).
//   corrupt register -> nothing excluded, and the unreadability is disclosed
//                       ([register_unavailable]) rather than read as an all-clear.
//
// The exclusion arms and the disclosure arms are pinned SEPARATELY on purpose:
// "the nag fired" has two possible causes (no exclusion, or a broken register
// read), so every unknown/inactive arm below runs beside R1-A40, the
// presumed-active CONTROL, which must pass for the OPPOSITE reason.
//
// Harness (makeProject/store, touchRegister, hookInput, runHook, out) is the
// idiom of scripts/tests/h22-dispatch-register.test.mjs, duplicated locally
// rather than imported, exactly as that file duplicates its own.
//
// NEW FILE — nothing is RETIRED here.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-06-10T12:00:00.000Z';
const MIN = 60_000;

const token = (c) => new RegExp('\\[' + c + '\\]');

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
  dispatch_register: { stale_minutes: 5 },
};

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h10-status-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  return { dir, store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function runHook(script, input, cwd) {
  const r = spawnSync(process.execPath, [join(HOOKS, script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// The brief pins WHAT is disclosed, never which stream carries it.
const out = (r) => `${r.stdout}\n${r.stderr}`;

function hookInput(dir, over = {}) {
  return { session_id: 's1', transcript_path: join(dir, 't', 's1.jsonl'), cwd: dir, permission_mode: 'default', hook_event_name: 'Stop', ...over };
}

function touchRegister(dir, paths, at = NOW) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  for (const p of paths) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), '// touched\n');
  }
  writeFileSync(join(dir, '.sterling', 'transient', 'touches.json'), JSON.stringify(paths.map((path) => ({ path, at }))));
}

function writeRegisterRaw(dir, content) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(
    join(dir, '.sterling', 'transient', 'dispatch-register.json'),
    typeof content === 'string' ? content : JSON.stringify(content)
  );
}

const agoISO = (minutesAgo) => new Date(Date.now() - minutesAgo * MIN).toISOString();

const regEntry = (agentId, files, over = {}) => ({
  agent_id: agentId,
  agent_type: 'coder',
  session_id: 's1',
  files,
  attribution: 'block',
  at: agoISO(0),
  ...over,
});

const stop = (dir) => runHook('h10-direct-capture.mjs', hookInput(dir), dir);

// ===========================================================================
// R1-A40 — CONTROL, PLACED FIRST. presumed-active still EXCLUDES.
// Every arm below asserts "the duty fired"; without this control a green run
// could equally mean "H10 stopped consulting the register at all".
// ===========================================================================

test('R1-A40 CONTROL: a presumed-active entry owning the sole touched file still EXCLUDES it — no capture nag, exit 0', () => {
  const { dir, cleanup } = makeProject();
  try {
    touchRegister(dir, ['src/x.mjs']);
    writeRegisterRaw(dir, [regEntry('live-1', ['src/x.mjs'], { at: agoISO(1) })]); // stale_minutes = 5
    const r = stop(dir);
    assert.equal(r.code, 0, `a live lane's territory is deferred, so nothing is owed — out=${out(r)}`);
    assert.doesNotMatch(r.stderr, /nothing was captured/, 'the capture duty never fires for a deferred file');
    assert.doesNotMatch(out(r), token('dispatch_status_unknown'), 'a presumed-active dispatch is not uncertain');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// UNKNOWN — discloses WITHOUT excluding. Both halves are asserted, because
// either one alone is satisfiable by the wrong implementation: excluding-and-
// disclosing looks identical to disclosing-and-not-excluding in the text.
// ===========================================================================

test('R1-A41: an UNKNOWN (lease-expired, same session) owner does NOT exclude — the capture duty fires exactly as if no entry existed', () => {
  const { dir, cleanup } = makeProject();
  try {
    touchRegister(dir, ['src/x.mjs']);
    writeRegisterRaw(dir, [regEntry('expired-1', ['src/x.mjs'], { at: agoISO(60) })]); // 12x the 5m lease
    const r = stop(dir);
    assert.equal(r.code, 2, `an expired lease is not a licence to defer — out=${out(r)}`);
    assert.match(r.stderr, /nothing was captured/);
  } finally {
    cleanup();
  }
});

test('R1-A42: the UNKNOWN owner is DISCLOSED — [dispatch_status_unknown], the dispatch ref with its measured age, and the settle path', () => {
  const { dir, cleanup } = makeProject();
  try {
    touchRegister(dir, ['src/x.mjs']);
    writeRegisterRaw(dir, [regEntry('expired-2', ['src/x.mjs'], { at: agoISO(60) })]);
    const text = out(stop(dir));
    assert.match(text, token('dispatch_status_unknown'), `the uncertainty carries its code — out=${text}`);
    // The exact age RENDERING is pinned once, at its owner
    // (dispatch-register-owner.test.mjs R1-A21/A22); here the pin is that H10
    // cites the shared ref rather than a hand-rolled identity string.
    assert.match(text, /coder:expired-2 \(registered /, 'the ref names the dispatch and carries its measured age');
    assert.match(text, /TaskStop/, 'the settle path is named, so the reader can close the uncertainty');
    assert.doesNotMatch(text, /NaN/);
  } finally {
    cleanup();
  }
});

test('R1-A43: an UNKNOWN owner is never reported as DEFERRED — H10 must not claim it withheld a duty it did not withhold', () => {
  const { dir, cleanup } = makeProject();
  try {
    touchRegister(dir, ['src/x.mjs']);
    writeRegisterRaw(dir, [regEntry('expired-3', ['src/x.mjs'], { at: agoISO(60) })]);
    const text = out(stop(dir));
    assert.doesNotMatch(text, /defer/i, `nothing was deferred here — a deferral claim would be false; out=${text}`);
  } finally {
    cleanup();
  }
});

// A2: other-session entries are no longer pruned on write, so H10 now MEETS
// them and must classify rather than ignore them.
test('R1-A44: a FOREIGN-SESSION entry classifies unknown — it never excludes, and it is disclosed like any other unknown', () => {
  const { dir, cleanup } = makeProject();
  try {
    touchRegister(dir, ['src/x.mjs']);
    writeRegisterRaw(dir, [regEntry('foreign-1', ['src/x.mjs'], { session_id: 's2', at: agoISO(0) })]);
    const r = stop(dir);
    assert.equal(r.code, 2, 'a foreign-session holder never defers this session\'s duty');
    assert.match(out(r), token('dispatch_status_unknown'));
    assert.match(out(r), /coder:foreign-1/);
  } finally {
    cleanup();
  }
});

test('R1-A45: an entry with an unparseable `at` classifies unknown and prints "age unreadable" — never a fabricated age', () => {
  const { dir, cleanup } = makeProject();
  try {
    touchRegister(dir, ['src/x.mjs']);
    writeRegisterRaw(dir, [regEntry('badclock-1', ['src/x.mjs'], { at: 'whenever' })]);
    const r = stop(dir);
    assert.equal(r.code, 2, 'an unreadable clock never defers a duty');
    assert.match(out(r), token('dispatch_status_unknown'));
    assert.match(out(r), /age unreadable/);
    assert.doesNotMatch(out(r), /NaN/);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// INACTIVE-CONFIRMED — ignored. Not excluded, and not nagged about.
// ===========================================================================

test('R1-A46: an ENDED entry (inactive-confirmed) does NOT exclude — the round is over, so the duty is owed', () => {
  const { dir, cleanup } = makeProject();
  try {
    touchRegister(dir, ['src/x.mjs']);
    writeRegisterRaw(dir, [regEntry('done-1', ['src/x.mjs'], { at: agoISO(0), ended: { at: agoISO(0), event: 'subagent-stop' } })]);
    const r = stop(dir);
    assert.equal(r.code, 2, 'a stopped dispatch defers nothing, even though its `at` is inside the lease');
    assert.match(r.stderr, /nothing was captured/);
  } finally {
    cleanup();
  }
});

test('R1-A47: an ENDED entry is IGNORED, not disclosed — a settled round is not an open uncertainty (P1: no ceremony)', () => {
  const { dir, cleanup } = makeProject();
  try {
    touchRegister(dir, ['src/x.mjs']);
    writeRegisterRaw(dir, [regEntry('done-2', ['src/x.mjs'], { at: agoISO(0), ended: { at: agoISO(0), event: 'subagent-stop' } })]);
    const text = out(stop(dir));
    assert.doesNotMatch(text, token('dispatch_status_unknown'), `an ended round is not uncertain — out=${text}`);
    assert.ok(!text.includes('done-2'), `nothing to settle, so nothing is said about it — out=${text}`);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PARTIAL — the mixed register. The unknown half is disclosed and the
// presumed-active half is still excluded IN THE SAME EMISSION, which is what
// proves the policy is per-entry rather than per-register.
// ===========================================================================

test('R1-A48: a register carrying one presumed-active and one unknown owner excludes only the live one and discloses only the unknown one', () => {
  const { dir, cleanup } = makeProject();
  try {
    touchRegister(dir, ['src/live.mjs', 'src/uncertain.mjs']);
    writeRegisterRaw(dir, [
      regEntry('live-2', ['src/live.mjs'], { at: agoISO(1) }),
      regEntry('expired-4', ['src/uncertain.mjs'], { at: agoISO(60) }),
    ]);
    const r = stop(dir);
    assert.equal(r.code, 2, 'the non-deferred remainder still owes the duty');
    const text = out(r);
    assert.match(text, token('dispatch_status_unknown'));
    assert.match(text, /coder:expired-4/, 'the unknown owner is named');
    assert.ok(!/\[dispatch_status_unknown\][^\n]*live-2/.test(text), 'the live owner is never named as uncertain');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// REGISTER AVAILABILITY — a register that EXISTS and cannot be read is an
// anomaly, and reading it as "nothing in flight" is the all-clear the decision
// forbids. R1-A40 is this pair's control (a readable register still excludes).
// ===========================================================================

test('R1-A49: a CORRUPT register excludes nothing and is disclosed once with [register_unavailable]', () => {
  const { dir, cleanup } = makeProject();
  try {
    touchRegister(dir, ['src/x.mjs']);
    writeRegisterRaw(dir, '{not valid json,,,');
    const r = stop(dir);
    assert.equal(r.code, 2, 'an unreadable register can never justify withholding a duty');
    const text = out(r);
    const lines = text.split('\n').filter((l) => token('register_unavailable').test(l));
    assert.equal(lines.length, 1, `exactly one unavailability disclosure, found ${lines.length}: ${text}`);
    assert.match(lines[0], /corrupt/, 'the line names WHICH unavailability it is');
  } finally {
    cleanup();
  }
});

test('R1-A50: an unreadable register never enumerates agents it could not read — one line, no fabricated identities', () => {
  const { dir, cleanup } = makeProject();
  try {
    touchRegister(dir, ['src/x.mjs']);
    writeRegisterRaw(dir, { agent_id: 'not-an-array', agent_type: 'coder' });
    const text = out(stop(dir));
    assert.match(text, token('register_unavailable'));
    assert.ok(!text.includes('not-an-array'), `a corrupt register yields no per-agent enumeration — out=${text}`);
    assert.doesNotMatch(text, token('dispatch_status_unknown'), 'unavailable is its own disclosure, never N per-agent unknowns');
  } finally {
    cleanup();
  }
});

test('R1-A51 CONTROL: an EMPTY array register is readable-and-empty — no unavailability line at all, and the duty fires normally', () => {
  const { dir, cleanup } = makeProject();
  try {
    touchRegister(dir, ['src/x.mjs']);
    writeRegisterRaw(dir, []);
    const r = stop(dir);
    assert.equal(r.code, 2);
    assert.doesNotMatch(out(r), token('register_unavailable'), 'an empty register is not an unavailable one');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// A6 — every H10 register-consumer line carries a code token.
// ===========================================================================

test('R1-A52: every H10 dispatch-status line carries a [snake_case] code token — no untokened advisory prose', () => {
  const { dir, cleanup } = makeProject();
  try {
    touchRegister(dir, ['src/x.mjs']);
    writeRegisterRaw(dir, [regEntry('expired-5', ['src/x.mjs'], { at: agoISO(60) })]);
    const text = out(stop(dir));
    const statusLines = text.split('\n').filter((l) => l.includes('coder:expired-5'));
    assert.ok(statusLines.length > 0, `the unknown owner must be reported somewhere — out=${text}`);
    for (const line of statusLines) {
      assert.match(line, /\[[a-z][a-z0-9_]*\]/, `every dispatch-status line carries its code: ${line}`);
    }
  } finally {
    cleanup();
  }
});

// Classification is a READ. H10 owns exactly one register write (the residue
// stamp pinned in dispatch-residue-and-resources.test.mjs SPEC A(3c)); it must
// never delete, re-order or re-stamp an entry while classifying it, because
// deleting is H22/H1 territory and an entry lost here is a lost review round.
test('R1-A53: classifying never removes or re-times an entry — the unknown owner survives the Stop with its own `at` intact', () => {
  const { dir, cleanup } = makeProject();
  try {
    touchRegister(dir, ['src/x.mjs']);
    const seeded = regEntry('expired-6', ['src/x.mjs'], { at: agoISO(60) });
    writeRegisterRaw(dir, [seeded]);
    const p = join(dir, '.sterling', 'transient', 'dispatch-register.json');
    stop(dir);
    assert.equal(existsSync(p), true, 'the register survives the Stop');
    const after = JSON.parse(readFileSync(p, 'utf8'));
    assert.equal(after.length, 1, 'H10 never removes a register entry — only H22 Stop marks it and H1 wipes the file');
    assert.equal(after[0].agent_id, 'expired-6');
    assert.equal(after[0].at, seeded.at, 'H10 never refreshes an entry into looking live again');
    assert.equal(after[0].ended, undefined, 'and it never invents a terminal event it did not observe');
  } finally {
    cleanup();
  }
});
