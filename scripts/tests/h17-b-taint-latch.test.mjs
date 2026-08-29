// H17 (B) SURFACE — CROSS-CALL TAINT LATCH (Sterling SLICE S3).
//
// Spec: decision `b-surface-adoption-point-closes-with-an-incident-bound-taint-latch-not-a-persisted-manifest`
// (bcd2cc09), RULINGS 7-11 specifically, refining decision
// `h17-ruling-d-needs-a-b-enumerating-stamp-producer-and-stamp-invalidation`
// (fac9a69b) which this file's sibling scripts/tests/h17-b-detect-and-deny.test.mjs
// already pins (single-call detect-and-deny, one-call/two-call self-attestation
// forgery). THIS FILE PINS ONLY THE NEW CROSS-CALL LATCH — it does not repeat
// the detect-and-deny pins already established there.
//
// THE DEFECT THIS SLICE CLOSES (bcd2cc09's own opening paragraph): Pre
// re-collects the (B) baseline from CURRENT DISK STATE every call. An
// unattested (B) modify is denied EXACTLY ONCE, with the bytes deliberately
// left on disk (fac9a69b's ruling) — but the VERY NEXT call's Pre adopts those
// tampered bytes as its own new legitimate baseline and ALLOWS forever. One
// denial currently buys a permanent edit to live enforcement config
// (`.claude/agents/**` is the agent GRANT DEFINITIONS). AC-L4 below is the
// direct, executable proof of this bug against HEAD, and the direct proof
// that the fix closes it.
//
// Authored BLIND to scripts/hooks/h17-bash-write-sweep.mjs and
// scripts/enforcement-stamp.mjs per H4 — no hook or CLI source was read to
// write these pins. Every expectation comes from the dispatch brief's ACs and
// decision bcd2cc09's prose (a decision record is spec, not implementation —
// H4's wall gates Read/Grep on code, not knowledge_get).
//
// HARNESS is a faithful, non-imported copy of the makeGitProject/h17/lane/git/
// oneLine/stampPath/writeStamp/coderPath/sha256Of idiom shared by
// scripts/tests/h17-b-detect-and-deny.test.mjs (the primary model for nearly
// every helper below — copied in shape, not imported, since that file exports
// nothing). The SYMLINK_SKIP host-capability-probe idiom is copied in shape
// from scripts/tests/h17-baseline-symlink.test.mjs. The FIFO_SKIP,
// UNREADABLE_SKIP and WRITE_DENY_SKIP probes have NO sibling precedent found
// in this repo's H17 test files — they are newly authored for this file,
// following the same "probe on this host, skip with a named reason rather
// than fail or vacuously pass" shape as SYMLINK_SKIP/DEEP_SKIP/HARDLINK_SKIP.
// Flagged in the handoff report as new, unprecedented harness pieces.
//
// RUN COMMAND (node toolchain adapter):
//   node --test scripts/tests/h17-b-taint-latch.test.mjs

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
  lstatSync,
  statSync,
  chmodSync,
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
// Flatten whitespace, never truncate. (Copied in shape from
// h17-b-detect-and-deny.test.mjs.)
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

// Copied in shape from h17-baseline-symlink.test.mjs's SYMLINK_SKIP.
const SYMLINK_SKIP = (() => {
  try {
    const d = mkdtempSync(join(tmpdir(), 'sterling-latch-symprobe-'));
    writeFileSync(join(d, 'target'), 'x');
    symlinkSync(join(d, 'target'), join(d, 'link'));
    const ok = lstatSync(join(d, 'link')).isSymbolicLink();
    rmSync(d, { recursive: true, force: true });
    return ok ? false : 'symlinks are not observable on this host';
  } catch (e) {
    return `symlinks unavailable on this host (${e.code ?? e.message})`;
  }
})();

// NEW — no sibling precedent found. Probes whether `mkfifo` is available and
// actually produces a FIFO node this host can lstat as such, rather than
// assuming POSIX support or failing opaquely mid-test (P5).
const FIFO_SKIP = (() => {
  let d;
  try {
    d = mkdtempSync(join(tmpdir(), 'sterling-latch-fifoprobe-'));
    const p = join(d, 'f');
    const r = spawnSync('mkfifo', [p]);
    if (r.error || r.status !== 0) {
      return `mkfifo is not available on this host (${r.error?.code ?? r.status}, stderr: ${oneLine(r.stderr)})`;
    }
    const ok = lstatSync(p).isFIFO();
    return ok ? false : 'mkfifo ran but the result does not lstat as a FIFO on this host';
  } catch (e) {
    return `mkfifo unavailable on this host (${e.code ?? e.message})`;
  } finally {
    if (d) rmSync(d, { recursive: true, force: true });
  }
})();

// NEW — no sibling precedent found. Probes whether this process is actually
// denied read access by a 0o000 file (it will not be if running as root, in
// which case the fixture cannot be honestly constructed and must skip, not
// vacuously pass).
const UNREADABLE_SKIP = (() => {
  let d;
  try {
    d = mkdtempSync(join(tmpdir(), 'sterling-latch-unreadprobe-'));
    const p = join(d, 'f');
    writeFileSync(p, 'x');
    chmodSync(p, 0o000);
    try {
      readFileSync(p);
      return 'this process can read a 0o000 file (likely running as root/uid 0) — the unreadable-file fixture cannot be constructed honestly on this host';
    } catch (e) {
      return e.code === 'EACCES' ? false : `unexpected error probing unreadable-file support (${e.code ?? e.message})`;
    }
  } catch (e) {
    return `unreadable-file fixture unsupported on this host (${e.code ?? e.message})`;
  } finally {
    if (d) {
      try {
        chmodSync(join(d, 'f'), 0o644);
      } catch {}
      rmSync(d, { recursive: true, force: true });
    }
  }
})();

// NEW — no sibling precedent found. Probes whether this process is actually
// denied file-creation by a 0o555 directory (root bypasses this).
const WRITE_DENY_SKIP = (() => {
  let d;
  try {
    d = mkdtempSync(join(tmpdir(), 'sterling-latch-writedenyprobe-'));
    chmodSync(d, 0o555);
    try {
      writeFileSync(join(d, 'probe'), 'x');
      return 'this process can create files inside a 0o555 directory (likely running as root/uid 0) — the set-failure fixture cannot be constructed honestly on this host';
    } catch (e) {
      return e.code === 'EACCES' || e.code === 'EPERM' ? false : `unexpected error probing write-deny support (${e.code ?? e.message})`;
    }
  } catch (e) {
    return `write-deny fixture unsupported on this host (${e.code ?? e.message})`;
  } finally {
    if (d) {
      try {
        chmodSync(d, 0o755);
      } catch {}
      rmSync(d, { recursive: true, force: true });
    }
  }
})();

