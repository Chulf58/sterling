// H17 — A (B)-SURFACE PATH IS NEVER DELETED BY THE (A) SWEEP (v4.1 defect
// repair, 2026-08-27). USER RULING: an unexpected ADDITION to the protected (B)
// enforcement surface is DETECTED, DENIED and LEFT ON DISK — deleting is
// irreversible and H17 cannot tell a malicious plant from a legitimate file the
// conductor just created.
//
// THE DEFECT THESE PINS COVERED (PAST TENSE since dc616f69 / 78dc9bd6 — the (A)
// arm no longer restores or removes ANYTHING, so the route below is closed by
// deletion rather than by a guard). v4.0 deleted the (B) addition arm's unlink
// (`removeUnder`/`removeFileAt`), which closed the (B) ROUTE to the (B) surface
// and left the (A) ROUTE open:
//   1. Pre records no `.claude/agents/new.md`.
//   2. The guarded command creates it and runs `git add -f .claude/agents/new.md`.
//   3. Post's `git status --porcelain` reported it as ADDED, so it entered the (A)
//      TRACKED sweep, which ran BEFORE the (B) collection.
//   4. `isEnforcementSurface` made it an (A) violation -> `restoreTracked`.
//   5. It was NOT IN HEAD, so the not-in-HEAD arm called `removeTreeAt` — DELETING
//      the file the ruling says must survive.
//   6. The (B) collection then ran against a surface the hook had already
//      changed, so it never recorded the addition and never emitted the
//      "left on disk" disposition.
// dc616f69 R11 deleted `restoreTracked`, `removeTreeAt` and the whole restore
// chain, so steps 4-6 are unreachable. Every pin below is re-cut to the DURABLE
// oracle: DETECT, DENY, LATCH — bytes untouched on disk (dc616f69 R16).
//
// THE VERDICT CARRIER IS SURVIVAL + BYTE-IDENTITY, NEVER THE EXIT CODE.
// Measured on this exact hook: an exit-code assertion stays GREEN with the guard
// removed, because the old code DELETED the file and DENIED anyway (the path is
// an (A) violation either way). Every treatment pin below therefore asserts
// `existsSync` AND `deepEqual(readFileSync(...), plantedBytes)` and treats
// `code === 2` as a NECESSARY-BUT-INSUFFICIENT companion — a file that is
// neither deleted nor denied is a total bypass and strictly worse than the bug.
//
// CAUSE ISOLATION (control-arm discipline, controls PLACED FIRST). RE-CUT per
// dc616f69: both original controls were "deletion/restore still happens here",
// and that evidence no longer exists to be had — the sweep DID stop mutating
// anything, deliberately. The opposite-cause arm is now PIN 6: a CLEAN window
// on the same fixture must ALLOW and leave NO latch, which is what keeps every
// deny below from being explained by "this fixture denies everything".
//   * PIN 1 is a force-added file OUTSIDE the (B) surface (`hooks/newdir/…`).
//     It must STILL be DETECTED and DENIED — and now also left on disk.
//   * PIN 2 is a MODIFIED TRACKED enforcement file: the primary (A) contract
//     case, carrying the full oracle (bytes unchanged, latch written, next Pre
//     denied before re-baselining).
//
// SABOTAGE TABLE, POST-dc616f69 (specified; mutation runs are conductor-only,
// decision 02e03ed8, and in-place mutation of scripts/hooks/** is anti-pattern
// 37b3cb0a):
//   N1  delete the `latchOnDetection`/`noteTrackedViolation` call from the (A)
//       detection site (leave the denial intact) -> PIN 2's latch-exists
//       assertion goes RED while its exit-code assertion stays green.
//   N2  drop the standing-latch consult at Pre -> PIN 2's next-Pre assertion
//       goes RED (exit 0 instead of 2) — the adoption bug reproduced.
//   N3  reintroduce ANY write to a detected (A) path (a `git checkout HEAD --`
//       on the violation set) -> PIN 2's byte-identity assertion goes RED.
//   N4  drop the (A) violation push entirely (detect nothing) -> PIN 1 and
//       PIN 2 both go RED on `code === 2`, and PIN 6 stays green — which is
//       what makes PIN 6 a control rather than a duplicate.
//
// HISTORICAL TABLE (the guards below were DELETED with the restore chain; kept
// as the record of what the pre-dc616f69 layering was, not as live sabotages).
// Rows S6-S11 were the same table carried in the hook at the `removeUnder`
// gravestone:
//   S6  strip LAYER 1 (the isEnforcementSurface early return in restoreTracked's
//       not-in-HEAD arm) -> PIN 3 STAYS GREEN (layer 2 carries it); PIN 4 green.
//   S7  strip LAYER 2 (the isEnforcementSurface refusal at the top of
//       removeTreeAt) -> PIN 3 STAYS GREEN (layer 1 carries it); PIN 4 goes RED.
//   S6/S7 ARE A DEFENCE-IN-DEPTH PAIR, NOT REDUNDANCY TO DELETE: either one
//   alone leaves PIN 3 green because the OTHER layer carries the verdict — that
//   is a correct measured result, not test hollowness, and it is NOT license to
//   remove either layer on the grounds that "its own pin stayed green after I
//   took it out". Only PIN 4 (the descendant case, which only layer 2 reaches)
//   and S8 (strip both) actually distinguish the two layers — read those before
//   concluding either guard is dead weight.
//   S8  strip BOTH -> PIN 3 RED on `existsSync(plant)`; PIN 4 RED. This is the
//       pre-v4.1 code, and it is the only single mutation that reproduces the
//       reported defect.
//   S9  keep the layers but re-order the (B) stage ahead of the (A) sweep instead
//       -> PIN 5 RED (its store is broken, so the (B) stage is skipped entirely
//       and only a path-level guard can save the file). Ordering is not a guard.
//   S10 un-gate the `rmdirSync` in removeTreeAt (rmdir even when a protected
//       descendant was kept) -> PIN 4 RED on the survivor's existence.
//   S11 push the (A)-detected survivor into `violations` instead of
//       `unauthorizedAdditions` -> PIN 3 RED on doesNotMatch(/reverted/i).
//
// HARNESS is the idiom of scripts/tests/h17-ancestor-hardening.test.mjs
// (makeGitProject, one tool_use_id per Pre/Post lane, oneLine, GIT_SKIP), copied
// rather than imported since that file exports nothing. ROOT is computed the
// same relative way as that sibling (not hardcoded) — this file was AUTHORED in
// the scratchpad because H5 denies the coder every edit under scripts/tests/**,
// but it is LANDED here as a normal repo test and must not carry a
// machine-specific absolute path forward.
//
// RUN COMMAND (node toolchain adapter):
//   node --test scripts/tests/h17-b-surface-survives-a-sweep.test.mjs

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(ROOT, 'scripts', 'hooks');
const NOW = '2026-06-10T12:00:00.000Z';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(ROOT, 'packages', 'store', 'dist', 'index.js')).href));
});

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

