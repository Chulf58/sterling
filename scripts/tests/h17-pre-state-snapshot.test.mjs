// H17 PRE-STATE SNAPSHOT — decision h17-pre-state-snapshot-closes-false-denial-
// not-the-restore-hole (knowledge_get 7021526c-09b0-4ec2-96eb-fd59cf52c0ad),
// board 0b848342 finding (4). IMPLEMENTED AND SHIPPED as v3.3 (commit b945cf0),
// then hardened by the five review findings pinned at the end of this file — so
// every "today" / "RED today" framing in the per-pin comments below describes
// the PRE-FIX baseline at authoring time, not current state. The whole file is
// green as of the finding-1..5 fix. Authored BLIND to
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
// DEGRADED-LOUD FALLBACK. When this ruling was made, tool_use_id was read by no
// hook in this repo and was attested only in docs/historical/PROBES.md:45 — H17
// reads it now, which is what these pins drove. When it is missing or unusable
// H17 KEEPS the old blanket pre-existing denial AND SAYS SO. A silent fall back
// to a per-run key is a defect, so both halves are pinned — the denial, and the
// message naming the reason. The denial's SOURCE is pinned too, since a fallback
// that denies unconditionally is indistinguishable from one that works: see
// PIN-REVERT-TO-CLEAN-DEGRADED's control arm.
//
// WHERE EACH PIN LIVES, so no behaviour has two homes. THIS FILE holds the
// MECHANISM pins: the four state terms, per-call keying, the byte state's
// digest-over-raw-bytes behaviour, the fail-closed record branches, and the adjudicated
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
// (B) content baseline and the per-run paths-only attribution record. Sparing
// those is what keeps the fail-closed pins honest — deleting the
// attribution record would deny through the ALREADY-pinned "missing attribution
// record" branch (enforcement.test.mjs:1505) and the test would pass without
// ever exercising the new per-path state comparison.
//
// SELECTION IS BY THE (A) STATE RECORD'S OWN NAME, not by subtracting two known
// filenames (2026-08-25, ahead of board 11609d1f). The (B) content baseline is
// being re-keyed PER CALL — the same laundering fix AC14 already applied to
// THIS (A) record — so a SECOND, filename-unpredictable
// `sterling-enforce-<projectTag>-*` temp file will exist per lane, and a
// subtract-the-two-known-names filter would then hand that baseline to
// soleRecordPath / PIN-CORRUPT-RECORD / PIN-RECORD-DIR-NO-CHILDREN /
// PIN-RECORD-PROTO / PIN-RECORD-NO-BYTES-BLOAT as though it were the (A) state
// record — one pin would tamper the wrong file and the rest would fire their
// exactly-one precondition. AC14 names the (A) record exactly
// (`sterling-enforce-<projectTag>-<runId>-call-<hash>.json`), and a per-call
// (B) baseline MUST carry some further distinguishing token because two files
// cannot share one path, so that exact shape is the discriminator.
//
// THE SUBTRACTIVE FORM IS KEPT AS A FALLBACK, deliberately: this helper must
// never return an EMPTY set, which would quietly turn a real pin into a vacuous
// pass. If no temp file matches the AC14 shape, selection degrades to
// "everything except the two per-run files and anything naming itself a
// baseline" — the pre-2026-08-25 behaviour plus that one exclusion.
function recordName(p) {
  return String(p).split(/[\\/]/).pop() ?? '';
}

// does this temp file carry the (A) per-call STATE record's AC14 filename?
// (nit, roster F7: projectTag/runId used to be interpolated UNESCAPED into a
// RegExp — safe for the current hex/UUID-derived fixtures, but a latent trap
// for any future value carrying a regex metacharacter. Plain prefix/suffix
// string comparison plus a hex-only check on the extracted middle segment
// preserves the EXACT prior semantics — ^sterling-enforce-<tag>-<runId>-call-
// [0-9a-f]+\.json$ — without ever feeding projectTag/runId to `new RegExp`.)
function isStateRecord(p, { projectTag, runId }) {
  const name = recordName(p);
  const prefix = `sterling-enforce-${projectTag}-${runId}-call-`;
  const suffix = '.json';
  if (!name.startsWith(prefix) || !name.endsWith(suffix)) return false;
  const middle = name.slice(prefix.length, name.length - suffix.length);
  return middle.length > 0 && /^[0-9a-f]+$/.test(middle);
}

function perCallRecords(fx) {
  const { projectTag, baselinePath, dirtyPath } = fx;
  const all = tempRecords(projectTag);
  const byName = all.filter((p) => isStateRecord(p, fx));
  if (byName.length > 0) return byName;
  return all.filter((p) => p !== baselinePath && p !== dirtyPath && !/baseline/i.test(recordName(p)) && !recordName(p).endsWith('.dirty.json'));
}

// The (B) CONTENT BASELINE record(s) this call's Pre wrote, under EITHER key —
// the legacy per-run path or a per-call-keyed one (board 11609d1f). Lets a pin
// assert "Pre wrote a baseline and it is still there" without also asserting
// that the key is run-scoped, which is the very thing 11609d1f changes.
function baselineRecords(fx) {
  const { projectTag, dirtyPath } = fx;
  return tempRecords(projectTag).filter((p) => p !== dirtyPath && !isStateRecord(p, fx) && !recordName(p).endsWith('.dirty.json'));
}

