// H17 PRE-STATE SNAPSHOT — decision h17-pre-state-snapshot-closes-false-denial-
// not-the-restore-hole (knowledge_get 7021526c-09b0-4ec2-96eb-fd59cf52c0ad),
// board 0b848342 finding (4). NOT YET IMPLEMENTED. Authored BLIND to
// scripts/hooks/h17-bash-write-sweep.mjs and scripts/enforcement-stamp.mjs per
// H4 — no hook or CLI source was read to write these pins.
//
// THE RULING THAT CHANGED. H17's Post used to deny the entire Bash tool result
// whenever ANY enforcement-surface path was dirty at Pre, on the warrant that
// "the enforcement surface cannot be verified while it is dirty". That warrant
// held only because Pre recorded PATHS ONLY, so Post could not tell whether the
// audited command had touched the path. Pre now snapshots per-path STATE and
// Post compares it:
//   * pre-dirty, state UNCHANGED at Post -> NO deny, and no stamp is consulted
//     or needed (an unchanged path is verified by OBSERVATION, not attestation).
//   * pre-dirty, state CHANGED at Post   -> consult the stamp FRESH and hash the
//     CURRENT state; an exact match is a conductor attestation and ALLOWS,
//     otherwise DENY. Either way, deliberately NOT restored (a pre-image restore
//     would clobber a concurrent lane's legitimate write; that hole stays open
//     and is a separate, deferred slice).
//   * clean at Pre, dirty at Post        -> unchanged behaviour: fresh-stamp
//     check (decision 4d9b76e8), else restore to HEAD and deny.
// THE STAMP CONSULT ON THE CHANGED ARM (decision 7021526c v2, settling an
// interaction v1 left open — 4d9b76e8 wins and its rule is GENERAL, not confined
// to the clean-at-Pre branch): a stamp can be written ONLY by a deliberate
// conductor-run CLI and never from a Bash-invoked rebuild (6e132e19 rejected
// auto-stamping for exactly that reason), so bytes matching a FRESH stamp mean
// the change is conductor-attested and denying it would punish the conductor for
// its own attested edit. See PIN-STAMP-ON-CHANGED-PREDIRT.
//   * AC9 fail-closed retained IN FULL: a missing/corrupt snapshot record, an
//     unsupported file type, an lstat/git/index error, or any unexpected error
//     DENIES with exit 2 — never a non-blocking exit 1.
//
// "STATE" IS NOT BYTES ALONE. It is existence, file TYPE, MODE, symlink TARGET
// (read via readlink, never followed) and the INDEX entry (stage, mode, blob
// OID). Bytes-only equality is escapable four ways that the old blanket denial
// DID catch, and each is pinned below as a release blocker, not a residual:
// PIN-MODE (mode flip, identical bytes), PIN-TYPE (regular file swapped for a
// symlink whose target holds identical bytes), PIN-LINK (symlink re-pointed at a
// different target with identical content), PIN-INDEX-A/B (staged-index-only
// change with an unchanged worktree).
//
// PER-CALL KEYING. The snapshot record is keyed by sha256(tool_use_id) IN
// ADDITION to project tag and run id, because a run-scoped key admits a FALSE
// ALLOW: if lane B's Pre lands after lane A's command tampered, a shared record
// adopts the tampered bytes as B's baseline and Post A then allows a real
// tamper. PIN-KEY exercises exactly that (Pre A, Pre B, Posts in REVERSE
// order). Consequence the harness relies on: a per-call record CANNOT be the
// per-run `.dirty.json` attribution file, so it must be discoverable as a
// distinct `sterling-enforce-<projectTag>-*` temp file.
//
// DEGRADED-LOUD FALLBACK. tool_use_id is read by no hook in this repo today and
// is attested only in docs/historical/PROBES.md:45, so when it is missing or
// unusable H17 KEEPS the old blanket pre-existing denial AND SAYS SO. A silent
// fall back to a per-run key is a defect, so both halves are pinned — the
// denial, and the message naming the reason.
//
// WHERE EACH PIN LIVES, so no behaviour has two homes. THIS FILE holds the
// MECHANISM pins: the four state terms, per-call keying, the base64/invalid-UTF-8
// representation, the fail-closed record branches, and the adjudicated
// stamp-consult arm on a CHANGED pre-dirty path (including its PER-PATH
// disposition, which only shows up in message content, never in the exit code).
// scripts/tests/enforcement.test.mjs holds the AC-LEVEL pins, in the slots the
// old AC12 tests occupied: unchanged pre-dirt allows; changed BYTES deny and are
// not restored; the comparison is per path; existence in the absent->present
// direction; the brief-scope class; the ABSENT-tool_use_id fallback; and the
// stamp shapes that no longer decide a pre-dirty path. Two tests here are
// DELIBERATE cross-file tripwires for behaviour this ruling does NOT change but
// whose code region it edits (PIN-STAMP-BEFORE-RESTORE, PIN-CLEAN-AT-PRE-
// UNCHANGED) — the same idiom h17-stamp-honor.test.mjs's PIN6 uses.
//
// Harness is a faithful mirror of scripts/tests/h17-stamp-honor.test.mjs's
// fixture (temp git repo, projectTag-derived temp record paths, Pre-then-mutate-
// then-Post invocation, stamp fabrication helpers), extended with: an explicit
// per-call tool_use_id on every h17() pair, a tmpdir sweep in cleanup (per-call
// records have unpredictable filenames and would otherwise leak), and host
// capability probes for file mode bits and symlinks.
//
// RUN COMMAND (node toolchain adapter):
//   node --test scripts/tests/h17-pre-state-snapshot.test.mjs
//
// Per-test EXPECTED FAILURE SHAPE and the one-line SABOTAGE each test is
// designed to catch are documented immediately above each test.

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
  symlinkSync,
  chmodSync,
  lstatSync,
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

function runHook(script, input, cwd) {
  const r = spawnSync(process.execPath, [join(HOOKS, script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 30_000,
  });
  return { code: r.status, stderr: r.stderr ?? '', stdout: r.stdout ?? '' };
}

// Anti-pattern ee89c3fd: raw multi-line child-process stderr interpolated into
// an assertion message that is EXPECTED to fail poisons the TAP crash/assertion
// classifier — the multi-line `code:` diagnostic starts a YAML line, so
// ERR_ASSERTION is no longer the first `code:` the parser sees and the outcome
// classifies as a CRASH instead of assertion_fail. Every deny/allow assertion in
// this file interpolates H17's multi-line stderr and most of them are expected to
// FAIL today, so this is load-bearing here: the mutation battery this slice is
// verified by must be able to tell "the pin caught the sabotage" from "the
// harness fell over". Flatten whitespace only — NEVER truncate: the whole
// message must stay readable when a pin fires.
function oneLine(s) {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
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
  toolchains: [
    {
      adapter: 'node',
      path_globs: ['**/*.mjs', '**/*.ts'],
      test_globs: ['**/*.test.mjs', 'tests/**'],
      run_commands: { test: 'node --test' },
    },
  ],
  context_watch: { warn_pct: 60, block_pct: 95, mode: 'observe', windows: { default: 200000 } },
};

// Mirrors h17-stamp-honor.test.mjs's node-adapter brief fixture exactly:
// in-scope src/feature.ts + src/new-file.ts, incidental src/types.ts,
// out_of_scope src/legacy/** — so scopeCheck denies every OTHER repo path.
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
    blast_radius: {
      files: [
        { path: 'src/feature.ts', owning_articles: [] },
        { path: 'src/new-file.ts', owning_articles: [] },
      ],
      reconcile_list: [],
    },
    incidental_scope: ['src/types.ts'],
    out_of_scope: ['src/legacy/**'],
    phases: [{ phase_id: 'p1', goal: 'g', subtasks: [], ac_ids: ['AC1'], difficulty: { level: 'normal', reasons: [] }, model_hint: 'sonnet' }],
    decisions_made: [],
  };
}

const GIT_SKIP = (() => {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0 ? false : 'git not available on this host';
})();

// Host capability probes. The MODE and symlink escapes are unobservable on
// hosts where the filesystem does not carry POSIX mode bits / permit symlink
// creation (notably native Windows without developer mode) — those tests SKIP
// with a named reason rather than passing vacuously (P5: a check that cannot
// run says so).
const MODE_SKIP = (() => {
  try {
    const d = mkdtempSync(join(tmpdir(), 'sterling-modeprobe-'));
    const f = join(d, 'f');
    writeFileSync(f, 'x');
    chmodSync(f, 0o644);
    const before644 = lstatSync(f).mode & 0o777;
    chmodSync(f, 0o755);
    const after755 = lstatSync(f).mode & 0o777;
    rmSync(d, { recursive: true, force: true });
    return before644 !== after755 ? false : 'file mode bits are not observable on this host';
  } catch (e) {
    return `mode probe failed on this host (${e.code ?? e.message})`;
  }
})();

const SYMLINK_SKIP = (() => {
  try {
    const d = mkdtempSync(join(tmpdir(), 'sterling-symprobe-'));
    writeFileSync(join(d, 'target'), 'x');
    symlinkSync(join(d, 'target'), join(d, 'link'));
    const ok = lstatSync(join(d, 'link')).isSymbolicLink();
    rmSync(d, { recursive: true, force: true });
    return ok ? false : 'symlinks are not observable on this host';
  } catch (e) {
    return `symlinks unavailable on this host (${e.code ?? e.message})`;
  }
})();

