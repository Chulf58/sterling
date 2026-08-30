// H17 (B) SURFACE — THE PERSISTENT BASELINE HASH LIST COMPARATOR (Sterling
// de-complication SLICE S4).
//
// Spec: decision `b-baseline-hash-list-concrete-design` (fe861066), settling
// the CONCRETE MECHANISM for decision
// `h17-demotes-to-tripwire-with-minimal-b-hash-list` (78dc9bd6)'s ADD clause.
// The stamp/attestation apparatus (scripts/enforcement-stamp.mjs and every
// per-call manifest it produced) is DELETED OUTRIGHT — a same-UID-forgeable
// attestation may never change a verdict. This file pins its successor: a
// PERSISTENT, gitignored JSON file at .sterling/enforcement-baseline.json,
// minted only by the clearer (scripts/enforcement-reconcile.mjs, out of
// scope here), that the hook compares the CURRENT (B) surface against on
// every gated Bash call.
//
// SHAPE (fe861066 D1): {version: exactly 1, minted_at (DIAGNOSTIC ONLY),
// entries: SORTED ARRAY of {path, sha256}}, ascending by path — duplicate or
// unsorted entries are MALFORMED, not merely unusual. Paths are repo-relative
// forward-slash BASELINE_GLOBS members; hashes are lowercase 64-hex sha256.
// The list file itself lives OUTSIDE BASELINE_GLOBS, exactly like the taint
// latch.
//
// COMPARATOR SEMANTICS (fe861066 D3/D4/D6):
//   * LIST PRESENT + VALID  -> set-exact 4-arm compare (listed-but-missing /
//     bytes-differ / live-but-unlisted / exact) vs the current (B) surface.
//     ANY mismatch -> first-class deny AND the taint latch set EAGERLY at the
//     detection site (findings named listDenied). An exact match means ONLY
//     that listDenied stays empty — it never early-allows, and it never
//     suppresses any OTHER independent finding (the no-suppression arm below).
//   * LIST ABSENT           -> comparator SKIPPED, one-line non-fatal stderr
//     notice (degraded-loud), NO deny. Bootstrap reality, a documented
//     weakness, not a bug.
//   * LIST MALFORMED (bad version, unsorted/duplicate entries, bad hash
//     format, unparseable JSON, non-regular file) -> first-class deny AND
//     LATCH (deny-only would launder: deny, the file gets removed, the next
//     call sees ABSENT and skips, adopting current bytes as legitimate).
//   * The comparator runs INDEPENDENT of store availability, run resolution,
//     and the per-call Pre-state/(B) records.
//
// AUTHORED BLIND to scripts/hooks/h17-bash-write-sweep.mjs per H4 — no hook
// source was read to write these pins. Every expectation comes from decision
// fe861066's prose (a decision record is spec, not implementation — H4's wall
// gates Read/Grep on code, not knowledge_get).
//
// HARNESS is a faithful, non-imported copy of the makeGitProject/h17/lane/git/
// oneLine idiom shared by scripts/tests/h17-b-taint-latch.test.mjs and
// scripts/tests/h17-b-detect-and-deny.test.mjs (copied in shape, not
// imported — none of these files export anything). The SYMLINK_SKIP
// host-capability probe is copied in shape from
// scripts/tests/h17-b-taint-latch.test.mjs. The broken-store technique
// (close handle, drop -wal/-shm, overwrite the db file with non-sqlite bytes)
// is copied in shape from scripts/tests/enforcement.test.mjs's "H17 AC9d"
// arrangement and scripts/tests/h17-stamp-honor-hardening.test.mjs's PIN H1.
//
// RUN COMMAND (node toolchain adapter):
//   node --test scripts/tests/h17-b-baseline-list.test.mjs

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  realpathSync,
  symlinkSync,
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

// Copied in shape from h17-b-taint-latch.test.mjs's SYMLINK_SKIP.
const SYMLINK_SKIP = (() => {
  try {
    const d = mkdtempSync(join(tmpdir(), 'sterling-blist-symprobe-'));
    writeFileSync(join(d, 'target'), 'x');
    symlinkSync(join(d, 'target'), join(d, 'link'));
    const ok = lstatSync(join(d, 'link')).isSymbolicLink();
    rmSync(d, { recursive: true, force: true });
    return ok ? false : 'symlinks are not observable on this host';
  } catch (e) {
    return `symlinks unavailable on this host (${e.code ?? e.message})`;
  }
})();