// The PER-CALL attribution record(s) — the '(A) attribution record' is now
// keyed per call too (board 489554d4 rules the run-keyed name a HIGH defect),
// so a call's own `.dirty.json` no longer has the predictable legacy
// per-run name (`fx.dirtyPath`). Selection is by suffix, excluding the
// legacy per-run path, mirroring the (A) state record / (B) baseline
// selection idiom above.
function attributionRecords(fx) {           // the per-call .dirty.json under this call's key
  const legacy = recordName(fx.dirtyPath);
  return tempRecords(fx.projectTag).filter(p => recordName(p).endsWith('.dirty.json') && recordName(p) !== legacy);
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
// WHAT CARRIES IT — CORRECTED 2026-08-22 FROM MEASUREMENT (two reviews plus the
// conductor's battery; the original note below was a guess and it was wrong).
// THIS PIN DOES NOT ISOLATE THE TYPE TERM. Three redundant terms carry it:
//   * MODE — a regular file here is 0644 and a symlink reports 0777, so the mode
//     term alone denies;
//   * REPRESENTATION MISMATCH — a symlink state carries `target` and no
//     `sha256`, so the file arm compares its digest against undefined;
//   * TYPE — the term the name suggests.
// So deleting TYPE alone is not enough, and the original instruction to "delete
// mode and type together" is ALSO insufficient: you must additionally unify the
// file/symlink representation before this test can go red.
//
// WHAT IT DOES PIN, which is why it stays: the security property — a
// regular-file -> symlink swap with identical followed bytes DENIES — held up by
// three independent terms. That is defense in depth, not hollowness (contrast
// PIN-STAMP-TYPE-GATE-ON-CHANGED-PREDIRT below, whose original name claimed a
// guard no mutation could move).
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
// PIN-UTF8-CHANGED — THE BYTE STATE IS A DIGEST OVER RAW BYTES, NEVER OVER A
// DECODED STRING. (Header corrected 2026-08-22: this pin was authored when the
// representation was base64 bytes; finding 5 replaced that with a whole-file
// raw-byte sha256. The PROPERTY pinned here is unchanged and still correct under
// the digest — only the wording of the representation moved.) The pre-dirty file
// holds INVALID UTF-8. In-window, one invalid byte (0xC3, a truncated 2-byte
// lead) is replaced by a different invalid byte (0xC0, an overlong lead). Both
// decode to exactly one U+FFFD, so the two contents are INDISTINGUISHABLE as
// UTF-8 strings while their raw bytes differ.
//
// EXPECTED FAILURE SHAPE, as authored pre-fix: denied for the wrong reason (the
// blanket pre-existing denial); once PIN-ALLOW's behaviour landed, a
// decoded-string snapshot sees equality and ALLOWS, so `assert.equal(r.code, 2)`
// fires with actual 0. GREEN with the fix in place.
//
// CATCHES SABOTAGE: the digest fed a decoded string instead of the raw buffer
// (`update(readFileSync(abs, 'utf8'))` rather than `update(readFileSync(abs))`)
// — this fixture is what makes that substitution observable at all, since any
// valid-text file hashes identically either way. Also one leg of
// PIN-RECORD-NO-BYTES-BLOAT's dependency: it is part of what forbids reading
// that pin's size budget as a licence to drop byte state entirely.
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
// satisfiable by an always-mismatching representation. (Header corrected
// 2026-08-22 alongside its companion: the representation is now a raw-byte
// sha256, not base64. The property is unchanged.) The same invalid-UTF-8
// pre-dirty file, untouched across the window, must ALLOW: a digest over raw
// bytes is deterministic, so it has to compare EQUAL to itself — including for
// bytes that are not valid text.
//
// EXPECTED FAILURE SHAPE, as authored pre-fix (RED): the blanket pre-existing
// denial fired, so `assert.equal(r.code, 0)` fires with actual 2. GREEN with the
// fix in place.
//
// CATCHES SABOTAGE: equality forced to always-UNEQUAL, and any representation
// that is not stable over non-text bytes (e.g. a digest recomputed over a
// decoded string at Post, where the lossy U+FFFD substitution differs from what
// Pre recorded).
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
// WHAT CARRIES IT — CORRECTED 2026-08-22 FROM MEASUREMENT. THIS PIN DOES NOT
// ISOLATE THE EXISTENCE TERM, for the same reason PIN-TYPE does not isolate
// TYPE: a deletion moves several terms at once — existence, file type, mode, and
// the availability of a digest at all — so any one of them still denies with the
// existence term gone. It goes red under equality forced to always-EQUAL, or
// under those terms removed together.
//
// WHAT IT DOES PIN: the two properties in its name, neither of which any other
// test covers — an in-window deletion of a pre-dirty enforcement path DENIES,
// and it is NOT resurrected (a changed pre-dirty path is never restored). The
// second assertion is the load-bearing one and it is isolated: only a restore
// on this arm can move it.
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
    // The (B) content baseline FOR THIS CALL must still be there, under EITHER
    // key: the legacy per-run filename or the per-call one board 11609d1f
    // introduces. This pin's subject is "Pre wrote a baseline and this branch
    // left it intact", never "the baseline key is run-scoped" — asserting the
    // run-keyed path specifically would pin the very defect 11609d1f corrects.
    assert.ok(
      existsSync(baselinePath) || baselineRecords(fx).length >= 1,
      `the (B) content baseline for this call is deliberately left intact, isolating this branch — none found under either key. Temp files present for this project tag: ${tempRecords(fx.projectTag).map(recordName).join(', ') || '(none)'}`
    );
    assert.ok(existsSync(dirtyPath) || attributionRecords(fx).length >= 1, 'the attribution record for this call is left intact, isolating this branch');

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
// THE CONTROL ARM IS WHAT MAKES THIS PIN MEAN ANYTHING (added 2026-08-22 on an
// external review finding). Without it the pin proves only that a degraded call
// denies in this scenario — and an implementation that denied EVERY call with an
// unusable tool_use_id would pass it identically. That is the same ambiguity
// class as the hollow pin this file already had to replace, and it would be
// sitting on the fix for the CRITICAL fail-closed violation. So the control arm
// runs FIRST, on a CLEAN tree with no pre-dirty enforcement paths at all, and
// must ALLOW. Only an implementation that SOURCES the denial from the RECORDED
// pre-dirty set passes both arms.
//
// EXPECTED FAILURE SHAPE (RED as authored, pre-fix): three independent red
// assertions — the pin arm is ALLOWED (`assert.equal(r.code, 2)` fires with
// actual 0, stderr empty), and `assert.match(r.stderr, /tool_use_id/)` has
// nothing to match.
//
// CATCHES SABOTAGE, one mutation per arm and they point in OPPOSITE directions:
//   * PIN ARM — the degraded blanket denial computed from the CURRENT status
//     instead of the RECORDED pre-dirty set (`if (currentDirty.length &&
//     noUsableId) deny`): the cleaned tree has nothing to deny over, so the pin
//     arm ALLOWS and fires.
//   * CONTROL ARM — the degraded denial made UNCONDITIONAL (`if (noUsableId)
//     deny`, ignoring the recorded set entirely): the clean-tree call is denied
//     and the control fires.
// Neither mutation can satisfy both arms, which is exactly the property the
// single-arm version lacked.
// =========================================================================

test('PIN-REVERT-TO-CLEAN-DEGRADED: degraded mode (unusable tool_use_id) still DENIES when the command cleans EVERY pre-dirty enforcement path — the safety net may not fail open (control: a degraded call on a CLEAN tree ALLOWS)', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const bundle = bundlePath(dir);
    const headBytes = readFileSync(bundle, 'utf8');

    // ---- CONTROL ARM (expected ALLOW): degraded, but NOTHING was pre-dirty.
    // This is what distinguishes "denied because a recorded pre-dirty path was
    // cleaned" from "denied because degraded mode denies everything".
    assert.equal(porcelain(dir), '', 'PRECONDITION: the tree is CLEAN — there is no pre-dirty enforcement path for a denial to be sourced from');
    const cleanCall = { agent_id: 'a1', tool_use_id: '' };
    assert.equal(h17(dir, 'PreToolUse', cleanCall).code, 0);
    const control = h17(dir, 'PostToolUse', cleanCall); // the command writes nothing
    assert.notEqual(control.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(
      control.code,
      0,
      `CONTROL: an unusable tool_use_id is not by itself a denial — with nothing pre-dirty the degraded fallback has nothing to fall back FROM (AC4: clean tree -> allow). If THIS fails, the pin arm below proves nothing, because a blanket "degraded always denies" would pass it too — actual ${control.code}, stderr: ${oneLine(control.stderr)}`
    );

    // ---- PIN ARM: the same degraded shape, but now a pre-dirty enforcement
    // path exists at Pre and the command CLEANS it.
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
// CATCHES SABOTAGE (measured): the gate widened to treat this difference as
// byte-attestable — the out-of-repo bytes are then hashed and attested and this
// test goes red.
// DOES NOT ISOLATE (measured, corrected 2026-08-22): the gate's TYPE term. The
// symlink swap also moves the MODE term (0644 -> 0777), so the gate's MODE check
// still rejects the difference with the type check removed — the same redundancy
// PIN-TYPE has. What this pins is that the gate rejects this CLASS of
// difference, not which term does the rejecting.
// DOES NOT CATCH AT ALL (measured): either stamp-side link guard, alone or
// together. That is the finding this test was renamed for.
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
// CATCHES SABOTAGE — CORRECTED 2026-08-22 FROM MEASUREMENT: the guard that
// actually carries this is the STATE COMPARISON's own missing-children check,
// not the record-loader validation this note originally named. Three redundant
// guards stand behind it, and only the specific `?? {}` reintroduction (a
// directory state read as `pre.children ?? {}` inside the comparison) turns it
// red — the conductor's battery had to remove all three layers before it moved.
// Genuine defense in depth, and the reason this pin is sound rather than hollow:
// the property has no mutation that leaves it green.
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
// CATCHES SABOTAGE — CORRECTED 2026-08-22 FROM MEASUREMENT. What carries this
// is STATE SHAPE VALIDATION, not the lookup's prototype safety: the crafted
// `__proto__` entry's VALUE is a path -> state MAP, which is not a valid state,
// so it is rejected on shape before prototype safety is ever reached.
//
// SO THIS PIN DOES NOT INDEPENDENTLY COVER THE MAP CONSTRUCTION, and the two
// cannot be separated by this fixture — a `__proto__` value shaped like a VALID
// state cannot install a per-path lookup entry, because a state is not a
// path -> state map. Isolating prototype safety would need a different record
// shape than the one this finding describes, so it stays uncovered rather than
// falsely claimed.
//
// WHAT IT DOES PIN, which is the security property finding 4(b) asked for: a
// real pre-dirty path with no OWN record entry cannot resolve a state through
// the prototype and must hit the absent-entry deny. Red under: the state shape
// validation removed AND the lookup built with `Object.assign(map, parsed)` or a
// `map[k] = parsed[k]` loop — both route an own `__proto__` through [[Set]] and
// really do move the map's prototype. (JSON.parse alone creates `__proto__` as
// an own data property and does not pollute, which is why the copy step is the
// mutation that matters.)
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
//
// LOAD-BEARING DEPENDENCY, named because this pin is NOT SAFE ALONE (review
// finding, 2026-08-22): a size bound is satisfied just as well by omitting byte
// state ENTIRELY as by digesting it, so on its own this pin would license
// deleting the bytes term — the opposite of what finding 5 intends. It is safe
// only in company: PIN-LARGE-MIDFILE-FLIP (a whole-file digest, not a prefix)
// and PIN-UTF8-CHANGED (raw bytes, not a decoded string) are what forbid the
// no-bytes-at-all reading. Never move or skip this pin without them; the three
// are one oracle in three parts.
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
// Measured 2026-08-22: it caught a digest truncated to a 64 KiB prefix.
//
// THE OTHER HALF OF PIN-RECORD-NO-BYTES-BLOAT'S DEPENDENCY (stated in both
// directions on a review finding): that pin's size budget is also satisfied by
// omitting byte state entirely, so THIS pin — together with PIN-UTF8-CHANGED —
// is what makes the budget mean "digest the bytes" rather than "drop the bytes".
// Removing either of these two silently converts the size budget into a licence
// to delete the term finding 5 exists to preserve.
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

// #########################################################################
// ##  BOARD 7dd39b85 (HIGH) — CURRENTLY LIVE, TWO PINS BELOW             ##
// #########################################################################
//
// `git status --porcelain` collapses an untracked DIRECTORY to a single entry
// (`?? hooks/newdir/`), so the set Post checks a currently-dirty path against
// for "already dirty at Pre" membership — an EXACT match — never contains the
// directory's CHILDREN, only the directory path itself. When the audited
// command makes a child individually visible to porcelain (`git add -A` is the
// everyday trigger: the child then reports as its own `A  hooks/newdir/a.mjs`
// entry), that child fails the exact-match membership test, is treated as a
// write THIS COMMAND made, and is swept: since it is not in HEAD, the restore
// path DELETES it. Net effect: a conductor's brand-new untracked enforcement-
// surface file is destroyed and the denial blames the agent for it.
//
// Authored BLIND to scripts/hooks/h17-bash-write-sweep.mjs, exactly like every
// pin above — from the board's behaviour statement only, never from hook
// source. Both pins below assert BEHAVIOUR only (survival, byte identity, exit
// code, and that the denial names the offending path) — never HOW the fix
// distinguishes a covered child from a genuinely new one.
// #########################################################################

// =========================================================================
// PIN-CHILD-SURVIVES-STAGE — the core pin plus its CONTROL. A file that
// existed inside a pre-dirty untracked enforcement-surface DIRECTORY must
// SURVIVE the Post sweep — bytes unchanged on disk — even when the audited
// command staged it (`git add -A`) so porcelain now reports it individually
// instead of as part of the collapsed directory entry. The command is still
// DENIED: survival must not be bought by turning the violation into an allow.
//
// CONTROL ARM FIRST (decision cf863d84 — a verdict with more than one possible
// cause needs a control that fails differently, placed first so a green pin
// always carries its evidence): a file created by the SAME audited command
// (create + `git add -A`) inside a directory that was NOT dirty at Pre is a
// genuinely NEW write and must still be swept — restored/removed — and the
// call still denies. Without this arm, "the child survives" in the pin arm
// could be explained by an implementation that simply stopped deleting
// anything under hooks/ at all, which would be a much bigger and unrelated
// hole; the control rules that out, because deletion still happens here, for
// the opposite (correct, unrelated) reason.
//
// EXPECTED FAILURE SHAPE (RED today, PIN ARM only): the child
// `hooks/newdir/a.mjs` does not exact-match the Pre-recorded directory path
// `hooks/newdir/`, so it is swept as a fresh write — `assert.equal(existsSync
// (child), true)` fires with actual false, the file is gone. The CONTROL ARM
// is expected GREEN today: an ordinary new write with no pre-dirty ancestor
// already gets removed and denied correctly, so it does not exercise this
// defect.
//
// SABOTAGE (one line at a time, each must flip the named assertion to RED):
//   * CORE PIN (survival) — the ancestor-coverage check for a currently-dirty
//     path deleted or short-circuited, i.e. reverting to a bare
//     `recordedPreDirty.has(path)` exact-match test with no "is this path
//     inside a recorded pre-dirty directory's recorded children" fallback: the
//     child then fails membership again and is deleted — both
//     `assert.equal(existsSync(child), true)` and the byte-identical assertion
//     fire.
//   * DENIAL — the fix implemented by exempting the child from the
//     enforcement-surface check entirely instead of recognizing it as
//     pre-dirty (allow instead of deny): `assert.equal(r.code, 2)` fires with
//     actual 0.
//   * CONTROL — the ancestor-coverage check widened to match ANY
//     currently-dirty path regardless of a recorded ancestor (i.e. "assume
//     pre-dirty unless proven otherwise"): the control's genuinely-new file
//     then survives too, and `assert.equal(existsSync(freshFile), false)`
//     fires with actual true.
// =========================================================================

test('PIN-CHILD-SURVIVES-STAGE: a file inside a pre-dirty untracked enforcement-surface directory survives `git add -A` staging it individually — denies, but does not destroy it (control: a same-shaped file under a directory NOT pre-dirty is genuinely new and is still removed)', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    // ---- CONTROL ARM (expected: denied AND removed — the ordinary, correct
    // behaviour for a genuinely new write with no pre-dirty ancestor).
    assert.equal(porcelain(dir), '', 'PRECONDITION: the tree is CLEAN — the control directory does not exist yet at Pre');
    const C = lane('childcontrol');
    assert.equal(h17(dir, 'PreToolUse', C).code, 0);

    const controlDir = join(dir, 'hooks', 'control-new');
    mkdirSync(controlDir, { recursive: true });
    const freshFile = join(controlDir, 'fresh.mjs');
    writeFileSync(freshFile, "// genuinely new, created inside this command's own window\n");
    git(dir, ['add', '-A'], { must: true });
    assert.match(porcelain(dir), /A\s+hooks\/control-new\/fresh\.mjs/, 'PRECONDITION: staging makes the new file individually visible, same as the pin arm below');

    const control = h17(dir, 'PostToolUse', C);
    assert.notEqual(control.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(
      control.code,
      2,
      `CONTROL: a genuinely new enforcement-surface write must still deny — if THIS fails, the pin arm below proves nothing, because nothing would distinguish a working sweep from one that simply stopped deleting anything under hooks/ — actual ${control.code}, stderr: ${oneLine(control.stderr)}`
    );
    assert.equal(existsSync(freshFile), false, 'CONTROL: and it is genuinely new (no pre-dirty ancestor), so it is swept — removed, since it is not in HEAD');

    // ---- PIN ARM: the child was ALREADY THERE, inside a directory that was
    // already dirty (untracked) at Pre — only staging makes it individually
    // visible to porcelain.
    const newDir = join(dir, 'hooks', 'newdir');
    mkdirSync(newDir, { recursive: true });
    const child = join(newDir, 'a.mjs');
    const childBytes = '// pre-dirty untracked enforcement-surface file, uncommitted\n';
    writeFileSync(child, childBytes);
    assert.match(porcelain(dir), /\?\?\s+hooks\/newdir\//, 'PRECONDITION: the untracked directory collapses to ONE entry at Pre, exactly as the defect describes');

    const P = lane('childpin');
    assert.equal(h17(dir, 'PreToolUse', P).code, 0);

    git(dir, ['add', '-A'], { must: true });
    assert.match(porcelain(dir), /A\s+hooks\/newdir\/a\.mjs/, 'PRECONDITION: staging inside the window makes the child its OWN porcelain entry — the everyday trigger named in the defect');

    const r = h17(dir, 'PostToolUse', P);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(
      r.code,
      2,
      `staging a pre-dirty untracked enforcement-surface path is still a violation and must deny — survival must not be bought by turning this into an allow — actual ${r.code}, stderr: ${oneLine(r.stderr)}`
    );
    assert.match(r.stderr, /newdir/, 'the denial names the offending enforcement-surface path');
    assert.equal(
      existsSync(child),
      true,
      `THE PIN: a file that existed inside a pre-dirty untracked directory before this command ran must survive being staged — actual: file is gone, stderr: ${oneLine(r.stderr)}`
    );
    assert.equal(readFileSync(child, 'utf8'), childBytes, 'and its bytes are byte-identical — untouched by the sweep');
  } finally {
    cleanup();
  }
});

// =========================================================================
// PIN-CHILD-SURVIVES-STAGE-NESTED — the same defect, TWO LEVELS below the
// recorded directory (`hooks/newdir/sub/deep.mjs`). The board's account of the
// defect names the recorded directory state as a RECURSIVE children map
// (PIN-RECORD-DIR-NO-CHILDREN above establishes that Pre records one for a
// dirty untracked directory); a fix that only recognizes a DIRECT child of the
// recorded path — checking one level of nesting rather than walking the
// recursive map — would pass PIN-CHILD-SURVIVES-STAGE above while still
// destroying a grandchild.
//
// Relies on PIN-CHILD-SURVIVES-STAGE's control arm for the opposite-cause
// evidence (a genuinely new write with no pre-dirty ancestor is still removed
// and denied) — that property does not change with nesting depth, so it is not
// re-proven here.
//
// EXPECTED FAILURE SHAPE (RED today): identical in shape to
// PIN-CHILD-SURVIVES-STAGE — `hooks/newdir/sub/deep.mjs` does not exact-match
// the Pre-recorded `hooks/newdir/` entry, so `assert.equal(existsSync(deep),
// true)` fires with actual false.
//
// SABOTAGE: an ancestor-coverage fix that only checks ONE level of nesting
// (e.g. comparing the path's immediate parent directory against the recorded
// set instead of walking up through every ancestor to it) — `hooks/newdir/sub/
// deep.mjs`'s immediate parent is `hooks/newdir/sub`, which is itself
// unrecorded, so the shallow check still fails membership and the file is
// still deleted, flipping both the existence and byte-identical assertions to
// red.
// =========================================================================

test('PIN-CHILD-SURVIVES-STAGE-NESTED: a GRANDCHILD two levels below a pre-dirty untracked enforcement-surface directory survives `git add -A` staging it individually — denies, but does not destroy it', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const newDir = join(dir, 'hooks', 'newdir', 'sub');
    mkdirSync(newDir, { recursive: true });
    const deep = join(newDir, 'deep.mjs');
    const deepBytes = '// pre-dirty untracked enforcement-surface file, two levels deep, uncommitted\n';
    writeFileSync(deep, deepBytes);
    assert.match(porcelain(dir), /\?\?\s+hooks\/newdir\//, 'PRECONDITION: the untracked directory collapses to ONE entry at Pre, exactly as the defect describes, regardless of how deep its contents nest');

    const P = lane('grandchildpin');
    assert.equal(h17(dir, 'PreToolUse', P).code, 0);

    git(dir, ['add', '-A'], { must: true });
    assert.match(porcelain(dir), /A\s+hooks\/newdir\/sub\/deep\.mjs/, 'PRECONDITION: staging inside the window makes the grandchild its OWN porcelain entry');

    const r = h17(dir, 'PostToolUse', P);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(
      r.code,
      2,
      `staging a pre-dirty untracked enforcement-surface path is still a violation and must deny — actual ${r.code}, stderr: ${oneLine(r.stderr)}`
    );
    assert.match(r.stderr, /newdir/, 'the denial names the offending enforcement-surface path');
    assert.equal(
      existsSync(deep),
      true,
      `THE PIN: a file two levels below a pre-dirty untracked directory must survive being staged — a fix that only recognizes DIRECT children would still delete this one — actual: file is gone, stderr: ${oneLine(r.stderr)}`
    );
    assert.equal(readFileSync(deep, 'utf8'), deepBytes, 'and its bytes are byte-identical — untouched by the sweep');
  } finally {
    cleanup();
  }
});

// =========================================================================
// PIN-SIBLING-PREFIX-NOT-COVERED — the over-broad-coverage hazard that
// PIN-CHILD-SURVIVES-STAGE and PIN-CHILD-SURVIVES-STAGE-NESTED do not pin.
// Those two pin that a covered CHILD survives; neither can distinguish a
// correct ancestor-boundary walk from a raw string-prefix test, because for
// them the recorded directory (`hooks/newdir`) and the covered path
// (`hooks/newdir/a.mjs`) share a '/' boundary either way containment is
// computed. This pin forces the two approaches apart: a SIBLING directory
// whose name merely starts with the recorded directory's name as a STRING —
// `hooks/newdir2/` — must NOT be treated as covered by `hooks/newdir`'s
// pre-dirty record, even though `'hooks/newdir2/x.mjs'.startsWith
// ('hooks/newdir')` is true. Coverage must be computed by walking ancestors
// on '/' boundaries, never by a bare prefix test.
//
// Both arms run in the SAME command window against the SAME pre-dirty
// record, so one verdict cannot be explained by "the coverage check broke"
// (that would also fail the covered-child arm) or by "the coverage check now
// covers everything" (that would also pass the sibling arm) — only a
// boundary-correct walk satisfies both at once (decision cf863d84: a verdict
// with more than one possible cause needs a control arm that fails the
// opposite way, so a green pin always carries its evidence).
//
// EXPECTED (today): GREEN. The ancestor-aware fix for board 7dd39b85 already
// walks on '/' boundaries, so the sibling is correctly seen as UNCOVERED and
// swept, while the recorded directory's own child survives in the same run.
// This pin guards against a REGRESSION back to string-prefix matching — it
// is not chasing a live defect, and it should not be weakened if it passes.
//
// SABOTAGE: replace the ancestor-boundary walk with a bare
// `rel.startsWith(candidate)` containment test. Under that sabotage,
// `'hooks/newdir2/x.mjs'.startsWith('hooks/newdir')` is true, so the sibling
// file is wrongly treated as already covered by the pre-dirty record and
// SURVIVES the sweep — `assert.equal(existsSync(sibFile), false)` fires with
// actual true. (The covered-child arm stays green either way under this
// sabotage, which is exactly why neither existing sibling pin can catch it.)
// =========================================================================

test('PIN-SIBLING-PREFIX-NOT-COVERED: a NEW sibling directory whose name string-prefixes a pre-dirty untracked enforcement-surface directory is NOT covered by it — denies, and the sibling is swept while the recorded directory\'s own child survives in the same run', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const newDir = join(dir, 'hooks', 'newdir');
    mkdirSync(newDir, { recursive: true });
    const child = join(newDir, 'a.mjs');
    const childBytes = '// pre-dirty untracked enforcement-surface file, uncommitted\n';
    writeFileSync(child, childBytes);
    assert.match(porcelain(dir), /\?\?\s+hooks\/newdir\//, 'PRECONDITION: the untracked directory collapses to ONE entry at Pre, exactly as the defect describes');

    const L = lane('siblingprefix');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0);

    const sibDir = join(dir, 'hooks', 'newdir2');
    mkdirSync(sibDir, { recursive: true });
    const sibFile = join(sibDir, 'x.mjs');
    writeFileSync(sibFile, "// genuinely new sibling directory whose name merely starts with the recorded one\n");
    git(dir, ['add', '-A'], { must: true });
    assert.match(porcelain(dir), /A\s+hooks\/newdir2\/x\.mjs/, 'PRECONDITION: staging makes the sibling file individually visible to porcelain');
    assert.match(porcelain(dir), /A\s+hooks\/newdir\/a\.mjs/, 'PRECONDITION: the recorded directory\'s own child is ALSO staged, in the same window, against the same record');

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(
      r.code,
      2,
      `a window containing a genuinely new enforcement-surface write must deny — actual ${r.code}, stderr: ${oneLine(r.stderr)}`
    );
    assert.equal(
      existsSync(sibFile),
      false,
      `THE PIN: a sibling directory sharing only a STRING PREFIX with a recorded pre-dirty directory is NOT covered by it — it is genuinely new and must still be swept — actual: file survived, stderr: ${oneLine(r.stderr)}`
    );
    assert.equal(existsSync(child), true, "CONTROL: the recorded directory's own child still survives in the same run — the coverage check did not simply stop working, it correctly declined to extend across a sibling boundary");
    assert.equal(readFileSync(child, 'utf8'), childBytes, 'and its bytes are byte-identical — untouched by the sweep');
  } finally {
    cleanup();
  }
});