// run git in `dir` (setup helper — never silently swallows a setup failure: P5)
function git(dir, args, { must = false } = {}) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (must) assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${oneLine(r.stderr)}`);
  return r;
}

// write a loose blob into the object database and return its OID — used to plant
// an INDEX entry whose blob differs while the worktree bytes and the porcelain
// XY status code both stay put (PIN-INDEX-B).
function hashObject(dir, content) {
  const r = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: content, encoding: 'utf8' });
  assert.equal(r.status, 0, `git hash-object failed: ${oneLine(r.stderr)}`);
  return r.stdout.trim();
}

// Build a git-backed project with a live Sterling store + active run — a
// faithful mirror of h17-stamp-honor.test.mjs's makeGitProject.
function makeGitProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h17-prestate-'));
  const runId = 'r-h17ps-' + randomUUID().slice(0, 8);

  git(dir, ['init', '-q'], { must: true });
  git(dir, ['config', 'user.email', 'h17@sterling.test'], { must: true });
  git(dir, ['config', 'user.name', 'H17 Test'], { must: true });
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.autocrlf', 'false'], { must: true }); // pin line endings (see enforcement.test.mjs)

  writeFileSync(join(dir, '.gitignore'), ['.claude/agents/', '.claude/settings.local.json', '.sterling/', ''].join('\n'));

  mkdirSync(join(dir, 'hooks'), { recursive: true });
  writeFileSync(join(dir, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [] } }, null, 2) + '\n');
  writeFileSync(join(dir, 'hooks', 'h3-contract-gate.mjs'), '// bundled enforcement hook (pristine)\nprocess.exit(0);\n');

  mkdirSync(join(dir, 'src', 'legacy'), { recursive: true });
  writeFileSync(join(dir, 'src', 'feature.ts'), 'export const x = 1;\n');
  writeFileSync(join(dir, 'src', 'types.ts'), 'export type T = 1;\n');
  writeFileSync(join(dir, 'src', 'other.ts'), 'export const other = 1;\n');
  writeFileSync(join(dir, 'src', 'legacy', 'old.ts'), 'export const legacy = 1;\n');
  mkdirSync(join(dir, 'tests'), { recursive: true });
  writeFileSync(join(dir, 'tests', 'frozen.test.mjs'), "import { test } from 'node:test';\ntest('frozen', () => {});\n");

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

  // Must mirror h17's projectTag(cwd) EXACTLY — sha256(realpath(cwd)).slice(0,16).
  const projectTag = createHash('sha256').update(realpathSync(dir)).digest('hex').slice(0, 16);
  const baselinePath = join(tmpdir(), `sterling-enforce-${projectTag}-${runId}.json`);
  const dirtyPath = join(tmpdir(), `sterling-enforce-${projectTag}-${runId}.dirty.json`);
  let closed = false;
  const closeStore = () => {
    if (!closed) {
      try {
        store.close();
      } catch {}
      closed = true;
    }
  };
  // Sweep EVERY temp record for this project tag, not just the two known
  // filenames: per-call snapshot records are keyed by sha256(tool_use_id), so
  // their names are not predictable from here and would otherwise leak into
  // /tmp for every test in this file.
  const cleanup = (extraPaths = []) => {
    closeStore();
    rmSync(dir, { recursive: true, force: true });
    for (const p of tempRecords(projectTag)) rmSync(p, { force: true });
    for (const p of extraPaths) rmSync(p, { force: true });
  };
  return { dir, store, runId, dbPath, projectTag, baselinePath, dirtyPath, closeStore, cleanup };
}

// every temp file H17 owns for this project tag
function tempRecords(projectTag) {
  let names = [];
  try {
    names = readdirSync(tmpdir());
  } catch {
    return [];
  }
  return names.filter((n) => n.startsWith(`sterling-enforce-${projectTag}`)).map((n) => join(tmpdir(), n));
}

// The PER-CALL snapshot records: everything for this project tag EXCEPT the
// per-run (B) baseline and the per-run paths-only attribution record. Sparing
// those two is what keeps the fail-closed pins honest — deleting the
// attribution record would deny through the ALREADY-pinned "missing attribution
// record" branch (enforcement.test.mjs:1505) and the test would pass without
// ever exercising the new per-path state comparison.
function perCallRecords({ projectTag, baselinePath, dirtyPath }) {
  return tempRecords(projectTag).filter((p) => p !== baselinePath && p !== dirtyPath);
}

// run h17 in Pre (snapshot) or Post (verify+sweep) mode. agent_id + tool_use_id
// via `over`.
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
      tool_input: { command: 'grep -rn "resolveRun" scripts/' }, // the MEASURED victim: a read-only command
      ...(event === 'PostToolUse' ? { tool_response: { stdout: '', stderr: '' } } : {}),
      ...over,
    },
    dir
  );
}

// One Bash call = one tool_use_id, carried by BOTH its Pre and its Post. Two
// concurrent lanes carry DIFFERENT ones.
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

const BUNDLE_REL = 'hooks/h3-contract-gate.mjs';
function bundlePath(dir) {
  return join(dir, 'hooks', 'h3-contract-gate.mjs');
}

// make the tracked bundled hook dirty BEFORE Pre — the conductor's own
// uncommitted rebuild, the state that used to deny every parallel lane
function preDirtyBundle(dir, bytes) {
  const p = bundlePath(dir);
  writeFileSync(p, bytes);
  return p;
}

// =========================================================================
// PIN-ALLOW — THE MEASURED REGRESSION, end to end. A lane running a READ-ONLY
// command, while a DIFFERENT lane's committed rebuild has left two
// enforcement-surface paths dirty, must complete. No stamp exists (the allow
// comes from OBSERVATION, not attestation) and every pre-dirty byte survives.
//
// EXPECTED FAILURE SHAPE (RED): today's Post denies on any pre-dirty
// enforcement path, so `assert.equal(r.code, 0)` fires with actual 2 and the
// stderr in the message will carry today's "PRE-EXISTING change(s)" block.
//
// CATCHES SABOTAGE: equality forced to always-UNEQUAL (`if (false) continue`)
// — the comparison then never reports "unchanged", every pre-dirty path denies,
// and this test goes red at the same assertion.
// =========================================================================

test('PIN-ALLOW: two pre-dirty enforcement paths, UNCHANGED across the window, no longer deny a read-only lane — and no stamp is needed', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const bundle = preDirtyBundle(dir, '// conductor rebuild in a parallel lane, not yet committed\n');
    const hooksJson = join(dir, 'hooks', 'hooks.json');
    writeFileSync(hooksJson, JSON.stringify({ hooks: { PreToolUse: [] }, rebuilt: true }, null, 2) + '\n');
    const bundleBytes = readFileSync(bundle, 'utf8');
    const hooksJsonBytes = readFileSync(hooksJson, 'utf8');
    assert.equal(existsSync(stampPath(dir)), false, 'PRECONDITION: no stamp exists — the allow must come from observation, not attestation');

    const L = lane('readonly');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre snapshot succeeds');
    // the command writes nothing at all — the measured victim was `grep`
    const r = h17(dir, 'PostToolUse', L);

    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 0, `an UNCHANGED pre-dirty enforcement surface is verifiable and must not deny — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    assert.equal(readFileSync(bundle, 'utf8'), bundleBytes, "the other lane's uncommitted bundle survives untouched");
    assert.equal(readFileSync(hooksJson, 'utf8'), hooksJsonBytes, "the other lane's uncommitted hooks.json survives untouched");
  } finally {
    cleanup();
  }
});

// =========================================================================
// PIN-MODE — STATE IS NOT BYTES ALONE (1/4): a MODE flip with byte-identical
// content must deny. The fixture is built so the bytes term cannot carry this
// test: the file's content is written BEFORE Pre and never touched again, so a
// bytes-only comparison reports "unchanged" and allows.
//
// EXPECTED FAILURE SHAPE (RED-then-GREEN direction): today this denies for the
// wrong reason (blanket pre-existing denial). Once PIN-ALLOW's behaviour lands,
// a bytes-only implementation ALLOWS here and `assert.equal(r.code, 2)` fires
// with actual 0.
//
// CATCHES SABOTAGE: the MODE term deleted from the equality. Existence, type,
// link target, index entry and bytes are all identical across the window, so
// mode is the ONLY term that can produce the deny.
// =========================================================================

test('PIN-MODE: a MODE flip with byte-identical content on a pre-dirty enforcement path DENIES (bytes-only equality is escapable by chmod)', { skip: GIT_SKIP || MODE_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const bundle = preDirtyBundle(dir, '// conductor rebuild, not yet committed\n');
    chmodSync(bundle, 0o644);
    const bytesBefore = readFileSync(bundle, 'utf8');

    const L = lane('mode');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0);

    chmodSync(bundle, 0o755); // the ONLY change: the executable bit
    assert.equal(readFileSync(bundle, 'utf8'), bytesBefore, 'PRECONDITION: the bytes are identical — a bytes-only check must see no change');
    assert.equal(lstatSync(bundle).mode & 0o111, 0o111, 'PRECONDITION: the mode actually flipped on this host');
    assert.equal(existsSync(stampPath(dir)), false, 'PRECONDITION: no stamp exists — this deny must land on the "otherwise" arm (step 3), never on the attested arm (step 2)');

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `a mode flip on a pre-dirty enforcement path must deny — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// =========================================================================
// PIN-TYPE — STATE IS NOT BYTES ALONE (2/4): the pre-dirty regular file is
// replaced by a SYMLINK whose target holds byte-identical content. Reading the
// path (following the link) returns the same bytes, so bytes-only equality
// allows. The decoy target lives OUTSIDE the repo, so it cannot itself register
// as a violation and confound the result.
//
// EXPECTED FAILURE SHAPE: denies today for the wrong reason; once PIN-ALLOW
// lands, a bytes-only implementation ALLOWS and `assert.equal(r.code, 2)` fires
// with actual 0.
//
// CATCHES SABOTAGE: the TYPE term deleted from the equality — PROVIDED the mode
// term carries permission bits only (`mode & 0o7777`). An implementation that
// snapshots the raw `st.mode` catches the type flip through the type BITS, in
// which case this pin still denies correctly but the named sabotage must delete
// mode and type together. Disclosed rather than hidden: the security property
// (a symlink swap denies) is pinned either way.
// =========================================================================

test('PIN-TYPE: swapping a pre-dirty regular file for a SYMLINK whose target holds identical bytes DENIES', { skip: GIT_SKIP || SYMLINK_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  const decoy = join(tmpdir(), 'sterling-h17-decoy-' + randomUUID().slice(0, 8));
  try {
    const identical = '// conductor rebuild, not yet committed\n';
    const bundle = preDirtyBundle(dir, identical);
    writeFileSync(decoy, identical); // outside the repo: same bytes, different inode

    const L = lane('type');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0);

    rmSync(bundle, { force: true });
    symlinkSync(decoy, bundle);
    assert.equal(readFileSync(bundle, 'utf8'), identical, 'PRECONDITION: following the link yields byte-identical content');
    assert.equal(lstatSync(bundle).isSymbolicLink(), true, 'PRECONDITION: the path is now a symlink');
    assert.equal(existsSync(stampPath(dir)), false, 'PRECONDITION: no stamp exists — this deny must land on the "otherwise" arm (step 3), never on the attested arm (step 2)');

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `a regular-file -> symlink type swap must deny even with identical bytes — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
  } finally {
    cleanup([decoy]);
  }
});

// =========================================================================
// PIN-LINK — STATE IS NOT BYTES ALONE (3/4): the pre-dirty path is a SYMLINK at
// Pre and a SYMLINK at Post, re-pointed at a DIFFERENT target holding identical
// content. Existence, type, mode and followed-bytes are all identical; the
// readlink TARGET is the only term that differs. This is why the target must be
// read via readlink and never followed.
//
// EXPECTED FAILURE SHAPE: denies today for the wrong reason; once PIN-ALLOW
// lands, any implementation lacking a link-target term ALLOWS and
// `assert.equal(r.code, 2)` fires with actual 0.
//
// CATCHES SABOTAGE: the symlink LINK-TARGET comparison replaced with `true`.
// No other term can carry this test.
// =========================================================================

