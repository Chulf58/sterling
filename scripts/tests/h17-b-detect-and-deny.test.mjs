// H17 (B) DETECT-AND-DENY — decision `h17-ruling-d-needs-a-b-enumerating-stamp-producer-and-stamp-invalidation`
// (fac9a69b), refining RULING D of decision `h17-baseline-integrity-redesign-rulings-abcd` (532a4383), S4.
//
// STATUS: NOT YET IMPLEMENTED. Today (per the dispatch brief's BACKGROUND, and
// decision fac9a69b's own plain-text description of enforcement-stamp.mjs:129
// `allDirtyPaths` / `git status --porcelain -z` with no `--ignored`) the (B)
// gitignored baseline set (.claude/agents/**, .sterling/config.json,
// .claude/settings*.json) is snapshotted Pre-call and RESTORED (bytes written
// back) Post-call, unconditionally, with no stamp-attestation route at all —
// the enforcement stamp is not consulted for (B) today. THE RULING THIS FILE
// PINS: (B) moves to DETECT-AND-DENY. A changed (B) path is allowed ONLY when
// a trusted stamp entry attests its CURRENT bytes; otherwise it is DENIED and
// the bytes are LEFT EXACTLY AS THE COMMAND LEFT THEM (never restored, never
// recreated, never truncated/rewritten by H17 itself).
//
// SUPERSEDED IN PART, 2026-08-29 — decision `b-surface-adoption-point-closes-
// with-an-incident-bound-taint-latch-not-a-persisted-manifest` (bcd2cc09).
// RULING 4 makes a stamp a SET-EXACT manifest of the CURRENT (B) surface,
// compared on EVERY call rather than only after an in-window difference; and
// PRE-AUTHORIZATION IS DEAD — a stamp attests OBSERVED CURRENT STATE, never
// future intent, so a hand-written stamp naming bytes that are not on disk is a
// bearer capability the sanctioned producer cannot even emit. THREE cases in
// this file rested on the retired semantics and were reworked, each carrying
// its own note: AC4-TREATMENT (now the sanctioned conductor-edits-then-attests
// workflow), AC8 (now the adoption closure: call N+1 denied AT PRE by the taint
// latch) and AC10 (the future-stamp property RETIRED, replaced by a negative
// pin on a hash that disagrees with disk). Everything else in this file is
// unchanged.
//
// AUTHORED BLIND to scripts/hooks/h17-bash-write-sweep.mjs and
// scripts/enforcement-stamp.mjs per H4 — no hook or CLI source was read to
// write these pins. Every expectation comes from the dispatch brief's ACs and
// decision fac9a69b/532a4383's prose (a decision record is spec, not
// implementation — H4's wall gates Read/Grep on code, not knowledge_get).
//
// HARNESS is a faithful, non-imported copy of the makeGitProject/h17/lane/git/
// oneLine idiom shared by scripts/tests/h17-stamp-honor.test.mjs,
// scripts/tests/h17-bounded-io.test.mjs, scripts/tests/h17-b-surface-survives-a-sweep.test.mjs
// and scripts/tests/enforcement.test.mjs (runStampCli). The hardlink CONTROL
// (AC11) is a faithful copy of scripts/tests/h17-read-blob-restore.test.mjs's
// T11 CONTROL (~line 853) and HARDLINK_SKIP probe (~line 217).
//
// RUN COMMAND (node toolchain adapter):
//   node --test scripts/tests/h17-b-detect-and-deny.test.mjs

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
  realpathSync,
  linkSync,
  statSync,
  openSync,
  closeSync,
  ftruncateSync,
  writeSync,
  constants as fsConstants,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-06-10T12:00:00.000Z';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