// #########################################################################
// ##  TWO REVIEW FINDINGS ON THE ANCESTOR-AWARE COVERAGE FIX ABOVE       ##
// #########################################################################
//
// Two independent reviews of the ancestor-aware coverage change (the fix
// behind PIN-CHILD-SURVIVES-STAGE / -NESTED / PIN-SIBLING-PREFIX-NOT-COVERED)
// each found one behaviour the three pins above never exercise, because all
// three create the child BEFORE Pre — so the child is always PRESENT in the
// recorded directory's `children` map. Both pins below are authored BLIND to
// scripts/hooks/h17-bash-write-sweep.mjs, exactly like every pin above.
// #########################################################################

// =========================================================================
// PIN-CHILD-ABSENT-FROM-RECORD — the RECORDED-ABSENT branch, the load-bearing
// correction of the whole ancestor-aware change and, until this pin, never
// executed by any test in this file. The settled rule: a path covered by a
// recorded pre-dirty ANCESTOR but ABSENT from that ancestor's recorded
// `children` map is DENIED and NOT restored. It must not be deleted, because
// "absent from the map" does not prove "the audited command created it" — the
// Pre snapshot is recursive but not atomic, and the record is agent-writable,
// so an absent entry is inconclusive, not damning.
//
// FIXTURE: at Pre, `hooks/newdir/a.mjs` exists (untracked directory, porcelain
// collapses it to one `?? hooks/newdir/` entry — same trigger as
// PIN-CHILD-SURVIVES-STAGE, so `a.mjs` IS in the recorded children map).
// INSIDE the audited command's window, a SECOND file `hooks/newdir/b.mjs` is
// created — it did not exist at Pre and is therefore structurally absent from
// whatever children map Pre recorded — then both are staged with `git add -A`
// in the same window, against the same record.
//
// CONTROL ARM: `a.mjs` (recorded, present in the children map) must ALSO
// survive, byte-identical, in the SAME run. Without it, "b.mjs survives" could
// be explained by an implementation that stopped restoring/deleting anything
// under a pre-dirty directory at all — a much bigger, unrelated hole distinct
// from the recorded-absent rule this pin targets. `a.mjs` surviving because it
// is a RECOGNIZED covered child, and `b.mjs` surviving because it is an
// UNRECOGNIZED-but-not-provably-new child, are two different reasons landing
// on the same observable outcome, and the control is what keeps them apart.
//
// EXPECTED TODAY: GREEN — the implemented code already takes the correct
// branch here (this is a correction that has already shipped; the pin exists
// to guard it against being undone, not to chase a live defect). Do not
// expect or try to make this test red.
//
// CATCHES SABOTAGE: recordedChild absent falling through to the destructive
// arm instead of the deny-only arm — concretely,
//   if (!recordedChild) { restoreTracked(cwd, p); violations.push(rel); restoredPaths.push(rel); continue; }
// in place of a deny-without-restore branch. That is the most destructive
// edit reachable in this change (it deletes a file the record never proved
// was new), and today the entire rest of the suite stays green under it —
// only this pin's `existsSync(b) === true` assertion catches it, flipping to
// actual `false`.
// =========================================================================