test('PIN-LINK: re-pointing a pre-dirty SYMLINK at a different target with identical content DENIES (readlink, never followed)', { skip: GIT_SKIP || SYMLINK_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  const decoyA = join(tmpdir(), 'sterling-h17-decoyA-' + randomUUID().slice(0, 8));
  const decoyB = join(tmpdir(), 'sterling-h17-decoyB-' + randomUUID().slice(0, 8));
  try {
    const identical = '// identical content behind two different targets\n';
    writeFileSync(decoyA, identical);
    writeFileSync(decoyB, identical);

    const bundle = bundlePath(dir);
    rmSync(bundle, { force: true });
    symlinkSync(decoyA, bundle); // pre-dirty AND already a symlink at Pre

    const L = lane('link');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0);

    rmSync(bundle, { force: true });
    symlinkSync(decoyB, bundle);
    assert.equal(readFileSync(bundle, 'utf8'), identical, 'PRECONDITION: followed bytes are identical');
    assert.equal(lstatSync(bundle).isSymbolicLink(), true, 'PRECONDITION: still a symlink — only the target moved');
    assert.equal(existsSync(stampPath(dir)), false, 'PRECONDITION: no stamp exists — this deny must land on the "otherwise" arm (step 3), never on the attested arm (step 2)');

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `a symlink re-pointed at a different identical-content target must deny — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
  } finally {
    cleanup([decoyA, decoyB]);
  }
});

// =========================================================================
// PIN-INDEX-A — STATE IS NOT BYTES ALONE (4/4), the realistic shape: a
// staged-index-only change with an unchanged worktree. `git add` inside the
// window moves the index entry while the worktree bytes, type and mode stay
// byte-identical.
//
// EXPECTED FAILURE SHAPE: denies today for the wrong reason; once PIN-ALLOW
// lands, a worktree-only implementation ALLOWS and `assert.equal(r.code, 2)`
// fires with actual 0.
//
// CATCHES SABOTAGE: the INDEX blob-OID term deleted from the equality — with
// the caveat that an implementation which also snapshots the porcelain XY code
// would catch this through XY (' M' -> 'M '). PIN-INDEX-B removes that caveat.
// =========================================================================

test('PIN-INDEX-A: `git add` inside the window (staged-index-only change, worktree byte-identical) DENIES', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const bundle = preDirtyBundle(dir, '// conductor rebuild, not yet committed\n');
    const bytesBefore = readFileSync(bundle, 'utf8');

    const L = lane('indexA');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0);

    git(dir, ['add', BUNDLE_REL], { must: true }); // index moves; worktree does not
    assert.equal(readFileSync(bundle, 'utf8'), bytesBefore, 'PRECONDITION: the worktree bytes are untouched');
    assert.equal(existsSync(stampPath(dir)), false, 'PRECONDITION: no stamp exists — this deny must land on the "otherwise" arm (step 3), never on the attested arm (step 2)');

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `a staged-index-only change must deny — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// =========================================================================
// PIN-INDEX-B — the same term, ISOLATED. The index entry is planted with
// `update-index --cacheinfo` on BOTH sides of the window, so the porcelain XY
// code is 'MM' before and after and CANNOT carry the difference: only the index
// BLOB OID moves. Worktree bytes, type and mode are untouched throughout.
//
// EXPECTED FAILURE SHAPE: denies today for the wrong reason; once PIN-ALLOW
// lands, an implementation without an index blob-OID term ALLOWS and
// `assert.equal(r.code, 2)` fires with actual 0.
//
// CATCHES SABOTAGE: the INDEX blob-OID term deleted from the equality —
// unambiguously, because the XY status code is held constant by construction.
// =========================================================================

test('PIN-INDEX-B: only the INDEX blob OID moves (porcelain XY held constant, worktree untouched) — DENIES', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const bundle = preDirtyBundle(dir, '// conductor rebuild, not yet committed\n');
    const bytesBefore = readFileSync(bundle, 'utf8');

    const oidA = hashObject(dir, '// staged blob A — never in the worktree\n');
    const oidB = hashObject(dir, '// staged blob B — never in the worktree, different OID\n');
    assert.notEqual(oidA, oidB, 'PRECONDITION: two distinct blob OIDs');

    git(dir, ['update-index', '--add', '--cacheinfo', `100644,${oidA},${BUNDLE_REL}`], { must: true });
    const xyBefore = git(dir, ['status', '--porcelain', '--', BUNDLE_REL], { must: true }).stdout.slice(0, 2);
    assert.equal(xyBefore.trim().length > 0, true, 'PRECONDITION: the path is dirty and porcelain reports a real XY code (never an empty string, which would make the equality below vacuous)');

    const L = lane('indexB');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0);

    git(dir, ['update-index', '--add', '--cacheinfo', `100644,${oidB},${BUNDLE_REL}`], { must: true });
    const xyAfter = git(dir, ['status', '--porcelain', '--', BUNDLE_REL], { must: true }).stdout.slice(0, 2);

    assert.equal(readFileSync(bundle, 'utf8'), bytesBefore, 'PRECONDITION: the worktree bytes are untouched');
    assert.equal(xyAfter, xyBefore, 'PRECONDITION: the porcelain XY code is IDENTICAL — only the index blob OID moved');
    assert.equal(existsSync(stampPath(dir)), false, 'PRECONDITION: no stamp exists — this deny must land on the "otherwise" arm (step 3), never on the attested arm (step 2)');

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `an index-blob-OID-only change must deny — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// =========================================================================
// PIN-UTF8-CHANGED — REPRESENTATION IS BASE64, NEVER A UTF-8 STRING. The
// pre-dirty file holds INVALID UTF-8. In-window, one invalid byte (0xC3, a
// truncated 2-byte lead) is replaced by a different invalid byte (0xC0, an
// overlong lead). Both decode to exactly one U+FFFD, so the two contents are
// INDISTINGUISHABLE as UTF-8 strings while their raw bytes differ.
//
// EXPECTED FAILURE SHAPE: denies today for the wrong reason; once PIN-ALLOW
// lands, a UTF-8-string snapshot sees equality and ALLOWS, so
// `assert.equal(r.code, 2)` fires with actual 0.
//
// CATCHES SABOTAGE: `readFileSync(abs)` changed to `readFileSync(abs, 'utf8')`
// — this is the fixture that sabotage needs to be observable at all.
// =========================================================================

const UTF8_PRE = Buffer.concat([Buffer.from('// pre-dirty bundle with invalid utf-8: '), Buffer.from([0xc3]), Buffer.from('\n')]);
const UTF8_POST = Buffer.concat([Buffer.from('// pre-dirty bundle with invalid utf-8: '), Buffer.from([0xc0]), Buffer.from('\n')]);

test('PIN-UTF8-CHANGED: two DIFFERENT invalid-UTF-8 byte sequences that decode identically must still count as CHANGED — DENIES', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    assert.notEqual(UTF8_PRE.toString('base64'), UTF8_POST.toString('base64'), 'PRECONDITION: the raw bytes differ');
    assert.equal(UTF8_PRE.toString('utf8'), UTF8_POST.toString('utf8'), 'PRECONDITION: lossy UTF-8 decoding makes them IDENTICAL — this is the escape');

    const bundle = preDirtyBundle(dir, UTF8_PRE);

    const L = lane('utf8changed');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0);
    writeFileSync(bundle, UTF8_POST);
    assert.equal(existsSync(stampPath(dir)), false, 'PRECONDITION: no stamp exists — this deny must land on the "otherwise" arm (step 3), never on the attested arm (step 2)');

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `a byte-level change invisible to UTF-8 decoding must still deny — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// =========================================================================
// PIN-UTF8-UNCHANGED — the companion that stops PIN-UTF8-CHANGED from being
// satisfiable by an always-mismatching representation. The same invalid-UTF-8
// pre-dirty file, untouched across the window, must ALLOW: a lossless base64
// round-trip has to compare EQUAL to itself, including for bytes that are not
// valid text.
//
// EXPECTED FAILURE SHAPE (RED): today's blanket pre-existing denial fires, so
// `assert.equal(r.code, 0)` fires with actual 2.
//
// CATCHES SABOTAGE: equality forced to always-UNEQUAL, and any representation
// that cannot round-trip non-text bytes (e.g. a hash over a decoded string that
// is recomputed differently at Post).
// =========================================================================

test('PIN-UTF8-UNCHANGED: an UNTOUCHED invalid-UTF-8 pre-dirty file compares EQUAL (lossless round-trip) — ALLOWS', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const bundle = preDirtyBundle(dir, UTF8_PRE);
    assert.equal(existsSync(stampPath(dir)), false, 'PRECONDITION: no stamp — the allow must come from observation');

    const L = lane('utf8same');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0);
    const r = h17(dir, 'PostToolUse', L);

    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 0, `an untouched non-text pre-dirty file must compare equal — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    assert.deepEqual(readFileSync(bundle), UTF8_PRE, 'and its exact bytes survive');
  } finally {
    cleanup();
  }
});

// =========================================================================
// PIN-EXISTENCE-GONE — EXISTENCE is a state term: a pre-dirty path DELETED
// in-window denies, and is NOT resurrected, since a changed pre-dirty path is
// never restored. (The other direction — absent at Pre, still absent at Post ->
// allow; recreated in-window -> deny — is pinned at the AC level in
// enforcement.test.mjs, where it replaced the old deleted:true stamp test.)
//
// EXPECTED FAILURE SHAPE: today this denies for the wrong reason, and today
// RESURRECTS the file via `git checkout HEAD` — so `assert.equal(existsSync
// (bundle), false)` is the red assertion.
//
// CATCHES SABOTAGE: the existence term deleted from the equality, and equality
// forced to always-EQUAL (the deny disappears).
// =========================================================================

test('PIN-EXISTENCE-GONE: a pre-dirty enforcement path DELETED in-window DENIES and is NOT resurrected', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const bundle = preDirtyBundle(dir, '// conductor rebuild, not yet committed\n');

    const L = lane('gone');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0);
    rmSync(bundle, { force: true });
    assert.equal(existsSync(stampPath(dir)), false, 'PRECONDITION: no stamp exists (in particular no deleted:true entry) — this deny must land on the "otherwise" arm (step 3), never on the attested arm (step 2)');

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `an in-window deletion of a pre-dirty enforcement path must deny — ${oneLine(r.stderr)}`);
    assert.equal(existsSync(bundle), false, 'a CHANGED pre-dirty path is never restored — so it is not resurrected either');
  } finally {
    cleanup();
  }
});

// =========================================================================
// PIN-NO-RECORD — AC9 FAIL-CLOSED, retained in full. With the per-run (B)
// baseline and the per-run paths-only attribution record BOTH left intact, the
// PER-CALL snapshot record is deleted after Pre. Post cannot compare, so it
// must DENY. Sparing the other two files is what isolates this branch from the
// already-pinned "missing attribution record" and "baseline absent at Post"
// branches (enforcement.test.mjs:1505 / :1422).
//
// EXPECTED FAILURE SHAPE (RED): there is no per-call record today, so
// `assert.ok(records.length >= 1, ...)` fires first — the precondition that a
// per-call record exists at all. That failure IS the pin: a per-call record
// cannot be the per-run `.dirty.json`, so it must be discoverable as its own
// `sterling-enforce-<tag>-*` temp file.
//
// CATCHES SABOTAGE: the no-record branch changed to `if (!record) continue` —
// under it, a missing record makes every pre-dirty path skip silently and the
// call is ALLOWED, so `assert.equal(r.code, 2)` fires with actual 0.
// =========================================================================

test('PIN-NO-RECORD: a MISSING per-call snapshot record DENIES (fail-closed) even though the baseline and attribution record are intact', { skip: GIT_SKIP }, () => {
  const fx = makeGitProject();
  const { dir, cleanup, baselinePath, dirtyPath } = fx;
  try {
    preDirtyBundle(dir, '// conductor rebuild, not yet committed\n');

    const L = lane('norecord');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0);

    const records = perCallRecords(fx);
    assert.ok(
      records.length >= 1,
      'PRECONDITION: Pre must write a PER-CALL snapshot record, discoverable as a sterling-enforce-<projectTag>-* temp file that is neither the per-run baseline nor the per-run .dirty.json — per-call keying by sha256(tool_use_id) makes the per-run attribution file structurally unable to serve as one'
    );
    for (const p of records) rmSync(p, { force: true });
    assert.equal(existsSync(baselinePath), true, 'the (B) baseline is deliberately left intact, isolating this branch');
    assert.equal(existsSync(dirtyPath), true, 'the per-run attribution record is deliberately left intact, isolating this branch');

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'AC9: never a non-blocking exit 1');
    assert.equal(r.code, 2, `an unverifiable pre-dirty path must deny rather than skip — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// =========================================================================
// PIN-CORRUPT-RECORD — AC9 fail-closed on an unparseable per-call record, plus
// CONTAINMENT: the record is not a restore source in this slice, and a crafted
// record carrying traversal / absolute path keys must never become one. Mirrors
// enforcement.test.mjs's AC10 idiom.
//
// EXPECTED FAILURE SHAPE (RED): the per-call-record precondition fires first,
// exactly as in PIN-NO-RECORD.
//
// CATCHES SABOTAGE: any parse path that treats an unreadable record as "nothing
// pre-dirty" (the `if (!record) continue` family), and any future use of the
// record as a restore source without key validation.
// =========================================================================

test('PIN-CORRUPT-RECORD: a CORRUPT per-call snapshot record DENIES, and crafted traversal/absolute keys produce NO out-of-tree write', { skip: GIT_SKIP }, () => {
  const fx = makeGitProject();
  const { dir, cleanup, runId } = fx;
  const outParent = join(dir, '..', 'pwned-prestate-' + runId + '.txt');
  const outAbs = join(tmpdir(), 'pwned-prestate-abs-' + runId + '.txt');
  try {
    preDirtyBundle(dir, '// conductor rebuild, not yet committed\n');

    const L = lane('corrupt');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0);

    const records = perCallRecords(fx);
    assert.ok(records.length >= 1, 'PRECONDITION: Pre must write a per-call snapshot record (see PIN-NO-RECORD)');
    for (const p of records) {
      writeFileSync(
        p,
        JSON.stringify({
          ['../pwned-prestate-' + runId + '.txt']: 'traversal payload',
          [outAbs]: 'absolute payload',
          truncated: '{ not valid',
        }) + ' ,,, not valid json either'
      );
    }

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'AC9: never a non-blocking exit 1');
    assert.equal(r.code, 2, `a corrupt per-call record must deny — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    assert.equal(existsSync(outParent), false, 'no out-of-tree write via a ../ traversal key');
    assert.equal(existsSync(outAbs), false, 'no out-of-tree write via an absolute key');
  } finally {
    cleanup([outParent, outAbs]);
  }
});

// =========================================================================
// PIN-KEY — PER-CALL KEYING CLOSES A FALSE ALLOW. Two overlapping Bash windows
// in the SAME run and project:
//   1. hooks/h3-contract-gate.mjs is pre-dirty with bytes X (a parallel lane's
//      uncommitted rebuild).
//   2. Pre A snapshots X.
//   3. Lane A's command TAMPERS the file to bytes Y — a real tamper of
//      pre-existing dirt.
//   4. Pre B snapshots Y (B legitimately sees Y as its own starting state).
//   5. Post B runs FIRST: unchanged within B's window -> allow. Correct: the
//      tamper predates B's Pre and is not B's to answer for.
//   6. Post A runs LAST and must DENY: X -> Y inside A's window.
// With a run-scoped key, step 4 OVERWRITES the single shared record with Y, and
// Post A then compares Y against Y and ALLOWS a real tamper.
//
// EXPECTED FAILURE SHAPE (RED): the two-distinct-records precondition fires
// first (no per-call record exists today at all).
//
// CATCHES SABOTAGE: the hashed tool_use_id component removed from the snapshot
// filename. TWO independent red signals — the record count collapses to 1, and
// Post A allows (actual 0 against the asserted 2). `doesNotMatch(/failing
// closed/)` additionally stops the test from passing for the wrong reason if
// Post B were to consume lane A's record.
// =========================================================================