function git(dir, args, { must = false } = {}) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (must) assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${oneLine(r.stderr)}`);
  return r;
}

function makeGitProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h17-blist-'));
  const runId = 'r-h17blist-' + randomUUID().slice(0, 8);

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
  };
  return { dir, store, runId, dbPath, projectTag, closeStore, cleanup };
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

function coderPath(dir) {
  return join(dir, '.claude', 'agents', 'coder.md');
}
function settingsPath(dir) {
  return join(dir, '.claude', 'settings.local.json');
}
function configJsonPath(dir) {
  return join(dir, '.sterling', 'config.json');
}

const CODER_REL = '.claude/agents/coder.md';
const SETTINGS_REL = '.claude/settings.local.json';
const CONFIG_REL = '.sterling/config.json';

function sha256Of(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// THE LATCH — deliberately outside the sealed DB and outside BASELINE_GLOBS,
// same object this decision's own D6 trigger set feeds.
function latchPath(dir) {
  return join(dir, '.sterling', 'enforcement-taint.json');
}

// THE LIST — decision fe861066 D1: .sterling/enforcement-baseline.json,
// deliberately NOT under transient/ (persistent evidence), and itself outside
// BASELINE_GLOBS (like the latch).
function baselineListPath(dir) {
  return join(dir, '.sterling', 'enforcement-baseline.json');
}

function fullBaselineEntries(dir) {
  return [
    { path: CODER_REL, sha256: sha256Of(coderPath(dir)) },
    { path: SETTINGS_REL, sha256: sha256Of(settingsPath(dir)) },
    { path: CONFIG_REL, sha256: sha256Of(configJsonPath(dir)) },
  ];
}

// Writes a VALID list: sorted ascending by path, {version:1, minted_at, entries}.
function writeBaselineList(dir, entries) {
  const sorted = [...entries].map(({ path, sha256 }) => ({ path, sha256 })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  writeFileSync(baselineListPath(dir), JSON.stringify({ version: 1, minted_at: NOW, entries: sorted }));
}

// Writes RAW bytes at the list path, bypassing every validity guarantee
// writeBaselineList provides — used only by the MALFORMED arms below.
function writeRawBaselineFile(dir, bytes) {
  mkdirSync(dirname(baselineListPath(dir)), { recursive: true });
  writeFileSync(baselineListPath(dir), bytes);
}

// PHASE-AGNOSTIC DENY, mirroring the idiom established by
// scripts/tests/h17-b-detect-and-deny.test.mjs's AC10 and
// scripts/tests/h17-b-taint-latch.test.mjs's AC-L4/AC-L8: decision fe861066
// does not name WHICH phase (Pre or Post) the list comparator's verdict lands
// on, only that it runs "on every gated Bash call". Pinning a phase the spec
// does not name would make a test red for a reason that is not a defect. Post
// runs ONLY if Pre allowed — never simulate execution after a denied Pre.
function denyPhaseAgnostic(dir, laneTag) {
  const L = lane(laneTag);
  const pre = h17(dir, 'PreToolUse', L);
  assert.notEqual(pre.code, 1, 'a security gate never fails with a non-blocking exit 1 (Pre)');
  const post = pre.code === 2 ? null : h17(dir, 'PostToolUse', L);
  if (post) assert.notEqual(post.code, 1, 'a security gate never fails with a non-blocking exit 1 (Post)');
  return { pre, post, denied: post ?? pre };
}

// ===========================================================================
// CONTROL — PLACED FIRST. An exact baseline list for every current (B) path,
// nothing changed in-window, ALLOWS — and it must be the comparator actually
// VALIDATING every call (finding it exact), not a "skip if nothing changed"
// shortcut that never opens the list at all. This test alone cannot
// distinguish those two causes (both ALLOW); the MISMATCH arms below are what
// prove the list is genuinely read and compared on every call, because they
// plant a standing mismatch with NOTHING touched in the current window and it
// still denies.
//
// EXPECTED: GREEN today is plausible only by accident — HEAD's existing
// per-call (B) detect-and-deny already allows an unchanged surface without
// ever opening any list at all, for an entirely different (and correct, but
// insufficient) reason. Once the comparator lands, this must ALSO allow, for
// the RIGHT reason (validated and found exact).
//
// SABOTAGE: this control has no independent sabotage of its own — see the
// mismatch arms below, whose sabotage would also flip this control to deny if
// the comparator were naively "any list present -> deny" instead of "exact
// match -> allow, mismatch -> deny".
// ===========================================================================
test('CONTROL: an exact baseline list for every current (B) path, nothing changed in-window, ALLOWS — comparator validates every call', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    writeBaselineList(dir, fullBaselineEntries(dir));
    const L = lane('control-exact');
    const pre = h17(dir, 'PreToolUse', L);
    assert.notEqual(pre.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(pre.code, 0, `Pre must allow on an exact baseline list — actual ${pre.code}, stderr: ${oneLine(pre.stderr)}`);
    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 0, `CONTROL: an exact baseline list must ALLOW even though it is validated on every call — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    assert.equal(existsSync(latchPath(dir)), false, 'no incident, no latch');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// ABSENT — no baseline list present at all: comparator SKIPPED (degraded-