test('PIN-CHILD-ABSENT-FROM-RECORD: a file created IN-WINDOW under a pre-dirty untracked enforcement-surface directory, ABSENT from the recorded children map, DENIES and is NOT restored — while its sibling recorded at Pre survives untouched in the same run', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const newDir = join(dir, 'hooks', 'newdir');
    mkdirSync(newDir, { recursive: true });
    const a = join(newDir, 'a.mjs');
    const aBytes = '// pre-dirty untracked enforcement-surface file, present at Pre, uncommitted\n';
    writeFileSync(a, aBytes);
    assert.match(porcelain(dir), /\?\?\s+hooks\/newdir\//, 'PRECONDITION: the untracked directory collapses to ONE entry at Pre, exactly as the defect describes');

    const L = lane('recordabsent');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0);

    // INSIDE the audited command's window: a second file that did NOT exist at
    // Pre and is therefore absent from whatever children map Pre recorded for
    // hooks/newdir.
    const b = join(newDir, 'b.mjs');
    const bBytes = "// created inside this command's own window, absent from the recorded children map\n";
    writeFileSync(b, bBytes);
    git(dir, ['add', '-A'], { must: true });
    assert.match(porcelain(dir), /A\s+hooks\/newdir\/a\.mjs/, 'PRECONDITION: a.mjs (recorded at Pre) is staged, individually visible to porcelain');
    assert.match(porcelain(dir), /A\s+hooks\/newdir\/b\.mjs/, 'PRECONDITION: b.mjs (created after Pre) is staged, individually visible to porcelain, and cannot be in the recorded children map');

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(
      r.code,
      2,
      `a window containing a path absent from the recorded children map is still a violation and must deny — actual ${r.code}, stderr: ${oneLine(r.stderr)}`
    );

    assert.equal(existsSync(a), true, "CONTROL: the sibling that WAS recorded at Pre still survives in the same run — a recognized covered child is not the thing this pin is testing");
    assert.equal(readFileSync(a, 'utf8'), aBytes, 'and its bytes are byte-identical — untouched by the sweep');

    assert.equal(
      existsSync(b),
      true,
      `THE PIN: a child absent from the recorded children map must NOT be deleted — absence does not prove the audited command created it (the Pre snapshot is recursive but not atomic, and the record is agent-writable) — actual: file is gone, stderr: ${oneLine(r.stderr)}`
    );
    assert.equal(readFileSync(b, 'utf8'), bBytes, 'and its bytes are byte-identical — untouched by the sweep');
  } finally {
    cleanup();
  }
});