test('PIN-KEY: Pre A, Pre B, then Posts in REVERSE order — Post A still catches the tamper a shared per-run key would have adopted as B\'s baseline', { skip: GIT_SKIP }, () => {
  const fx = makeGitProject();
  const { dir, cleanup } = fx;
  try {
    const bundle = preDirtyBundle(dir, '// X: parallel lane rebuild, uncommitted\n');

    const A = lane('laneA');
    const B = lane('laneB');
    assert.notEqual(A.tool_use_id, B.tool_use_id, 'PRECONDITION: two lanes, two tool_use_ids');

    assert.equal(h17(dir, 'PreToolUse', A).code, 0, 'Pre A snapshots X');
    const recordsAfterA = perCallRecords(fx);

    const tampered = '// Y: TAMPERED by lane A inside its own window\n';
    writeFileSync(bundle, tampered);

    assert.equal(h17(dir, 'PreToolUse', B).code, 0, 'Pre B lands AFTER the tamper and snapshots Y');
    const recordsAfterB = perCallRecords(fx);

    assert.ok(recordsAfterA.length >= 1, 'PRECONDITION: Pre A wrote a per-call record (see PIN-NO-RECORD)');
    assert.ok(
      recordsAfterB.length >= recordsAfterA.length + 1,
      `PRECONDITION AND PIN: Pre B must write its OWN record rather than overwrite lane A's — a run-scoped filename collapses both lanes onto one baseline (after A: ${recordsAfterA.length}, after B: ${recordsAfterB.length})`
    );

    // load-bearing for Post A below: with no stamp anywhere, lane A's deny must
    // land on the "otherwise" arm (step 3) and can never be the attested arm
    assert.equal(existsSync(stampPath(dir)), false, 'PRECONDITION: no stamp exists — Post A\'s deny must land on the "otherwise" arm (step 3), never on the attested arm (step 2)');

    const postB = h17(dir, 'PostToolUse', B);
    assert.equal(postB.code, 0, `lane B changed nothing inside ITS window and must not be denied — actual ${postB.code}, stderr: ${oneLine(postB.stderr)}`);

    assert.ok(
      perCallRecords(fx).some((p) => recordsAfterA.includes(p)),
      "lane B's Post must not consume lane A's snapshot record — a Post owns exactly its own per-call record"
    );

    const postA = h17(dir, 'PostToolUse', A);
    assert.notEqual(postA.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(postA.code, 2, `THE FALSE ALLOW: lane A's own window changed X -> Y and must deny — actual ${postA.code}, stderr: ${oneLine(postA.stderr)}`);
    assert.doesNotMatch(postA.stderr, /failing closed/, "and it denies by COMPARISON, not because lane B's Post destroyed A's record");
    assert.doesNotMatch(
      postA.stderr,
      /absent at Post/,
      "nor because lane B's Post consumed the shared per-run (B) baseline out from under lane A — if THIS assertion is what fires, the diagnosis is per-run transient lifecycle under overlapping windows, not the state comparison"
    );
    assert.match(postA.stderr, /h3-contract-gate/, "and it names the path lane A's window changed");
    assert.equal(readFileSync(bundle, 'utf8'), tampered, 'still not restored — the pre-image restore is the deferred slice');
  } finally {
    cleanup();
  }
});

// =========================================================================
// PIN-FALLBACK-BLANK — DEGRADED-LOUD FALLBACK for an UNUSABLE tool_use_id. (The
// ABSENT case is pinned at the AC level in enforcement.test.mjs, where it
// replaced the old "falls back to the existing denial" stamp test; this file
// carries the unusable-but-present variant.) An empty string is
// present-but-unusable: a presence check (`'tool_use_id' in input`) accepts it
// and hashes it to a CONSTANT, which is a run-scoped key under another name and
// reopens PIN-KEY's false allow for every lane at once. The denial alone is not
// enough — a silent degrade is a defect, so the message must NAME the reason.
//
// EXPECTED FAILURE SHAPE: the `r.code === 2` half is expected GREEN today (today
// always denies on pre-dirt). The RED assertion is `assert.match(r.stderr,
// /tool_use_id/)` — today's message has no notion of the field.
//
// CATCHES SABOTAGE: a presence check substituted for a usability check (the
// blank id is then accepted as a key, the unchanged pre-dirty path is ALLOWED,
// and the code assertion fires), and a fallback that degrades silently.
// =========================================================================

test('PIN-FALLBACK-BLANK: an EMPTY-STRING tool_use_id is unusable, not usable — same degraded-loud blanket denial, reason named', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    preDirtyBundle(dir, '// conductor rebuild, not yet committed\n');

    const blank = { agent_id: 'a1', tool_use_id: '' };
    assert.equal(h17(dir, 'PreToolUse', blank).code, 0);
    const r = h17(dir, 'PostToolUse', blank);

    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `a blank tool_use_id must NOT be treated as a usable key — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    assert.match(r.stderr, /tool_use_id/, 'DEGRADED-LOUD: the fallback names the reason');
  } finally {
    cleanup();
  }
});

// =========================================================================
// PIN-FALLBACK-SKEW — a Pre that carried a tool_use_id and a Post that does not
// (a version-skewed bundle pair, or a platform that stops emitting the field
// mid-session) can never find its per-call record. Both readings of that state
// — "record unfindable" and "no usable tool_use_id" — deny, so this is a
// boundary guard on AC9 rather than a mutation catcher, and is labelled as one.
//
// EXPECTED FAILURE SHAPE: expected GREEN today (today denies on pre-dirt
// unconditionally). It must STAY green once the fix lands.
// =========================================================================

test('PIN-FALLBACK-SKEW (boundary guard): a tool_use_id present at Pre and absent at Post denies — never allows on an unfindable record', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    preDirtyBundle(dir, '// conductor rebuild, not yet committed\n');

    assert.equal(h17(dir, 'PreToolUse', lane('skew')).code, 0);
    const r = h17(dir, 'PostToolUse', { agent_id: 'a1' }); // no tool_use_id at Post

    assert.notEqual(r.code, 1, 'AC9: never a non-blocking exit 1');
    assert.equal(r.code, 2, `a Pre/Post tool_use_id skew must deny — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// =========================================================================
// PIN-STAMP-BEFORE-RESTORE — same-file tripwire for decision 4d9b76e8. The
// clean-at-Pre arm is explicitly UNCHANGED by this ruling: an in-window change
// to a path that was CLEAN at Pre still consults the fresh stamp first, and
// only restores to HEAD when no entry matches the CURRENT bytes. This slice
// edits exactly that code region, so the tripwire lives here beside it;
// primary coverage stays h17-stamp-honor.test.mjs PIN1 (the established
// duplicated-tripwire idiom, cf. that file's PIN6).
//
// EXPECTED: GREEN today, and green after — confirmed by run, 2026-08-22.
// Decision 4d9b76e8's fresh-stamp consult IS built; only board 0b848342's
// findings (1)/(2)/(3) — the pre-image restore, the gitignored-baseline
// attestation branch, the generation-bound stamp id — remain unbuilt. Do NOT
// read this as an expected-failure pin: a red here is a REAL regression.
//
// CATCHES SABOTAGE: the fresh-stamp check before a clean-at-Pre restore forced
// to `if (false)` — the attested edit is then restored and denied, firing both
// the code and the bytes assertion.
// =========================================================================

test('PIN-STAMP-BEFORE-RESTORE (tripwire): a CLEAN-at-Pre in-window change matching a fresh stamp is still honored — not restored, not denied', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const hooksJson = join(dir, 'hooks', 'hooks.json'); // CLEAN at Pre

    const L = lane('stamp');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0);

    const newBytes = JSON.stringify({ hooks: { PreToolUse: [] }, CONDUCTOR_EDIT: true }) + '\n';
    writeFileSync(hooksJson, newBytes);
    writeStamp(dir, [{ path: 'hooks/hooks.json', sha256: sha256Of(hooksJson), at: NOW }]);

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 0, `a matching fresh stamp must still exempt a clean-at-Pre in-window change — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    assert.equal(readFileSync(hooksJson, 'utf8'), newBytes, 'the attested bytes are KEPT, not reverted to HEAD');
  } finally {
    cleanup();
  }
});

// =========================================================================
// PIN-STAMP-ON-CHANGED-PREDIRT — THE ADJUDICATED ARM (decision 7021526c v2,
// settling the interaction its v1 left open; decision 4d9b76e8 WINS and its
// rule is GENERAL, not confined to the clean-at-Pre branch). Post's order is:
//   1. state UNCHANGED  -> allow, no stamp consulted (PIN-ALLOW);
//   2. state CHANGED    -> consult the stamp FRESH and hash the CURRENT state;
//                          exact match -> ALLOW, attested, and still NO restore;
//   3. otherwise        -> DENY, and still no restore.
// THE WHY, which is what makes step 2 safe rather than a hole: a stamp can be
// written ONLY by a deliberate conductor-run CLI and never from a Bash-invoked
// rebuild (decision 6e132e19 — auto-stamping from build-hooks.mjs was rejected
// precisely because an agent rebuilding inside its own Bash call would then
// self-attest). So current bytes matching a FRESH stamp mean the change is
// conductor-attested, and denying it would punish the conductor for its own
// attested edit.
//
// ARM 1 pins step 2: the stamp hashes the CHANGED (current) bytes -> allow.
// ARM 2 pins that step 2 hashes the CURRENT state and not the Pre image: a
// stamp matching the PRE-image while the file now holds something else is NOT
// an exact match, so it falls to step 3 and denies. Without arm 2 an
// implementation could compare the stamp against its own Pre snapshot and pass
// arm 1 while attesting nothing about what is actually on disk. Arm 2 runs
// FIRST in the body as defensive ordering: a sequential arm placed after a
// failing one never executes, so putting the cheaper guard first keeps it
// exercised even if the other arm ever regresses to red.
//
// EXPECTED: BOTH ARMS GREEN today, and green after — confirmed by run,
// 2026-08-22. THIS IS A REGRESSION GUARD, NOT A NEW-BEHAVIOUR PIN, and the
// reason matters: today's stamp consult already covers every pre-dirty path,
// ALL-OR-NOTHING over the whole pre-existing set, so "changed pre-dirty + fresh
// matching stamp -> allow" already happens — by a different route than the
// PER-PATH step 2 the adjudication describes. The adjudication therefore
// described behaviour already on disk rather than introducing it. The per-path
// rewrite could easily break this, which is exactly why the guard stays. A red
// here is a REAL regression, never an expected failure.
//
// CATCHES SABOTAGE: the fresh-stamp consult on the CHANGED-pre-dirty arm forced
// to `if (false)` — arm 1 flips to a deny, firing both its code assertion and
// its bytes assertion. Arm 2 catches the converse over-widening: a consult that
// matches against the Pre image, or that treats the mere PRESENCE of a stamp
// entry for the path as attestation.
//
// NO COLLISION with the mismatched/corrupt/non-array stamp table in
// enforcement.test.mjs: that table holds the state UNCHANGED, so it never
// reaches step 2 and the stamp's shape cannot matter there. The stamp is
// causally irrelevant on the unchanged arm and causally decisive on the changed
// arm — one order of operations, no contradiction.
// =========================================================================

test('PIN-STAMP-ON-CHANGED-PREDIRT: a pre-dirty path CHANGED in-window whose CURRENT bytes match a fresh stamp is conductor-attested — allow, and still no restore', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const bundle = bundlePath(dir);

    // ARM 2 FIRST (expected GREEN today, so today's red on arm 1 cannot mask it):
    // the stamp attests the PRE image while the file has since moved on. Not an
    // exact match on the CURRENT state -> step 3 denies.
    const preImage = '// X: conductor rebuild in flight, uncommitted\n';
    writeFileSync(bundle, preImage);

    const L2 = lane('stale-attestation');
    assert.equal(h17(dir, 'PreToolUse', L2).code, 0); // Pre snapshots X
    writeStamp(dir, [{ path: BUNDLE_REL, sha256: sha256Of(bundle), at: NOW }]); // hashes X, the Pre image
    const laterBytes = '// Z: changed again, while the stamp still attests X\n';
    writeFileSync(bundle, laterBytes); // ...then the file moves to Z

    let r = h17(dir, 'PostToolUse', L2);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `a stamp matching the PRE image rather than the CURRENT bytes attests nothing — must deny — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    assert.equal(readFileSync(bundle, 'utf8'), laterBytes, 'and the deny still performs no restore on a pre-dirty path');

    // ARM 1 (expected RED today) — the stamp attests the CHANGED bytes
    const L1 = lane('attested-change');
    assert.equal(h17(dir, 'PreToolUse', L1).code, 0); // Pre snapshots Z
    const conductorBytes = '// Y: the conductor continued its own rebuild INSIDE the window\n';
    writeFileSync(bundle, conductorBytes);
    assert.notEqual(conductorBytes, laterBytes, 'PRECONDITION: the state genuinely CHANGED — the allow below must come from step 2, never from step 1');
    writeStamp(dir, [{ path: BUNDLE_REL, sha256: sha256Of(bundle), at: NOW }]); // hashes the CURRENT bytes

    r = h17(dir, 'PostToolUse', L1);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 0, `a fresh stamp matching the CHANGED bytes is a conductor attestation and must allow — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    assert.equal(readFileSync(bundle, 'utf8'), conductorBytes, 'and the bytes are left exactly as the conductor wrote them: attested, and still NO restore');
  } finally {
    cleanup();
  }
});

// =========================================================================
// PIN-STAMP-PER-PATH-ON-CHANGED — step 2 is PER PATH, and this is the only
// place that shows it. Two pre-dirty enforcement paths, BOTH changed in-window,
// only ONE of them stamped.
//
// THE EXIT CODE CANNOT CARRY THIS TEST, which is why the assertions are about
// message content and disposition: the command DENIES either way, because the
// unstamped changed path denies on its own. What differs is ATTRIBUTION. Under
// an all-or-nothing consult over the changed set, one unstamped path collapses
// attestation for the whole set, so BOTH paths are treated as unverified and
// named. Under per-path step 2, the stamped path is attested and must NOT be
// reported as a violation or as unverified, while the unstamped one is.
//
// THE NEGATIVE ASSERTION IS PRECEDENTED, not invented: "no deny names the
// attested path" is already the accepted oracle for attestation in this
// territory (h17-stamp-honor.test.mjs PIN1, h17-stamp-honor-hardening.test.mjs
// PIN H4, the latter using this same /h3-contract-gate/ negative). What makes
// THIS test stronger than either is that here the exit is 2 and stderr is
// NON-EMPTY, so the attested path's absence cannot be satisfied by an empty
// message — it is the first test where an attested path must be absent from a
// denial that genuinely exists.
//
// ROLE ASSIGNMENT IS DELIBERATE: the ATTESTED path is the one with the
// distinctive name (hooks/h3-contract-gate.mjs) and the unattested one is
// hooks/hooks.json. A doesNotMatch on a generic token like /hooks\.json/ could
// fire on ordinary explanatory prose about the enforcement surface; a
// distinctive filename cannot appear by accident. KNOWN FRAGILITY, disclosed:
// if a future implementation prints an informational "attested:" line naming
// exempted paths, this assertion needs the region-scoped form (absent from the
// VIOLATION block rather than from the whole message) — the security property
// would be unchanged, only the oracle's shape.
//
// EXPECTED FAILURE SHAPE (RED): `assert.doesNotMatch(r.stderr,
// /h3-contract-gate/)` fires — today's all-or-nothing consult collapses on the
// unstamped hooks.json and names BOTH paths, so the attested path appears in
// the denial. The exit code and the /hooks\.json/ positive already hold today.
//
// CATCHES SABOTAGE: step 2 reverted to an all-or-nothing check over the changed
// set (any-unstamped -> attest nothing), which makes the stamped path reappear
// in the denial message and fires the doesNotMatch. Also catches the converse
// over-widening — one stamped path attesting the whole set — via the
// /hooks\.json/ positive and the code assertion.
// =========================================================================

test('PIN-STAMP-PER-PATH-ON-CHANGED: two pre-dirty paths BOTH changed in-window with only ONE stamped — the unstamped one is named, the ATTESTED one is not, and neither is restored', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const attestedPath = bundlePath(dir); // hooks/h3-contract-gate.mjs — distinctive name
    const unattestedPath = join(dir, 'hooks', 'hooks.json');
    writeFileSync(attestedPath, '// X1: parallel lane rebuild, uncommitted\n');
    writeFileSync(unattestedPath, JSON.stringify({ hooks: { PreToolUse: [] }, rebuilt: true }, null, 2) + '\n');

    const L = lane('mixed-attestation');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre snapshots both pre-dirty paths');

    // BOTH change inside the window
    const attestedAfter = '// Y1: the conductor continued its own rebuild INSIDE the window\n';
    const unattestedAfter = JSON.stringify({ hooks: {}, TAMPERED: true });
    writeFileSync(attestedPath, attestedAfter);
    writeFileSync(unattestedPath, unattestedAfter);

    // exactly ONE of the two is attested, on its CURRENT bytes
    writeStamp(dir, [{ path: BUNDLE_REL, sha256: sha256Of(attestedPath), at: NOW }]);
    const stamp = JSON.parse(readFileSync(stampPath(dir), 'utf8'));
    assert.equal(stamp.length, 1, 'PRECONDITION: exactly ONE of the two changed paths is stamped — otherwise this test cannot distinguish per-path from all-or-nothing');
    assert.equal(stamp[0].path, BUNDLE_REL, 'PRECONDITION: and it is the distinctively-named one');

    const r = h17(dir, 'PostToolUse', L);

    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `the UNSTAMPED changed path still denies, so the command denies either way — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    assert.match(r.stderr, /hooks\.json/, 'the unattested changed path IS named');
    assert.doesNotMatch(
      r.stderr,
      /h3-contract-gate/,
      'THE PIN: the attested changed path is NOT reported as a violation or as unverified — attestation is PER PATH, so one unstamped path cannot collapse it for the whole set'
    );
    assert.equal(readFileSync(attestedPath, 'utf8'), attestedAfter, 'the attested path keeps the conductor bytes — no restore');
    assert.equal(readFileSync(unattestedPath, 'utf8'), unattestedAfter, 'and the denied pre-dirty path is not restored either (the pre-image restore stays a deferred slice)');
  } finally {
    cleanup();
  }
});

// =========================================================================
// PIN-CLEAN-AT-PRE-UNCHANGED — the negative boundary that keeps the whole
// comparison from being written as "compare only what was dirty". A path CLEAN
// at Pre and CHANGED in-window is still swept, restored to HEAD and denied,
// with no stamp present. The pre-state comparison must not become a way in.
//
// EXPECTED FAILURE SHAPE: expected GREEN today (this is enforcement.test.mjs
// :1485's contract, restated here as a same-file tripwire because this slice
// rewrites the branch that sits immediately beside it).
//
// CATCHES SABOTAGE: any change that routes clean-at-Pre paths through the new
// pre-dirty "unchanged -> allow" arm — e.g. treating an absent per-path
// snapshot entry as "unchanged" instead of "was clean, must be swept".
// =========================================================================

test('PIN-CLEAN-AT-PRE-UNCHANGED (tripwire): a path CLEAN at Pre and changed in-window is still restored to HEAD and denied', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const bundle = bundlePath(dir); // clean at Pre
    const committed = readFileSync(bundle, 'utf8');
    assert.equal(existsSync(stampPath(dir)), false, 'PRECONDITION: no stamp — nothing may exempt this');

    const L = lane('cleanpre');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0);
    writeFileSync(bundle, '// tampered by the agent mid-command\n');

    const r = h17(dir, 'PostToolUse', L);
    assert.equal(r.code, 2, `an in-window tamper of a clean-at-Pre enforcement path must deny — ${oneLine(r.stderr)}`);
    assert.equal(readFileSync(bundle, 'utf8'), committed, 'restored to HEAD (unchanged behaviour)');
  } finally {
    cleanup();
  }
});

// #########################################################################
// ##  REVIEW FINDINGS AGAINST v3.3 (commit b945cf0) — FIVE PINS BELOW    ##
// #########################################################################
//
// Two independent reviews (a roster reviewer and an outside-model reviewer)
// found five defects in the shipped v3.3; all five were conductor-adjudicated
// REAL and are release blockers. Authored BLIND to
// scripts/hooks/h17-bash-write-sweep.mjs, exactly like the pins above — the
// findings were supplied as behaviour statements, and every fixture below is
// built from the STORE's account of the contract (article h17-bash-write-sweep
// AC12/AC13/AC14, decisions 7021526c / 4d9b76e8 / 6e132e19 / 2422e76a), never
// from hook source.
//
// NO CONFLICT WITH THE STORE, checked before authoring rather than assumed:
//   * F1 (dirty-at-Pre, CLEAN-at-Post must deny) is 7021526c's "otherwise
//     deny" arm reached through the EXISTENCE/BYTES terms — the ruling says
//     "compare state -> if unchanged, allow", and reverting a file to HEAD
//     changes its bytes, so it is not unchanged. Nothing in the ruling licenses
//     skipping a recorded pre-dirty path because git no longer reports it.
//   * F2/F3 (mode / index / TYPE changes are not attestable) rest on
//     7021526c's own words: "consult the stamp FRESH and hash the CURRENT
//     STATE". A stamp entry is {path, sha256} (4d9b76e8 FIX-A: "exact {path,
//     sha256} match"), which structurally cannot attest a mode, a file type or
//     an index entry — so those changes fall to the ruling's third arm. The
//     already-green PIN-STAMP-ON-CHANGED-PREDIRT arm 1 (a BYTES change matched
//     by a byte hash -> allow) is untouched: bytes are the one term a byte hash
//     can attest.
//   * F4's exploit route needs a tampered record, which 2422e76a accepts as a
//     determined-attacker residual ("the plaintext OS-temp baseline at a
//     deterministic path is forgeable in the same command"). These two pins are
//     therefore SHAPE-VALIDATION pins, not new-hole pins: AC12 promises "an
//     absent or unparseable record denies fail-closed", and a record whose
//     per-path VALUE is malformed is unparseable in every sense that matters.
//   * F5's chosen fix (a per-path sha256 instead of base64 bytes) narrows the
//     AC12 sentence "bytes (base64, lossless — never a UTF-8 string)". That
//     sentence's PURPOSE is stated in the same breath — it exists so a
//     byte-level change invisible to UTF-8 decoding is still CHANGED — and a
//     digest over the raw bytes preserves exactly that, which is why
//     PIN-UTF8-CHANGED / PIN-UTF8-UNCHANGED above remain correct AS WRITTEN
//     under a hash (raw-byte digest: differing bytes -> differing digest;
//     identical bytes -> identical digest). The two pins here add what a hash
//     newly makes checkable: the record stays FLAT as dirt grows, and the
//     digest covers the WHOLE file rather than a prefix.
//
// DELIBERATELY NOT PINNED, disclosed rather than smuggled in: the arm where a
// reverted-to-clean path carries a fresh stamp attesting the HEAD bytes. The
// sanctioned writer (scripts/enforcement-stamp.mjs, decision 6e132e19) "records
// whatever enforcement paths are currently DIRTY", so a stamp entry for a path
// that is clean is not a state the CLI can produce — asserting either outcome
// there would invent behaviour. Every deny below instead asserts NO STAMP
// EXISTS, the established idiom in this file, so each lands on the "otherwise"
// arm and none can be satisfied by the attested arm.
// #########################################################################

// the working tree as git reports it — used as a PRECONDITION, so a failure
// here is a fixture failure and must be loud (P5)
function porcelain(dir) {
  return git(dir, ['status', '--porcelain'], { must: true }).stdout;
}

// The single per-call snapshot record, for the tests that TAMPER it. Asserting
// exactly one keeps the tamper unambiguous; today's failure of this assertion
// is the same per-call-record precondition PIN-NO-RECORD documents.
function soleRecordPath(fx, why) {
  const records = perCallRecords(fx);
  assert.equal(
    records.length,
    1,
    `PRECONDITION: exactly ONE per-call snapshot record must exist so ${why} is unambiguous (found ${records.length}; per PIN-NO-RECORD a per-call record cannot be the per-run .dirty.json and must be its own sterling-enforce-<projectTag>-* temp file)`
  );
  return records[0];
}

// Recursively delete every `children` key, returning how many were removed.
// Blind-safe by construction: it assumes NOTHING about the record's key format
// for a dirty untracked directory (trailing slash or not) or about where in the
// value the children live.
function stripChildren(node) {
  let removed = 0;
  if (Array.isArray(node)) {
    for (const v of node) removed += stripChildren(v);
    return removed;
  }
  if (node && typeof node === 'object') {
    if (Object.prototype.hasOwnProperty.call(node, 'children')) {
      delete node.children;
      removed += 1;
    }
    for (const v of Object.values(node)) removed += stripChildren(v);
    return removed;
  }
  return 0;
}

const BIG_SIZE = 4 * 1024 * 1024; // one dirty file, big enough that base64 bytes cannot hide
const RECORD_BUDGET = 64 * 1024; // generous for a handful of per-path digests; 100x under base64 of BIG_SIZE

// =========================================================================
// PIN-REVERT-TO-CLEAN — FINDING 1 (CRITICAL), the fail-closed violation.
// Post iterates only the paths the CURRENT `git status` reports, so a path that
// was dirty at Pre and is CLEAN at Post is never visited: no comparison, no
// stamp consult, no denial. The reproducer is a destructive one — the command
// runs `git checkout HEAD -- <enforcement path>`, destroying the conductor's
// uncommitted enforcement-file work — and the agent is ALLOWED.
//
// THE CLAUSE PINNED: dirty-at-Pre and clean-at-Post is a STATE CHANGE and must
// DENY (decision 7021526c's third arm, reached because the bytes moved from the
// conductor's in-flight image to HEAD's).
//
// EXPECTED FAILURE SHAPE (RED TODAY): the tree is fully clean at Post, so
// today's blanket pre-existing denial has an empty pre-existing set and the
// call is ALLOWED — `assert.equal(r.code, 2)` fires with actual 0 and an empty
// stderr. This is red NOW, not red-after-PIN-ALLOW.
//
// CATCHES SABOTAGE: the recorded-pre-dirty iteration deleted, i.e. the Post
// loop reverted to `for (const rel of currentlyDirtyPaths)` — the recorded set
// is then only ever consulted as a lookup for paths git still reports, and this
// path disappears from the sweep entirely.
// =========================================================================

test('PIN-REVERT-TO-CLEAN: a pre-dirty enforcement path REVERTED to HEAD inside the window (CLEAN at Post, absent from git status) DENIES', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const bundle = bundlePath(dir);
    const headBytes = readFileSync(bundle, 'utf8');
    preDirtyBundle(dir, '// conductor rebuild in flight, uncommitted — the work this destroys\n');

    const L = lane('revert');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre snapshots the pre-dirty state');

    // THE COMMAND'S EFFECT. H17 watches file EFFECTS, never command strings
    // (decision f404dfb4), so the recorded tool_input stays the measured
    // read-only victim while the effect below is what the reproducer's
    // `git checkout HEAD -- hooks/h3-contract-gate.mjs` actually produces.
    git(dir, ['checkout', 'HEAD', '--', BUNDLE_REL], { must: true });

    assert.equal(
      porcelain(dir),
      '',
      'PRECONDITION AND THE WHOLE POINT: the tree is CLEAN at Post, so the path is ABSENT from git status and a Post that iterates only currently-dirty paths never visits it'
    );
    assert.equal(existsSync(stampPath(dir)), false, 'PRECONDITION: no stamp exists — this deny must land on the "otherwise" arm (step 3), never on the attested arm (step 2)');

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(
      r.code,
      2,
      `dirty-at-Pre + CLEAN-at-Post is a STATE CHANGE — the conductor's uncommitted enforcement work was destroyed inside this window — and must deny — actual ${r.code}, stderr: ${oneLine(r.stderr)}`
    );
    assert.match(r.stderr, /h3-contract-gate/, 'and the denial names the path whose RECORDED pre-dirty state changed');
    assert.equal(readFileSync(bundle, 'utf8'), headBytes, 'a CHANGED pre-dirty path is still never restored — the destroyed pre-image is NOT resurrected (that stays the deferred slice)');
  } finally {
    cleanup();
  }
});