function git(dir, args, { must = false } = {}) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (must) assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${oneLine(r.stderr)}`);
  return r;
}

// Copied in shape from h17-b-detect-and-deny.test.mjs's makeGitProject.
function makeGitProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h17-latch-'));
  const runId = 'r-h17latch-' + randomUUID().slice(0, 8);

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

// THE LATCH — Ruling 7: `.sterling/enforcement-taint.json`, a plain file,
// deliberately outside the sealed DB and outside BASELINE_GLOBS.
function latchPath(dir) {
  return join(dir, '.sterling', 'enforcement-taint.json');
}

// ===========================================================================
// AC-L7 — CONTROL, PLACED FIRST (per the task instruction and this file's own
// assertion-quality rule): with NO latch and an UNCHANGED (B) surface, the
// call must ALLOW. This is the fixture every other test in this file departs
// from by exactly one variable (either a latch is planted, or the (B)
// surface is changed) — without this control, a DENY anywhere else in this
// file could equally be explained by "the latch denies everything always" or
// "something in the shared fixture already denies", neither of which this
// slice is about.
//
// EXPECTED: GREEN NOW. HEAD carries no latch mechanism at all, so an
// unchanged (B) surface already allows via plain observation (fac9a69b's
// established behaviour) — this test's role is a regression guard, proving a
// correct latch implementation does not accidentally deny-everything.
//
// SABOTAGE: make the mere ABSENCE of a latch deny (e.g. inverting an
// `existsSync(latchPath)` check to its negation) — this control flips from
// ALLOW to DENY, and every DENY assertion elsewhere in this file becomes
// unable to distinguish "the latch mechanism fired" from "the latch check is
// just broken and denies unconditionally".
// ===========================================================================
test('AC-L7 CONTROL: with no latch present and the (B) surface unchanged, the call ALLOWS — the latch must not become deny-everything', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    assert.equal(existsSync(latchPath(dir)), false, 'PRECONDITION: no latch exists');
    const L = lane('ac-l7-control');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre on a clean tree with no latch allows');
    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 0, `CONTROL: no latch + unchanged (B) surface must ALLOW — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    assert.equal(existsSync(latchPath(dir)), false, 'no latch is spuriously created on an ordinary allowed call');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-L1 — SET ON (B) DENIAL. An unattested (B) modify that gets denied must