// loud), ALLOW, one-line non-fatal stderr notice, NO latch. This is the
// documented bootstrap weakness (fe861066 D4), not a bug — deliberately
// distinct from every MALFORMED arm below, which denies+latches instead.
//
// WORDING DISCLOSED AS UNCERTAIN (H4 forbids reading the hook to confirm the
// exact phrase): the assertion below matches loosely on "baseline" plus
// "absent/missing/no " — the conductor should confirm the precise notice text
// once this is red and tighten the match if it is more specific.
// ===========================================================================
test('ABSENT: no baseline list present → comparator SKIPPED, ALLOW, with a one-line non-fatal stderr notice, no latch', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    assert.equal(existsSync(baselineListPath(dir)), false, 'PRECONDITION: no baseline list exists');
    const L = lane('absent');
    const pre = h17(dir, 'PreToolUse', L);
    assert.notEqual(pre.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(pre.code, 0, `Pre must allow with no baseline list — actual ${pre.code}, stderr: ${oneLine(pre.stderr)}`);
    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 0, `ABSENT: no baseline list must ALLOW (comparator skipped, not deny-by-default) — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    assert.match(oneLine(r.stderr) + oneLine(pre.stderr), /baseline/i, 'a one-line degraded notice mentions the baseline list by name (disclosed as loosely matched — see comment above)');
    assert.match(oneLine(r.stderr) + oneLine(pre.stderr), /absent|missing|no baseline/i, 'the notice discloses the ABSENT condition, not silence');
    assert.equal(existsSync(latchPath(dir)), false, 'ABSENT never latches — it is a documented weakness, not a detected incident');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// MISMATCH — three directions, each its own test, each denies + latches. All
// three plant the mismatch BEFORE Pre with NOTHING touched in the current
// window, so a deny can only be explained by the list comparator itself
// (never by the ordinary per-call (B) detect-and-deny, which needs an
// in-window change to fire at all).
// ===========================================================================

test('MISMATCH (bytes-differ): a baseline list entry whose hash disagrees with its CURRENT on-disk bytes denies + latches, with nothing changed in-window', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const wrongHash = createHash('sha256').update('not the real coder.md content').digest('hex');
    const entries = fullBaselineEntries(dir).map((e) => (e.path === CODER_REL ? { ...e, sha256: wrongHash } : e));
    writeBaselineList(dir, entries);
    assert.equal(existsSync(latchPath(dir)), false, 'PRECONDITION: no latch exists yet');

    const { denied } = denyPhaseAgnostic(dir, 'mismatch-bytes-differ');
    assert.equal(denied.code, 2, `a listed path whose hash disagrees with disk must deny — stderr: ${oneLine(denied.stderr)}`);
    assert.match(oneLine(denied.stderr), new RegExp(CODER_REL.replace(/\./g, '\\.')), 'the denial names the disagreeing path');
    assert.equal(existsSync(latchPath(dir)), true, 'the mismatch latches (listDenied is in the corrected trigger set, fe861066 D6)');
  } finally {
    cleanup();
  }
});

test('MISMATCH (listed-but-missing): a baseline list entry naming a path that is now ABSENT from disk denies + latches, with nothing changed in-window', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    writeBaselineList(dir, fullBaselineEntries(dir));
    rmSync(settingsPath(dir), { force: true }); // listed, but now missing — BEFORE Pre, not an in-window delete
    assert.equal(existsSync(settingsPath(dir)), false, 'PRECONDITION: the listed path is genuinely absent from disk');
    assert.equal(existsSync(latchPath(dir)), false, 'PRECONDITION: no latch exists yet');

    const { denied } = denyPhaseAgnostic(dir, 'mismatch-listed-missing');
    assert.equal(denied.code, 2, `a listed path missing from disk must deny — stderr: ${oneLine(denied.stderr)}`);
    assert.match(oneLine(denied.stderr), new RegExp(SETTINGS_REL.replace(/\./g, '\\.')), 'the denial names the missing path');
    assert.equal(existsSync(latchPath(dir)), true, 'the mismatch latches');
  } finally {
    cleanup();
  }
});

test('MISMATCH (live-but-unlisted): a current (B) path with NO baseline list entry at all denies + latches, with nothing changed in-window', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const entries = fullBaselineEntries(dir).filter((e) => e.path !== SETTINGS_REL); // omit a path that still exists on disk
    writeBaselineList(dir, entries);
    assert.equal(existsSync(settingsPath(dir)), true, 'PRECONDITION: the unlisted path still exists live on disk');
    assert.equal(existsSync(latchPath(dir)), false, 'PRECONDITION: no latch exists yet');

    const { denied } = denyPhaseAgnostic(dir, 'mismatch-live-unlisted');
    assert.equal(denied.code, 2, `a live (B) path with no list entry must deny — stderr: ${oneLine(denied.stderr)}`);
    assert.match(oneLine(denied.stderr), new RegExp(SETTINGS_REL.replace(/\./g, '\\.')), 'the denial names the unlisted path');
    assert.equal(existsSync(latchPath(dir)), true, 'the mismatch latches');
  } finally {
    cleanup();
  }
});

// ===========================================================================
// MALFORMED — nine arms, each its own test, each denies + latches (fe861066
// D4: deny-only would launder — remove the malformed file, the next call
// sees ABSENT and skips, adopting whatever is on disk as legitimate). Every
// arm otherwise carries the SAME accurate content as a valid list (built from
// fullBaselineEntries) so the sole variable is the one named malformation.
// The last two arms (unknown entry key, non-canonical path key) were added
// per a Codex delta-review HIGH finding: the hook's own list parser accepts
// shapes the CLEARER (scripts/enforcement-reconcile.mjs) refuses, so a list
// valid to one reader is malformed to the other — a hook/clearer validity
// divergence. Both must be malformed to the HOOK TOO, closing the gap.
// ===========================================================================

test('MALFORMED (version !== 1): a baseline list with the wrong version denies + latches', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const entries = fullBaselineEntries(dir).sort((a, b) => (a.path < b.path ? -1 : 1));
    writeRawBaselineFile(dir, JSON.stringify({ version: 2, minted_at: NOW, entries }));

    const { denied } = denyPhaseAgnostic(dir, 'malformed-version');
    assert.equal(denied.code, 2, `version !== 1 must deny — stderr: ${oneLine(denied.stderr)}`);
    assert.equal(existsSync(latchPath(dir)), true, 'a malformed list latches (deny-only would launder)');
  } finally {
    cleanup();
  }
});

test('MALFORMED (entries unsorted): a baseline list whose entries are not sorted ascending by path denies + latches', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const entries = fullBaselineEntries(dir).sort((a, b) => (a.path < b.path ? 1 : -1)); // DESCENDING — deliberately wrong
    assert.notDeepEqual(
      entries.map((e) => e.path),
      [...entries.map((e) => e.path)].sort(),
      'PRECONDITION: the entries are genuinely NOT in ascending order'
    );
    writeRawBaselineFile(dir, JSON.stringify({ version: 1, minted_at: NOW, entries }));

    const { denied } = denyPhaseAgnostic(dir, 'malformed-unsorted');
    assert.equal(denied.code, 2, `unsorted entries must deny — stderr: ${oneLine(denied.stderr)}`);
    assert.equal(existsSync(latchPath(dir)), true, 'a malformed list latches');
  } finally {
    cleanup();
  }
});

test('MALFORMED (duplicate path entries): a baseline list naming the same path twice denies + latches', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const base = fullBaselineEntries(dir).sort((a, b) => (a.path < b.path ? -1 : 1));
    const entries = [...base, base[0]].sort((a, b) => (a.path < b.path ? -1 : 1)); // CODER_REL duplicated
    writeRawBaselineFile(dir, JSON.stringify({ version: 1, minted_at: NOW, entries }));

    const { denied } = denyPhaseAgnostic(dir, 'malformed-duplicate');
    assert.equal(denied.code, 2, `duplicate path entries must deny — stderr: ${oneLine(denied.stderr)}`);
    assert.equal(existsSync(latchPath(dir)), true, 'a malformed list latches');
  } finally {
    cleanup();
  }
});

test('MALFORMED (sha256 not lowercase-64-hex): a baseline list entry whose hash is uppercase hex denies + latches', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const entries = fullBaselineEntries(dir)
      .map((e) => (e.path === CODER_REL ? { ...e, sha256: e.sha256.toUpperCase() } : e))
      .sort((a, b) => (a.path < b.path ? -1 : 1));
    assert.notEqual(entries.find((e) => e.path === CODER_REL).sha256, sha256Of(coderPath(dir)), 'PRECONDITION: the hash is genuinely not lowercase-64-hex (uppercased)');
    writeRawBaselineFile(dir, JSON.stringify({ version: 1, minted_at: NOW, entries }));

    const { denied } = denyPhaseAgnostic(dir, 'malformed-hashformat');
    assert.equal(denied.code, 2, `a non-lowercase-64-hex hash must deny — stderr: ${oneLine(denied.stderr)}`);
    assert.equal(existsSync(latchPath(dir)), true, 'a malformed list latches');
  } finally {
    cleanup();
  }
});

test('MALFORMED (unparseable JSON): a baseline list that is not valid JSON denies + latches', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    writeRawBaselineFile(dir, '{ not valid json,,,');

    const { denied } = denyPhaseAgnostic(dir, 'malformed-unparseable');
    assert.equal(denied.code, 2, `unparseable JSON must deny — stderr: ${oneLine(denied.stderr)}`);
    assert.equal(existsSync(latchPath(dir)), true, 'a malformed list latches');
  } finally {
    cleanup();
  }
});

test('MALFORMED (non-regular: directory): a directory sitting at the baseline list path denies + latches', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    mkdirSync(baselineListPath(dir), { recursive: true });

    const { denied } = denyPhaseAgnostic(dir, 'malformed-directory');
    assert.equal(denied.code, 2, `a directory at the list path must deny — stderr: ${oneLine(denied.stderr)}`);
    assert.equal(existsSync(latchPath(dir)), true, 'a malformed (non-regular) list latches');
    assert.equal(lstatSync(baselineListPath(dir)).isDirectory(), true, 'H17 never replaced the directory in the course of denying');
  } finally {
    cleanup();
  }
});

test('MALFORMED (non-regular: symlink): a symlink sitting at the baseline list path denies + latches', { skip: GIT_SKIP || SYMLINK_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const nowhere = join(tmpdir(), 'sterling-blist-symlink-nonexistent-target-' + randomUUID().slice(0, 8));
    symlinkSync(nowhere, baselineListPath(dir));

    const { denied } = denyPhaseAgnostic(dir, 'malformed-symlink');
    assert.equal(denied.code, 2, `a symlink at the list path must deny — stderr: ${oneLine(denied.stderr)}`);
    assert.equal(existsSync(latchPath(dir)), true, 'a malformed (non-regular) list latches');
    assert.equal(lstatSync(baselineListPath(dir)).isSymbolicLink(), true, 'the symlink itself survives untouched');
  } finally {
    cleanup();
  }
});

// ADDED per Codex delta-review HIGH finding (hook/clearer list-validity
// divergence): today the hook's parser is more PERMISSIVE than the clearer's
// — it validates and ALLOWS shapes scripts/enforcement-reconcile.mjs already
// refuses to mint or verify. A list valid to one reader and malformed to the
// other means the two components of this ONE mechanism disagree about what
// "the baseline" even is. Both arms below are RED-FIRST against the CURRENT
// hook (today it accepts both shapes); they close the divergence, they do
// not merely restate the existing MALFORMED family.
test('MALFORMED (unknown entry key): a baseline list entry carrying an extra key (deleted: true) denies + latches — closes the hook/clearer validity divergence', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const entries = fullBaselineEntries(dir)
      .map((e) => (e.path === CODER_REL ? { ...e, deleted: true } : e))
      .sort((a, b) => (a.path < b.path ? -1 : 1));
    assert.ok('deleted' in entries.find((e) => e.path === CODER_REL), 'PRECONDITION: the entry genuinely carries a key beyond {path, sha256}');
    writeRawBaselineFile(dir, JSON.stringify({ version: 1, minted_at: NOW, entries }));

    const { denied } = denyPhaseAgnostic(dir, 'malformed-unknownkey');
    assert.equal(denied.code, 2, `an entry with an unknown key ("deleted") must deny, not merely be tolerated with the extra key ignored — stderr: ${oneLine(denied.stderr)}`);
    assert.equal(
      existsSync(latchPath(dir)),
      true,
      'a malformed list latches — the hook must refuse a shape the clearer already refuses, so a list valid to one reader is never malformed to the other'
    );
    // SABOTAGE: accept an entry with an unknown key (validate only that
    // {path, sha256} are PRESENT rather than that the entry has EXACTLY those
    // two keys) — this deny flips to allow and the latch assertion flips to
    // false.
  } finally {
    cleanup();
  }
});

test('MALFORMED (non-canonical path key): a baseline list entry whose path uses backslashes instead of the canonical forward-slash form denies + latches — the hook must never normalize a list path into validity', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const canonicalEntries = fullBaselineEntries(dir).sort((a, b) => (a.path < b.path ? -1 : 1));
    const nonCanonicalPath = CODER_REL.replace(/\//g, '\\'); // '.claude\agents\coder.md' — byte-different from the canonical key
    assert.notEqual(nonCanonicalPath, CODER_REL, 'PRECONDITION: the backslash form is genuinely byte-different from the canonical repo-relative forward-slash path');
    const entries = canonicalEntries.map((e) => (e.path === CODER_REL ? { ...e, path: nonCanonicalPath } : e));
    writeRawBaselineFile(dir, JSON.stringify({ version: 1, minted_at: NOW, entries }));

    const { denied } = denyPhaseAgnostic(dir, 'malformed-noncanonicalpath');
    assert.equal(denied.code, 2, `a non-canonical (backslash-form) path key must deny, never be silently normalized into a match against the canonical path — stderr: ${oneLine(denied.stderr)}`);
    assert.equal(
      existsSync(latchPath(dir)),
      true,
      "a malformed list latches — mirrors the clearer's validateBaselineKey(e.path) !== e.path refusal exactly, so the hook and the clearer agree on what counts as a valid key"
    );
    // SABOTAGE: normalize a list path (e.g. path.replace(/\\/g, '/')) before
    // comparing it against the canonical form, instead of refusing any path
    // that is not ALREADY byte-identical to its canonical form — this deny
    // flips to allow and the latch assertion flips to false.
  } finally {
    cleanup();
  }
});

// ===========================================================================
// STORE-INDEPENDENCE — the comparator runs (and its finding latches)
// INDEPENDENT of store availability (fe861066 D3). CONTROL placed first,
// passing for the OPPOSITE reason: a broken store denies on its own for
// generic reasons that have nothing to do with the list, so a broken-store
// deny alone proves nothing about listDenied specifically. Without this
// control, the TREATMENT below (broken store + list mismatch -> latch) could
// equally be explained by "a broken store denial latches unconditionally."
//
// Technique copied in shape from scripts/tests/enforcement.test.mjs's "H17
// AC9d" and scripts/tests/h17-stamp-honor-hardening.test.mjs's PIN H1: close
// the fixture's own store handle, drop the -wal/-shm files, overwrite the db
// file with non-sqlite bytes.
// ===========================================================================

function breakStore(fx) {
  fx.closeStore();
  rmSync(fx.dbPath + '-wal', { force: true });
  rmSync(fx.dbPath + '-shm', { force: true });
  writeFileSync(fx.dbPath, 'this is not a sqlite database — resolveRun must throw');
}

test('STORE-INDEPENDENCE CONTROL: a broken store denies on its own (generic reason) but does NOT latch when the list is absent/exact — isolates the cause', { skip: GIT_SKIP }, () => {
  const fx = makeGitProject();
  const { dir, cleanup } = fx;
  try {
    assert.equal(h17(dir, 'PreToolUse', lane('storeindep-control-pre')).code, 0, 'Pre while the store is still healthy');
    assert.equal(existsSync(baselineListPath(dir)), false, 'PRECONDITION: no baseline list — nothing for the comparator to find mismatched');
    breakStore(fx);

    const r = h17(dir, 'PostToolUse', lane('storeindep-control-post'));
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `a broken store must fail closed on its own, independent of the list — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    assert.equal(existsSync(latchPath(dir)), false, 'CONTROL: this denial is the generic broken-store deny, not a list finding — it must NOT latch, or the TREATMENT below cannot isolate the cause');
  } finally {
    cleanup();
  }
});