// =========================================================================
// PIN-REVERT-TO-CLEAN-DEGRADED — FINDING 1, SECOND HALF: the same defect
// breaks the SAFETY NET. With no usable tool_use_id there is no per-call
// record, and the blanket pre-existing denial is driven by a set populated only
// while iterating currently-dirty paths — so a command that cleans EVERY
// pre-dirty enforcement path leaves that set empty and degraded mode ALLOWS.
// A fallback that fails OPEN is worse than the hole it backs up, which is why
// this gets its own pin rather than riding the one above.
//
// The empty-string tool_use_id is the same unusable-but-present shape
// PIN-FALLBACK-BLANK uses; what differs here is that the command CLEANS the
// dirt instead of leaving it.
//
// EXPECTED FAILURE SHAPE (RED TODAY): two independent red assertions — the
// call is ALLOWED (`assert.equal(r.code, 2)` fires with actual 0, stderr
// empty), and `assert.match(r.stderr, /tool_use_id/)` has nothing to match.
//
// CATCHES SABOTAGE: the degraded blanket denial computed from the CURRENT
// status instead of the RECORDED pre-dirty set (`if (currentDirty.length &&
// noUsableId) deny`) — the cleaned tree then has nothing to deny over.
// =========================================================================

test('PIN-REVERT-TO-CLEAN-DEGRADED: degraded mode (unusable tool_use_id) still DENIES when the command cleans EVERY pre-dirty enforcement path — the safety net may not fail open', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const bundle = bundlePath(dir);
    const headBytes = readFileSync(bundle, 'utf8');
    preDirtyBundle(dir, '// conductor rebuild in flight, uncommitted\n');

    const blank = { agent_id: 'a1', tool_use_id: '' }; // present but unusable
    assert.equal(h17(dir, 'PreToolUse', blank).code, 0, 'Pre runs; with no usable tool_use_id it writes no per-call STATE record (AC14)');

    git(dir, ['checkout', 'HEAD', '--', BUNDLE_REL], { must: true });

    assert.equal(porcelain(dir), '', 'PRECONDITION: every pre-dirty path is CLEAN at Post — nothing remains for a status-driven blanket denial to fire on');
    assert.equal(existsSync(stampPath(dir)), false, 'PRECONDITION: no stamp exists — nothing may exempt this');

    const r = h17(dir, 'PostToolUse', blank);
    assert.notEqual(r.code, 1, 'AC9: never a non-blocking exit 1');
    assert.equal(
      r.code,
      2,
      `degraded mode keeps the BLANKET pre-existing denial (AC14) — and a command that cleaned the dirt is exactly when it must fire, not when it lapses — actual ${r.code}, stderr: ${oneLine(r.stderr)}`
    );
    assert.match(r.stderr, /tool_use_id/, 'DEGRADED-LOUD: and it still names the reason it could not verify (AC14 — a silent degrade is a defect)');
    assert.equal(readFileSync(bundle, 'utf8'), headBytes, 'and the destroyed pre-image is not resurrected');
  } finally {
    cleanup();
  }
});