function porcelain(dir) {
  return git(dir, ['status', '--porcelain'], { must: true }).stdout;
}

// `ignoreClaude:false` leaves `.claude/` VISIBLE to git — the only way to make a
// not-in-HEAD DIRECTORY whose CHILDREN are (B) surface (PIN 4).
function makeGitProject({ ignoreClaude = true, seedClaude = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h17-bsurv-'));
  const runId = 'r-h17bs-' + randomUUID().slice(0, 8);

  git(dir, ['init', '-q'], { must: true });
  git(dir, ['config', 'user.email', 'h17@sterling.test'], { must: true });
  git(dir, ['config', 'user.name', 'H17 Test'], { must: true });
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.autocrlf', 'false'], { must: true });

  writeFileSync(join(dir, '.gitignore'), [...(ignoreClaude ? ['.claude/agents/', '.claude/settings.local.json'] : []), '.sterling/', ''].join('\n'));

  mkdirSync(join(dir, 'hooks'), { recursive: true });
  writeFileSync(join(dir, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [] } }, null, 2) + '\n');
  writeFileSync(join(dir, 'hooks', 'h3-contract-gate.mjs'), '// bundled enforcement hook (pristine)\nprocess.exit(0);\n');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'feature.ts'), 'export const x = 1;\n');

  git(dir, ['add', '-A'], { must: true });
  git(dir, ['commit', '-q', '-m', 'init'], { must: true });

  if (seedClaude) {
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'agents', 'coder.md'), '# coder (legit)\n');
    writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify({ hooks: 'enabled' }) + '\n');
  }

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
  store.close();

  const projectTag = createHash('sha256').update(realpathSync(dir)).digest('hex').slice(0, 16);
  const cleanup = () => {
    rmSync(dir, { recursive: true, force: true });
    let names = [];
    try {
      names = readdirSync(tmpdir());
    } catch {
      /* nothing to sweep */
    }
    for (const n of names.filter((x) => x.startsWith(`sterling-enforce-${projectTag}`))) rmSync(join(tmpdir(), n), { force: true });
  };
  return { dir, dbPath, cleanup };
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
      tool_input: { command: 'grep -rn "resolveRun" scripts/' },
      ...(event === 'PostToolUse' ? { tool_response: { stdout: '', stderr: '' } } : {}),
      ...over,
    },
    dir
  );
}