test('STORE-INDEPENDENCE: a baseline-list mismatch still denies AND latches even when the store is broken/unavailable', { skip: GIT_SKIP }, () => {
  const fx = makeGitProject();
  const { dir, cleanup } = fx;
  try {
    const wrongHash = createHash('sha256').update('store-independence mismatch bytes').digest('hex');
    const entries = fullBaselineEntries(dir).map((e) => (e.path === CODER_REL ? { ...e, sha256: wrongHash } : e));
    writeBaselineList(dir, entries);

    // SIMPLIFIED per coordinator direction: decision fe861066 D3's own words
    // are phase-SPECIFIC, not phase-agnostic — "on every gated Bash Post,
    // list present + shape-valid -> set-exact compare" (D3, verbatim) — so
    // Pre never carries the list verdict and always allows here. Asserted
    // OUTRIGHT rather than carried as a dead `pre.code === 2 ? null : ...`
    // branch. THE SAME D3 WORDING applies equally to the CONTROL/MISMATCH/
    // MALFORMED tests above, whose denyPhaseAgnostic helper is therefore ALSO
    // more cautious than the spec strictly requires — left untouched here
    // per this follow-up's explicit scope ("only those two tests"), not
    // because the spec is actually silent there. A future Pre-side deny on
    // THIS fixture must rewrite the assertion below, never silently absorb
    // into a phase-agnostic branch that would mask the regression.
    assert.equal(h17(dir, 'PreToolUse', lane('storeindep-treatment-pre')).code, 0, "Pre on a clean tree with a standing list mismatch still allows — fe861066 D3 names the comparator's verdict a Post-only stage");
    breakStore(fx);

    const post = h17(dir, 'PostToolUse', lane('storeindep-treatment-post'));
    assert.notEqual(post.code, 1, 'a security gate never fails with a non-blocking exit 1 (Post)');
    assert.equal(post.code, 2, `a list mismatch must still deny under a broken store — stderr: ${oneLine(post.stderr)}`);
    assert.equal(
      existsSync(latchPath(dir)),
      true,
      'TREATMENT: THE COMPARATOR RUNS INDEPENDENT OF STORE AVAILABILITY (fe861066 D3) — the list finding latches even though the store cannot be consulted for anything else'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// NO-SUPPRESSION — an exact list match must NEVER suppress an in-window
// finding. An attacker who tampers a (B) file AND rewrites the persistent
// list to describe the POST-tamper bytes as legitimate ("attacker-
// consistent") still gets denied, via the ORDINARY per-call in-window
// baselineDenied arm — a list agreeing with whatever is currently on disk is
// not a licence to have put it there.
//
// THE CONTROL THIS ARM NEEDS ALREADY EXISTS ABOVE: the CONTROL test proves an
// exact list match with NOTHING changed in-window ALLOWS. This test changes
// exactly one variable — an in-window (B) modification — while keeping the
// list EXACT (now matching the new bytes). The only way this can still deny
// is the in-window arm firing despite the exact match, which is the property
// under test.
//
// STRENGTHENED per correctness-review objection: exit code 2 + a latch alone
// cannot distinguish "the in-window arm fired despite the exact match" (the
// pin's subject) from "the list comparator itself spuriously fired on an
// EXACT match" (a bug this fixture would then be certifying by accident,
// since both produce code 2 + a latch). Two additional assertions close that
// gap:
//   (1) stderr NAMES the tampered (B) path — the identifying signal for a
//       baselineDenied finding, using the SAME stable-fragment convention
//       (the bare path string, not a full sentence) every other (B)
//       detect-and-deny pin in this file family already asserts on
//       (h17-b-detect-and-deny.test.mjs AC1/AC2/AC3, this file's own
//       MISMATCH arms).
//   (2) stderr does NOT name the baseline list's OWN artifact
//       (enforcement-baseline.json) — the identifying signal a listDenied
//       finding would carry. DISCLOSED, NOT VERIFIED (H4 forbids reading
//       scripts/hooks/h17-bash-write-sweep.mjs to confirm the exact wording):
//       this is inferred BY ANALOGY to an established convention already
//       proven elsewhere in this test-file family — a mechanism-specific
//       denial names its OWN artifact (the retired stamp denial asserted
//       `/enforcement-stamp\.json/` for a stamp-specific finding; the taint
//       latch denial asserts `/taint|latch/i` for a latch-specific finding).
//       If this assertion goes red for the WRONG reason (the hook simply
//       never mentions its own filename anywhere, on ANY finding), that is a
//       fixture defect to fix, not a defect in the hook — the conductor
//       should confirm the actual wording once red and correct the pattern
//       here rather than loosen or delete the assertion.
//
// SABOTAGE: making the exact-list match suppress the in-window arm (an
// implementation that short-circuits detect-and-deny once the list is found
// exact) flips assertion (1) — the path is never named because no
// baselineDenied finding fires at all. Making the comparator fire its OWN
// finding on an exact match (e.g. treating "list present" alone, rather than
// "list mismatched", as denial-worthy) flips assertion (2) — the list's own
// artifact name appears in a deny that should have had nothing to do with it.
// ===========================================================================
test('NO-SUPPRESSION: an in-window (B) modification, with the baseline list rewritten to exactly match the POST bytes, still DENIES via the in-window arm', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    writeBaselineList(dir, fullBaselineEntries(dir)); // matches PRE-modification bytes
    const L = lane('no-suppression');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre on a clean, exactly-listed tree allows');

    const newBytes = Buffer.from('---\nname: attacker-consistent-relist\n---\n# tampered in-window; the list below is rewritten to match\n');
    writeFileSync(coderPath(dir), newBytes);
    // ATTACKER-CONSISTENT: the list is rewritten to attest the CURRENT
    // (post-tamper) bytes, exactly as if this had always been the legitimate
    // state.
    writeBaselineList(dir, fullBaselineEntries(dir));
    assert.equal(
      fullBaselineEntries(dir).find((e) => e.path === CODER_REL).sha256,
      sha256Of(coderPath(dir)),
      'PRECONDITION: the rewritten list is an EXACT match for the current (tampered) bytes'
    );

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(
      r.code,
      2,
      `THE PIN: an exact list match must NEVER suppress an in-window finding — a list rewritten to agree with tampered bytes is not authorization — actual ${r.code}, stderr: ${oneLine(r.stderr)}`
    );
    assert.deepEqual(readFileSync(coderPath(dir)), newBytes, 'the (B) bytes are left exactly as the command wrote them (detect-and-deny, never restored)');
    assert.equal(existsSync(latchPath(dir)), true, 'the in-window (B) modification latches (baselineDenied is in the trigger set regardless of listDenied)');

    const stderrFlat = oneLine(r.stderr);
    assert.match(
      stderrFlat,
      new RegExp(CODER_REL.replace(/\./g, '\\.')),
      'ASSERTION (1) — WHICH GUARD CARRIES THIS VERDICT: the deny must NAME the tampered path — this is the baselineDenied finding, not a bare exit code that could equally mean the list comparator fired for the wrong reason'
    );
    assert.doesNotMatch(
      stderrFlat,
      /enforcement-baseline\.json/,
      'ASSERTION (2), THE DISCRIMINATOR: the deny must NOT name the baseline list\'s own artifact — an exact list match produced no listDenied finding here; if it did, this deny would be for the WRONG reason despite carrying the right exit code and latch'
    );
  } finally {
    cleanup();
  }
});

// ===========================================================================
// FSMONITOR-INJECTION — added per a Codex delta-review MEDIUM finding: H17's
// OWN two internal `git status` invocations (the Pre snapshot sweep and the
// Post (A) sweep) still honor repo-local `core.fsmonitor`. Git's fsmonitor
// hook protocol runs the configured VALUE AS AN ARBITRARY COMMAND whenever a
// command that needs index freshness (status, add, ...) is invoked without an
// override — so a write-only actor (an agent with no more access than a
// gitignored `.git/config` line) gets arbitrary command execution under H17's
// OWN UID, purely by being audited. The CLEARER (scripts/enforcement-
// reconcile.mjs) already carries this hardening — this file's sibling suite's
// AC-R59 pins it there. THE HOOK DID NOT, until this pin exists to prove it.
//
// FIXTURE: a repo-local `core.fsmonitor = sh -c '<touch a sentinel>' --`. The
// trailing `--` makes `sh -c` treat it as $0 (the script name slot), so any
// arguments git itself appends (a version token, a query token) land in
// positional parameters the inner command never reads — "ignoring argv",
// exactly the same shape as the clearer's own AC-R59 fixture.
//
// ONE PIN COVERS BOTH INVOCATIONS: an ordinary benign gated Bash call runs
// BOTH the Pre sweep and the Post (A) sweep in the course of one normal
// Pre/Post pair, so a single fixture exercises both git spawns at once.
//
// HOST-CAPABILITY PROBE, not a vacuous-pass risk left unchecked: this
// technique depends on this host's git actually invoking `core.fsmonitor` as
// an arbitrary command on a PLAIN, unguarded `git status` — if it does not
// (an old git version, a fsmonitor implementation gated behind a feature
// flag), the fixture cannot be constructed honestly and must SKIP with a
// named reason, never silently pass as if the hook's own guard had fired.
// ===========================================================================

const FSMONITOR_INJECTION_SKIP = (() => {
  let probeDir;
  let sentinel;
  try {
    probeDir = mkdtempSync(join(tmpdir(), 'sterling-blist-fsmonprobe-'));
    const rInit = spawnSync('git', ['init', '-q'], { cwd: probeDir, encoding: 'utf8' });
    if (rInit.error || rInit.status !== 0) return `git init failed on this host (${rInit.error?.code ?? rInit.status})`;
    sentinel = join(tmpdir(), 'sterling-blist-fsmonprobe-sentinel-' + randomUUID().slice(0, 8));
    const rConfig = spawnSync('git', ['config', 'core.fsmonitor', `sh -c 'touch "${sentinel}"' --`], { cwd: probeDir, encoding: 'utf8' });
    if (rConfig.error || rConfig.status !== 0) return 'git config core.fsmonitor could not be set on this host';
    // an UNGUARDED `git status` (no -c core.fsmonitor= override) — proves the
    // injection mechanism itself fires here, independent of H17 entirely.
    spawnSync('git', ['status', '--porcelain'], { cwd: probeDir, encoding: 'utf8' });
    const fired = existsSync(sentinel);
    return fired
      ? false
      : "this host/git version does not invoke core.fsmonitor as an arbitrary command on a plain 'git status' — the injection fixture cannot be constructed honestly here";
  } catch (e) {
    return `fsmonitor-injection probe unavailable on this host (${e.code ?? e.message})`;
  } finally {
    if (sentinel) rmSync(sentinel, { force: true });
    if (probeDir) rmSync(probeDir, { recursive: true, force: true });
  }
})();

test("FSMONITOR-INJECTION: a repo-local core.fsmonitor pointing at an arbitrary command never executes under EITHER of H17's own git invocations (Pre sweep + Post (A) sweep)", { skip: GIT_SKIP || FSMONITOR_INJECTION_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  const sentinelPath = join(tmpdir(), 'sterling-blist-fsmonitor-sentinel-' + randomUUID().slice(0, 8));
  try {
    git(dir, ['config', 'core.fsmonitor', `sh -c 'touch "${sentinelPath}"' --`], { must: true });
    assert.equal(existsSync(sentinelPath), false, 'PRECONDITION: the sentinel does not exist before any gated call runs');

    const L = lane('fsmonitor-injection');
    const pre = h17(dir, 'PreToolUse', L); // exercises the Pre sweep's own git invocation
    assert.notEqual(pre.code, 1, 'a security gate never fails with a non-blocking exit 1 (Pre)');
    assert.equal(pre.code, 0, `Pre on a benign read-only call over a clean tree must ALLOW — the fixture's normal verdict, unchanged by a hostile core.fsmonitor — actual ${pre.code}, stderr: ${oneLine(pre.stderr)}`);

    const r = h17(dir, 'PostToolUse', L); // exercises the Post (A) sweep's own git invocation
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1 (Post)');
    assert.equal(r.code, 0, `Post on the same benign call must ALLOW — the fixture's normal verdict, unchanged by a hostile core.fsmonitor — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);

    assert.equal(
      existsSync(sentinelPath),
      false,
      "THE PIN: neither of H17's own git invocations (Pre sweep, Post (A) sweep) may execute repo-local core.fsmonitor — both must pass -c core.fsmonitor= to every internal git spawn, exactly as the clearer already does (this file's sibling suite, AC-R59)"
    );
    // SABOTAGE: remove `-c core.fsmonitor=` from EITHER of H17's internal git
    // spawns (the Pre snapshot sweep's, or the Post (A) sweep's) — the
    // sentinel assertion flips from false to true.
  } finally {
    if (sentinelPath && existsSync(sentinelPath)) rmSync(sentinelPath, { force: true });
    cleanup();
  }
});