// =========================================================================
// PIN-STAMP-MODE — FINDING 2(a) (HIGH): THE STAMP ATTESTS BYTES, NOT STATE. On
// the changed-pre-dirty arm, attestation is decided by hashing the file's
// current bytes against the stamp — but a stamp entry records only {path,
// sha256} (4d9b76e8 FIX-A), so it structurally CANNOT attest a mode, a file
// type, or an index entry. A change whose bytes are IDENTICAL while another
// state term moved is therefore wrongly attested and allowed.
//
// THE CLAUSE PINNED: 7021526c's step 2 hashes the CURRENT STATE, not the
// current bytes; a state difference the stamp cannot express falls through to
// step 3 and DENIES. The complement of PIN-MODE above: that one pins the
// no-stamp route, this one pins the stamped route, and together they close both.
//
// EXPECTED FAILURE SHAPE (RED TODAY): today's stamp consult covers every
// pre-dirty path and matches on bytes alone, so the call is ALLOWED —
// `assert.equal(r.code, 2)` fires with actual 0.
//
// CATCHES SABOTAGE: the guard restricting stamp attestation to a BYTES-ONLY
// state difference deleted, i.e. attestation decided by the byte hash alone.
// (Existence, type, link target and index entry are all identical across this
// window, so mode is the only term that can produce the deny — the same
// isolation PIN-MODE relies on.)
// =========================================================================

test('PIN-STAMP-MODE: a MODE flip with byte-identical content is NOT attestable by a {path, sha256} stamp — a fresh stamp matching the bytes must still DENY', { skip: GIT_SKIP || MODE_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const bundle = preDirtyBundle(dir, '// conductor rebuild, not yet committed\n');
    chmodSync(bundle, 0o644);
    const bytesBefore = readFileSync(bundle, 'utf8');

    const L = lane('stampmode');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0);

    chmodSync(bundle, 0o755); // the ONLY change: the executable bit
    writeStamp(dir, [{ path: BUNDLE_REL, sha256: sha256Of(bundle), at: NOW }]);

    assert.equal(readFileSync(bundle, 'utf8'), bytesBefore, 'PRECONDITION: the bytes never moved, so the stamp attests EXACTLY the bytes that were there at Pre — a byte-hash consult matches');
    assert.equal(lstatSync(bundle).mode & 0o111, 0o111, 'PRECONDITION: the mode actually flipped on this host');
    assert.equal(JSON.parse(readFileSync(stampPath(dir), 'utf8'))[0].sha256, sha256Of(bundle), 'PRECONDITION: the stamp is FRESH against the CURRENT bytes — this test must fail on the mode term, never on a stale hash');

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(
      r.code,
      2,
      `a {path, sha256} entry can attest a BYTES change and nothing else — a mode flip it cannot see must still deny — actual ${r.code}, stderr: ${oneLine(r.stderr)}`
    );
  } finally {
    cleanup();
  }
});

// =========================================================================
// PIN-STAMP-INDEX — FINDING 2(b) (HIGH), the same defect through the INDEX
// term: `git add` inside the window moves the index entry while the worktree
// bytes stay byte-identical, so the fresh stamp still matches and a bytes-only
// attestation allows a staged tamper.
//
// EXPECTED FAILURE SHAPE (RED TODAY): allowed by today's bytes-only stamp
// consult — `assert.equal(r.code, 2)` fires with actual 0.
//
// CATCHES SABOTAGE: (a) the bytes-only restriction on stamp attestation
// deleted; (b) the INDEX blob-OID term deleted from the state comparison — the
// state then compares UNCHANGED, step 1 allows without any stamp consult at
// all, and the same assertion fires.
// =========================================================================

test('PIN-STAMP-INDEX: `git add` inside the window (worktree bytes untouched) is NOT attestable by a {path, sha256} stamp — a fresh matching stamp must still DENY', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const bundle = preDirtyBundle(dir, '// conductor rebuild, not yet committed\n');
    const bytesBefore = readFileSync(bundle, 'utf8');

    const L = lane('stampindex');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0);

    git(dir, ['add', BUNDLE_REL], { must: true }); // index moves; worktree does not
    writeStamp(dir, [{ path: BUNDLE_REL, sha256: sha256Of(bundle), at: NOW }]);

    assert.equal(readFileSync(bundle, 'utf8'), bytesBefore, 'PRECONDITION: the worktree bytes are untouched, so the stamp matches them exactly');
    assert.match(porcelain(dir), /^M /m, 'PRECONDITION: the change is STAGED — the index entry is what moved');

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(
      r.code,
      2,
      `a stamp cannot attest an INDEX entry — a staged-index-only change must still deny even with a byte-perfect fresh stamp — actual ${r.code}, stderr: ${oneLine(r.stderr)}`
    );
  } finally {
    cleanup();
  }
});

// =========================================================================
// PIN-STAMP-TYPE-GATE-ON-CHANGED-PREDIRT — RENAMED 2026-08-22 AFTER MUTATION
// MEASUREMENT (was PIN-STAMP-SYMLINK; the old name claimed a property the
// battery proved it does not pin, and a name is what most readers see). THIS
// TEST DOES NOT PIN THE STAMP-SIDE LINK GUARDS. It was authored to pin finding
// 3 (the stamp consult follows a symlink) and it does not. The conductor
// removed the stamp side's link guards one at a time and then together — the
// helper's regular-file check, the caller's `kind !== 'file'` early return, and
// both — and this test stayed GREEN every time. It is satisfied by a different
// guard.
//
// WHY, so the next reader does not repeat the mistake: this fixture exercises
// the CHANGED-PRE-DIRTY arm, and finding 2's fix put a gate in front of the
// stamp consult on that arm which rejects any state difference a {path, sha256}
// entry cannot speak for — a file TYPE change among them. A regular file
// replaced by a symlink is a type change, so the consult is never reached and
// the deny comes from finding 2's gate. On this path the link guards are dead
// code, which is precisely why removing them changed nothing.
//
// WHAT IT ACTUALLY PINS, and it is worth keeping for this: finding 2's gate
// covering the TYPE term on the changed-pre-dirty arm. The test name and the
// assertion messages now say exactly that. The rename touched ONLY those
// strings — the fixture, the assertions and the expected outcomes are
// unchanged — so the measurement recorded above still describes this exact
// test.
//
// CATCHES SABOTAGE (measured): the gate's TYPE term forced true, i.e. an
// attestation predicate that treats a type change as byte-attestable — the
// out-of-repo bytes are then hashed and attested and this test goes red.
// DOES NOT CATCH (measured): either stamp-side link guard, alone or together.
//
// FINDING 3's LINK GUARDS ARE PINNED BY PIN-STAMP-SYMLINK-CLEAN-AT-PRE at the
// end of this file, on the CLEAN-AT-PRE arm — where a path has no recorded
// state, so there is no difference to qualify, finding 2's gate is not
// consulted, and the lstat guard is the only thing standing between a symlink
// and an attested allow. That is the arm where the guards are load-bearing.
//
// Skips with a named reason where the host cannot create symlinks, exactly as
// PIN-TYPE and PIN-LINK do (P5: a check that cannot run says so).
// =========================================================================

