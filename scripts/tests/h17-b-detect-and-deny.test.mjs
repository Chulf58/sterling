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

// DELETED S4: stampPath's own file (.sterling/transient/enforcement-stamp.json)
// no longer exists as a concept, but the function itself stays — AC1/AC2/AC3
// below still assert its PRECONDITION absence (harmlessly and trivially true
// now, since nothing ever creates it), and those tests are left untouched per
// this slice's disposition.
function stampPath(dir) {
  return join(dir, '.sterling', 'transient', 'enforcement-stamp.json');
}

function sha256Of(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function coderPath(dir) {
  return join(dir, '.claude', 'agents', 'coder.md');
}

const CODER_REL = '.claude/agents/coder.md';

const SETTINGS_REL = '.claude/settings.local.json';
const CONFIG_REL = '.sterling/config.json';

function settingsPath(dir) {
  return join(dir, '.claude', 'settings.local.json');
}

function configJsonPath(dir) {
  return join(dir, '.sterling', 'config.json');
}

// ---------------------------------------------------------------------------
// ADDED S4 — decision `b-baseline-hash-list-concrete-design` (fe861066), D1:
// the persistent (B) baseline hash list at .sterling/enforcement-baseline.json
// replaces the stamp manifest as the cross-call comparator. Shape:
// {version: exactly 1, minted_at (diagnostic only), entries: [{path, sha256}]
// SORTED ASCENDING BY PATH}. This helper mints a valid list by hand — driving
// the real clearer (scripts/enforcement-reconcile.mjs) end-to-end lives in
// h17-b-baseline-list.test.mjs, not here.
// ---------------------------------------------------------------------------
function baselineListPath(dir) {
  return join(dir, '.sterling', 'enforcement-baseline.json');
}

function writeBaselineList(dir, entries) {
  const sorted = [...entries].map(({ path, sha256 }) => ({ path, sha256 })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  writeFileSync(baselineListPath(dir), JSON.stringify({ version: 1, minted_at: NOW, entries: sorted }));
}

// A COMPLETE list, hashing the bytes that are ON DISK RIGHT NOW — the only
// thing the sanctioned clearer can emit (it enumerates every live (B) member
// via BASELINE_GLOBS and hashes its CURRENT bytes; a list naming a hash that
// disagrees with disk is never legitimately mintable, only forged).
function fullBaselineEntries(dir) {
  return [
    { path: CODER_REL, sha256: sha256Of(coderPath(dir)) },
    { path: SETTINGS_REL, sha256: sha256Of(settingsPath(dir)) },
    { path: CONFIG_REL, sha256: sha256Of(configJsonPath(dir)) },
  ];
}

// THE LATCH — Ruling 7: `.sterling/enforcement-taint.json`, a plain file,
// deliberately outside the sealed DB and outside BASELINE_GLOBS. Presence alone
// is the verdict; it is cleared ONLY by a separate conductor reconciliation.
function latchPath(dir) {
  return join(dir, '.sterling', 'enforcement-taint.json');
}

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
    // dc616f69 (2026-08-30): the (A) arm now emits an explicit NON-action
    // DISCLAIMER — "NOTHING WAS REVERTED" — as part of its own detect-and-deny
    // wording. This fixture is (B)-only (`.claude/agents/` is gitignored, so the
    // (A) git-status sweep never sees it) and should not carry that sentence at
    // all; the strip below makes the assertion say what it MEANS — no ACTION
    // CLAIM — so a co-firing message could never satisfy it by accident nor fail
    // it for stating the truth. Strength is unchanged: a disclaimer that nothing
    // was reverted is the opposite of a false claim that something was.
    // LITERAL disclaimer only (security review LOW): an unbounded uppercase-run
    // mask would also swallow a genuine all-caps false claim beside it.
    const err = oneLine(r.stderr).replace(/NOTHING WAS REVERTED/g, ' ');
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
// AC4-CONTROL: the exact same target bytes, with no persistent baseline list
// present at all, must still DENY.
// AC4-TREATMENT (REWORKED S4 — decision `b-baseline-hash-list-concrete-design`,
// fe861066, superseding the retired stamp-manifest shape this test used to
// exercise): the SANCTIONED WORKFLOW — the (B) bytes are already at their
// current value, a persistent baseline list at .sterling/enforcement-
// baseline.json exact-matches the WHOLE current (B) set, and an agent window
// that changes nothing ALLOWS.
//
// WHY THE FIXTURE CHANGED. The old fixture minted the list-equivalent via
// scripts/enforcement-stamp.mjs (a per-call, forgeable "stamp"); that whole
// apparatus is deleted (decision 78dc9bd6/fe861066) in favour of a plain,
// persistent hash list minted ONLY by the clearer
// (scripts/enforcement-reconcile.mjs), conductor-gated. This test hand-writes
// the list file directly — driving the real clearer end-to-end is out of
// scope for this suite (it lives in scripts/tests/h17-b-baseline-list.test.mjs)
// — but the property pinned is unchanged: THE CONDUCTOR edits (B) itself, then
// a COMPLETE, exact-matching baseline list is on disk, and a later agent
// window that changes nothing then allows.
//
// EXPECTED: CONTROL is most plausibly GREEN today (today's (B) arm denies on
// any change, attested or not — there is no exemption route yet at all).
// TREATMENT is most plausibly GREEN today TOO, and deliberately so: with
// nothing changed in-window it allows on HEAD without any list ever being
// opened. Its job is to pin that the persistent list comparator does not
// FALSELY DENY the conductor's normal workflow once it lands. DISCLOSED
// HONESTLY: an ALLOW here has two possible causes — "the list was validated
// and found exact" and "nothing changed in-window, so the list was never
// consulted" — and this test alone cannot tell them apart. The discriminator
// lives in h17-b-baseline-list.test.mjs (a list that disagrees with disk must
// DENY with nothing changed in-window).
//
// SABOTAGE (CONTROL): disable (B) checking entirely (always allow) — CONTROL
// flips from deny (2) to allow (0), which is exactly the "checking disabled"
// hypothesis this control rules out.
// SABOTAGE (TREATMENT): invert the exact-list verdict — make the presence of a
// baseline list, or an exact set/hash match, DENY instead of attest. The allow
// flips to deny, which is the false-denial-of-the-sanctioned-workflow failure
// this pin exists to catch. NOTE, stated plainly rather than overclaimed: this
// test does NOT go red under "never consult the list for (B)" — that mutation
// is h17-b-baseline-list.test.mjs's CONTROL to catch, not this one's.
// ===========================================================================
const AC4_NEW_BYTES = Buffer.from('---\nname: attested-change\n---\n# (B) content the conductor pre-authorized\n');

test('AC4-CONTROL: a (B) modify with NO baseline list present is DENIED (proves checking is not disabled)', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const coder = coderPath(dir);
    const L = lane('ac4-control');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0);
    assert.equal(existsSync(baselineListPath(dir)), false, 'PRECONDITION: no baseline list exists for this arm');
    writeFileSync(coder, AC4_NEW_BYTES);

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `CONTROL: an unattested (B) change must deny — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
  } finally {
    cleanup();
  }
});

test('AC4-TREATMENT: the SANCTIONED WORKFLOW — a COMPLETE persistent baseline list attesting the whole CURRENT (B) set, and an agent window that changes nothing, ALLOWS and keeps the conductor\'s bytes', { skip: GIT_SKIP }, () => {
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

    // STEP 2 — the persistent baseline list now exact-matches every live (B)
    // member's CURRENT bytes (decision fe861066 D1: {version:1, minted_at,
    // entries: sorted ascending by path}). writeBaselineList sorts for us.
    writeBaselineList(dir, fullBaselineEntries(dir));
    assert.deepEqual(
      fullBaselineEntries(dir)
        .map((e) => e.path)
        .sort(),
      [CODER_REL, CONFIG_REL, SETTINGS_REL].sort(),
      'FIXTURE SELF-CHECK: the list is COMPLETE — every current (B) member is attested, so no missing-path violation can be what this arm observes'
    );

    // STEP 3 — the agent's window changes NOTHING. An agent never writes (B).
    const L = lane('ac4-treatment');
    const pre = h17(dir, 'PreToolUse', L);
    assert.notEqual(pre.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(pre.code, 0, `Pre must allow on an exactly-attested (B) surface — actual ${pre.code}, stderr: ${oneLine(pre.stderr)}`);

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 0, `TREATMENT: an exact, COMPLETE persistent baseline list for the current (B) set must ALLOW — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
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
// DELETED S4 (decision 78dc9bd6/fe861066): AC5 (the producer-CLI test), AC6
// (the ABSENT/CORRUPT/OVERSIZE stamp-shape CONTROL+DENY families), AC7
// (one-call self-attestation forgery), AC8 (two-call stamp-forgery laundering
// — its "the adoption point is closed" property is instead pinned, via a real
// (B) file modify rather than a forged stamp, by h17-b-taint-latch.test.mjs's
// AC-L4), AC9 (the stamp path's own protection) and AC10 (a stamp hash
// disagreeing with disk) all exercised the deleted enforcement-stamp
// apparatus directly. The set-exact/mismatch comparator property AC10 pinned
// now lives in h17-b-baseline-list.test.mjs over the persistent
// .sterling/enforcement-baseline.json list instead.
// ===========================================================================

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