// CREATE the latch file.
//
// EXPECTED FAILURE SHAPE (RED): HEAD has no latch mechanism at all, so
// `existsSync(latchPath(dir))` after Post comes back `false` — the
// `assert.equal(..., true)` assertion fires. The deny itself (r.code === 2)
// is most plausibly already GREEN today (fac9a69b's established behaviour);
// this pin adds only the latch-file assertion.
//
// SABOTAGE: remove the latch-creation call from the (B)-modify-denial branch
// only (leave the deny itself intact) — `existsSync(latchPath(dir))` flips
// from true to false.
// ===========================================================================
test('AC-L1: an unattested (B) MODIFY that is denied CREATES the taint latch', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const coder = coderPath(dir);
    assert.equal(existsSync(latchPath(dir)), false, 'PRECONDITION: no latch exists before this call');
    const L = lane('ac-l1-modify');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre on a clean tree allows');

    writeFileSync(coder, Buffer.from('---\nname: modified-in-window\n---\n# tampered (B) file, no attestation\n'));

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `an unattested (B) modify must deny — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    assert.equal(existsSync(latchPath(dir)), true, 'THE RULING: a denied unattested (B) modify sets the cross-call taint latch');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-L2 — SET ON UNAUTHORIZED ADDITION. A new file appearing under a (B) glob
// (never routed through the git index — the plain, already-established
// `unauthorizedAdditions` route per board 8b53dc84/v4.1) must also set the
// latch. Ruling 9 is explicit that the latch fires on
// `unauthorizedAdditions.length > 0`, a DIFFERENT array than `baselineDenied`
// (AC-L1's modify/delete route) — so this is genuinely separate ground, not a
// restatement of AC-L1.
//
// EXPECTED FAILURE SHAPE (RED): the deny + "left on disk" disposition for a
// bare (B) addition is most plausibly already GREEN today (pre-dating this
// slice). `existsSync(latchPath(dir))` after Post comes back `false` — the
// new assertion this pin adds.
//
// SABOTAGE: set the latch on the `baselineDenied` branch only, and skip it
// specifically on the `unauthorizedAdditions` branch — `existsSync(latchPath(dir))`
// flips from true to false for THIS fixture while AC-L1 stays green.
// ===========================================================================
test('AC-L2: a new file appearing under a (B) glob (unauthorizedAdditions) ALSO sets the taint latch', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    assert.equal(existsSync(latchPath(dir)), false, 'PRECONDITION: no latch exists before this call');
    const L = lane('ac-l2-addition');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre records a (B) baseline that does not include the not-yet-created file');

    const addedPath = join(dir, '.claude', 'agents', 'latch-addition.md');
    const addedBytes = Buffer.from('---\nname: unauthorized-addition\n---\n# planted directly, never routed through the git index\n');
    writeFileSync(addedPath, addedBytes);

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `an unauthorized addition under a (B) glob must deny — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    assert.deepEqual(readFileSync(addedPath), addedBytes, 'the addition is left on disk byte-identical, never deleted');
    assert.equal(existsSync(latchPath(dir)), true, 'THE RULING: an unauthorizedAdditions denial ALSO sets the cross-call taint latch');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-L3 — SET ON STAMP TAMPER EVEN WHEN NO (B) FILE CHANGED. A stamp change
// inside a window with no (B) change at all is denied and invalidated
// (already established by the sibling suite's AC9) — the NEW ground here is
// that the latch must be set too, because "a command that tried to
// manufacture its own attestation is an incident in its own right" (Ruling 9)
// independent of whether any (B) file was actually touched.
//
// EXPECTED FAILURE SHAPE (RED): the deny + stamp-invalidation (deletion) for
// an in-window stamp write is most plausibly already GREEN today (the
// sibling suite's established AC9 ground). `existsSync(latchPath(dir))` after
// Post comes back `false` — the new assertion this pin adds.
//
// SABOTAGE: set the latch on `baselineDenied`/`unauthorizedAdditions` only,
// and skip it on `stampTampered` — `existsSync(latchPath(dir))` flips from
// true to false for THIS fixture while AC-L1/AC-L2 stay green.
// ===========================================================================
test('AC-L3: an in-window stamp tamper with NO (B) file changed ALSO sets the taint latch', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const coder = coderPath(dir);
    const originalBytes = readFileSync(coder);
    assert.equal(existsSync(latchPath(dir)), false, 'PRECONDITION: no latch exists before this call');
    const L = lane('ac-l3-stamponly');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre: no stamp exists yet');
    assert.equal(existsSync(stampPath(dir)), false, 'PRECONDITION: no stamp exists at Pre');

    // a "correct-looking" stamp (attests the currently-unchanged bytes),
    // written strictly inside the window — untrusted regardless of
    // self-consistency, per fac9a69b Ruling 2.
    writeStamp(dir, [{ path: CODER_REL, sha256: sha256Of(coder), at: NOW }]);

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `an in-window stamp write with no (B) change must still deny — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    assert.deepEqual(readFileSync(coder), originalBytes, 'the (B) path itself was never touched — isolating this from AC-L1/AC-L2');
    assert.equal(existsSync(latchPath(dir)), true, 'THE RULING: EVERY stampTampered event sets the latch, even with no (B) file changed');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-L4 — THE HEADLINE. THE ADOPTION POINT IS CLOSED. Call N tampers a (B)
// file -> denied, latch set, bytes left. Call N+1 makes NO further change (the
// tampered bytes from call N simply still sit there) -> must STILL DENY.
//
// EXPECTED FAILURE SHAPE (RED, the whole point of this slice): against HEAD
// there is no latch at all, so call N+1's Pre RE-COLLECTS the tampered bytes
// as its own new legitimate baseline and ALLOWS — `assert.equal(pre2.code, 2,
// ...)` fires with actual 0. (The earlier `existsSync(latchPath(dir))`
// assertion right after call N is ALSO red today, for the same underlying
// reason as AC-L1 — either assertion alone proves the defect; this test
// carries both because the second is the one that specifically demonstrates
// "the adoption point is closed", which is this slice's entire purpose.)
//
// SABOTAGE (either alone reproduces the exact defect this slice exists to
// close): (a) remove the latch-creation call on (B) denial — the first
// existsSync assertion flips; (b) even with the latch created, fail to
// consult it at Pre (skip the "deny before execution while latched" check) —
// `pre2.code` flips from 2 back to 0, reproducing the adoption bug exactly
// while (a) stays fixed.
// ===========================================================================
test('AC-L4: THE ADOPTION POINT IS CLOSED — call N tampers a (B) file (denied, latch set, bytes left); call N+1 makes NO further change and must STILL DENY', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const coder = coderPath(dir);
    assert.equal(existsSync(latchPath(dir)), false, 'PRECONDITION: no latch exists before call N');

    // --- call N: unattested (B) modify, denied, latch set, bytes left ---
    const L1 = lane('ac-l4-calln');
    assert.equal(h17(dir, 'PreToolUse', L1).code, 0, 'call N Pre: clean tree allows');
    const tamperedBytes = Buffer.from('# call N tamper — never attested, and never fixed by call N+1\n');
    writeFileSync(coder, tamperedBytes);

    const r1 = h17(dir, 'PostToolUse', L1);
    assert.notEqual(r1.code, 1, 'a security gate never fails with a non-blocking exit 1 (call N)');
    assert.equal(r1.code, 2, `call N: an unattested (B) modify must deny — actual ${r1.code}, stderr: ${oneLine(r1.stderr)}`);
    assert.deepEqual(readFileSync(coder), tamperedBytes, 'call N: bytes left exactly as the command wrote them (fac9a69b)');
    assert.equal(existsSync(latchPath(dir)), true, 'call N: the (B) surface taint latch is SET on this denial');

    // --- call N+1: no further change at all — the tampered bytes just sit there ---
    const L2 = lane('ac-l4-calln1');
    const pre2 = h17(dir, 'PreToolUse', L2);
    assert.notEqual(pre2.code, 1, 'a security gate never fails with a non-blocking exit 1 (call N+1 Pre)');
    assert.equal(
      pre2.code,
      2,
      `THE HEADLINE: with the surface still tainted, call N+1 must STILL DENY even though NOTHING changed within its own window — this is what "the adoption point is closed" means. Against HEAD (no cross-call latch), Pre re-collects the tampered bytes as the new baseline and this call ALLOWS instead. Actual ${pre2.code}, stderr: ${oneLine(pre2.stderr)}`
    );
    assert.match(oneLine(pre2.stderr), /taint|latch/i, 'the denial names the ONGOING taint, not a fresh (B) violation (there is none in this window)');

    const post2 = h17(dir, 'PostToolUse', L2); // defensive only — production never sends Post for a Pre-denied call
    assert.notEqual(post2.code, 1, 'a security gate never fails with a non-blocking exit 1 (call N+1 Post, defensive)');

    assert.deepEqual(readFileSync(coder), tamperedBytes, "the (B) path still holds EXACTLY call N's tampered bytes — call N+1 never touched it and H17 never adopted it as a fresh baseline");
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-L5 — PRESENCE ALONE IS THE VERDICT. A latch file whose CONTENTS are
// empty, malformed JSON, or contain a field like `{"cleared":true}` or
// `{"trusted":true}` must STILL DENY. No field inside the file may reduce
// enforcement (Ruling 7). AC-L7 above is this family's control (absence
// allows); these four all plant SOME bytes at the latch path and must all
// deny regardless of what those bytes say.
//
// EXPECTED FAILURE SHAPE (RED, all four): HEAD has no latch-reading logic at
// all — a file merely sitting at `.sterling/enforcement-taint.json` has no
// effect today, so a plain read-only Bash call ALLOWS. `assert.equal(pre.code,
// 2, ...)` fires with actual 0, for all four shapes.
//
// SABOTAGE (per shape): EMPTY/MALFORMED — treat an unparseable latch as "not
// set" (fall back to allow on any JSON.parse failure) — the deny flips to
// allow for exactly these two. CLEARED/TRUSTED — parse the JSON and honour a
// `cleared`/`trusted` boolean field to skip enforcement — the deny flips to
// allow for exactly these two, while EMPTY/MALFORMED stay denied (proving the
// field-name-specific escape, not a shared parse-failure bug).
// ===========================================================================
const LATCH_CONTENT_SHAPES = [
  ['EMPTY', Buffer.alloc(0)],
  ['MALFORMED-JSON', Buffer.from('{ not valid json,,,')],
  ['CLEARED-FIELD', Buffer.from(JSON.stringify({ cleared: true }))],
  ['TRUSTED-FIELD', Buffer.from(JSON.stringify({ trusted: true }))],
];

for (const [label, bytes] of LATCH_CONTENT_SHAPES) {
  test(`AC-L5-${label}: a latch file with ${label} content still DENIES — no field inside it may reduce enforcement`, { skip: GIT_SKIP }, () => {
    const { dir, cleanup } = makeGitProject();
    try {
      writeFileSync(latchPath(dir), bytes);
      const L = lane(`ac-l5-${label.toLowerCase()}`);
      const pre = h17(dir, 'PreToolUse', L);
      assert.notEqual(pre.code, 1, 'a security gate never fails with a non-blocking exit 1');
      assert.equal(pre.code, 2, `a ${label} latch must still deny (presence alone is the verdict) — actual ${pre.code}, stderr: ${oneLine(pre.stderr)}`);
      assert.match(oneLine(pre.stderr), /taint|latch/i, 'the denial names the ongoing taint');
      assert.deepEqual(readFileSync(latchPath(dir)), bytes, 'the latch file itself is never rewritten/cleared by a mere Pre observation');
    } finally {
      cleanup();
    }
  });
}

// ===========================================================================
// AC-L6 — FAIL-CLOSED BY SHAPE. Each of these at the latch path must DENY: a
// directory, a symlink (pointing anywhere, including a nonexistent target), a
// FIFO (host-probed; sockets are NOT attempted here — synchronously
// constructing a listening unix-domain-socket file in this harness risks
// flakiness/leaked listeners for no additional coverage over the FIFO case,
// which already exercises "non-regular, non-symlink special file"; disclosed
// rather than faked), and an unreadable regular file (host-probed, since root
// bypasses permission bits).
//
// EXPECTED FAILURE SHAPE (RED, all four): same reasoning as AC-L5 — HEAD has
// no latch-reading logic, so any object sitting at the latch path has no
// effect today. `assert.equal(pre.code, 2, ...)` fires with actual 0.
//
// SABOTAGE (each): classify only "regular file" as tainted and treat every
// other lstat kind (directory/symlink/FIFO) as "not set" (allow) — the deny
// flips to allow for that shape specifically. For UNREADABLE: catch the
// EACCES on open/read and treat it as "not set" instead of "tainted/
// environment defect" — the deny flips to allow for that shape only.
// ===========================================================================
test('AC-L6-DIRECTORY: a directory sitting at the latch path DENIES (fail-closed by shape)', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    mkdirSync(latchPath(dir), { recursive: true });
    const L = lane('ac-l6-directory');
    const pre = h17(dir, 'PreToolUse', L);
    assert.notEqual(pre.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(pre.code, 2, `a directory at the latch path must deny — actual ${pre.code}, stderr: ${oneLine(pre.stderr)}`);
    assert.match(oneLine(pre.stderr), /taint|environment defect/i, 'the denial names the taint/environment-defect condition');
    assert.equal(lstatSync(latchPath(dir)).isDirectory(), true, 'H17 never replaced the directory in the course of denying');
  } finally {
    cleanup();
  }
});

test('AC-L6-SYMLINK: a symlink (pointing anywhere) at the latch path DENIES (fail-closed by shape)', { skip: GIT_SKIP || SYMLINK_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const nowhere = join(tmpdir(), 'sterling-latch-symlink-nonexistent-target-' + randomUUID().slice(0, 8));
    symlinkSync(nowhere, latchPath(dir));
    const L = lane('ac-l6-symlink');
    const pre = h17(dir, 'PreToolUse', L);
    assert.notEqual(pre.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(pre.code, 2, `a symlink at the latch path must deny regardless of where it points — actual ${pre.code}, stderr: ${oneLine(pre.stderr)}`);
    assert.match(oneLine(pre.stderr), /taint|environment defect/i, 'the denial names the taint/environment-defect condition');
    assert.equal(lstatSync(latchPath(dir)).isSymbolicLink(), true, 'the symlink itself survives untouched');
  } finally {
    cleanup();
  }
});

test('AC-L6-FIFO: a FIFO sitting at the latch path DENIES (fail-closed by shape)', { skip: GIT_SKIP || FIFO_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const r0 = spawnSync('mkfifo', [latchPath(dir)]);
    assert.equal(r0.status, 0, `PRECONDITION: mkfifo must succeed — ${oneLine(r0.stderr)}`);
    const L = lane('ac-l6-fifo');
    const pre = h17(dir, 'PreToolUse', L);
    assert.notEqual(pre.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(pre.code, 2, `a FIFO at the latch path must deny — actual ${pre.code}, stderr: ${oneLine(pre.stderr)}`);
    assert.match(oneLine(pre.stderr), /taint|environment defect/i, 'the denial names the taint/environment-defect condition');
    assert.equal(lstatSync(latchPath(dir)).isFIFO(), true, 'H17 never replaced the FIFO in the course of denying');
  } finally {
    cleanup();
  }
});

test('AC-L6-UNREADABLE: an unreadable regular file at the latch path DENIES (fail-closed by shape)', { skip: GIT_SKIP || UNREADABLE_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    writeFileSync(latchPath(dir), Buffer.from('irrelevant, unreadable\n'));
    chmodSync(latchPath(dir), 0o000);
    const L = lane('ac-l6-unreadable');
    const pre = h17(dir, 'PreToolUse', L);
    assert.notEqual(pre.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(pre.code, 2, `an unreadable file at the latch path must deny (classification error = tainted/environment defect) — actual ${pre.code}, stderr: ${oneLine(pre.stderr)}`);
    assert.match(oneLine(pre.stderr), /taint|environment defect/i, 'the denial names the taint/environment-defect condition');
    assert.equal(statSync(latchPath(dir)).mode & 0o777, 0, 'the file permissions are never "fixed" by H17 in the course of denying');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-L8 — BROKEN-STATE FAIL-CLOSED. `.sterling` present but `sterling.db`
// ABSENT must fail closed (broken state), NOT be treated as "not a Sterling
// project" (Ruling 11's explicit distinction).
//
// EXPECTED FAILURE SHAPE (uncertain, disclosed rather than guessed — H4
// forbids checking how H17 currently classifies this today): most plausibly
// RED via `assert.equal(pre.code, 2, ...)` firing with actual 0 (a missing db
// silently treated as "no Sterling project here, do nothing"); the
// `doesNotMatch(/not a sterling project/i)` assertion is a companion that
// could independently fail if some wording change slips in.
//
// SABOTAGE: treat an absent `sterling.db` (with `.sterling/` present) as "not
// a Sterling project" and allow unconditionally — `pre.code` flips from 2 to
// 0.
// ===========================================================================
test('AC-L8: .sterling/ present but sterling.db ABSENT fails closed (broken state), never "not a Sterling project"', { skip: GIT_SKIP }, () => {
  const fx = makeGitProject();
  const { dir, dbPath, cleanup, closeStore } = fx;
  try {
    closeStore();
    rmSync(dbPath, { force: true });
    rmSync(dbPath + '-wal', { force: true });
    rmSync(dbPath + '-shm', { force: true });
    assert.equal(existsSync(dbPath), false, 'PRECONDITION: sterling.db is absent while .sterling/ itself still exists');
    assert.equal(existsSync(join(dir, '.sterling')), true, 'PRECONDITION: .sterling/ itself is present');

    const L = lane('ac-l8-brokenstate');
    const r = h17(dir, 'PreToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `a present .sterling/ with an ABSENT sterling.db must fail closed (broken state) — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    assert.doesNotMatch(
      oneLine(r.stderr),
      /not a sterling project|not a project/i,
      'RULING 11: this must never be worded as "not a Sterling project" — .sterling/ exists, only the DB is missing'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-L9 — THE SET PRIMITIVE IS CREATE-ONLY. If a file already exists at the
// latch path in ANY shape, H17 must treat the latch as already set and NOT
// overwrite it.
//
// EXPECTED (disclosed as plausibly GREEN today, not asserted as fact): HEAD
// has no SET-latch code path at all, so nothing writes to `latchPath` today —
// the byte-identity assertion is vacuously true under the unimplemented
// state. This test is a REGRESSION GUARD for the create-only invariant once
// S3 lands: a naive `writeFileSync(latchPath, ...)` implementation of "set
// the latch" (as opposed to `O_CREAT|O_EXCL`) would truncate the pre-existing
// bytes here, which is exactly what this pin catches. Its discriminating
// power is proven by the SABOTAGE below, per this repo's own mutation-first
// posture for exactly this "plausibly green control" shape.
//
// SABOTAGE: change the latch-set call from a create-only primitive
// (O_CREAT|O_EXCL or equivalent existence-check-then-skip) to an
// unconditional overwrite (`writeFileSync(latchPath, ...)`) — the
// byte-identity assertion flips from the pre-existing bytes to the new
// latch's own JSON.
// ===========================================================================
test('AC-L9: the latch SET primitive is CREATE-ONLY — pre-existing bytes at the latch path survive a fresh denial untouched', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const preexisting = Buffer.from('PRE-EXISTING-LATCH-BYTES-DO-NOT-OVERWRITE\n');
    writeFileSync(latchPath(dir), preexisting);

    const L = lane('ac-l9-createonly');
    h17(dir, 'PreToolUse', L); // latch already present — may itself deny (AC-L4/AC-L6 concern); not the point of this pin, result ignored

    const coder = coderPath(dir);
    writeFileSync(coder, Buffer.from('# fresh unattested tamper while the latch was already set\n'));

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `a (B) surface tainted (and now with a fresh violation too) denies regardless — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    assert.deepEqual(
      readFileSync(latchPath(dir)),
      preexisting,
      'THE RULING: the SET primitive is CREATE-ONLY — pre-existing latch bytes (in ANY shape) must never be overwritten/truncated by a fresh incident'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-L10 — SET-FAILURE IS DISCLOSED, NEVER SILENT. Simulated by making
// `.sterling/` itself unwritable AFTER project setup (the WAL/db files it
// needs to already exist are created by makeGitProject before this point) so
// that creating a NEW file (the latch) inside it fails with EACCES/EPERM,
// while existing reads inside `.sterling/` remain unaffected.
//
// HONESTY DISCLOSURE (per the task's own instruction): this fixture chmods
// the WHOLE `.sterling/` directory to 0o555, not narrowly `.sterling/transient`'s
// parent as the brief's phrasing suggested (transient's parent IS `.sterling`
// in this fixture, since transient lives at `.sterling/transient/` — the two
// descriptions name the same directory here). This author cannot verify from
// the outside whether H17's own read path (e.g. re-opening the sqlite db in
// WAL mode, which can need to write -wal/-shm files) tolerates a read-only
// `.sterling/` at all; if it does not, this test could go red for an
// UNRELATED reason (a broken-state/crash exit rather than the specific
// set-failure-disclosure wording this AC is actually about). Flagged as a
// risk in the handoff report, not asserted as certain.
//
// EXPECTED FAILURE SHAPE (RED, most plausible): HEAD has no SET-latch logic
// and thus no failure-disclosure wording for it either — the
// `assert.match(.../persist/i, ...)` (or equivalent) assertion fires because
// no such phrase exists in today's stderr for this scenario.
//
// SABOTAGE: on a failed latch-creation attempt, either (a) swallow the error
// and proceed as if nothing happened (silently under-report — the specific
// disclosure wording assertion fails to match anything), or (b) claim success
// anyway (the doesNotMatch false-claim assertion fires).
// ===========================================================================
test('AC-L10: a latch-creation FAILURE (unwritable .sterling/) is disclosed in the denial, never silent, and never claims persistence that did not happen', { skip: GIT_SKIP || WRITE_DENY_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  const sterlingDir = join(dir, '.sterling');
  try {
    const coder = coderPath(dir);
    const L = lane('ac-l10-setfailure');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre on a clean tree allows, before .sterling/ is made read-only');

    writeFileSync(coder, Buffer.from('# unattested tamper while the latch cannot be persisted\n'));
    chmodSync(sterlingDir, 0o555);

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `the (B) modify must still deny even though the latch cannot be persisted — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    const err = oneLine(r.stderr);
    assert.match(err, /persist/i, 'the denial must disclose that the cross-call latch could NOT be persisted');
    assert.doesNotMatch(err, /repeated denial (is|was|has been) established/i, 'RULING 9: must NOT claim repeated denial was established when it was not');
  } finally {
    try {
      chmodSync(sterlingDir, 0o755);
    } catch {}
    cleanup();
  }
});

// ===========================================================================
// AC-L11 — EXACT MANIFEST (Ruling 4). Where a stamp EXISTS, the current (B)
// set is compared against its stamped subset on EVERY call, not only after an
// in-window difference. Three arms, control (exact match) placed FIRST.
// ===========================================================================

function fullAttestedStamp(dir) {
  return [
    { path: CODER_REL, sha256: sha256Of(coderPath(dir)), at: NOW },
    { path: SETTINGS_REL, sha256: sha256Of(settingsPath(dir)), at: NOW },
    { path: CONFIG_REL, sha256: sha256Of(configJsonPath(dir)), at: NOW },
  ];
}

// AC-L11-CONTROL: an exact stamp for every current (B) path, nothing changed
// in-window, ALLOWS. Placed first: without it, a DENY in the two arms below
// could equally be explained by "a stamp being present at all now denies
// everything" rather than by the specific exactness violation each plants.
//
// EXPECTED: GREEN today is plausible only by accident (HEAD's established
// per-call detect-and-deny already allows an unchanged (B) surface without
// even opening the stamp) — but Ruling 4 requires the exact-manifest
// validation to run on EVERY call once a stamp exists, so a correct
// implementation must ALSO allow here, for a DIFFERENT reason (validated and
// found exact, not merely "nothing changed, stamp not even consulted"). This
// pin cannot distinguish those two reasons by itself — the two DENY arms
// below are what prove the stamp is actually being read and validated on
// every call, not skipped.
//
// SABOTAGE: this control has no independent sabotage of its own — see the two
// arms below, whose sabotage would also flip this control to deny if it were
// naively "any stamp present -> deny" instead of "exact match -> allow,
// mismatch -> deny".
test('AC-L11-CONTROL (exact match): a stamp that exactly attests every current (B) path, nothing changed in-window, ALLOWS', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    writeStamp(dir, fullAttestedStamp(dir));
    const L = lane('ac-l11-control-exact');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre allows');
    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 0, `CONTROL: an exact stamp for every current (B) path must ALLOW even though it is validated on every call — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
  } finally {
    cleanup();
  }
});

// AC-L11-ARM-A (hash-different): the stamp names settings.local.json but with
// a WRONG hash (not matching its actual current bytes); settings.local.json
// itself is NEVER touched during the window. Per Ruling 4 this must still
// DENY, because the exact-manifest check runs every call, independent of
// whether anything changed in THIS window.
//
// EXPECTED FAILURE SHAPE (RED): HEAD's established per-call detect-and-deny
// only consults the stamp AFTER detecting an in-window difference (fac9a69b's
// GAP this decision closes) — with nothing changed in-window, HEAD allows
// without ever looking at the stamp's exactness. `assert.equal(r.code, 2,
// ...)` fires with actual 0.
//
// SABOTAGE: revert to "only consult the stamp when something changed
// in-window" (Ruling 4's own named mistake) — the deny flips back to allow.
test('AC-L11-ARM-A (hash-different): a stamp entry whose hash does NOT match its current (B) path denies, even with nothing changed in-window', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const wrongHash = createHash('sha256').update('not the real settings.local.json content').digest('hex');
    writeStamp(dir, [
      { path: CODER_REL, sha256: sha256Of(coderPath(dir)), at: NOW },
      { path: SETTINGS_REL, sha256: wrongHash, at: NOW }, // deliberately wrong
      { path: CONFIG_REL, sha256: sha256Of(configJsonPath(dir)), at: NOW },
    ]);
    const L = lane('ac-l11-arm-a-hashdiff');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre allows');
    const settingsBefore = readFileSync(settingsPath(dir));

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(
      r.code,
      2,
      `ARM A: a stamped (B) path whose hash does not match its current bytes must deny, even though nothing changed in this window — actual ${r.code}, stderr: ${oneLine(r.stderr)}`
    );
    assert.deepEqual(readFileSync(settingsPath(dir)), settingsBefore, 'settings.local.json was genuinely never touched during the window — isolating the exactness violation from an in-window change');
  } finally {
    cleanup();
  }
});

// AC-L11-ARM-B (absent from stamp): the stamp attests only two of the three
// current (B) paths, omitting settings.local.json entirely even though it
// currently exists on disk under the (B) glob. Per Ruling 4 this must deny.
//
// EXPECTED FAILURE SHAPE (RED): same reasoning as ARM A — HEAD only consults
// the stamp on an in-window difference; with nothing changed, HEAD allows
// without ever checking whether every current (B) path has a stamp entry.
// `assert.equal(r.code, 2, ...)` fires with actual 0.
//
// SABOTAGE: validate only the stamped paths against current bytes (a
// subset-only comparison) instead of exact-set (also checking that every
// CURRENT (B) path has a stamp entry) — the deny flips to allow.
test('AC-L11-ARM-B (absent from stamp): a current (B) path with NO stamp entry at all denies, even with nothing changed in-window', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    writeStamp(dir, [
      { path: CODER_REL, sha256: sha256Of(coderPath(dir)), at: NOW },
      { path: CONFIG_REL, sha256: sha256Of(configJsonPath(dir)), at: NOW },
      // SETTINGS_REL deliberately omitted, though it currently exists on disk
    ]);
    const L = lane('ac-l11-arm-b-absent');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre allows');
    const settingsBefore = readFileSync(settingsPath(dir));

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(
      r.code,
      2,
      `ARM B: a current (B) path absent from the stamp must deny, even though nothing changed in this window — actual ${r.code}, stderr: ${oneLine(r.stderr)}`
    );
    assert.deepEqual(readFileSync(settingsPath(dir)), settingsBefore, 'settings.local.json was genuinely never touched during the window — isolating the exactness violation from an in-window change');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-L12 — EAGERNESS. THE LATCH IS SET AT THE DETECTION SITE, NOT AT ONE LATE
// BLOCK. Spec: decision `taint-latch-persists-eagerly-at-detection-because-deny-is-a-hard-exit`
// (fd9d24af), RULING A — the three trigger producers (`observeStampTamper`,
// `noteUnauthorizedAddition`, `noteBaselineDenied`) each call the create-only
// latch-set IMMEDIATELY, before any ancillary work.
//
// WHY THIS IS NOT COVERED BY AC-L1/AC-L2/AC-L3 ABOVE: `deny()` is
// `process.stderr.write(...); process.exit(2)` (scripts/hooks/lib/common.mjs:108)
// — A HARD EXIT, NOT A THROW. fd9d24af records ~14 unconditional deny() exits
// sitting BETWEEN the earliest detection (`stampTampered`, h17-bash-write-sweep.mjs:4440)
// and where the latch used to be written (:5196). Every latch test above uses a
// fixture that sails through all of them and reaches that late block, so
// REVERTING THE EAGER HELPERS TO A SINGLE LATE BLOCK LEAVES THE WHOLE FILE
// GREEN. This pair is the only discrimination of WHERE the latch is written.
//
// THE FIXTURE VARIABLE that separates the two arms below is exactly one thing:
// whether a qualifying detection occurs before the unrelated early denial. The
// corrupted attribution record is held constant across both.
//
// THE THIRD LEG of the triangle already exists and is NOT modified here: AC-L3
// (detection, healthy attribution record, no early deny) pins detection ->
// latch. AC-L12-CONTROL pins early-deny-without-detection -> NO latch. AC-L12
// pins detection + early deny -> latch anyway. Only all three together mean
// "the latch was written at the detection site".
//
// ATTRIBUTION RECORDS: reached through this file's existing `tempRecords`
// helper (the `sterling-enforce-<projectTag>*` files in os.tmpdir() that
// `makeGitProject`'s own cleanup already sweeps, and that fd9d24af's reproduced
// exploit `rm`s). No implementation was read to find them. Both arms assert a
// PRECONDITION that at least one such record actually exists after Pre — so a
// wrong naming assumption fails LOUDLY on the precondition instead of passing
// vacuously.
// ===========================================================================

const CORRUPT_ATTRIBUTION_BYTES = Buffer.from('{ CORRUPTED-ATTRIBUTION-RECORD not valid json,,,');

// Corrupts every `sterling-enforce-<projectTag>*` record Post requires, leaving
// the FILES PRESENT but unparseable. Deliberately corruption rather than
// deletion: a present-but-unreadable enforcement artifact is unambiguously a
// broken enforcement state that must fail closed (the same class this file
// already pins at AC-L6-UNREADABLE and AC-L8), whereas an ABSENT record leaves
// open a second reading ("this call was never Pre-gated, not my business"),
// which would make the denial ambiguous. Returns how many were corrupted.
function corruptAttributionRecords(projectTag) {
  const paths = tempRecords(projectTag).filter((p) => {
    try {
      return lstatSync(p).isFile();
    } catch {
      return false;
    }
  });
  for (const p of paths) writeFileSync(p, CORRUPT_ATTRIBUTION_BYTES);
  return paths.length;
}

// AC-L12 ONLY. Selects the four Pre record classes by EXACT FILENAME SUFFIX so
// that only the attribution/dirty record can be corrupted. See AC-L12's comment
// block for why the narrowing is load-bearing.
//
// THE FOUR CLASSES — MEASURED at scripts/hooks/h17-bash-write-sweep.mjs and
// supplied by the conductor (this author's read wall, H4, forbids reading the
// hook). All four live under os.tmpdir() and share the one
// `sterling-enforce-<tag>-<runId>-call-<key>` stem that this file's existing
// `tempRecords` helper matches on, where `key` is sha256(tool_use_id); each
// also has a legacy no-`call-<key>` form (`sterling-enforce-<tag>-<runId>.dirty.json`):
//   .baseline.json  (:1542)  THE (B) BASELINE
//   .dirty.json     (:1572)  THE ATTRIBUTION / DIRTY RECORD   <- the only one corrupted
//   .json           (:1616)  THE STATE RECORD (no extra suffix before .json)
//   .stamp.json     (:1649)  THE STAMP WITNESS
//
// NOTE FOR THE NEXT READER: decision bab7d57d enumerates only THREE of these
// (baselineFile :1542, dirtyFile :1572, stateFile :1616) and does not mention
// the .stamp.json witness at :1649. That gap is what defeated this test's first
// two fixtures — see AC-L12's comment block. Trust the four-class list here
// over bab7d57d's three.
//
// THE WITNESS IS ITS OWN FILE, which is exactly why any blanket corruption of
// the shared prefix destroys the evidence the stamp-tamper detection depends on.
const DIRTY_SUFFIX = '.dirty.json';
const STAMP_SUFFIX = '.stamp.json';
const BASELINE_SUFFIX = '.baseline.json';

function classifyPreRecords(projectTag) {
  const all = tempRecords(projectTag).filter((p) => {
    try {
      return lstatSync(p).isFile();
    } catch {
      return false;
    }
  });
  const dirty = all.filter((p) => p.endsWith(DIRTY_SUFFIX));
  const stamp = all.filter((p) => p.endsWith(STAMP_SUFFIX));
  const baseline = all.filter((p) => p.endsWith(BASELINE_SUFFIX));
  const state = all.filter((p) => !p.endsWith(DIRTY_SUFFIX) && !p.endsWith(STAMP_SUFFIX) && !p.endsWith(BASELINE_SUFFIX));
  return { all, dirty, stamp, baseline, state };
}

function classCounts(rec) {
  return `total ${rec.all.length} — dirty ${rec.dirty.length}, stamp ${rec.stamp.length}, baseline ${rec.baseline.length}, state ${rec.state.length}`;
}

// ---------------------------------------------------------------------------
// AC-L12-CONTROL — PLACED FIRST, AND IT PASSES FOR THE OPPOSITE REASON (latch
// ABSENT, where AC-L12 requires it PRESENT).
//
// WHAT IT PINS, IN ONE SENTENCE: a call that hits the corrupted-attribution
// denial with NO qualifying detection in its window creates NO latch.
//
// THE CAUSE IT RULES OUT: AC-L12's verdict ("it denied AND the latch exists")
// has more than one possible cause — (a) the detection site latched eagerly,
// which is the ruling, or (b) THE DENIAL ITSELF PRODUCED THE LATCH, either
// because the corrupted-attribution path incidentally still runs the late
// composed block, or because some implementation latches on every deny. Under
// (b), AC-L12 would be green while pinning nothing about eagerness. This
// control holds the corrupted record constant and removes ONLY the detection:
// if the latch is still absent here, cause (b) is excluded and AC-L12's latch
// can only have come from the detection — which, since the denial that fired is
// this same early one, means it was written BEFORE that denial. Eagerness.
//
// EXPECTED: GREEN. Nothing in the window triggers a latch, so no latch exists
// under either the eager or the old late-block implementation; the deny is the
// fail-closed response to an enforcement artifact Post requires and cannot read.
//
// SABOTAGE: make any denial write the latch unconditionally — e.g. move the
// latch-set into `deny()` in scripts/hooks/lib/common.mjs, or set it on the
// corrupted/missing-attribution branch regardless of whether any trigger was
// observed. `existsSync(latchPath(dir)) === false` flips to true here, and
// AC-L12 below simultaneously loses all of its discriminating power.
// ---------------------------------------------------------------------------
test('AC-L12-CONTROL: a call denied for an UNRELATED reason (corrupted attribution record) with NO qualifying detection creates NO latch', { skip: GIT_SKIP }, () => {
  const { dir, projectTag, cleanup } = makeGitProject();
  try {
    const coder = coderPath(dir);
    const originalBytes = readFileSync(coder);
    const L = lane('ac-l12-control');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre on a clean tree with no latch allows');

    const corrupted = corruptAttributionRecords(projectTag);
    assert.notEqual(
      corrupted,
      0,
      "PRECONDITION: Pre must have written at least one sterling-enforce-<projectTag> attribution record into os.tmpdir() — if this fires, the record naming/location assumed by this file's own tempRecords helper is wrong and BOTH AC-L12 arms are vacuous"
    );

    // NOTHING ELSE happens in this window: no stamp write, no (B) change.
    assert.equal(existsSync(stampPath(dir)), false, 'PRECONDITION: no stamp is written in this window — no stampTampered detection');
    assert.deepEqual(readFileSync(coder), originalBytes, 'PRECONDITION: no (B) file changed in this window — no baselineDenied detection');
    assert.equal(existsSync(latchPath(dir)), false, 'PRECONDITION: no latch exists before Post');

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `an attribution record that Post REQUIRES but cannot parse must fail closed — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    assert.equal(
      existsSync(latchPath(dir)),
      false,
      'CONTROL: this denial observed NO incident, so it must NOT create the cross-call taint latch — otherwise AC-L12 below cannot distinguish "the detection site latched eagerly" from "every denial latches"'
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC-L12 — THE DISCRIMINATOR.
//
// WHAT IT PINS, IN ONE SENTENCE: a qualifying detection that is followed by an
// UNRELATED, EARLIER denial still leaves the taint latch on disk — because the
// latch is written at the detection site, not at a late block a hard exit can
// skip.
//
// THE FIXTURE: an in-window enforcement-stamp write is the EARLIEST trigger
// (fd9d24af: `stampTampered` observed at h17-bash-write-sweep.mjs:4440, calling
// `observeStampTamper`), and a corrupted ATTRIBUTION record denies further down
// the same arm (bab7d57d: the attribution exits at :4659/:4677/:4727, ~540
// lines before the (B) stage at :5195 that used to hold the single latch
// block). Detection first, unrelated hard-exit denial second, late composed
// block never reached.
//
// WHY THE CORRUPTION IS NARROWED TO ONE RECORD — MEASURED TWICE, NOT PREDICTED.
//
// FIRST FIXTURE (blanket corruption of every `sterling-enforce-<projectTag>*`
// record, as AC-L12-CONTROL above still does deliberately). MEASURED 2026-08-29
// (`node --test-reporter=tap scripts/tests/h17-b-taint-latch.test.mjs`, 22
// tests, this one the sole failure): RED with the latch absent — and the cause
// was the FIXTURE, not the code. All the Pre records share one prefix, so a
// blanket corruption destroys the STAMP WITNESS along with the attribution
// record; the tamper comparison is guarded by
// `if (!preWitness || typeof preWitness.kind !== 'string') { stampTrusted = false; }`,
// so with no usable witness `stampTampered` is NEVER SET, no detection occurs,
// and a latch at the detection site correctly does not appear.
//
// SECOND FIXTURE (select the attribution record BY CONTENT, on the assumption
// that bab7d57d's three classes were the whole set). MEASURED 2026-08-29: the
// precondition fired — "Found 2 such of 4 total" — because THERE ARE FOUR Pre
// RECORD CLASSES, NOT THREE, and the stamp witness is its OWN `.stamp.json`
// file (:1649) that bab7d57d never names. No content heuristic can separate
// four classes it does not know exist.
//
// THIRD AND CURRENT FIXTURE: EXACT SUFFIX SELECTION over the measured four-class
// list documented above `classifyPreRecords` — corrupt only `.dirty.json`, leave
// `.baseline.json`, `.stamp.json` and the bare state `.json` intact. Narrowing
// the corruption to the attribution record alone is what makes this test pin
// EAGERNESS instead of accidentally re-testing evidence destruction. Both dead
// fixtures are recorded here because each one FAILED LOUDLY ON A PRECONDITION
// rather than producing an ambiguous red, and that is the property to preserve
// if these record shapes ever change again.
//
// AND THAT BLANKET-CORRUPTION CASE IS A SEPARATE, STILL-OPEN DEFECT — DO NOT
// ADD A TEST FOR IT HERE. Destroying the whole record set means the audit could
// not be performed at all, which is the FOURTH-TRIGGER FAMILY
// (`baselineAuditUnavailable`): ruled on in decision
// `an-a-audit-failure-must-not-abort-the-b-audit-unverifiable-b-latches`
// (bab7d57d) and assigned to SLICE S2, not S3. It is genuinely unlatched at
// HEAD and is expected to stay so until S2 lands; S3 is the eager-latching
// correctness fix only. AC-L12 deliberately steps around that open defect so
// its verdict is about WHERE the latch is written.
//
// EXPECTED FAILURE SHAPE against the OLD single-late-block code (this is the
// discrimination missing from the suite today):
// `assert.equal(existsSync(latchPath(dir)), true, ...)` fires with actual
// false — the process exited at the attribution denial before the late latch
// block at :5196 ever ran. `r.code` is 2 in BOTH the old and the fixed code, so
// the exit-code assertions alone prove nothing here; the latch assertion is the
// whole pin. Against the fixed code (eager `observeStampTamper`) it is GREEN.
//
// WHY IT MATTERS, not merely "a latch file is missing": the next call's Pre
// re-collects the (B) baseline from current disk state, so a discarded
// detection means the tampered bytes are adopted as legitimate — and (B) is
// `.claude/agents/**`, the agent GRANT DEFINITIONS. One swallowed detection
// buys a permanent edit to live enforcement config.
//
// SABOTAGE (any one of these must turn this test RED, while every other test in
// this file — all of which reach the late block unobstructed — stays GREEN):
//   (1) remove the eager latch-set call from `observeStampTamper` in
//       scripts/hooks/h17-bash-write-sweep.mjs (Ruling A's producer), leaving
//       the other two helpers eager;
//   (2) equivalently, revert all three helpers to a single composed latch block
//       near the end of the Post arm — the original defect.
// In both cases `existsSync(latchPath(dir))` flips from true to false, because
// `deny()` is `process.exit(2)` and never unwinds to the late block.
// ---------------------------------------------------------------------------
test('AC-L12: a qualifying detection followed by an UNRELATED EARLIER deny STILL sets the latch — the latch is written at the detection site, not at a late block a hard exit skips', { skip: GIT_SKIP }, () => {
  const { dir, projectTag, cleanup } = makeGitProject();
  try {
    const coder = coderPath(dir);
    const L = lane('ac-l12-eager');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre on a clean tree with no latch allows');
    assert.equal(existsSync(stampPath(dir)), false, 'PRECONDITION: no stamp exists at Pre, so the write below is unambiguously in-window');

    // (i) THE EARLY DETECTION: an in-window enforcement-stamp write — the
    // command manufacturing its own attestation. Sets `stampTampered` and calls
    // `observeStampTamper`, the earliest of the three trigger producers.
    writeStamp(dir, [{ path: CODER_REL, sha256: sha256Of(coder), at: NOW }]);

    // (ii) THE UNRELATED, EARLIER DENIAL: the ATTRIBUTION record alone is left
    // present but unparseable, so the arm hard-exits at bab7d57d's :4677 —
    // well before the late composed block — while the (B) baseline and the
    // stamp WITNESS survive so that step (i) is genuinely detected.
    const rec = classifyPreRecords(projectTag);
    assert.notEqual(
      rec.all.length,
      0,
      "PRECONDITION: Pre must have written its sterling-enforce-<projectTag> records into os.tmpdir() — if this fires, the record naming/location assumed by this file's own tempRecords helper is wrong and this test proves nothing"
    );
    assert.notEqual(
      rec.dirty.length,
      0,
      `FIXTURE DIAGNOSIS (not a code verdict): at least one ${DIRTY_SUFFIX} attribution record must exist to corrupt — found none. Classified: ${classCounts(rec)}. If this fires the record naming has changed; re-shape the fixture. It says NOTHING about eagerness`
    );
    assert.notEqual(
      rec.stamp.length,
      0,
      `FIXTURE DIAGNOSIS (not a code verdict): at least one ${STAMP_SUFFIX} stamp-witness record MUST exist and SURVIVE this corruption, or stampTampered can never be set and there is no detection to be eager about. Classified: ${classCounts(rec)}. This is the exact fixture defect measured twice on 2026-08-29`
    );
    for (const p of rec.dirty) writeFileSync(p, CORRUPT_ATTRIBUTION_BYTES);
    for (const p of rec.stamp) {
      assert.notDeepEqual(readFileSync(p), CORRUPT_ATTRIBUTION_BYTES, `FIXTURE DIAGNOSIS (not a code verdict): the stamp witness at ${p} must be untouched by the corruption above`);
    }

    assert.equal(existsSync(latchPath(dir)), false, 'PRECONDITION: no latch exists before Post — the latch asserted below can only have been created by this call');

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `the call must deny — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    assert.equal(
      existsSync(latchPath(dir)),
      true,
      "RULING A (fd9d24af): the detection was OBSERVED, so the latch must already be on disk when the unrelated attribution denial hard-exits. With a single late latch block, deny() is process.exit(2) and this detection is silently discarded — and the next call's Pre then re-baselines the tampered .claude/agents/** bytes as legitimate"
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// AC-L13 — THE CREATE-ONLY SET PRIMITIVE IS ACTUALLY EXERCISED. Spec: decision
// bcd2cc09 RULING 8 — "if the leaf exists in ANY shape, treat the latch as
// already set — never overwrite. Otherwise latching becomes its own truncate
// primitive." An lstat check does NOT rule out a planted HARDLINK (a regular
// file to lstat), and that exact clobber was reproduced live in this repo
// earlier in this objective, which is what makes create-only load-bearing
// rather than tidy.
//
// WHAT IT PINS, IN ONE SENTENCE: when a genuine in-window incident reaches a
// detection site while a latch leaf ALREADY exists, the eager create-only set
// hits EEXIST and the pre-existing bytes survive byte-for-byte.
//
// WHY THIS IS NEW GROUND AND AC-L9 ABOVE IS NOT: AC-L9 plants the leaf BEFORE
// Pre, so Pre denies at the latch gate and its Post exits through the same
// taint check — THE SET PRIMITIVE IS NEVER CALLED AT ALL, and changing it to a
// truncate-in-place write leaves AC-L9 GREEN. AC-L9 IS THEREFORE
// NON-DISCRIMINATING; its green is not coverage of create-only, and the next
// reader should not mistake it for such. It is left exactly as it stands as the
// regression guard it is, and THIS test supersedes its discriminating role. The
// ordering fix is the whole point: the leaf appears AFTER Pre (which allows, so
// nothing latches early) but BEFORE the incident is detected at Post, so the
// eager set genuinely runs against an existing leaf.
//
// EXPECTED FAILURE SHAPE: against a truncating/overwriting set primitive,
// `assert.deepEqual(readFileSync(latchPath(dir)), PLANTED, ...)` fires — the
// planted bytes have been replaced by the hook's own latch JSON. The length
// assertion beside it fires for the same reason and is stated separately so the
// failure message says whether the file was truncated or rewritten.
//
// SABOTAGE: change `setTaintLatch`'s open flags in
// scripts/hooks/h17-bash-write-sweep.mjs from `O_CREAT|O_EXCL` (create-only) to
// a truncating write — `openSync(..., 'w')` or a plain
// `writeFileSync(latchPath, ...)`. The planted bytes are clobbered and this
// test goes RED, while AC-L9 above stays green (which is precisely why AC-L9
// could not be relied on).
//
// THE CAUSE THE REACHABILITY PROBE RULES OUT: "the planted bytes survived"
// has two possible causes — (a) the set primitive ran and correctly refused to
// overwrite, which is the ruling, or (b) THE SET PRIMITIVE WAS NEVER REACHED at
// all (exactly AC-L9's defect). The final assertion is the control for (b): it
// requires the denial to name the (B) path, which only a denial produced by the
// (B) detection stage can do. If that assertion fires, the byte assertion above
// it was vacuous and this test must be re-shaped, not re-graded.
// ===========================================================================
test('AC-L13: a latch leaf planted AFTER Pre survives byte-for-byte when a fresh in-window incident reaches the eager create-only set (AC-L9 never reaches that primitive)', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const coder = coderPath(dir);

    // 1. Clean project, no latch: Pre runs and ALLOWS. Nothing is latched yet,
    //    so the plant below cannot be short-circuited by a Pre-side taint gate.
    assert.equal(existsSync(latchPath(dir)), false, 'PRECONDITION: no latch exists at Pre');
    const L = lane('ac-l13-createonly-reached');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre on a clean, unlatched tree allows');

    // 2. NOW plant distinctive, recognisable bytes at the latch path.
    const PLANTED = Buffer.from('PLANTED-AFTER-PRE — these exact bytes must survive a create-only latch set (bcd2cc09 Ruling 8)\n');
    writeFileSync(latchPath(dir), PLANTED);
    assert.deepEqual(readFileSync(latchPath(dir)), PLANTED, 'PRECONDITION: the planted bytes are on disk before the incident');

    // 3. A genuine in-window incident that reaches a detection site: an
    //    unattested (B) modification (`noteBaselineDenied`, an eager producer).
    writeFileSync(coder, Buffer.from('# unattested (B) tamper, with a latch leaf already present\n'));

    // 4. Post: denies, and the eager set attempt hits the existing leaf.
    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `an unattested (B) modify must deny — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    assert.equal(
      readFileSync(latchPath(dir)).length,
      PLANTED.length,
      'THE RULING (bcd2cc09 Ruling 8): the create-only set must not truncate the existing leaf — a differing length here means the latch set is itself a truncate primitive'
    );
    assert.deepEqual(
      readFileSync(latchPath(dir)),
      PLANTED,
      'THE RULING (bcd2cc09 Ruling 8): an existing leaf in ANY shape is treated as already-set and never overwritten — otherwise latching is the arbitrary-write primitive this objective exists to remove'
    );
    assert.match(
      oneLine(r.stderr),
      /coder\.md|\.claude\/agents/i,
      'REACHABILITY PROBE (the control for this pin): the denial must name the (B) path, proving the detection stage — and therefore the eager set primitive — was actually reached. If this fires, the byte assertions above were vacuous in exactly the way AC-L9 is, and this fixture must be re-shaped rather than re-graded'
    );
  } finally {
    cleanup();
  }
});