test('PIN-STAMP-TYPE-GATE-ON-CHANGED-PREDIRT: a pre-dirty path whose file TYPE changed in-window is not byte-attestable — the gate must reject it BEFORE the stamp consult, so a fresh stamp matching the bytes still DENIES', { skip: GIT_SKIP || SYMLINK_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  const decoy = join(tmpdir(), 'sterling-h17-stampdecoy-' + randomUUID().slice(0, 8));
  try {
    const bundle = preDirtyBundle(dir, '// X: conductor rebuild in flight, uncommitted\n');
    const decoyBytes = '// Z: content the hook loader would execute, from OUTSIDE the repo\n';
    writeFileSync(decoy, decoyBytes);

    const L = lane('stamplink');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0);

    rmSync(bundle, { force: true });
    symlinkSync(decoy, bundle);
    // the stamp attests the bytes now reachable at the path, so a BYTE mismatch
    // cannot be why this denies — the TYPE term has to carry it
    writeStamp(dir, [{ path: BUNDLE_REL, sha256: createHash('sha256').update(decoyBytes).digest('hex'), at: NOW }]);

    assert.equal(readFileSync(bundle, 'utf8'), decoyBytes, 'PRECONDITION: the bytes at the path equal the STAMPED bytes, so a byte-hash attestation would match — the deny must come from the TYPE term, never from a stale or mismatched stamp');
    assert.equal(lstatSync(bundle).isSymbolicLink(), true, 'PRECONDITION: the path is no longer a regular file — this is how the fixture produces a TYPE change');

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(
      r.code,
      2,
      `a TYPE change is not attestable by {path, sha256}, so the gate must reject it before the stamp is ever consulted — actual ${r.code}, stderr: ${oneLine(r.stderr)}`
    );
    assert.equal(lstatSync(bundle).isSymbolicLink(), true, 'the changed pre-dirty path is still not restored (the pre-image restore stays the deferred slice)');
    assert.equal(readFileSync(decoy, 'utf8'), decoyBytes, 'containment check, NOT the link pin: this arm restores nothing at all, so an untouched out-of-repo target is expected either way — the link guards are pinned by PIN-STAMP-SYMLINK-CLEAN-AT-PRE');
  } finally {
    cleanup([decoy]);
  }
});

// =========================================================================
// PIN-RECORD-DIR-NO-CHILDREN — FINDING 4(a) (MEDIUM): the record's per-path
// VALUES are under-validated. Only the top-level object and its KEYS are
// checked, so a recorded DIRECTORY state that OMITS `children` compares EQUAL
// to a real empty directory (the comparison reads a missing children map as
// `{}`), and the destruction of every file under a dirty untracked
// enforcement-surface directory is allowed.
//
// WHY THE FIXTURE IS SHAPED THIS WAY, and why it ISOLATES this finding from
// finding 1: an EMPTY directory is invisible to git, so the emptied path is
// absent from Post's status output and is reached only by iterating the
// RECORDED pre-dirty set. Finding 1's fix alone therefore makes Post VISIT this
// path and then compare `{}` against `{}` and ALLOW — this test stays red until
// the missing-children shape itself denies. The tamper is a tampered record,
// which 2422e76a accepts as a determined-attacker residual; the pin is on the
// implementation's own claim that unexpected shapes DENY (AC12: "an absent or
// unparseable record denies fail-closed").
//
// EXPECTED FAILURE SHAPE (RED TODAY): `soleRecordPath`'s precondition fires
// first — no per-call record exists today at all (the same first-failure
// PIN-NO-RECORD, PIN-CORRUPT-RECORD and PIN-KEY have). Once the record exists,
// the carrying assertion is `assert.equal(r.code, 2)` with actual 0.
//
// CATCHES SABOTAGE: the per-path VALUE validation deleted, i.e. a directory
// state read as `pre.children ?? {}` — the emptied directory then compares
// equal and the call is allowed. Also catches a validator that checks only
// `typeof value === 'object'`.
//
// It asserts only THAT it denies, never HOW: per AC12 a malformed record may
// legitimately deny naming the RECORD rather than the path, so pinning the
// message text here would pin an implementation choice this finding does not
// settle.
// =========================================================================

test('PIN-RECORD-DIR-NO-CHILDREN: a recorded DIRECTORY state with NO `children` key DENIES — it must not compare EQUAL to a real EMPTY directory', { skip: GIT_SKIP }, () => {
  const fx = makeGitProject();
  const { dir, cleanup } = fx;
  try {
    const newDir = join(dir, 'hooks', 'newdir');
    mkdirSync(newDir, { recursive: true });
    writeFileSync(join(newDir, 'a.mjs'), '// untracked enforcement-surface file, uncommitted\n');
    assert.match(porcelain(dir), /newdir/, 'PRECONDITION: the untracked enforcement-surface directory is dirty at Pre and visible to porcelain');

    const L = lane('nochildren');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0);

    const rec = soleRecordPath(fx, 'the record tamper below');
    const parsed = JSON.parse(readFileSync(rec, 'utf8'));
    const removed = stripChildren(parsed);
    assert.ok(
      removed >= 1,
      'PRECONDITION: Pre must record recursive `children` for a dirty untracked directory (AC12) — with no children term anywhere in the record there is nothing for this pin to remove and the fixture is not exercising the defect'
    );
    writeFileSync(rec, JSON.stringify(parsed));

    // the child goes; the now-EMPTY directory stays
    rmSync(join(newDir, 'a.mjs'), { force: true });
    assert.equal(existsSync(newDir), true, 'PRECONDITION: the directory itself still exists and is now EMPTY — the state a missing children map is read as');
    assert.equal(
      porcelain(dir),
      '',
      'PRECONDITION: git cannot see an empty directory, so this path is ABSENT from Post\'s status and is reached only by iterating the RECORDED pre-dirty set'
    );
    assert.equal(existsSync(stampPath(dir)), false, 'PRECONDITION: no stamp exists — nothing may exempt this');

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'AC9: never a non-blocking exit 1');
    assert.equal(
      r.code,
      2,
      `a directory state with no \`children\` key is an unexpected shape and must deny — read as {} it compares EQUAL to the emptied directory and ALLOWS the destruction of every file under it — actual ${r.code}, stderr: ${oneLine(r.stderr)}`
    );
    assert.notEqual(oneLine(r.stderr), '', 'and the denial says something (P5: never a silent exit 2)');
  } finally {
    cleanup();
  }
});

// =========================================================================
// PIN-RECORD-PROTO — FINDING 4(b) (MEDIUM): the lookup map is a plain object,
// so a crafted `__proto__` key can install an INHERITED state that satisfies a
// real pre-dirty path and bypasses the explicit absent-entry check.
//
// HOW THE FIXTURE AVOIDS GUESSING THE STATE SCHEMA — and this is the load-
// bearing trick: the crafted prototype entry is not hand-written, it is
// HARVESTED. A second Pre runs after the tamper, so the record it writes holds
// the genuine state of the tampered file AS IT IS AT POST. Nothing about the
// state's field names is assumed, and a term this test does not know about (a
// timestamp, an inode) cannot make the pin pass for the wrong reason, because
// the harvest happens between the tamper and the Post with nothing changing in
// between.
//
// Built as TEXT, not an object literal: `{ __proto__: v }` in source SETS the
// prototype instead of creating an own property, so JSON.stringify would emit
// `{}` and the test would prove nothing.
//
// EXPECTED FAILURE SHAPE (RED TODAY): the per-call-record precondition fires
// first (no per-call record today), then the harvest key lookup. Once records
// exist, the carrying assertion is `assert.equal(r.code, 2)` with actual 0 if
// the map is pollutable.
//
// CATCHES SABOTAGE: the parsed record copied into a fresh lookup object with
// `Object.assign(map, parsed)` or a `for (const k of keys) map[k] = parsed[k]`
// loop — both route an own `__proto__` property through [[Set]] and really do
// change the map's prototype, after which the real path resolves the crafted
// state, compares UNCHANGED, and is allowed. (JSON.parse alone creates
// `__proto__` as an own data property and does not pollute — which is exactly
// why the sabotage is a copy step, and why this pin must exist before someone
// adds one.)
// =========================================================================

test('PIN-RECORD-PROTO: a record carrying a `__proto__` key must not let a real pre-dirty path resolve its state through the PROTOTYPE — that path still DENIES', { skip: GIT_SKIP }, () => {
  const fx = makeGitProject();
  const { dir, cleanup } = fx;
  try {
    const bundle = preDirtyBundle(dir, '// X: parallel lane rebuild, uncommitted\n');

    const L = lane('proto');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre L snapshots X');
    const afterL = perCallRecords(fx);
    assert.equal(afterL.length, 1, `PRECONDITION: exactly one per-call record after Pre L (found ${afterL.length}; see PIN-NO-RECORD)`);

    const tampered = '// Y: TAMPERED by this command, inside its own window\n';
    writeFileSync(bundle, tampered);

    // HARVEST the genuine post-tamper state — see the block comment
    const H = lane('protoharvest');
    assert.equal(h17(dir, 'PreToolUse', H).code, 0, 'a second Pre records the CURRENT (tampered) state');
    const harvestPath = perCallRecords(fx).find((p) => !afterL.includes(p));
    assert.ok(harvestPath, 'PRECONDITION: the harvest Pre wrote its OWN per-call record rather than overwriting lane L\'s (per-call keying — PIN-KEY)');
    const harvested = JSON.parse(readFileSync(harvestPath, 'utf8'));
    const key = Object.keys(harvested).find((k) => k.includes('h3-contract-gate'));
    assert.ok(key, `PRECONDITION: the record keys the pre-dirty path so its state can be harvested (keys seen: ${Object.keys(harvested).join(', ')})`);
    const stateY = harvested[key];
    rmSync(harvestPath, { force: true }); // the harvest lane's Post is never run

    const crafted = '{"__proto__":' + JSON.stringify({ [key]: stateY }) + '}';
    const craftedParsed = JSON.parse(crafted);
    assert.match(crafted, /"__proto__"/, 'PRECONDITION: the crafted record really carries a __proto__ KEY');
    assert.equal(
      Object.prototype.hasOwnProperty.call(craftedParsed, key),
      false,
      'PRECONDITION: and NO OWN entry for the real path — the prototype is the only route to a state, so an immune implementation must hit its absent-entry deny'
    );
    writeFileSync(afterL[0], crafted);
    assert.equal(existsSync(stampPath(dir)), false, 'PRECONDITION: no stamp exists — nothing may exempt this');

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'AC9: never a non-blocking exit 1');
    assert.equal(
      r.code,
      2,
      `a real pre-dirty path with no OWN record entry must hit the absent-entry deny and must never satisfy it through an inherited state — actual ${r.code}, stderr: ${oneLine(r.stderr)}`
    );
    assert.equal(readFileSync(bundle, 'utf8'), tampered, 'and the changed pre-dirty path is still not restored');
  } finally {
    cleanup();
  }
});