// Blind-safe tamper helper for PIN-RECORD-KEY-TRAILING-SLASH below. Mirrors
// stripChildren's assume-nothing-about-shape idiom: it does not assume whether
// a recorded pre-dirty path is stored as an object KEY (a path -> state/info
// map) or as a plain STRING entry in an array (a flat list) — it rewrites
// `target` to a trailing-slash variant wherever it finds it, in either shape,
// anywhere in the tree, and reports how many occurrences it changed so the
// caller can assert the tamper was unambiguous.
//
// Generalized (2026-08-23, additively, for PIN-RECORD-MALFORMED-ENTRY-
// REFUSED-AT-LOAD below) with an optional third `replacement` argument so the
// SAME walk can be reused for a different malformed shape instead of a second
// near-duplicate helper. Backward-compatible: every existing 2-arg call site
// (PIN-RECORD-KEY-TRAILING-SLASH) is untouched and computes the identical
// trailing-slash `withSlash` value it always did, since `replacement` is
// `undefined` there.
function addTrailingSlash(node, target, replacement) {
  const withSlash = replacement !== undefined ? replacement : target.endsWith('/') ? target : target + '/';
  let hits = 0;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      if (node[i] === target) {
        node[i] = withSlash;
        hits += 1;
      } else {
        hits += addTrailingSlash(node[i], target, replacement);
      }
    }
    return hits;
  }
  if (node && typeof node === 'object') {
    if (Object.prototype.hasOwnProperty.call(node, target)) {
      node[withSlash] = node[target];
      delete node[target];
      hits += 1;
    }
    for (const v of Object.values(node)) hits += addTrailingSlash(v, target, replacement);
    return hits;
  }
  return 0;
}

// =========================================================================
// PIN-RECORD-KEY-TRAILING-SLASH — the second review finding: the per-run
// attribution record (`sterling-enforce-<projectTag>-<runId>.dirty.json`,
// `dirtyPath` in this harness — the same file PIN-NO-RECORD names "the per-run
// attribution record") is JSON written to the OS temp dir and is
// agent-writable; UNLIKE the per-call snapshot record, its entries are not
// normalized. Normal Pre output strips trailing slashes, but an entry that
// reads `hooks/newdir/` instead of `hooks/newdir` must still cover
// `hooks/newdir/a.mjs` exactly as the bare form does — a recorded ancestor
// naming the same directory with or without a trailing slash is the SAME
// directory, and ancestor-walk coverage must not be defeated by a stray
// slash written (by hand or by a future code path) into an agent-writable
// file.
//
// The tamper is applied directly to the attribution record between Pre and
// Post via the blind-safe `addTrailingSlash` helper above, mirroring
// PIN-RECORD-DIR-NO-CHILDREN's `soleRecordPath` + JSON.parse/stringify idiom
// for reaching a temp record from this harness — the established prior art in
// this file for tampering a record without assuming its shape.
//
// EXPECTED TODAY: RED. The trailing-slash normalization on the attribution
// record's ancestor key is not implemented yet — a bare-string ancestor
// lookup does not match `hooks/newdir/` against the query path
// `hooks/newdir/a.mjs`'s ancestor `hooks/newdir`, so the child is treated as
// UNCOVERED and swept: `assert.equal(existsSync(child), true)` fires with
// actual `false`. (The exit-code assertion is expected green even today,
// since an uncovered child still denies — via the same "genuinely new write"
// path PIN-CHILD-SURVIVES-STAGE's control arm exercises — for the wrong
// reason.)
//
// CATCHES SABOTAGE (once the normalization lands): the trailing-slash strip
// removed from the ancestor-key comparison — e.g. comparing a candidate
// ancestor key against a currently-dirty path's ancestor directly instead of
// via `key.replace(/\/+$/, '')` (or equivalent) on the recorded side. Under
// that sabotage this test reverts to today's failure: `existsSync(child)`
// fires with actual `false` again.
// =========================================================================

test('PIN-RECORD-KEY-TRAILING-SLASH: a recorded pre-dirty ancestor keyed WITH a trailing slash in the (agent-writable, unnormalized) attribution record still covers its child exactly as the bare form does', { skip: GIT_SKIP }, () => {
  const fx = makeGitProject();
  const { dir, cleanup, dirtyPath } = fx;
  try {
    const newDir = join(dir, 'hooks', 'newdir');
    mkdirSync(newDir, { recursive: true });
    const child = join(newDir, 'a.mjs');
    const childBytes = '// pre-dirty untracked enforcement-surface file, uncommitted\n';
    writeFileSync(child, childBytes);
    assert.match(porcelain(dir), /\?\?\s+hooks\/newdir\//, 'PRECONDITION: the untracked directory collapses to ONE entry at Pre, exactly as the defect describes');

    const L = lane('trailingslash');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0);

    const [attrPath] = attributionRecords(fx);
    assert.ok(attrPath, 'PRECONDITION: the per-call attribution record exists after Pre');
    const parsed = JSON.parse(readFileSync(attrPath, 'utf8'));
    const hits = addTrailingSlash(parsed, 'hooks/newdir');
    assert.ok(
      hits >= 1,
      'PRECONDITION: the attribution record must record the recorded directory path in its normal (no trailing slash) form for this tamper to be unambiguous — if this fails, the fixture is not exercising the defect'
    );
    writeFileSync(attrPath, JSON.stringify(parsed));

    git(dir, ['add', '-A'], { must: true });
    assert.match(porcelain(dir), /A\s+hooks\/newdir\/a\.mjs/, 'PRECONDITION: staging makes the child its own porcelain entry, the same trigger as PIN-CHILD-SURVIVES-STAGE');

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(
      r.code,
      2,
      `staging a pre-dirty untracked enforcement-surface path is still a violation and must deny — actual ${r.code}, stderr: ${oneLine(r.stderr)}`
    );
    assert.equal(
      existsSync(child),
      true,
      `THE PIN: an attribution-record entry naming the recorded directory WITH a trailing slash ('hooks/newdir/') must cover its child exactly as the bare form ('hooks/newdir') does — actual: file is gone, stderr: ${oneLine(r.stderr)}`
    );
    assert.equal(readFileSync(child, 'utf8'), childBytes, 'and its bytes are byte-identical — untouched by the sweep');
  } finally {
    cleanup();
  }
});