function lane(tag) {
  return { agent_id: 'a1', tool_use_id: `toolu_${tag}_${randomUUID().replace(/-/g, '').slice(0, 16)}` };
}

// dc616f69: an (A) detection now LATCHES at `.sterling/enforcement-taint.json`,
// so any fixture reused across more than one Pre/Post pair must clear it between
// cases or the later Pre is denied by the PREVIOUS case's incident.
function latchPath(dir) {
  return join(dir, '.sterling', 'enforcement-taint.json');
}

// dc616f69 R13: the new denial carries an explicit NON-action disclaimer
// ("NOTHING WAS REVERTED"). Strip the disclaimer sentence before asserting that
// no ACTION claim survives — the pin is "H17 never claims it undid anything",
// which the disclaimer STATES rather than violates. Without this the disclaimer
// itself would fire the very assertion that exists to forbid a false claim.
function actionClaims(stderr) {
  // LITERAL disclaimer only (security review LOW): an unbounded uppercase-run
  // mask would also swallow a genuine all-caps false claim sitting adjacent to
  // the disclaimer.
  return oneLine(stderr).replace(/NOTHING WAS REVERTED/g, ' ');
}

// ===========================================================================
// PIN 1 — INVERTED per dc616f69 (the (A) arm stops restoring). This arm used to
// assert the force-added file was DELETED. Nothing is deleted any more, so that
// control's discriminating power is dead BY DESIGN and cannot be restated; what
// it still controls for is that a NON-(B) enforcement-surface addition is
// DETECTED AT ALL (PIN 3's survival must not be explained by "the (A) sweep
// stopped looking"). Opposite-cause evidence moved to PIN 6.
// EXPECTED FAILURE SHAPE: `post.code === 2` fires (actual 0) if detection is
// dropped; the byte-identity assertion fires if any write to the path returns.
// SABOTAGE: reintroduce a removal of not-in-HEAD (A) paths -> the
// `existsSync(fresh) === true` assertion goes RED.
// ===========================================================================
test('PIN 1 CONTROL: a force-added file OUTSIDE the (B) surface is still DETECTED and DENIED — and now left on disk (dc616f69)', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    assert.equal(porcelain(dir), '', 'PRECONDITION: clean tree at Pre');
    const L = lane('outside-control');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre on a clean tree allows');

    mkdirSync(join(dir, 'hooks', 'newdir'), { recursive: true });
    const fresh = join(dir, 'hooks', 'newdir', 'evil.mjs');
    const freshBytes = Buffer.from('// new untracked enforcement file, created in-window\n');
    writeFileSync(fresh, freshBytes);
    git(dir, ['add', '-f', 'hooks/newdir/evil.mjs'], { must: true });
    assert.match(porcelain(dir), /A\s+hooks\/newdir\/evil\.mjs/, 'PRECONDITION: force-added and individually visible, not in HEAD');

    const post = h17(dir, 'PostToolUse', L);
    assert.notEqual(post.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(post.code, 2, `an out-of-contract addition must deny — actual ${post.code}, stderr: ${oneLine(post.stderr)}`);
    assert.equal(existsSync(fresh), true, 'dc616f69: a NON-(B) addition is DENIED and LEFT ON DISK — H17 no longer removes anything');
    assert.deepEqual(readFileSync(fresh), freshBytes, 'and left byte-identical to what the command wrote');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN 2 — INVERTED per dc616f69, and now THE PRIMARY (A) CONTRACT CASE. A
// MODIFIED TRACKED enforcement file used to be restored to HEAD's bytes; the
// ruling deletes that arm outright, because no heuristic proves authorship in a
// shared worktree, so an in-HEAD "recoverable source of truth" does not make the
// conductor's uncommitted replacement bytes recoverable. The new oracle is the
// full R16 shape: exact pre-Post bytes recorded, exit 2, bytes UNCHANGED, the
// disposition STATED, no action claim, the latch written, and the NEXT Pre
// denied BEFORE it can re-baseline the surviving bytes.
// EXPECTED FAILURE SHAPE: if any restore returns, `deepEqual(after, tampered)`
// fires with the pristine bytes on disk; if latching is dropped, the
// `existsSync(latchPath) === true` assertion fires; if the Pre consult is
// dropped, the `pre2.code === 2` assertion fires with actual 0.
// SABOTAGE (one per assertion): N3 restores the path -> byte assertion RED;
// N1 removes the latch write -> latch assertion RED; N2 removes the Pre latch
// consult -> next-Pre assertion RED. No single mutation reds all three.
// ===========================================================================
test('PIN 2 TREATMENT: a MODIFIED TRACKED enforcement file is DENIED, LATCHED and LEFT ON DISK — never HEAD-restored (dc616f69)', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const rel = 'hooks/h3-contract-gate.mjs';
    const abs = join(dir, ...rel.split('/'));
    const pristine = readFileSync(abs);
    assert.equal(porcelain(dir), '', 'PRECONDITION: clean tree at Pre');
    assert.equal(existsSync(latchPath(dir)), false, 'PRECONDITION: no latch stands before this window');
    const L = lane('modified-treatment');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre on a clean tree allows');

    const tampered = Buffer.from('// TAMPERED in-window\nprocess.exit(0);\n');
    writeFileSync(abs, tampered);
    assert.notDeepEqual(tampered, pristine, 'PRECONDITION: the command genuinely changed the bytes');
    assert.match(porcelain(dir), /hooks\/h3-contract-gate\.mjs/, 'PRECONDITION: git reports the tracked file dirty');

    const post = h17(dir, 'PostToolUse', L);
    assert.notEqual(post.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(post.code, 2, `an in-window tamper of a tracked enforcement file must deny — stderr: ${oneLine(post.stderr)}`);

    // --- THE VERDICT CARRIER: the observed state is UNCHANGED by H17 ---
    assert.deepEqual(readFileSync(abs), tampered, 'THE RULING: the bytes stay exactly as the command wrote them — H17 performs no restore (dc616f69 R11)');
    const err = oneLine(post.stderr);
    assert.match(err, /left on disk/i, 'the denial STATES the disposition — denied, and the bytes are still there');
    assert.doesNotMatch(
      actionClaims(err),
      /reverted|restored to HEAD|rolled back to/i,
      'R13: no false action claim survives once the explicit non-action disclaimer is stripped'
    );

    // --- the durable half: the incident is persisted and the next call is stopped ---
    assert.equal(existsSync(latchPath(dir)), true, 'dc616f69: the detection LATCHES eagerly at .sterling/enforcement-taint.json');
    const pre2 = h17(dir, 'PreToolUse', lane('modified-nextcall'));
    assert.notEqual(pre2.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(pre2.code, 2, `THE ADOPTION CLOSURE: while the latch stands the NEXT Pre denies BEFORE re-baselining — actual ${pre2.code}, stderr: ${oneLine(pre2.stderr)}`);
    assert.match(oneLine(pre2.stderr), /taint|latch/i, 'and it names the STANDING incident, not a fresh in-window violation');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN 3 — THE REPORTED DEFECT. `git add -f` on a NEW (B) file routes it through
// the (A) sweep. It must be DETECTED, DENIED and LEFT ON DISK BYTE-IDENTICAL.
// VERDICT CARRIER: existsSync + byte-identity. The exit code is green either
// way (measured), so it is asserted as a companion, never as the pin.
// ===========================================================================
test('PIN 3 TREATMENT: a force-added NEW (B)-surface file SURVIVES byte-identical AND the command is DENIED', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    assert.equal(porcelain(dir), '', 'PRECONDITION: clean tree at Pre — .claude/agents/new.md does not exist and is gitignored');
    const L = lane('forceadd-b');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre on a clean tree allows (and records a (B) baseline WITHOUT new.md)');

    const rel = '.claude/agents/new.md';
    const plant = join(dir, '.claude', 'agents', 'new.md');
    const plantedBytes = Buffer.from('---\nname: planted\n---\n# a file that appeared in protected (B) territory\n');
    writeFileSync(plant, plantedBytes);
    git(dir, ['add', '-f', rel], { must: true });
    assert.match(porcelain(dir), /A\s+\.claude\/agents\/new\.md/, 'PRECONDITION: force-added into the INDEX, so the (A) git-status sweep meets it FIRST');

    const post = h17(dir, 'PostToolUse', L);

    // --- the verdict carrier ---
    assert.equal(existsSync(plant), true, 'THE RULING: an unexpected (B) addition is LEFT ON DISK — the (A) sweep must never delete it');
    assert.deepEqual(readFileSync(plant), plantedBytes, 'THE RULING: LEFT BYTE-IDENTICAL — not truncated, not rewritten, not replaced');

    // --- necessary companions ---
    assert.notEqual(post.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(post.code, 2, `the addition must still be DENIED — a file neither deleted nor denied is a total bypass. stderr: ${oneLine(post.stderr)}`);
    const err = oneLine(post.stderr);
    assert.match(err, /unauthorized addition/i, 'the denial must use the ADDITION disposition wording');
    assert.match(err, /left in place on disk|left on disk/i, 'the denial must STATE the disposition — the gate denied and the file is still there');
    assert.match(err, /\.claude\/agents\/new\.md/, 'the denial must name the surviving path so a human can inspect it');
    // dc616f69 R13: the (A) section now carries an explicit "NOTHING WAS
    // REVERTED" disclaimer, so this assertion is scoped to ACTION CLAIMS via
    // actionClaims() rather than to the bare word. Same property, same strength.
    assert.doesNotMatch(actionClaims(err), /reverted|restored to HEAD/i, 'NEVER the `violations` vocabulary — claiming a revert that did not happen is a false action claim (586bccdc)');
    assert.equal(err.split('.claude/agents/new.md').length - 1, 1, 'named ONCE: both the (A) and (B) surfaces detect it, but one path is one finding');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN 4 — RETIRED per dc616f69 R16(ii), not inverted. Its entire subject was
// making the RECURSIVE DELETE safe: "the recursion keeps every (B) descendant
// while still removing a non-(B) sibling". `removeTreeAt` is deleted, so the
// survival half would pass vacuously (nothing is removed) and the discriminating
// half — `existsSync(collateral) === false` — asserts a behaviour the ruling
// removed on purpose. Inverting it produces exactly the vacuous green R16
// forbids. The remaining live property (a not-in-HEAD (B) addition survives and
// denies) is carried by PIN 3.
// ===========================================================================

// ===========================================================================
// PIN 5 — ORDERING IS NOT A GUARD (kills sabotage S9). With a CORRUPT store the
// (B) stage is skipped entirely (no runId -> no honest baseline), so nothing
// downstream of the (A) sweep can save the plant: only a PATH-LEVEL guard can.
// The file must still survive, and the call must still deny.
// ===========================================================================
test('PIN 5 TREATMENT: with a BROKEN store (the (B) stage skipped), a force-added (B) file still survives and still denies', { skip: GIT_SKIP }, () => {
  const { dir, dbPath, cleanup } = makeGitProject();
  try {
    const L = lane('forceadd-b-storeerr');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre with a working store allows');

    const plant = join(dir, '.claude', 'agents', 'new.md');
    const plantedBytes = Buffer.from('# planted while the store is about to break\n');
    writeFileSync(plant, plantedBytes);
    git(dir, ['add', '-f', '.claude/agents/new.md'], { must: true });
    writeFileSync(dbPath, 'not a database at all'); // corrupt AFTER Pre, so Post takes the storeErr path

    const post = h17(dir, 'PostToolUse', L);

    // dc616f69: since the restore chain is deleted, the survival half below is
    // now defended BY DELETION rather than by a path-level guard — it is a
    // cheap regression tripwire, and the LOAD-BEARING assertion in this block is
    // the fail-closed deny under a broken store, which no other pin here covers.
    assert.equal(existsSync(plant), true, 'the survival guarantee cannot depend on the (B) stage running — it is skipped here');
    assert.deepEqual(readFileSync(plant), plantedBytes, 'byte-identical under the degraded path too');
    assert.notEqual(post.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(post.code, 2, `a broken store fails CLOSED — stderr: ${oneLine(post.stderr)}`);
  } finally {
    cleanup();
  }
});

// ===========================================================================
// PIN 6 — THE CLEAN CONTROL (dc616f69 R16: "assert a clean control produces NO
// marker"). It replaces the deletion-based controls PIN 1 and PIN 2 used to
// carry, and it is what makes every deny above evidence rather than assertion:
// on the SAME fixture, a window that writes nothing must ALLOW at Post and leave
// NO latch behind. An implementation that denied and latched unconditionally
// would satisfy PINs 1/2/3/5 identically and fail only here.
// EXPECTED FAILURE SHAPE: `post.code === 0` fires (actual 2) or the
// `existsSync(latchPath) === false` assertion fires.
// SABOTAGE: latch unconditionally at Post (move the latch write out of the
// detection branch) -> the no-latch assertion goes RED while every other pin in
// this file stays green.
// ===========================================================================
test('PIN 6 CONTROL: a window that changes NOTHING allows and leaves NO taint latch — the denials above are not unconditional', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    assert.equal(porcelain(dir), '', 'PRECONDITION: clean tree at Pre');
    const L = lane('clean-control');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre on a clean tree allows');

    const post = h17(dir, 'PostToolUse', L); // the audited command wrote nothing
    assert.notEqual(post.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(post.code, 0, `CONTROL: a clean window must ALLOW — actual ${post.code}, stderr: ${oneLine(post.stderr)}`);
    assert.equal(existsSync(latchPath(dir)), false, 'CONTROL: and no incident is persisted — the latch is minted by DETECTION, never by the Post call itself');
  } finally {
    cleanup();
  }
});