// =========================================================================
// PIN-RECORD-NO-BYTES-BLOAT — FINDING 5 (MEDIUM, resource shape). Pre
// snapshots every dirty path in the repo, recursing untracked directories and
// base64-encoding every file, with no cap on file size, child count, total
// bytes, path count or recursion depth — measured 717 KB live. A guard that
// OOMs or times out is a guard that FAILS, and it fails OUTSIDE its own
// fail-closed control flow, where AC9 cannot reach it.
//
// THE CHOSEN FIX is a per-path sha256 INSTEAD of base64 bytes (comparison only
// ever needs equality; the bytes existed solely for a pre-image restore that is
// explicitly out of scope, 7021526c). So the pin is on the OBSERVABLE
// CONSEQUENCE, not the mechanism: the record does not grow with the SIZE of the
// dirt. This is expressible blind because the record is an observable artifact
// of the Pre call — the harness already locates it by name for PIN-NO-RECORD —
// so nothing here reads or assumes hook source.
//
// EXPECTED FAILURE SHAPE (RED TODAY): `soleRecordPath`'s precondition fires
// first (no per-call record today). Under a base64 implementation the carrying
// assertion is the size bound, firing with ~5.6 MB against a 64 KiB budget.
//
// CATCHES SABOTAGE: the per-path digest replaced by (or accompanied by) the
// base64 bytes — the record immediately exceeds the budget. The budget is
// deliberately ~100x above what per-path digests need and ~100x below base64 of
// BIG_SIZE, so it cannot fire on incidental record growth.
// =========================================================================

test('PIN-RECORD-NO-BYTES-BLOAT: a 4 MiB pre-dirty file does not make the per-call record grow proportionally — the record holds a per-path DIGEST, not the bytes', { skip: GIT_SKIP }, () => {
  const fx = makeGitProject();
  const { dir, cleanup } = fx;
  try {
    const bundle = preDirtyBundle(dir, Buffer.alloc(BIG_SIZE, 0x41));
    assert.equal(lstatSync(bundle).size, BIG_SIZE, 'PRECONDITION: the pre-dirty enforcement path really is 4 MiB');

    const L = lane('bloat');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0);

    const rec = soleRecordPath(fx, 'the size measurement below');
    const size = lstatSync(rec).size;
    assert.ok(
      size < RECORD_BUDGET,
      `the record must stay FLAT as dirt grows: a per-path digest is a few hundred bytes, base64 bytes are ~4/3 of the tree (${BIG_SIZE} bytes of dirt -> ~5.6 MB of record, and no cap on size, child count, path count or depth). Measured ${size} bytes against a ${RECORD_BUDGET}-byte budget`
    );
  } finally {
    cleanup();
  }
});

// =========================================================================
// PIN-LARGE-MIDFILE-FLIP — FINDING 5's OTHER HALF, the one that keeps the fix
// honest: moving from bytes to a digest must not narrow WHAT IS COMPARED. One
// byte flipped 3 MiB into a 4 MiB pre-dirty file, with the file LENGTH held
// identical, must still be CHANGED.
//
// This is the scale companion to PIN-UTF8-CHANGED, which already pins that a
// byte-level change invisible to UTF-8 decoding still denies — and which
// remains correct AS WRITTEN under a raw-byte digest (differing bytes ->
// differing digest). What this adds is the sabotage PIN-UTF8-CHANGED's tiny
// fixture cannot see: a digest computed over a PREFIX, a truncated read, or a
// size+mtime shortcut.
//
// EXPECTED FAILURE SHAPE: denies TODAY for the wrong reason (the blanket
// pre-existing denial). Once PIN-ALLOW's behaviour lands, a prefix/truncated
// digest or a size-based shortcut reports UNCHANGED and ALLOWS, so
// `assert.equal(r.code, 2)` fires with actual 0. A regression/mutation guard,
// exactly like PIN-MODE — not a today-red pin, and labelled so nobody reads a
// green here as proof the fix landed.
//
// CATCHES SABOTAGE: the digest computed over a bounded prefix
// (`createHash('sha256').update(buf.subarray(0, 65536))`), a read capped at N
// bytes, or a comparison that falls back to size+mtime above a size threshold.
// =========================================================================

test('PIN-LARGE-MIDFILE-FLIP: ONE byte flipped 3 MiB into a 4 MiB pre-dirty file (length identical) is still CHANGED — DENIES', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const before = Buffer.alloc(BIG_SIZE, 0x41);
    const bundle = preDirtyBundle(dir, before);

    const L = lane('midflip');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0);

    const at = 3 * 1024 * 1024; // far beyond any plausible prefix window
    const after = Buffer.from(before);
    after[at] = 0x42;
    writeFileSync(bundle, after);

    assert.equal(after.length, before.length, 'PRECONDITION: the length is IDENTICAL, so a size-only check cannot carry this test');
    assert.notEqual(after[at], before[at], 'PRECONDITION: exactly one byte differs, 3 MiB in');
    assert.equal(lstatSync(bundle).size, BIG_SIZE, 'PRECONDITION: and the file on disk is still 4 MiB');
    assert.equal(existsSync(stampPath(dir)), false, 'PRECONDITION: no stamp exists — this deny must land on the "otherwise" arm (step 3)');

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(
      r.code,
      2,
      `a mid-file single-byte flip must deny — a digest replacing the bytes must cover the WHOLE file, never a prefix — actual ${r.code}, stderr: ${oneLine(r.stderr)}`
    );
  } finally {
    cleanup();
  }
});

// =========================================================================
// PIN-STAMP-SYMLINK-CLEAN-AT-PRE — FINDING 3, ON THE ARM WHERE THE STAMP-SIDE
// LINK GUARDS ARE ACTUALLY LOAD-BEARING. Replaces the coverage
// PIN-STAMP-TYPE-GATE-ON-CHANGED-PREDIRT (formerly PIN-STAMP-SYMLINK) was
// authored for and measurably does not provide (see its comment above): that
// fixture rides the CHANGED-PRE-DIRTY arm, where finding 2's attestation gate
// rejects a TYPE change before the stamp consult is ever reached, so the link
// guards are dead code there and removing them changed nothing.
//
// THIS arm is different, and the difference is the whole reason the pin lives
// here: a path CLEAN at Pre has NO recorded state, so there is no difference to
// qualify and finding 2's gate is not consulted at all — the stamp check is
// called directly. The lstat guard is then the only thing between a symlink and
// an attested allow, and an attested allow means the hook loader executes
// content from a path OUTSIDE the repo that no sweep covers and no
// `git checkout` can restore.
//
// THE CONTROL IS NOT OPTIONAL, and it is the lesson of the hollow pin: a test
// that denies for an unrelated reason is indistinguishable from a test that
// works. So the control arm runs FIRST and proves the stamp WOULD attest these
// exact bytes at this exact path as a REGULAR FILE — same path key, same
// sha256, byte-identical stamp file, asserted identical. Only then does the pin
// arm re-run the same fixture with the bytes behind a symlink. A green pin arm
// therefore always carries the control's evidence: the deny cannot be "the
// stamp never attested anything", because the stamp just did.
//
// ORDERING IS DELIBERATE (the idiom PIN-STAMP-ON-CHANGED-PREDIRT established): a
// sequential arm placed after a failing one never executes, and the arm whose
// evidence the other arm depends on must be the one that runs.
//
// EXPECTED FAILURE SHAPE: with the caller's `kind !== 'file'` early return
// removed (alone, or together with the helper's regular-file guard) the stamp
// hashes THROUGH the link, matches, and the change is attested — so
// `assert.equal(r.code, 2)` fires with actual 0 AND the restore assertion fires
// with the path still a symlink.
//
// CATCHES SABOTAGE — MEASURED 2026-08-22, so nobody has to infer it: removing
// BOTH stamp-side link guards (the caller's `kind !== 'file'` early return AND
// the helper's regular-file check) makes this test RED, firing exactly as the
// failure shape above predicts. Removing EITHER guard alone leaves it GREEN,
// because the two are redundant with each other — either one still refuses to
// hash through the link.
//
// READ THAT DISTINCTION CAREFULLY BEFORE CALLING THIS PIN HOLLOW: a green under
// a single-guard mutation is correct defense in depth, not hollowness. The
// difference from the test above, which WAS hollow, is the both-guards case —
// that one stayed green with both guards gone, meaning no mutation of the
// mechanism could ever move it. This one goes red the moment the property it
// names stops holding. The control arm is what makes the verdict trustworthy:
// because a byte-identical stamp attested moments earlier, a green pin arm
// cannot be explained away as "the stamp was never attesting."
// =========================================================================

test('PIN-STAMP-SYMLINK-CLEAN-AT-PRE: a CLEAN-at-Pre path replaced in-window by a SYMLINK to an OUT-OF-REPO file holding the stamped bytes is NOT attested — DENIES and is restored (control: the same bytes as a regular file ARE attested)', { skip: GIT_SKIP || SYMLINK_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  const decoy = join(tmpdir(), 'sterling-h17-cleanpre-decoy-' + randomUUID().slice(0, 8));
  try {
    const bundle = bundlePath(dir);
    const headBytes = readFileSync(bundle, 'utf8');
    const decoyBytes = '// Z: content the hook loader would execute, from OUTSIDE the repo\n';
    writeFileSync(decoy, decoyBytes);

    // ONE stamp, used by BOTH arms. Hashed from the bytes directly, never
    // through a path, so the fixture cannot accidentally hash a link.
    const stampEntries = [{ path: BUNDLE_REL, sha256: createHash('sha256').update(decoyBytes).digest('hex'), at: NOW }];

    // ---- CONTROL ARM (expected ALLOW): the stamp genuinely attests these
    // bytes at this path when they arrive as a REGULAR FILE. Without this, a
    // deny in the pin arm proves nothing.
    assert.equal(porcelain(dir), '', 'PRECONDITION: the path is CLEAN at Pre — this arm is the clean-at-Pre branch, not the pre-dirty one');
    const C = lane('cleanpre-control');
    assert.equal(h17(dir, 'PreToolUse', C).code, 0);

    writeFileSync(bundle, decoyBytes); // a plain regular-file write of the stamped bytes
    writeStamp(dir, stampEntries);
    const stampText = readFileSync(stampPath(dir), 'utf8');
    assert.equal(lstatSync(bundle).isFile(), true, 'PRECONDITION: the control arm writes a REGULAR FILE');

    const control = h17(dir, 'PostToolUse', C);
    assert.notEqual(control.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(
      control.code,
      0,
      `CONTROL: a fresh stamp matching the CURRENT bytes of a clean-at-Pre in-window change must be honored (decision 4d9b76e8) — if THIS fails the pin arm below cannot be trusted, because the stamp is not attesting at all — actual ${control.code}, stderr: ${oneLine(control.stderr)}`
    );
    assert.equal(readFileSync(bundle, 'utf8'), decoyBytes, 'CONTROL: and the attested bytes are KEPT, not restored to HEAD');

    // ---- back to CLEAN, so the pin arm runs the same branch as the control
    git(dir, ['checkout', 'HEAD', '--', BUNDLE_REL], { must: true });
    assert.equal(porcelain(dir), '', 'PRECONDITION: the path is CLEAN at Pre again for the pin arm');
    assert.equal(readFileSync(bundle, 'utf8'), headBytes, 'PRECONDITION: and back to its committed bytes');

    // ---- PIN ARM: the SAME stamped bytes, now reachable only THROUGH a link
    const S = lane('cleanpre-symlink');
    assert.equal(h17(dir, 'PreToolUse', S).code, 0);

    rmSync(bundle, { force: true });
    symlinkSync(decoy, bundle);
    writeStamp(dir, stampEntries); // the conductor stamps mid-window, exactly as in the control
    assert.equal(readFileSync(stampPath(dir), 'utf8'), stampText, 'THE CONTROL\'S FORCE: the stamp is BYTE-IDENTICAL to the one that just attested — same path key, same sha256, same freshness');
    assert.equal(lstatSync(bundle).isSymbolicLink(), true, 'PRECONDITION: the repo path is now a SYMLINK, not a regular file');
    assert.equal(readFileSync(bundle, 'utf8'), decoyBytes, 'PRECONDITION: following the link yields the STAMPED bytes — a link-following consult finds an exact match');

    const r = h17(dir, 'PostToolUse', S);
    assert.notEqual(r.code, 1, 'AC9: never a non-blocking exit 1');
    assert.equal(
      r.code,
      2,
      `a symlink is not a regular file and the stamp must NOT attest it — attesting it would let the hook loader execute content from outside the repo that no sweep covers — actual ${r.code}, stderr: ${oneLine(r.stderr)}`
    );
    assert.equal(lstatSync(bundle).isSymbolicLink(), false, 'the clean-at-Pre arm RESTORES an unattested in-window change — so the symlink is gone');
    assert.equal(readFileSync(bundle, 'utf8'), headBytes, 'and the path holds its committed bytes again');
    assert.equal(existsSync(decoy), true, 'the out-of-repo target still exists — a restore must never delete through a link');
    assert.equal(readFileSync(decoy, 'utf8'), decoyBytes, 'and its bytes are untouched — a restore that writes THROUGH a link is an arbitrary-write primitive outside the repo (AC10)');
  } finally {
    cleanup([decoy]);
  }
});