// =========================================================================
// PIN-RECORD-MALFORMED-ENTRY-REFUSED-AT-LOAD — an outside-review gap in the
// same loader PIN-RECORD-KEY-TRAILING-SLASH exercises. That loader was just
// hardened to strip trailing slashes and to refuse a non-array record or a
// non-string/empty entry — but a MALFORMED, non-empty, non-trailing-slash path
// shape survives it uncaught. `hooks/newdir/.` is exactly such a shape: it
// passes "non-array? no. non-string-or-empty entry? no." and comes out the
// other side unchanged, because trailing-slash stripping never touches a
// trailing `.` segment.
//
// WHY THIS IS DANGEROUS, NOT MERELY WRONG: the surviving-but-mangled entry no
// longer string-equals (nor ancestor-matches) the `hooks/newdir` ancestor the
// ancestor-walk coverage check builds from the CURRENTLY-dirty path
// `hooks/newdir/a.mjs`. So the recorded pre-dirty directory silently loses its
// child's protection: the coverage walk visits `a.mjs`, finds no matching
// recorded ancestor, treats it as clean-at-Pre / genuinely new (the same
// "otherwise" path PIN-CHILD-SURVIVES-STAGE's CONTROL arm exercises), and it
// is swept — DELETED — because it is (wrongly) not believed to predate this
// command. Only afterward, when the sweep also notices the record entry
// itself doesn't correspond to anything it can use, does any denial fire —
// by which point the file is already gone. A deny that arrives after the
// delete is not the same claim as a deny that PREVENTS the delete, and this
// pin is written to tell the two apart: EXIT CODE ALONE PROVES NOTHING HERE.
//
// THE RULE THIS PINS: a malformed attribution-record entry must be REFUSED AT
// LOAD — before the sweep walks anything, and therefore before anything can be
// restored/deleted — never silently treated as "no coverage here, carry on".
//
// FIXTURE: identical setup to PIN-RECORD-KEY-TRAILING-SLASH — `hooks/newdir/
// a.mjs` is written BEFORE Pre so the untracked directory collapses to one `??
// hooks/newdir/` porcelain entry and Pre records `hooks/newdir` (bare, no
// trailing slash) as a pre-dirty ancestor with `a.mjs` in its children. Between
// Pre and Post, the per-run attribution record (`dirtyPath`) is tampered
// in-place via the SAME blind-safe `addTrailingSlash` walk PIN-RECORD-KEY-
// TRAILING-SLASH already established — reused here with its new optional
// third argument to rewrite the `hooks/newdir` entry to the malformed
// `hooks/newdir/.` instead of a second near-duplicate walker. The `hits >= 1`
// precondition is kept for the same reason it is kept there: an
// unrecognized record shape would make this tamper silently a no-op, and the
// pin must fail loudly on THAT rather than pass for the wrong reason. The
// child is then staged with `git add -A` in the same window, exactly the
// everyday trigger PIN-CHILD-SURVIVES-STAGE names.
//
// EXPECTED TODAY: RED. The validation this pins is not implemented yet (I am
// told it is being implemented in parallel and may be green by the time this
// runs — the prediction below is for the state at authoring time and is not
// weakened either way). Concretely:
//   * `hooks/newdir/.` does not match `hooks/newdir` as a recorded ancestor of
//     `hooks/newdir/a.mjs` (no trailing-`.`-segment normalization exists), so
//     the child is treated as an uncovered/genuinely-new write and deleted by
//     the sweep BEFORE any refusal — `assert.equal(existsSync(child), true)`
//     is the assertion that fires, with actual `false`.
//   * the exit-code assertions (`r.code === 2`, `r.code !== 1`) are expected
//     GREEN even today, since an uncovered child still denies via the same
//     "genuinely new write" path — exactly the trap the background for this
//     pin warns about: a deny alone proves nothing, because today's deny
//     lands AFTER the delete, not instead of it.
//   * the stderr content match (`/crafted|attribution record/i`) is expected
//     RED today too: today's denial explains a new/unrecognized write, not a
//     rejected record entry, so it is not expected to use either word.
// Once the load-time validation lands, all four assertions are expected
// GREEN: the malformed entry is refused before the sweep runs, so the sweep
// never reaches (and never deletes) the child, and the refusal names the
// crafted entry.
//
// CATCHES SABOTAGE: relaxing the per-entry validation back to "non-empty
// string after stripping trailing slashes" (i.e. accepting anything that
// survives a bare `.replace(/\/+$/, '')` and an empty-string check) — under
// that relaxed rule `hooks/newdir/.` is still non-empty after stripping
// trailing slashes (there are none to strip) and so passes the loader again,
// exactly reproducing today's failure: the child is deleted and
// `assert.equal(existsSync(child), true)` flips back to actual `false`.
// =========================================================================