// anti-pattern ee89c3fd: raw multi-line child-process stderr interpolated
// into an assertion message poisons the TAP crash/assertion classifier.
// Flatten whitespace, never truncate.
function oneLine(s) {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function runHook(script, input, cwd) {
  const r = spawnSync(process.execPath, [join(HOOKS, script)], { input: JSON.stringify(input), encoding: 'utf8', cwd, timeout: 30_000 });
  return { code: r.status, stderr: r.stderr ?? '', stdout: r.stdout ?? '' };
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
    stack_tags: ['node'],
  };
}

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs', '**/*.ts'], test_globs: ['**/*.test.mjs', 'tests/**'], run_commands: { test: 'node --test' } }],
  context_watch: { warn_pct: 60, block_pct: 95, mode: 'observe', windows: { default: 200000 } },
};

function briefRecord() {
  return {
    ...envelope('brief'),
    slug: 'feat',
    title: 'Feature',
    problem: 'p',
    feature: 'f',
    user_stated: { criteria: [], constraints: [] },
    conductor_proposals: [],
    acceptance_criteria: [{ ac_id: 'AC1', text: 'works end to end', verifiable_at: 'final' }],
    technical_design: { approach: 'a', interfaces: [], shared_structures: [] },
    blast_radius: { files: [{ path: 'src/feature.ts', owning_articles: [] }], reconcile_list: [] },
    incidental_scope: [],
    out_of_scope: ['src/legacy/**'],
    phases: [{ phase_id: 'p1', goal: 'g', subtasks: [], ac_ids: ['AC1'], difficulty: { level: 'normal', reasons: [] }, model_hint: 'sonnet' }],
    decisions_made: [],
  };
}

const GIT_SKIP = (() => {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0 ? false : 'git not available on this host';
})();

function git(dir, args, { must = false } = {}) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (must) assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${oneLine(r.stderr)}`);
  return r;
}

function makeGitProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h17-bdad-'));
  const runId = 'r-h17bdad-' + randomUUID().slice(0, 8);

  git(dir, ['init', '-q'], { must: true });
  git(dir, ['config', 'user.email', 'h17@sterling.test'], { must: true });
  git(dir, ['config', 'user.name', 'H17 Test'], { must: true });
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.autocrlf', 'false'], { must: true });

  writeFileSync(join(dir, '.gitignore'), ['.claude/agents/', '.claude/settings.local.json', '.sterling/', ''].join('\n'));

  mkdirSync(join(dir, 'hooks'), { recursive: true });
  writeFileSync(join(dir, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [] } }, null, 2) + '\n');
  writeFileSync(join(dir, 'hooks', 'h3-contract-gate.mjs'), '// bundled enforcement hook (pristine)\nprocess.exit(0);\n');

  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'feature.ts'), 'export const x = 1;\n');

  git(dir, ['add', '-A'], { must: true });
  git(dir, ['commit', '-q', '-m', 'init'], { must: true });

  mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'agents', 'coder.md'), '# coder (legit)\n');
  writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify({ hooks: 'enabled' }) + '\n');

  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  const dbPath = join(dir, '.sterling', 'sterling.db');
  const store = new SterlingStore(dbPath);
  const brief = store.create(briefRecord());
  store.createRun({
    id: runId,
    brief_ref: brief.id,
    branch: 'sterling/' + runId,
    machine_state: 'running',
    phases: [{ id: 'p1', status: 'in_progress', signals: [], commits: [] }],
    dispatch_counts: {},
    escalations: [],
    started_at: NOW,
  });

  const projectTag = createHash('sha256').update(realpathSync(dir)).digest('hex').slice(0, 16);
  let closed = false;
  const closeStore = () => {
    if (!closed) {
      try {
        store.close();
      } catch {}
      closed = true;
    }
  };
  const cleanup = () => {
    closeStore();
    rmSync(dir, { recursive: true, force: true });
    for (const p of tempRecords(projectTag)) rmSync(p, { force: true });
  };
  return { dir, store, runId, dbPath, projectTag, closeStore, cleanup };
}

function tempRecords(projectTag) {
  let names = [];
  try {
    names = readdirSync(tmpdir());
  } catch {
    return [];
  }
  return names.filter((n) => n.startsWith(`sterling-enforce-${projectTag}`)).map((n) => join(tmpdir(), n));
}

function h17(dir, event, over = {}) {
  return runHook(
    'h17-bash-write-sweep.mjs',
    {
      session_id: 's1',
      transcript_path: join(dir, 'transcripts', 's1.jsonl'),
      cwd: dir,
      permission_mode: 'default',
      hook_event_name: event,
      tool_name: 'Bash',
      tool_input: { command: 'grep -rn "resolveRun" scripts/' }, // read-only; fixtures do the tampering directly
      ...(event === 'PostToolUse' ? { tool_response: { stdout: '', stderr: '' } } : {}),
      ...over,
    },
    dir
  );
}

function lane(tag) {
  return { agent_id: 'a1', tool_use_id: `toolu_${tag}_${randomUUID().replace(/-/g, '').slice(0, 16)}` };
}

function stampPath(dir) {
  return join(dir, '.sterling', 'transient', 'enforcement-stamp.json');
}

function writeStamp(dir, entries) {
  const p = stampPath(dir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(entries));
}

function sha256Of(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sha256OfBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function coderPath(dir) {
  return join(dir, '.claude', 'agents', 'coder.md');
}

const CODER_REL = '.claude/agents/coder.md';

// ---------------------------------------------------------------------------
// ADDED 2026-08-29 for decision `b-surface-adoption-point-closes-with-an-
// incident-bound-taint-latch-not-a-persisted-manifest` (bcd2cc09), RULING 4
// (EXACT MANIFEST) and RULINGS 7-11 (THE TAINT LATCH). Copied in shape from
// scripts/tests/h17-b-taint-latch.test.mjs's fullAttestedStamp/latchPath —
// this file's own idiom, not an import (neither file exports anything).
//
// Ruling 4 makes a stamp a SET-EXACT manifest of the CURRENT (B) surface, so a
// pin that needs a LEGITIMATE stamp must name EVERY current (B) member, not
// just coder.md. The three members this fixture materializes are exactly
// `.claude/agents/**`, `.claude/settings*.json` and `.sterling/config.json`.
// ---------------------------------------------------------------------------
const SETTINGS_REL = '.claude/settings.local.json';
const CONFIG_REL = '.sterling/config.json';

function settingsPath(dir) {
  return join(dir, '.claude', 'settings.local.json');
}

function configJsonPath(dir) {
  return join(dir, '.sterling', 'config.json');
}

// A COMPLETE manifest, hashing the bytes that are ON DISK RIGHT NOW — which is
// the only thing the sanctioned producer can emit (it enumerates every live (B)
// member and hashes its CURRENT bytes; its own header calls the result a
// snapshot of what the conductor "has just attested"). NEVER a future hash:
// PRE-AUTHORIZATION IS DEAD — a stamp naming bytes that are not on disk is a
// bearer capability, i.e. an authorization token for a future write, which is
// exactly the "persist an authorizing artifact" shape decision bcd2cc09
// rejected in favour of persisting the INCIDENT.
function fullAttestedStamp(dir) {
  return [
    { path: CODER_REL, sha256: sha256Of(coderPath(dir)), at: NOW },
    { path: SETTINGS_REL, sha256: sha256Of(settingsPath(dir)), at: NOW },
    { path: CONFIG_REL, sha256: sha256Of(configJsonPath(dir)), at: NOW },
  ];
}

// THE LATCH — Ruling 7: `.sterling/enforcement-taint.json`, a plain file,
// deliberately outside the sealed DB and outside BASELINE_GLOBS. Presence alone
// is the verdict; it is cleared ONLY by a separate conductor reconciliation.
function latchPath(dir) {
  return join(dir, '.sterling', 'enforcement-taint.json');
}

// enforcement-stamp.mjs CLI runner, mirroring enforcement.test.mjs's runStampCli.
function runStampCli(dir) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'enforcement-stamp.mjs')], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
}

const MIB = 1024 * 1024;
const OVERSIZE_STAMP_BYTES = 24 * MIB; // mirrors h17-bounded-io.test.mjs's OVERSIZE_RECORD_BYTES judgment call
function bigBuffer(bytes, fillByte) {
  return Buffer.alloc(bytes, fillByte);
}
const CORRUPT_STAMP = Buffer.from('{ not valid json,,,');

// ===========================================================================
// AC1 — an unattested MODIFY of a (B) path is DENIED and the bytes are LEFT
// EXACTLY AS THE COMMAND WROTE THEM (never restored to the pre-call bytes).
//
// EXPECTED FAILURE SHAPE (RED): today's (B) arm restores the Pre-call bytes
// on any detected change, so `readFileSync(coder)` comes back as `original`,
// not `newBytes` — the `deepEqual(..., newBytes)` assertion fires (actual:
// original bytes, expected: newBytes). The exit code (2) may already be green
// today, since a restore is plausibly accompanied by a deny; this pin does
// not rely on the exit code alone (assertion-quality rule).
//
// SABOTAGE: reintroduce the old restore-bytes Post-call behavior for (B) (or
// equivalently, materialize `original` back onto the path on deny) — the
// byte-identity assertion flips from newBytes to the restored original bytes.
// ===========================================================================
test('AC1: an unattested MODIFY of a (B) path is DENIED and the bytes are left exactly as the command wrote them (never restored)', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const coder = coderPath(dir);
    const original = readFileSync(coder);
    const L = lane('ac1-modify');

    assert.equal(existsSync(stampPath(dir)), false, 'PRECONDITION: no stamp exists — the deny must come from the absence of attestation');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre on a clean tree allows');

    const newBytes = Buffer.from('---\nname: modified-in-window\n---\n# tampered (B) file, no attestation\n');
    writeFileSync(coder, newBytes);

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `an unattested (B) modify must deny — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    assert.deepEqual(readFileSync(coder), newBytes, 'THE RULING: bytes are LEFT EXACTLY AS THE COMMAND WROTE THEM — never restored to the original');
    assert.notDeepEqual(readFileSync(coder), original, 'sanity: the surviving bytes are not the old pre-call bytes either');
    assert.match(oneLine(r.stderr), new RegExp(CODER_REL.replace(/\./g, '\\.')), 'the denial names the specific (B) path');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC2 — an unattested DELETE of a (B) path is DENIED and the path remains
// ABSENT afterwards (never recreated).
//
// EXPECTED FAILURE SHAPE (RED): today's restore-bytes behavior recreates a
// deleted (B) path from its Pre-call snapshot, so `existsSync(coder)` comes
// back `true`, contradicting the asserted `false`.
//
// SABOTAGE: keep recreating a deleted (B) path from the Pre snapshot —
// `existsSync` flips from false to true.
// ===========================================================================
test('AC2: an unattested DELETE of a (B) path is DENIED and the path remains absent (never recreated)', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const coder = coderPath(dir);
    const L = lane('ac2-delete');

    assert.equal(existsSync(stampPath(dir)), false, 'PRECONDITION: no stamp exists');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre on a clean tree allows');

    rmSync(coder, { force: true });
    assert.equal(existsSync(coder), false, 'PRECONDITION: the command really deleted the (B) path');

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `an unattested (B) delete must deny — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    assert.equal(existsSync(coder), false, 'THE RULING: the path is LEFT ABSENT — never recreated by H17');
    assert.match(oneLine(r.stderr), new RegExp(CODER_REL.replace(/\./g, '\\.')), 'the denial names the specific (B) path');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC3 — denial WORDING is truthful: a (B) modify/delete denial must NEVER
// claim the change was "reverted" or "rolled back" (a false action claim,
// P5/conduct-rules), and must instead state the true disposition — left in
// place / left on disk.
//
// EXPECTED FAILURE SHAPE (RED): the task states plainly that "the current
// code says exactly that" — i.e. today's denial text uses reverted/rolled-
// back wording for (B). `assert.doesNotMatch(..., /reverted|rolled back/i)`
// fires today.
//
// SABOTAGE: leave (or reintroduce) "reverted"/"rolled back" wording on the
// (B) denial path — the doesNotMatch assertion fires.
// ===========================================================================
test('AC3: the (B) denial wording is truthful — never claims a revert/rollback that did not happen', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const coder = coderPath(dir);
    const L = lane('ac3-wording');

    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre on a clean tree allows');
    writeFileSync(coder, Buffer.from('# tampered for wording pin\n'));

    const r = h17(dir, 'PostToolUse', L);
    assert.equal(r.code, 2, `a (B) modify with no attesting stamp must deny — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    const err = oneLine(r.stderr);
    assert.doesNotMatch(err, /reverted|rolled\s*back/i, 'FALSE ACTION CLAIM: the file was NOT reverted — this wording must never appear for the new detect-and-deny (B) disposition');
    assert.match(err, /left (in place|on disk|untouched|as[- ]is)/i, 'the denial must state the TRUE disposition — left in place / left on disk');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC4 — CONTROL then TREATMENT (both required; an allow-only test passes
// trivially if (B) checking is disabled entirely).
//
// AC4-CONTROL: the exact same target bytes, with NO attesting stamp entry,
// must still DENY.
// AC4-TREATMENT (REWRITTEN 2026-08-29 — see below): the SANCTIONED WORKFLOW —
// the (B) bytes are already at their current value, a COMPLETE stamp attests
// the WHOLE current (B) set, and an agent window that changes nothing ALLOWS.
//
// WHY THE OLD TREATMENT FIXTURE IS RETIRED. It hand-wrote a stamp naming a
// FUTURE hash for coder.md and then let the AGENT write those bytes. Decision
// bcd2cc09 kills that shape outright: PRE-AUTHORIZATION IS DEAD — A STAMP
// ATTESTS OBSERVED CURRENT STATE, NEVER FUTURE INTENT. A stamp naming bytes
// that are not on disk is a bearer capability (an authorization token for a
// future write), the very "persist an authorizing artifact" design that
// objective rejected in favour of persisting the INCIDENT; and the sanctioned
// producer cannot emit such a stamp at all, since it enumerates the live (B)
// members and hashes their CURRENT bytes. The old fixture also named only ONE
// (B) path, which Ruling 4's set-exact comparison now denies on its own.
// THE REPLACEMENT WORKFLOW, which this test expresses: the CONDUCTOR edits (B)
// itself (an agent never writes its own grant definitions — there is no
// legitimate case for it), then runs the producer, which attests the COMPLETE
// current set; a later agent window that changes nothing then allows.
//
// EXPECTED: CONTROL is most plausibly GREEN today (today's (B) arm denies on
// any change, attested or not — there is no exemption route yet at all).
// TREATMENT is most plausibly GREEN today TOO, and deliberately so: with
// nothing changed in-window it allows on HEAD without the stamp ever being
// opened. Its job is to pin that Ruling 4's EVERY-CALL exact-manifest
// comparison does not FALSELY DENY the conductor's normal workflow once it
// lands. DISCLOSED HONESTLY: an ALLOW here has two possible causes — "the
// manifest was validated and found exact" and "nothing changed in-window, so
// the stamp was never consulted" — and this test alone cannot tell them apart.
// The discriminator is AC10 below (a COMPLETE manifest that DISAGREES with
// disk must DENY with nothing changed in-window), which is red under exactly
// the "never consult the stamp" implementation this test cannot see.
//
// SABOTAGE (CONTROL): disable (B) checking entirely (always allow) — CONTROL
// flips from deny (2) to allow (0), which is exactly the "checking disabled"
// hypothesis this control rules out.
// SABOTAGE (TREATMENT): invert the exact-manifest verdict — make the presence
// of a stamp, or an exact set/hash match, DENY instead of attest (e.g. flip
// the `mismatch -> deny, exact -> allow` comparison, or add a freshness rule
// rejecting any stamp not written inside the current call). The allow flips to
// deny, which is the false-denial-of-the-sanctioned-workflow failure this pin
// exists to catch. NOTE, stated plainly rather than overclaimed: this test
// does NOT go red under "never consult the stamp for (B)" — that mutation is
// AC10's to catch, not this one's.
// ===========================================================================
const AC4_NEW_BYTES = Buffer.from('---\nname: attested-change\n---\n# (B) content the conductor pre-authorized\n');

test('AC4-CONTROL: a (B) modify with NO attesting stamp entry is DENIED (proves checking is not disabled)', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const coder = coderPath(dir);
    const L = lane('ac4-control');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0);
    assert.equal(existsSync(stampPath(dir)), false, 'PRECONDITION: no stamp exists for this arm');
    writeFileSync(coder, AC4_NEW_BYTES);

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `CONTROL: an unattested (B) change must deny — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
  } finally {
    cleanup();
  }
});

test('AC4-TREATMENT: the SANCTIONED WORKFLOW — a COMPLETE stamp attesting the whole CURRENT (B) set, and an agent window that changes nothing, ALLOWS and keeps the conductor\'s bytes', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const coder = coderPath(dir);

    // STEP 1 — THE CONDUCTOR edits (B) ITSELF, outside any agent window. Modelled
    // as a plain filesystem write: a conductor tool call carries no agent_id and
    // is exempt from the agent gate, and that exemption is already pinned by
    // enforcement.test.mjs's H17 AC5, so it is not re-asserted here (re-asserting
    // it would add a second possible cause to this test's verdict). The bytes are
    // CONTROL's bytes on purpose: same target content, so the only difference
    // between the two arms is WHO wrote them and whether the whole current (B)
    // set is attested.
    writeFileSync(coder, AC4_NEW_BYTES);

    // STEP 2 — the conductor runs the producer, which enumerates every live (B)
    // member and hashes its CURRENT bytes. Hand-mirrored here as a COMPLETE
    // manifest (the REAL CLI is driven end-to-end by AC5 below, so this file does
    // not rest on a hand-written stamp alone).
    writeStamp(dir, fullAttestedStamp(dir));
    assert.deepEqual(
      fullAttestedStamp(dir)
        .map((e) => e.path)
        .sort(),
      [CODER_REL, CONFIG_REL, SETTINGS_REL].sort(),
      'FIXTURE SELF-CHECK: the manifest is COMPLETE — every current (B) member is attested, so no missing-path violation can be what this arm observes'
    );

    // STEP 3 — the agent's window changes NOTHING. An agent never writes (B).
    const L = lane('ac4-treatment');
    const pre = h17(dir, 'PreToolUse', L);
    assert.notEqual(pre.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(pre.code, 0, `Pre must allow on an exactly-attested (B) surface — actual ${pre.code}, stderr: ${oneLine(pre.stderr)}`);

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 0, `TREATMENT: an exact, COMPLETE attestation of the current (B) set must ALLOW — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    assert.deepEqual(readFileSync(coder), AC4_NEW_BYTES, "the conductor's attested bytes are KEPT — never restored, never rewritten by H17");
    assert.doesNotMatch(oneLine(r.stderr), new RegExp(CODER_REL.replace(/\./g, '\\.')), 'no denial names the attested path');
    assert.equal(existsSync(latchPath(dir)), false, 'and no taint latch is created: an exactly-attested (B) surface is not an incident (Rulings 7-9)');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC5 — PRODUCER INTEGRATION (do not skip — the hollow-test trap named in
// decision fac9a69b). Drives the REAL `node scripts/enforcement-stamp.mjs`
// CLI, never a handwritten-JSON-only fixture.
//
// EXPECTED FAILURE SHAPE (RED): per fac9a69b's GAP 1 (a decision record, cited
// as spec — not a code read), the producer's `allDirtyPaths` runs plain
// `git status --porcelain -z` with no `--ignored`; every (B) path is
// gitignored, so with ONLY a (B) path dirty, git sees a clean tree and the
// CLI refuses ("nothing to attest", per enforcement.test.mjs's own pin) and
// writes NO stamp file at all. `assert.equal(existsSync(stampPath(dir)), true)`
// fires (actual: false).
//
// SABOTAGE (post-fix): revert the producer's discovery back to git-status-only
// (drop the BASELINE_GLOBS enumeration Ruling 1 adds) — the entry lookup
// returns undefined and `assert.ok(entry, ...)` fires.
// ===========================================================================
test('AC5: the enforcement-stamp producer CLI enumerates a dirty (B) path and attests its CURRENT bytes (not just git-visible dirt)', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const coder = coderPath(dir);
    writeFileSync(coder, Buffer.from('# dirtied (B) content, no tracked dirt anywhere else\n'));
    assert.equal(git(dir, ['status', '--porcelain']).stdout.trim(), '', 'PRECONDITION: git sees a fully clean tracked tree — the ONLY dirt is the gitignored (B) path');

    const r = runStampCli(dir);
    assert.equal(existsSync(stampPath(dir)), true, `the producer must emit a stamp attesting the (B) path even though git status is clean — CLI exit ${r.status}, output: ${oneLine((r.stdout || '') + (r.stderr || ''))}`);

    const stamp = JSON.parse(readFileSync(stampPath(dir), 'utf8'));
    const entry = Array.isArray(stamp) ? stamp.find((e) => e.path === CODER_REL) : undefined;
    assert.ok(entry, `the stamp must carry an entry for ${CODER_REL} — got: ${JSON.stringify(stamp)}`);
    assert.equal(entry.sha256, sha256Of(coder), 'the attested hash matches the (B) path\'s CURRENT bytes');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC6 — FAIL-CLOSED IS "NO EXEMPTION", NOT "DENY EVERYTHING". CONTROL arms
// (placed FIRST, per stamp shape) prove an unusable stamp does not by itself
// deny an UNCHANGED (B) surface; DENY arms (placed after) prove the same
// unusable stamp shapes deny a CHANGED (B) path with no attestation route.
// ===========================================================================

const STAMP_SHAPES = [
  ['ABSENT', null],
  ['CORRUPT', CORRUPT_STAMP],
  ['OVERSIZE', bigBuffer(OVERSIZE_STAMP_BYTES, 0x2a)],
];

// CONTROLs — EXPECTED: most plausibly GREEN today (an unrelated/unusable
// stamp with nothing changed about the (B) path should not matter under
// today's Pre/Post-compare-then-restore-on-change logic either). Kept as
// controls, not treated as required-red, per the h17-bounded-io convention.
//
// SABOTAGE (each): make the hook deny whenever the stamp is unusable
// regardless of whether the (B) surface changed — the ALLOW assertion flips
// to DENY (actual 2, not 0).
for (const [label, bytes] of STAMP_SHAPES) {
  test(`AC6-CONTROL-${label}: an ${label} stamp with an UNCHANGED (B) surface still ALLOWS, without consulting the stamp`, { skip: GIT_SKIP }, () => {
    const { dir, cleanup } = makeGitProject();
    try {
      const coder = coderPath(dir);
      const original = readFileSync(coder);
      if (bytes !== null) {
        mkdirSync(dirname(stampPath(dir)), { recursive: true });
        writeFileSync(stampPath(dir), bytes);
      }
      const L = lane(`ac6-control-${label.toLowerCase()}`);
      assert.equal(h17(dir, 'PreToolUse', L).code, 0, `Pre with a ${label} stamp present`);

      const r = h17(dir, 'PostToolUse', L); // nothing touches the (B) path
      assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
      assert.equal(r.code, 0, `CONTROL: an ${label} stamp must not deny an UNCHANGED (B) surface — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
      assert.deepEqual(readFileSync(coder), original, 'the untouched (B) path survives byte-identical');
    } finally {
      cleanup();
    }
  });
}

// DENYs — EXPECTED FAILURE SHAPE (RED): today's restore-bytes (B) arm most
// plausibly still denies (2) for a changed path regardless of stamp shape,
// but RESTORES to `original` — so the byte-identity assertion (kept as
// `newBytes`, left in place) fires. Disclosed rather than asserted as fact,
// per the sibling PIN5 idiom (this author cannot execute the suite).
//
// SABOTAGE (each): treat an unusable stamp as an implicit exemption (fail
// open) — the DENY flips to ALLOW (actual 0, not 2); or keep restoring
// bytes on deny — the kept-bytes assertion fires.
for (const [label, bytes] of STAMP_SHAPES) {
  test(`AC6-DENY-${label}: a CHANGED (B) path with an ${label} stamp DENIES and leaves the command's bytes in place (no exemption possible)`, { skip: GIT_SKIP }, () => {
    const { dir, cleanup } = makeGitProject();
    try {
      const coder = coderPath(dir);
      if (bytes !== null) {
        mkdirSync(dirname(stampPath(dir)), { recursive: true });
        writeFileSync(stampPath(dir), bytes);
      }
      const L = lane(`ac6-deny-${label.toLowerCase()}`);
      assert.equal(h17(dir, 'PreToolUse', L).code, 0, `Pre with a ${label} stamp present`);

      const newBytes = Buffer.from(`# tampered in-window, only a ${label} stamp exists\n`);
      writeFileSync(coder, newBytes);

      const r = h17(dir, 'PostToolUse', L);
      assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
      assert.equal(r.code, 2, `a ${label} stamp gives NO exemption to a CHANGED (B) path — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
      assert.deepEqual(readFileSync(coder), newBytes, 'the bytes are LEFT EXACTLY AS THE COMMAND WROTE THEM — never restored');
      assert.match(oneLine(r.stderr), new RegExp(CODER_REL.replace(/\./g, '\\.')), 'the denial names the specific (B) path');
    } finally {
      cleanup();
    }
  });
}

// ===========================================================================
// AC7 — ONE-CALL SELF-ATTESTATION FORGERY. A single Bash call that changes a
// (B) file AND writes a matching forged stamp in the SAME window must DENY;
// the forged stamp must never be honoured in that same Post (ordering:
// stamp-integrity check precedes the exemption consult), and the forged
// stamp is invalidated (deleted) before the hook returns.
//
// EXPECTED FAILURE SHAPE (RED): no ordering/invalidation discipline exists
// today — the stamp is simply never consulted for (B), so the change is
// unconditionally restored (byte-identity assertion fires, reverted not
// kept-as-newBytes) and the forged stamp file is left untouched on disk
// (`existsSync(stampPath(dir))` fires, actual true not false).
//
// SABOTAGE: consult the exemption BEFORE checking whether the stamp itself
// changed within the window — the forged stamp gets honoured (code flips to
// 0); or skip invalidating a stamp written/changed within the window — the
// existsSync(false) assertion fires.
// ===========================================================================
test('AC7: a single call that both tampers a (B) path and writes a matching forged stamp is DENIED — the forged stamp is not honoured and is invalidated', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const coder = coderPath(dir);
    const L = lane('ac7-forge-onecall');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0);
    assert.equal(existsSync(stampPath(dir)), false, 'PRECONDITION: no stamp exists at Pre');

    const newBytes = Buffer.from('# tampered AND self-attested in the same window\n');
    writeFileSync(coder, newBytes);
    writeStamp(dir, [{ path: CODER_REL, sha256: sha256OfBytes(newBytes), at: NOW }]); // forged self-attestation

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `a forged same-window self-attestation must NOT be honoured — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    assert.deepEqual(readFileSync(coder), newBytes, 'the (B) bytes are left exactly as the command left them (denied, not restored)');
    assert.match(oneLine(r.stderr), new RegExp(CODER_REL.replace(/\./g, '\\.')), 'the denial names the (B) path');
    assert.equal(existsSync(stampPath(dir)), false, 'the forged in-window stamp is INVALIDATED (deleted) before the hook returns');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC8 — TWO-CALL LAUNDERING, REWRITTEN 2026-08-29 TO THE ADOPTION CLOSURE
// (decision bcd2cc09, RULINGS 7-11). Call N writes ONLY a forged stamp (no (B)
// change) -> DENY, the forged stamp is invalidated, AND the incident is
// LATCHED. Call N+1 is then DENIED AT PRE, BEFORE EXECUTION, BY THE LATCH.
//
// WHY THE OLD SHAPE IS RETIRED. It asserted that call N+1's Pre ALLOWS and
// that the laundering attempt was caught only afterwards, at Post. That is
// EXACTLY the adoption point decision bcd2cc09 exists to close: a denial with
// no cross-call consequence lets the next call's Pre re-collect whatever the
// last one left and carry on. Under Rulings 6-9 the incident is durable —
// `stampTampered` latches unconditionally (`invalidateStamp` is best-effort,
// and a command that tried to manufacture its own attestation is an incident
// whether or not the deletion succeeded) — and while the latch stands EVERY
// subsequent agent tool call is denied BEFORE it runs. So call N+1's command
// never executes, and this test must not simulate its execution: no Post, and
// no (B) write, after a denied Pre.
//
// EXPECTED FAILURE SHAPE (RED): against HEAD there is no latch mechanism at
// all. Two assertions fire, in order: (1) after call N,
// `existsSync(latchPath(dir))` comes back false where true is asserted; (2)
// call N+1's `pre2.code` comes back 0 (Pre adopts the state and allows) where
// 2 is asserted. Assertion (2) is the headline — it is the executable
// statement of "the adoption point is closed". Note per anti-pattern f1d66bef
// that (1) firing MASKS (2): when this goes red, fix the first and re-run
// before concluding anything about the second.
//
// WHICH GUARD CARRIES THE VERDICT: two distinct guards, one assertion each,
// and neither is defence-in-depth for the other.
// SABOTAGE (a) — restrict latch creation to `baselineDenied` /
// `unauthorizedAdditions` and skip it on `stampTampered` (Ruling 9's named
// mistake): the post-call-N `existsSync(latchPath(dir))` assertion flips true
// -> false. Sibling AC-L1/AC-L2 in h17-b-taint-latch.test.mjs stay green,
// which is what makes this arm's coverage specific rather than redundant.
// SABOTAGE (b) — with the latch still created, drop the latch consult at Pre
// (the "deny before execution while latched" check): `pre2.code` flips 2 -> 0,
// reproducing the original defect exactly while (a) stays fixed.
// ===========================================================================
test('AC8: call N forges ONLY a stamp (denied + invalidated + LATCHED); call N+1 is DENIED AT PRE by the latch — the adoption point is closed', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const coder = coderPath(dir);
    const originalBytes = readFileSync(coder);
    const futureBytes = Buffer.from('# the bytes the agent intended to launder in call N+1\n');
    const forgedHash = sha256OfBytes(futureBytes);

    assert.equal(existsSync(latchPath(dir)), false, 'PRECONDITION: no latch exists before call N');
    assert.equal(existsSync(stampPath(dir)), false, 'PRECONDITION: no stamp exists before call N');

    // --- call N: forge ONLY the stamp, no (B) change ---
    // CONTROL ARM, PLACED FIRST, passing for the OPPOSITE reason: this same
    // fixture, this same lane shape, this same read-only command ALLOWS at Pre
    // while no incident is on record. Without it, call N+1's Pre denial below
    // could equally be explained by "this fixture/mode denies every Pre".
    const L1 = lane('ac8-launder-calln');
    const pre1 = h17(dir, 'PreToolUse', L1);
    assert.notEqual(pre1.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(pre1.code, 0, `CONTROL: with no incident on record, Pre must ALLOW — actual ${pre1.code}, stderr: ${oneLine(pre1.stderr)}`);

    writeStamp(dir, [{ path: CODER_REL, sha256: forgedHash, at: NOW }]); // a FUTURE hash: the dead pre-authorization shape, forged in-window

    const r1 = h17(dir, 'PostToolUse', L1);
    assert.notEqual(r1.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r1.code, 2, `call N: an in-window stamp write with no corresponding (B) change must deny — actual ${r1.code}, stderr: ${oneLine(r1.stderr)}`);
    assert.equal(existsSync(stampPath(dir)), false, 'call N: the forged stamp is INVALIDATED (deleted) before Post returns');
    assert.deepEqual(readFileSync(coder), originalBytes, 'call N: the (B) path itself was never touched');
    assert.equal(existsSync(latchPath(dir)), true, 'call N: a stamp tamper is an INCIDENT IN ITS OWN RIGHT — the durable taint latch is set (Ruling 9: latch EVERY stampTampered, invalidation succeeded or not)');

    // --- call N+1: THE ADOPTION CLOSURE. Denied BEFORE execution, at Pre. ---
    const L2 = lane('ac8-launder-calln1');
    const pre2 = h17(dir, 'PreToolUse', L2);
    assert.notEqual(pre2.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(
      pre2.code,
      2,
      `THE ADOPTION CLOSURE: with the surface latched by call N, call N+1 is denied BEFORE EXECUTION even though nothing has changed in its own window — the laundering command never gets to run. Against the pre-latch behaviour this Pre ALLOWS and the forged hash reaches disk. Actual ${pre2.code}, stderr: ${oneLine(pre2.stderr)}`
    );
    assert.match(oneLine(pre2.stderr), /taint|latch/i, 'the denial names the ONGOING taint, not a fresh (B) violation (there is none in this window)');

    // Deliberately NO Post and NO (B) write for call N+1: a denied Pre means the
    // command never ran, so writing futureBytes here would assert against a state
    // production can never reach.
    assert.deepEqual(readFileSync(coder), originalBytes, 'call N+1 never executed: the (B) path still holds its original bytes and the forged hash was never realized on disk');
    assert.equal(existsSync(latchPath(dir)), true, 'the latch SURVIVES an ordinary call — only a separate conductor reconciliation clears it, never an ordinary Pre/Post and never the stamp producer (Rulings 3/5/10)');
    assert.equal(existsSync(stampPath(dir)), false, 'and no stamp has reappeared to attest anything');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC9 — a stamp change inside a window with NO (B) change at all is DENIED
// and INVALIDATED, proving the stamp path itself is protected (it is
// currently in neither the (A) ENFORCEMENT_SURFACE nor (B) BASELINE_GLOBS,
// per decision fac9a69b's RESIDUAL note).
//
// EXPECTED FAILURE SHAPE (RED): the stamp path is entirely unprotected today
// — writing to it in-window is not flagged at all, so with nothing else
// changed the call is most plausibly ALLOWED (`assert.equal(r.code, 2)`
// fires, actual 0) and the stamp file survives (`existsSync(...)` fires,
// actual true not false).
//
// SABOTAGE: leave the stamp path outside both protected sets — the deny
// flips to allow and the invalidation never happens.
// ===========================================================================
test('AC9: a stamp change inside a window with NO (B) change at all is DENIED and the stamp is invalidated — the stamp path itself is protected', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const coder = coderPath(dir);
    const originalBytes = readFileSync(coder);
    const L = lane('ac9-stamponly');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0);
    assert.equal(existsSync(stampPath(dir)), false, 'PRECONDITION: no stamp exists at Pre');

    // a "correct-looking" stamp (attests the CURRENTLY unchanged bytes) written
    // strictly inside the window — even self-consistent, it is untrusted here.
    writeStamp(dir, [{ path: CODER_REL, sha256: sha256Of(coder), at: NOW }]);

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `an in-window stamp write with no (B) change must still deny — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    assert.match(oneLine(r.stderr), /enforcement-stamp\.json/, 'the denial names the STAMP path itself');
    assert.equal(existsSync(stampPath(dir)), false, 'the in-window stamp write is INVALIDATED (deleted)');
    assert.deepEqual(readFileSync(coder), originalBytes, 'the (B) path itself was never touched — the deny is about the stamp, not a false-flagged (B) change');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC10 — NEGATIVE PIN, REPLACING A NOW-FORBIDDEN PROPERTY (2026-08-29,
// decision bcd2cc09 RULING 4 + the pre-authorization ruling).
//
// WHAT WAS RETIRED, AND WHY. This slot used to assert that "a future stamp
// survives a quiet window without denial": a stamp naming bytes that were NOT
// on disk was written between windows, sat through a completed quiet window,
// and then EXEMPTED the agent's own write of those bytes. That property is now
// FORBIDDEN, not merely unpinned. A stamp naming bytes that are not on disk is
// a BEARER CAPABILITY — an authorization token for a future write — and the
// sanctioned producer cannot emit one, because it enumerates the live (B)
// members and hashes their CURRENT bytes. The conductor's normal workflow does
// not need pre-authorization: the conductor edits (B) itself and then attests
// the complete resulting state (that is AC4-TREATMENT above).
//
// WHAT IS PINNED INSTEAD: a manifest naming a hash that DISAGREES with disk
// DENIES while the disagreement stands, and it does so on an ORDINARY call
// with NOTHING changed inside the window — Ruling 4's "compare the current (B)
// set against the stamp on EVERY call, not only after an in-window
// difference".
//
// CAUSE ISOLATION — THIS IS THE DISCRIMINATION THAT MATTERS. A denial here
// could in principle be produced by three different guards, and only one of
// them is this pin's subject:
//   (i) THE HASH-MISMATCH ARM (the subject) — a stamped path whose hash does
//       not match its current bytes.
//   (ii) the MISSING-PATH arm — a current (B) path absent from the stamp.
//        ISOLATED OUT by construction: the manifest is COMPLETE (one entry per
//        current (B) member) and an explicit FIXTURE SELF-CHECK below asserts
//        both that every stamped path exists on disk and that EXACTLY ONE
//        entry disagrees. Without that, the test would pass identically under
//        an implementation that only ever checks for missing paths.
//   (iii) the IN-WINDOW STAMP-TAMPER arm (AC9) — isolated out because the
//        stamp is written BEFORE Pre, never inside the window, and the (B)
//        files are never touched at all.
// The CONTROL that must pass for the OPPOSITE reason is AC4-TREATMENT above,
// which appears EARLIER in this file: same fixture, same complete manifest,
// same do-nothing window, but every hash agreeing — and it must ALLOW. The two
// together are what make a green here mean "the exact-manifest comparison ran
// and found a hash mismatch", rather than "a stamp being present denies".
//
// EXPECTED FAILURE SHAPE (RED): HEAD consults the stamp for (B) only AFTER
// detecting an in-window difference, and there is none here, so the call is
// allowed without the manifest ever being compared — the deny assertion fires
// with actual 0.
//
// SABOTAGE (the load-bearing guard): revert the (B) stamp consult to fire
// ONLY when an in-window difference was detected (Ruling 4's own named
// mistake), or drop the per-entry hash comparison while keeping the set
// comparison — either flips this deny back to an allow. NOTE the second one is
// the specific guard this arm names: the set-exactness guard alone does NOT
// carry this verdict, because the manifest here is set-exact.
// ===========================================================================
test('AC10: a COMPLETE manifest whose entry hash DISAGREES with the bytes on disk DENIES while the disagreement stands, with nothing changed in-window', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const coder = coderPath(dir);
    const onDisk = readFileSync(coder);
    const neverWrittenBytes = Buffer.from('# bytes that are NOT on disk — a stamp naming them would be a bearer capability\n');
    assert.notDeepEqual(onDisk, neverWrittenBytes, 'PRECONDITION: the stamped hash really is the hash of bytes that are NOT on disk');

    // A COMPLETE manifest — every CURRENT (B) member present — in which exactly
    // one entry's hash disagrees with disk. Written BEFORE Pre, so it is not an
    // in-window stamp tamper either.
    const manifest = fullAttestedStamp(dir).map((e) => (e.path === CODER_REL ? { ...e, sha256: sha256OfBytes(neverWrittenBytes) } : e));
    writeStamp(dir, manifest);

    assert.deepEqual(
      manifest.map((e) => e.path).sort(),
      [CODER_REL, CONFIG_REL, SETTINGS_REL].sort(),
      'FIXTURE SELF-CHECK: the manifest is SET-EXACT against the current (B) surface — the missing-path arm cannot be what fires'
    );
    for (const e of manifest) {
      assert.equal(existsSync(join(dir, e.path)), true, `FIXTURE SELF-CHECK: every stamped path exists on disk (${e.path})`);
    }
    assert.equal(
      manifest.filter((e) => e.sha256 !== sha256Of(join(dir, e.path))).length,
      1,
      'FIXTURE SELF-CHECK: EXACTLY ONE entry disagrees with disk — the isolation this pin rests on'
    );

    const L = lane('ac10-hash-disagreement');
    const pre = h17(dir, 'PreToolUse', L);
    assert.notEqual(pre.code, 1, 'a security gate never fails with a non-blocking exit 1 (Pre)');

    // PHASE-AGNOSTIC ON PURPOSE, and FLAGGED as an ambiguity rather than guessed:
    // Ruling 4 says the comparison runs on EVERY CALL; it does not say whether the
    // (B) manifest verdict lands at Pre or at Post. Pinning a phase the ruling
    // does not name would make this test go red for a reason that is not a defect.
    // Post therefore runs ONLY if Pre allowed — never simulate execution after a
    // denied Pre.
    const post = pre.code === 2 ? null : h17(dir, 'PostToolUse', L);
    if (post) assert.notEqual(post.code, 1, 'a security gate never fails with a non-blocking exit 1 (Post)');
    const denied = post ?? pre;
    assert.equal(
      denied.code,
      2,
      `A manifest entry disagreeing with disk must DENY on an ordinary call, with nothing changed in-window (Ruling 4: compared on EVERY call, not only after an in-window difference) — Pre ${pre.code}, Post ${post ? post.code : 'not run (Pre denied)'}, stderr: ${oneLine(denied.stderr)}`
    );
    assert.match(oneLine(denied.stderr), new RegExp(CODER_REL.replace(/\./g, '\\.')), 'the denial names the DISAGREEING path specifically, not merely "a stamp problem"');
    assert.deepEqual(
      readFileSync(coder),
      onDisk,
      'and H17 takes NO write action: the disk bytes are never "corrected" to match the manifest — a stamp is an OBSERVATION of current state, never an instruction to produce it'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC11 — HARDLINK REGRESSION PIN. A (B) path replaced by a hardlink to a
// victim file OUTSIDE the protected set must be DENIED, and H17 must take NO
// write action on it at all (consistent with detect-and-deny/no-restore):
// the victim's bytes, the leaf's bytes, and the shared inode/link
// relationship must all survive Post untouched. Asserting only "victim
// inode untouched" is insufficient (a no-op hook passes that trivially) — the
// denial-reported and link-relationship assertions rule that out.
//
// CONTROL (placed first, no H17 involved, faithful copy of
// scripts/tests/h17-read-blob-restore.test.mjs's T11 CONTROL ~line 853):
// proves truncate-in-place through a hardlinked leaf really does clobber the
// linked outside file ON THIS HOST — without it a green TREATMENT is
// unfalsifiable (it would pass identically if hardlinks don't work here).
//
// EXPECTED FAILURE SHAPE (RED, disclosed as uncertain — this author cannot
// execute the suite, matching the sibling PIN5 idiom): today's (B) arm
// attempts a RESTORE of the pre-call bytes for a detected change. If that
// restore writes through the (now-hardlinked) path via truncate-in-place, the
// VICTIM's bytes get clobbered with the original coder.md content — the
// `deepEqual(readFileSync(victim), distinctiveBytes)` assertion fires. If
// instead restore unlinks+recreates a fresh inode, the shared-inode assertion
// fires (the leaf no longer links to the victim). Either sub-assertion firing
// is a valid red signal for this pin; the conductor should confirm which one
// fires once red.
//
// SABOTAGE: take ANY write action on a detected (B) change instead of pure
// detect-and-deny — e.g. a "helpful" unlink+recreate (breaks the link
// relationship — the ino/nlink assertion fires) or a truncate-in-place
// "restore" (clobbers the victim — the byte-identity assertions fire).
// ===========================================================================

const HARDLINK_SKIP = (() => {
  let outsideProbe;
  let targetProbe;
  try {
    outsideProbe = mkdtempSync(join(tmpdir(), 'sterling-h17-bdad-hlprobe-outside-'));
    targetProbe = mkdtempSync(join(tmpdir(), 'sterling-h17-bdad-hlprobe-target-'));
    const a = join(outsideProbe, 'a.txt');
    const b = join(targetProbe, 'b.txt');
    writeFileSync(a, 'x');
    try {
      linkSync(a, b);
    } catch (e) {
      if (e.code === 'EXDEV') {
        throw new Error(
          `BROKEN FIXTURE (not a skip): the outside-victim dir (${outsideProbe}) and the ephemeral git-project temp shape (${targetProbe}) are on DIFFERENT devices — link() failed EXDEV. Both are meant to be tmpdir() siblings; fix the directory placement rather than letting this skip silently.`
        );
      }
      throw e;
    }
    const ok = statSync(b).nlink >= 2 && statSync(a).ino === statSync(b).ino;
    return ok
      ? false
      : `hard links are not supported between ${outsideProbe} and ${targetProbe} on this host/filesystem — the hardlink fixture cannot be constructed`;
  } catch (e) {
    if (typeof e.message === 'string' && e.message.startsWith('BROKEN FIXTURE')) throw e; // never swallow — must fail loudly, never skip
    return `hard links are not supported on this host (${e.code ?? e.message})`;
  } finally {
    if (outsideProbe) rmSync(outsideProbe, { recursive: true, force: true });
    if (targetProbe) rmSync(targetProbe, { recursive: true, force: true });
  }
})();

test('AC11 CONTROL: on this host, truncate-in-place through a hardlinked leaf really does clobber the linked outside file (no H17 involved)', { skip: GIT_SKIP || HARDLINK_SKIP }, () => {
  const probeDir = mkdtempSync(join(tmpdir(), 'sterling-h17-bdad-hlcontrol-'));
  const outsideDir = mkdtempSync(join(tmpdir(), 'sterling-h17-bdad-hlcontrol-outside-'));
  try {
    const outsideFile = join(outsideDir, 'outside-control.bin');
    const distinctiveBytes = Buffer.from('AC11-CONTROL-DISTINCTIVE-OUTSIDE-BYTES-DO-NOT-TOUCH\n');
    writeFileSync(outsideFile, distinctiveBytes);

    const leaf = join(probeDir, 'leaf.txt');
    linkSync(outsideFile, leaf);

    const fd = openSync(leaf, fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW);
    const newBytes = Buffer.from('CLOBBERED-BY-TRUNCATE-IN-PLACE\n');
    try {
      ftruncateSync(fd, 0);
      writeSync(fd, newBytes, 0, newBytes.length, 0);
    } finally {
      closeSync(fd);
    }

    const after = readFileSync(outsideFile);
    assert.ok(!after.equals(distinctiveBytes), 'CONTROL: writing through a hardlinked leaf via truncate-in-place must actually change the OUTSIDE file bytes on this host, or AC11 proves nothing');
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('AC11: a (B) path replaced by a HARDLINK to an outside victim is DENIED, and H17 takes NO write action — victim, leaf and link survive', { skip: GIT_SKIP || HARDLINK_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  const outsideDir = mkdtempSync(join(tmpdir(), 'sterling-h17-bdad-outside-'));
  try {
    const leaf = coderPath(dir);
    const victim = join(outsideDir, 'victim.bin');
    const distinctiveBytes = Buffer.from('AC11-DISTINCTIVE-OUTSIDE-BYTES-DO-NOT-TOUCH\n');
    writeFileSync(victim, distinctiveBytes);

    const L = lane('ac11-hardlink');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre observes the ordinary (B) baseline');

    // the attack: replace the (B) leaf with a hardlink to an outside victim.
    rmSync(leaf, { force: true });
    linkSync(victim, leaf);
    assert.equal(statSync(leaf).ino, statSync(victim).ino, 'PRECONDITION: the (B) leaf now shares the victim\'s inode');

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `a (B) path aliased to an outside victim via hardlink must deny — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    assert.match(oneLine(r.stderr), new RegExp(CODER_REL.replace(/\./g, '\\.')), 'the denial names the (B) path');

    assert.deepEqual(readFileSync(victim), distinctiveBytes, 'THE LOAD-BEARING PROPERTY: the VICTIM\'s bytes are unchanged — H17 took no write action through the shared inode');
    assert.deepEqual(readFileSync(leaf), distinctiveBytes, 'the protected leaf\'s bytes are unchanged too (same inode, but checked independently per the task instruction)');
    assert.equal(statSync(leaf).ino, statSync(victim).ino, 'the leaf still shares the victim\'s inode after Post — H17 neither restored (fresh inode) nor truncated in place');
    assert.ok(statSync(leaf).nlink >= 2, 'the hardlink relationship itself survives — a no-op-equivalent unlink+recreate would also break this');
  } finally {
    rmSync(outsideDir, { recursive: true, force: true });
    cleanup();
  }
});