test('PIN-RECORD-MALFORMED-ENTRY-REFUSED-AT-LOAD: a malformed non-empty attribution-record entry (`hooks/newdir/.`) is REFUSED AT LOAD, before the sweep runs — the child is never reached, let alone deleted', { skip: GIT_SKIP }, () => {
  const fx = makeGitProject();
  const { dir, cleanup, dirtyPath } = fx;
  try {
    const newDir = join(dir, 'hooks', 'newdir');
    mkdirSync(newDir, { recursive: true });
    const child = join(newDir, 'a.mjs');
    const childBytes = '// pre-dirty untracked enforcement-surface file, uncommitted\n';
    writeFileSync(child, childBytes);
    assert.match(porcelain(dir), /\?\?\s+hooks\/newdir\//, 'PRECONDITION: the untracked directory collapses to ONE entry at Pre, exactly as the defect describes');

    const L = lane('malformedentry');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0);

    const [attrPath] = attributionRecords(fx);
    assert.ok(attrPath, 'PRECONDITION: the per-call attribution record exists after Pre');
    const parsed = JSON.parse(readFileSync(attrPath, 'utf8'));
    const hits = addTrailingSlash(parsed, 'hooks/newdir', 'hooks/newdir/.');
    assert.ok(
      hits >= 1,
      'PRECONDITION: the attribution record must record the recorded directory path in its normal (no trailing slash) form for this tamper to be unambiguous — if this fails, the fixture is not exercising the defect, and the pin would otherwise pass for the wrong reason'
    );
    writeFileSync(attrPath, JSON.stringify(parsed));

    git(dir, ['add', '-A'], { must: true });
    assert.match(porcelain(dir), /A\s+hooks\/newdir\/a\.mjs/, 'PRECONDITION: staging makes the child its own porcelain entry, the same trigger as PIN-CHILD-SURVIVES-STAGE and PIN-RECORD-KEY-TRAILING-SLASH');

    const r = h17(dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(
      r.code,
      2,
      `a malformed attribution-record entry must deny — actual ${r.code}, stderr: ${oneLine(r.stderr)}`
    );
    assert.match(
      r.stderr,
      /crafted|attribution record/i,
      `the refusal must name the malformed attribution-record entry, not merely deny for an unrelated reason — stderr: ${oneLine(r.stderr)}`
    );
    assert.equal(
      existsSync(child),
      true,
      `THE PIN: a malformed record entry must be refused AT LOAD, before the sweep runs — it must never silently withdraw the recorded directory's coverage and let the sweep delete its child first — actual: file is gone, stderr: ${oneLine(r.stderr)}`
    );
    assert.equal(readFileSync(child, 'utf8'), childBytes, 'and its bytes are byte-identical — untouched, because the sweep must never have reached it');
  } finally {
    cleanup();
  }
});

// #########################################################################
// ##  H17 v3.4 SLICE B HARDENING — board 1f4b7af0 items 2 & 3, board       ##
// ##  7675ebbc. Authored BLIND to                                          ##
// ##  scripts/hooks/h17-bash-write-sweep.mjs, exactly like every pin       ##
// ##  above — built from the store's account of the two board items and   ##
// ##  the h17-bash-write-sweep article (AC12/AC13/AC14), never from hook   ##
// ##  source.                                                              ##
// #########################################################################

// append `entry` into the per-call attribution record's dirty-path array
// (board 1f4b7af0 item 2 describes it as `new Set(JSON.parse(...))` — a flat
// JSON array of path strings) — mirrors PIN-RECORD-KEY-TRAILING-SLASH's
// established idiom for tampering this same record.
function appendAttributionEntry(fx, entry) {
  const [attrPath] = attributionRecords(fx);
  assert.ok(attrPath, 'PRECONDITION: the per-call attribution record exists after Pre');
  const parsed = JSON.parse(readFileSync(attrPath, 'utf8'));
  assert.ok(Array.isArray(parsed), 'PRECONDITION: the attribution record is a flat array of recorded pre-dirty paths (per 1f4b7af0\'s own account: new Set(JSON.parse(...)))');
  parsed.push(entry);
  writeFileSync(attrPath, JSON.stringify(parsed));
}

// add a `path -> state` entry into the per-call STATE record (a JSON OBJECT
// mapping path to state, per the coder's corrected fixture — the shape
// perCallRecords/soleRecordPath already resolve) — the state-record
// analogue of appendAttributionEntry above, used to make an attribution-array
// key PRESENT-AND-CONSISTENT in both records so it does not trip the
// separate attribution/state "disagree" deny-cause.
function addStateEntry(fx, path, state) {
  const rec = soleRecordPath(fx, `adding a consistent state entry for ${path}`);
  const parsed = JSON.parse(readFileSync(rec, 'utf8'));
  parsed[path] = state;
  writeFileSync(rec, JSON.stringify(parsed));
}

// =========================================================================
// PIN-RECORD-KEY-VALIDATION-CRAFTED — 1f4b7af0 item 2, REWRITTEN per
// coordinator/coder correction (the first draft's control was hollow). Two
// record shapes are load-bearing here, and getting them wrong is what broke
// it:
//   * the ATTRIBUTION record ('-call-<hash>.dirty.json', found via
//     attributionRecords(fx)) is a JSON ARRAY of repo-relative path strings.
//   * the per-call STATE record ('-call-<hash>.json', found via
//     perCallRecords(fx)/soleRecordPath(fx, why)) is a JSON OBJECT mapping
//     path -> state.
// A path present in the attribution array but ABSENT from (or disagreeing
// with) the state object trips a SEPARATE "disagree" deny-cause. A pure
// exit-code assertion cannot isolate validateStateKey from that second
// cause: a crafted key that survived loading UNCHECKED would still be
// denied — via disagreement, not via key validation — the instant it lacks
// a matching state entry, so the pin would read green even with Fix 1
// deleted. That is exactly what happened to the first draft's control
// ('foo\bar' appended to the attribution array ONLY, no matching state
// entry): it tripped the disagreement deny, for a reason that has nothing
// to do with key validation.
//
// THE FIX: make the CONTROL key PRESENT-AND-CONSISTENT in BOTH records —
// appended to the attribution array AND given a matching state entry, using
// the simplest valid state, absent-state `{"exists": false, "index": null}`,
// with the path genuinely absent on disk so the live-computed state at Post
// agrees with the recorded one (unchanged -> allow, no disagreement, no key
// violation). The two CRAFTED arms then add ONLY the malformed key to the
// attribution array — the state record is never touched — so any deny they
// draw is attributable to the key's shape alone, never to a manufactured
// mismatch.
//
// WHY ONLY TWO CRAFTED SHAPES (`C:/x`, a literal-NUL `data\u0000.txt`) AND
// NOT THE FIRST DRAFT'S FOUR: `/etc/passwd` (absolute) and
// `hooks/x/../../../etc/passwd` (root-escaping) are caught by a
// PRE-EXISTING malformed-segment check — the same one
// PIN-RECORD-MALFORMED-ENTRY-REFUSED-AT-LOAD already pins for
// `hooks/newdir/.` — so denying on those two would prove nothing new about
// Fix 1 specifically; they do not isolate it. The two kept here are denied
// ONLY by validateStateKey.
//
// THE ANTI-HOLLOW ANCHOR: each crafted arm additionally asserts stderr does
// NOT match /disagree/i. Without this negative assertion, a Fix-1-less
// build could still deny the crafted arm via the disagreement path (the key
// has no state entry) and the "crafted attribution record entry" + phrase
// matches could still coincidentally hold — the /disagree/i negative is
// what pins the deny to validateStateKey specifically rather than to the
// second deny-cause.
//
// THE NUL-ARM PHRASE IS A DISCLOSED BEST-GUESS, not confirmed by execution:
// this test-writer holds no Bash (H4) and cannot run the suite to read the
// actual deny text. `/NUL|null byte|contains a null/i` is the coordinator's
// own stated fallback; the conductor must confirm it against the real
// stderr on the first run and correct the regex here if it does not match
// (a PRECONDITION-style failure on THIS assertion, not a defect in Fix 1).
//
// EXPECTED FAILURE SHAPE (RED under the named sabotage): delete the
// validateStateKey deny in the attribution-load loop — the crafted entry
// then survives loading unchecked, has no matching state entry, and is
// denied via the DISAGREEMENT path instead of key validation (or allowed
// outright, if the disagreement check only fires on paths git currently
// reports dirty and this crafted path is not one). Either way the
// `/crafted attribution record entry/i` match and/or the arm's unique
// phrase match vanish, and/or the `/disagree/i` negative assertion fires —
// the arm goes red on at least one of its four assertions.
// =========================================================================

test('PIN-RECORD-KEY-VALIDATION-CRAFTED: a crafted attribution-record entry (drive-prefixed / NUL-bearing) DENIES via validateStateKey specifically, never the disagreement check — control: a well-formed, present-and-consistent key still ALLOWS', { skip: GIT_SKIP }, () => {
  const CRAFTED = [
    ['drive-prefixed', 'C:/x', /drive-prefixed|contained within the project root|escaping the root/i],
    ['NUL-bearing', 'data\u0000.txt', /NUL|null byte|contains a null/i],
  ];

  // ---- CONTROL ARM (place first, must pass for the OPPOSITE reason): a
  // well-formed key, present AND consistent in BOTH records, must ALLOW.
  {
    const fx = makeGitProject();
    const { dir, cleanup } = fx;
    try {
      writeFileSync(join(dir, 'hooks', 'real-dirty.mjs'), '// genuinely dirty legit enforcement path, uncommitted\n');
      assert.match(porcelain(dir), /real-dirty\.mjs/, 'PRECONDITION: the legit enforcement path is dirty at Pre, so both records get a real baseline entry');

      const L = lane('keyvalid-control');
      assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre runs with a usable tool_use_id');

      const ctrlPath = join(dir, 'hooks', 'ctrl.mjs');
      assert.equal(existsSync(ctrlPath), false, 'PRECONDITION: hooks/ctrl.mjs does not exist on disk — the absent-state entry must be genuine, not a lie');

      appendAttributionEntry(fx, 'hooks/ctrl.mjs');
      addStateEntry(fx, 'hooks/ctrl.mjs', { exists: false, index: null });

      const r = h17(dir, 'PostToolUse', L);
      assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
      assert.equal(
        r.code,
        0,
        `CONTROL: a well-formed key present-and-consistent in BOTH records (attribution array + a matching absent-state entry) must ALLOW — if THIS fails, the crafted arms below prove nothing, because the anti-hollow /disagree/i negative cannot be trusted without a passing positive case first — actual ${r.code}, stderr: ${oneLine(r.stderr)}`
      );
    } finally {
      cleanup();
    }
  }

  // ---- CRAFTED ARMS: malformed key in the attribution array ONLY — the
  // state record is never touched, so any deny is attributable to the key's
  // shape alone, not to a manufactured attribution/state mismatch.
  for (const [label, entry, phrase] of CRAFTED) {
    const fx = makeGitProject();
    const { dir, cleanup } = fx;
    try {
      writeFileSync(join(dir, 'hooks', 'real-dirty.mjs'), '// genuinely dirty legit enforcement path, uncommitted\n');
      assert.match(porcelain(dir), /real-dirty\.mjs/, 'PRECONDITION: the legit enforcement path is dirty at Pre, so both records get a real baseline entry');

      const L = lane('keyvalid-' + label.replace(/[^a-z0-9]/gi, ''));
      assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre runs with a usable tool_use_id');

      appendAttributionEntry(fx, entry); // attribution record ONLY — deliberately no matching state entry

      const r = h17(dir, 'PostToolUse', L);
      assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
      assert.equal(r.code, 2, `a crafted ${label} attribution-record entry must deny — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
      assert.match(r.stderr, /crafted attribution record entry/i, `the refusal must name the crafted entry (${label}) — stderr: ${oneLine(r.stderr)}`);
      assert.match(r.stderr, phrase, `the refusal must carry the ${label}-specific phrase — stderr: ${oneLine(r.stderr)}`);
      assert.doesNotMatch(
        r.stderr,
        /disagree/i,
        `THE ANTI-HOLLOW ANCHOR: the deny must come from validateStateKey, never from the attribution/state disagreement check — a /disagree/i match here means this arm is hollow — stderr: ${oneLine(r.stderr)}`
      );
    } finally {
      cleanup();
    }
  }
});

// harvest the per-call STATE for `keyIncludes` from a FRESH Pre in `dir`,
// then remove that harvest record so it cannot interfere with anything else
// in the project — the exact PIN-RECORD-PROTO idiom, extracted so the three
// arms of PIN-RECORD-STRAY-FIELD can each harvest a donor class without
// guessing its field names.
function harvestState(fx, dir, keyIncludes, tag) {
  const before = perCallRecords(fx);
  const H = lane('harvest-' + tag);
  assert.equal(h17(dir, 'PreToolUse', H).code, 0, `harvest Pre for ${keyIncludes}`);
  const recPath = perCallRecords(fx).find((p) => !before.includes(p));
  assert.ok(recPath, `PRECONDITION: the harvest Pre wrote its OWN per-call record for ${keyIncludes} (per-call keying — PIN-KEY)`);
  const parsed = JSON.parse(readFileSync(recPath, 'utf8'));
  const key = Object.keys(parsed).find((k) => k.includes(keyIncludes));
  assert.ok(key, `PRECONDITION: the harvested record keys the ${keyIncludes} path (keys seen: ${Object.keys(parsed).join(', ')})`);
  const state = parsed[key];
  rmSync(recPath, { force: true });
  return state;
}

// =========================================================================
// PIN-RECORD-STRAY-FIELD — board 1f4b7af0 item 3(b): a per-call STATE record
// entry carrying a field FOREIGN to its own existence class — an ABSENT
// state carrying a `type`; a FILE state carrying `children` or `target`; a
// DIRECTORY state carrying `sha256` — is a shape no genuine snapshot can
// produce (each class's fields are read directly off what actually exists
// at that path: an absent path has no file to type, a plain file has no
// children/symlink target, a directory has no byte digest) and must DENY.
//
// HARVEST, NEVER GUESS (the established idiom in this file —
// PIN-RECORD-PROTO): every field NAME and VALUE below is taken from a
// GENUINE per-call record for that existence class, on this same host and
// this same build, rather than assumed. A PRECONDITION asserts the donor
// class actually carries the field and the recipient class genuinely lacks
// it — if either assumption is wrong for the shipped schema, the
// PRECONDITION fails loudly instead of the pin silently proving nothing (a
// real, disclosed risk: this test-writer is blind to the actual field
// names per H4, and the PRECONDITIONs are what make that risk loud rather
// than a silent false pass).
//
// CONTROL (place first): a canonical, untampered pre-dirty file record —
// exactly the fields a real snapshot produces, nothing foreign — must still
// ALLOW when nothing else changes. This rules out "the harness's own tamper
// technique breaks validation" before any pin arm is trusted.
//
// EXPECTED FAILURE SHAPE (RED before this fix): each PIN arm's
// `assert.equal(r.code, 2)` fires with actual 0 — comparison never inspects
// the stray field (it is not part of that class's own comparison), so a
// recorded state with a foreign extra field still compares equal to the
// unchanged live state and Post ALLOWS.
//
// CATCHES SABOTAGE: remove strayFieldError (or the shape check it
// implements) — the stray-field record loads, comparison proceeds as if the
// extra field were not there, and every PIN arm reverts to the ALLOW above.
// =========================================================================

test('PIN-RECORD-STRAY-FIELD: a state object carrying a field foreign to its own shape (absent+type, file+children, dir+sha256) DENIES — control: a canonical untampered record still ALLOWS', { skip: GIT_SKIP }, () => {
  // ---- CONTROL (place first): canonical, untampered record -> allow.
  {
    const { dir, cleanup } = makeGitProject();
    try {
      preDirtyBundle(dir, '// control: canonical file state, untouched\n');
      const L = lane('strayfield-control');
      assert.equal(h17(dir, 'PreToolUse', L).code, 0);
      const r = h17(dir, 'PostToolUse', L); // nothing changes in-window; the record is untampered
      assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
      assert.equal(r.code, 0, `CONTROL: a canonical, untampered record must still allow — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    } finally {
      cleanup();
    }
  }

  // ---- PIN 1: ABSENT state carrying a stray `type` field (borrowed from FILE).
  {
    const fx = makeGitProject();
    const { dir, cleanup } = fx;
    try {
      preDirtyBundle(dir, '// donor file for the stray-type harvest\n');
      const fileState = harvestState(fx, dir, 'h3-contract-gate', 'donorfile-abs');

      const absentPath = join(dir, 'hooks', 'stray-absent.mjs');
      writeFileSync(absentPath, '// tracked, about to be deleted\n');
      git(dir, ['add', '-A'], { must: true });
      git(dir, ['commit', '-q', '-m', 'add stray-absent'], { must: true });
      rmSync(absentPath, { force: true });
      assert.match(porcelain(dir), /stray-absent/, 'PRECONDITION: the deleted tracked file is pre-dirty (absent) at Pre');

      const L = lane('strayabsent');
      assert.equal(h17(dir, 'PreToolUse', L).code, 0);

      const rec = soleRecordPath(fx, 'the absent+type stray-field tamper');
      const parsed = JSON.parse(readFileSync(rec, 'utf8'));
      const key = Object.keys(parsed).find((k) => k.includes('stray-absent'));
      assert.ok(key, `PRECONDITION: the record keys the deleted path (keys seen: ${Object.keys(parsed).join(', ')})`);
      const absentState = parsed[key];
      assert.ok('type' in fileState, `PRECONDITION: the harvested FILE state carries a 'type' field (keys: ${Object.keys(fileState).join(', ')})`);
      assert.ok(!('type' in absentState), `PRECONDITION: the genuine ABSENT state does NOT carry 'type' (keys: ${Object.keys(absentState).join(', ')}) — otherwise this is not a stray field`);
      parsed[key] = { ...absentState, type: fileState.type };
      writeFileSync(rec, JSON.stringify(parsed));
      assert.equal(existsSync(stampPath(dir)), false, 'PRECONDITION: no stamp exists — nothing may exempt this');

      const r = h17(dir, 'PostToolUse', L);
      assert.notEqual(r.code, 1, 'AC9: never a non-blocking exit 1');
      assert.equal(r.code, 2, `an ABSENT state carrying a stray 'type' field must deny — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    } finally {
      cleanup();
    }
  }

  // ---- PIN 2: FILE state carrying a stray `children` field (borrowed from DIRECTORY).
  {
    const fx = makeGitProject();
    const { dir, cleanup } = fx;
    try {
      mkdirSync(join(dir, 'hooks', 'donordir'), { recursive: true });
      writeFileSync(join(dir, 'hooks', 'donordir', 'a.mjs'), '// donor directory child\n');
      const dirState = harvestState(fx, dir, 'donordir', 'donordir-file');

      const fileBytes = '// recipient FILE state\n';
      const bundle = preDirtyBundle(dir, fileBytes);
      const L = lane('strayfilechildren');
      assert.equal(h17(dir, 'PreToolUse', L).code, 0);

      const rec = soleRecordPath(fx, 'the file+children stray-field tamper');
      const parsed = JSON.parse(readFileSync(rec, 'utf8'));
      const key = Object.keys(parsed).find((k) => k.includes('h3-contract-gate'));
      assert.ok(key, `PRECONDITION: the record keys the pre-dirty file (keys seen: ${Object.keys(parsed).join(', ')})`);
      const fileState = parsed[key];
      assert.ok('children' in dirState, `PRECONDITION: the harvested DIRECTORY state carries a 'children' field (keys: ${Object.keys(dirState).join(', ')})`);
      assert.ok(!('children' in fileState), `PRECONDITION: the genuine FILE state does NOT carry 'children' (keys: ${Object.keys(fileState).join(', ')}) — otherwise this is not a stray field`);
      parsed[key] = { ...fileState, children: dirState.children };
      writeFileSync(rec, JSON.stringify(parsed));
      assert.equal(existsSync(stampPath(dir)), false, 'PRECONDITION: no stamp exists — nothing may exempt this');

      const r = h17(dir, 'PostToolUse', L);
      assert.notEqual(r.code, 1, 'AC9: never a non-blocking exit 1');
      assert.equal(r.code, 2, `a FILE state carrying a stray 'children' field must deny — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
      assert.equal(readFileSync(bundle, 'utf8'), fileBytes, 'the file itself is untouched throughout (unchanged pre-dirty path, no restore)');
    } finally {
      cleanup();
    }
  }

  // ---- PIN 3: DIRECTORY state carrying a stray `sha256` field (borrowed from FILE).
  {
    const fx = makeGitProject();
    const { dir, cleanup } = fx;
    try {
      preDirtyBundle(dir, '// donor file for sha256 harvest\n');
      const fileState = harvestState(fx, dir, 'h3-contract-gate', 'donorfile-dir');

      const newDir = join(dir, 'hooks', 'strayshadir');
      mkdirSync(newDir, { recursive: true });
      writeFileSync(join(newDir, 'a.mjs'), '// recipient DIRECTORY state\n');
      assert.match(porcelain(dir), /strayshadir/, 'PRECONDITION: the untracked directory is dirty at Pre');

      const L = lane('strayshadir');
      assert.equal(h17(dir, 'PreToolUse', L).code, 0);

      const rec = soleRecordPath(fx, 'the dir+sha256 stray-field tamper');
      const parsed = JSON.parse(readFileSync(rec, 'utf8'));
      const key = Object.keys(parsed).find((k) => k.replace(/\/+$/, '') === 'hooks/strayshadir');
      assert.ok(key, `PRECONDITION: the record keys the top-level pre-dirty directory (keys seen: ${Object.keys(parsed).join(', ')})`);
      const dirState = parsed[key];
      assert.ok('sha256' in fileState, `PRECONDITION: the harvested FILE state carries a 'sha256' field (keys: ${Object.keys(fileState).join(', ')})`);
      assert.ok(!('sha256' in dirState), `PRECONDITION: the genuine DIRECTORY state does NOT carry 'sha256' (keys: ${Object.keys(dirState).join(', ')}) — otherwise this is not a stray field`);
      parsed[key] = { ...dirState, sha256: fileState.sha256 };
      writeFileSync(rec, JSON.stringify(parsed));
      assert.equal(existsSync(stampPath(dir)), false, 'PRECONDITION: no stamp exists — nothing may exempt this');

      const r = h17(dir, 'PostToolUse', L);
      assert.notEqual(r.code, 1, 'AC9: never a non-blocking exit 1');
      assert.equal(r.code, 2, `a DIRECTORY state carrying a stray 'sha256' field must deny — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
    } finally {
      cleanup();
    }
  }
});

