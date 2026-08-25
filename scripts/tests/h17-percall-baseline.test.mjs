// H17 (B) BASELINE — PER-CALL KEYING (board 11609d1f, HIGH, user-filed).
//
// STATUS: RED until the per-call (B) baseline lands (board 11609d1f). Every
// test in this file is authored AHEAD of the implementation. Nothing in this
// file describes shipped behaviour. Two exceptions are named where they live
// rather than glossed here: the CONTROL arm of PIN-B-BASELINE-DEGRADED-LOUD is
// expected GREEN today by design (that is what makes it a control), and
// PIN-B-BASELINE-PER-CALL-CONSUMED may ALREADY be green under the run-keyed
// implementation — it is the lifecycle half that must keep holding once the key
// changes, and its own header says so.
//
// THE DEFECT. The (B) content baseline is keyed by project tag + runId ONLY, so
// every concurrent Bash lane in a run SHARES one baseline file and each Pre
// OVERWRITES it. Laundering sequence, all four steps ordinary:
//   1. lane A's Pre sees a regular file at a (B) path and writes the baseline;
//   2. lane A's command tampers with that path;
//   3. lane B's Pre runs BEFORE lane A's Post, snapshots the TAMPERED state and
//      overwrites the shared baseline with it;
//   4. both Posts compare against the tampered baseline — neither observes a
//      change, and the tamper is ADOPTED as the legitimate pre-image.
// This is the exact hole the (A) side already closed: its per-call STATE record
// is keyed by sha256(tool_use_id) IN ADDITION to project tag and run id, and
// AC14 states the reason in as many words — "if lane B's Pre lands after lane
// A's command already tampered, a shared record adopts the tampered bytes as
// B's baseline and Post A then allows a real tamper". The same argument applies
// verbatim to (B), which was simply not migrated — and (B) is the branch that
// RESTORES by writing file content, so an adopted-tamper baseline here is not
// only a missed denial, it is a WRITE of attacker-influenced bytes.
//
// WHY THESE PINS EXIST RATHER THAN THE TWO THAT USED TO STAND HERE. Two frozen
// assertions in scripts/tests/h17-pre-state-snapshot.test.mjs pinned the
// RUN-KEYED baseline as written (the `:829` "the (B) baseline is deliberately
// left intact" equality against the run-keyed path, and the perCallRecords
// selection that subtracted exactly that one filename). The user's board item
// rules the run-keyed behaviour a HIGH DEFECT, so those were WRONG PINS and
// have been corrected in place to be key-agnostic — not a gate routed around.
//
// FIX SHAPE THE BOARD NAMES (this file pins its OBSERVABLE consequences, never
// a filename): key the (B) baseline the way the (A) state record is keyed
// (callKey(tool_use_id)), with the SAME LOUD degradation when tool_use_id is
// unusable — never a silent fall back to a per-run key, which IS the defect —
// and consume/unlink the per-call baseline at the Post that read it (P4).
//
// Authored BLIND to scripts/hooks/h17-bash-write-sweep.mjs per H4 — no hook
// source was read; every expectation comes from board 11609d1f, the owning
// article's AC14, and the (A) side's settled behaviour.
//
// HARNESS is a faithful copy of scripts/tests/h17-baseline-ancestor.test.mjs's
// idiom (makeGitProject, one tool_use_id per lane carried by both its Pre and
// its Post, oneLine, GIT_SKIP) — NOT imported, since that file exports nothing.
// The (B) path used throughout is `.claude/settings.local.json`: gitignored, so
// the (A) tracked/untracked sweep cannot be the cause of any verdict here.
//
// RUN COMMAND (node toolchain adapter):
//   node --test scripts/tests/h17-percall-baseline.test.mjs

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, realpathSync } from 'node:fs';
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

// anti-pattern ee89c3fd: raw multi-line child-process stderr interpolated into
// an assertion message that is EXPECTED to fail poisons the TAP crash/assertion
// classifier, so a red pin reads as a CRASH instead of an assertion failure.
// Every assertion in this file is expected to fail today, so this is
// load-bearing here. Flatten whitespace, NEVER truncate.
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

function git(dir, args, { must = false } = {}) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (must) assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${oneLine(r.stderr)}`);
  return r;
}

function porcelain(dir) {
  return git(dir, ['status', '--porcelain'], { must: true }).stdout;
}

function makeGitProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h17-pcb-'));
  const runId = 'r-h17pcb-' + randomUUID().slice(0, 8);

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
  const cleanup = (extraPaths = []) => {
    closeStore();
    rmSync(dir, { recursive: true, force: true });
    for (const p of tempRecords(projectTag)) rmSync(p, { force: true });
    for (const p of extraPaths) rmSync(p, { force: true, recursive: true });
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

function recordName(p) {
  return String(p).split(/[\\/]/).pop() ?? '';
}

// The (A) per-call STATE record's filename, exactly as AC14 states it:
// sterling-enforce-<projectTag>-<runId>-call-<hash>.json. Used only to SUBTRACT
// the (A) records when counting (B) baselines — this file never asserts what a
// (B) baseline is CALLED, because the board leaves the naming to the fix.
function isStateRecord(p, { projectTag, runId }) {
  return new RegExp(`^sterling-enforce-${projectTag}-${runId}-call-[0-9a-f]+\\.json$`).test(recordName(p));
}

// Every temp record that is neither an (A) state record nor the per-run
// paths-only attribution record — i.e. the (B) content baseline(s), under
// whatever key the implementation uses.
function baselineRecords(fx) {
  return tempRecords(fx.projectTag).filter((p) => !isStateRecord(p, fx) && !recordName(p).endsWith('.dirty.json'));
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
      tool_input: { command: 'grep -rn "resolveRun" scripts/' }, // read-only; the fixtures do the tampering
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

function settingsPath(dir) {
  return join(dir, '.claude', 'settings.local.json');
}

const X_BYTES = '{"hooks":"enabled","note":"X — the legitimate pre-image lane A snapshots"}\n';
const Y_BYTES = '{"hooks":"DISABLED","note":"Y — TAMPERED by lane A inside its own window"}\n';

// =========================================================================
// PIN-B-BASELINE-PER-CALL — RED until the per-call (B) baseline lands (board
// 11609d1f).
//
// The board's laundering sequence, executed exactly: Pre A snapshots X, lane A's
// command tampers X -> Y, Pre B lands AFTER the tamper and legitimately
// snapshots Y, then the Posts run in REVERSE order.
//   * Post B must ALLOW: nothing changed inside B's window, and the tamper
//     predates B's Pre — it is not B's to answer for.
//   * Post A must DENY and RESTORE X: its own window changed X -> Y.
// With a run-keyed baseline, Pre B overwrites the single shared file with Y and
// Post A then compares Y against Y — a real tamper, ALLOWED, with the tampered
// bytes adopted as the legitimate pre-image.
//
// THE RESTORE ASSERTION IS THE ONE THAT CANNOT BE SATISFIED FOR THE WRONG
// REASON, and it is why this pin does not merely assert "Post A denied": a deny
// caused by a CONSUMED or MISSING shared baseline (Post B unlinking the file
// lane A still needed) is fail-closed noise, not the property. Only a comparison
// against lane A's OWN baseline can restore the file to X. The two
// `doesNotMatch` assertions name that failure mode explicitly so a red is
// diagnosable, mirroring PIN-KEY's idiom on the (A) side.
//
// EXPECTED FAILURE SHAPE (RED TODAY, both halves plausible and both worth
// naming, in the order they would fire):
//   (a) the mechanism half fires first — `assert.ok(afterB.length >=
//       afterA.length + 1, ...)` with "after A: 1, after B: 1", because the
//       run-keyed filename collapses both lanes onto one baseline; and
//   (b) with that precondition removed, `assert.equal(postA.code, 2, ...)` fires
//       with actual 0 (the adopted-tamper allow), or — if Post B consumed the
//       shared file — postA denies with an "absent at Post"/"failing closed"
//       message, which the `doesNotMatch` assertions catch instead, and
//       `assert.equal(readFileSync(settings), X_BYTES)` fires holding Y.
//
// SABOTAGE (once green): drop the call-key component from the (B) baseline
// filename, i.e. key it by project tag + runId again. Both halves must go red.
// =========================================================================

test(
  'PIN-B-BASELINE-PER-CALL: Pre A, Pre B, then Posts in REVERSE order — Post A still catches the (B) tamper a shared per-run baseline would have adopted as B\'s pre-image',
  { skip: GIT_SKIP },
  () => {
    const fx = makeGitProject();
    const { dir, cleanup } = fx;
    try {
      const settings = settingsPath(dir);
      writeFileSync(settings, X_BYTES);
      assert.equal(porcelain(dir), '', 'PRECONDITION AND CAUSE ISOLATION: the tree is clean to git — .claude/settings.local.json is gitignored, so nothing here can be decided by the (A) sweep');
      assert.equal(existsSync(stampPath(dir)), false, 'PRECONDITION: no stamp exists — nothing may exempt this');

      const A = lane('laneA');
      const B = lane('laneB');
      assert.notEqual(A.tool_use_id, B.tool_use_id, 'PRECONDITION: two lanes, two tool_use_ids');

      assert.equal(h17(dir, 'PreToolUse', A).code, 0, 'Pre A snapshots X');
      const afterA = baselineRecords(fx);
      assert.ok(
        afterA.length >= 1,
        `PRECONDITION: Pre A wrote a (B) content baseline, discoverable as a sterling-enforce-<projectTag>-* temp file that is neither an (A) per-call state record nor the per-run .dirty.json (found: ${afterA.map(recordName).join(', ') || '(none)'})`
      );

      writeFileSync(settings, Y_BYTES); // lane A's command tampers, inside A's window

      assert.equal(h17(dir, 'PreToolUse', B).code, 0, 'Pre B lands AFTER the tamper and legitimately snapshots Y as its own starting state');
      const afterB = baselineRecords(fx);
      assert.ok(
        afterB.length >= afterA.length + 1,
        `MECHANISM HALF: Pre B must write its OWN (B) baseline rather than overwrite lane A's — a run-keyed filename collapses both lanes onto one baseline and adopts the tamper (after A: ${afterA.length} [${afterA
          .map(recordName)
          .join(', ')}], after B: ${afterB.length} [${afterB.map(recordName).join(', ')}])`
      );

      const postB = h17(dir, 'PostToolUse', B);
      assert.equal(postB.code, 0, `lane B changed nothing inside ITS window and must not be denied — actual ${postB.code}, stderr: ${oneLine(postB.stderr)}`);
      assert.equal(readFileSync(settings, 'utf8'), Y_BYTES, "and lane B's Post restores nothing — Y is B's own legitimate pre-image");

      const postA = h17(dir, 'PostToolUse', A);
      assert.notEqual(postA.code, 1, 'a security gate never fails with a non-blocking exit 1');
      assert.equal(
        postA.code,
        2,
        `THE FALSE ALLOW: lane A's own window changed the (B) path X -> Y and must deny — actual ${postA.code}, stderr: ${oneLine(postA.stderr)}`
      );
      assert.doesNotMatch(postA.stderr, /failing closed/, "and it denies by COMPARISON against lane A's OWN baseline, not because that baseline went missing");
      assert.doesNotMatch(
        postA.stderr,
        /absent at Post/,
        "nor because lane B's Post consumed a SHARED baseline out from under lane A — if THIS assertion is what fires, the diagnosis is a shared per-run baseline's lifecycle under overlapping windows, not the comparison"
      );
      assert.match(postA.stderr, /settings\.local\.json/, 'and it names the (B) path lane A\'s window changed');
      assert.equal(
        readFileSync(settings, 'utf8'),
        X_BYTES,
        'THE PROPERTY THAT CANNOT BE FAKED BY A FAIL-CLOSED DENY: the (B) stage restored lane A\'s OWN pre-image X — a deny caused by a missing/consumed shared baseline restores nothing, and an adopted-tamper baseline leaves Y in place'
      );
    } finally {
      cleanup();
    }
  }
);

// =========================================================================
// PIN-B-BASELINE-PER-CALL-CONSUMED — RED until the per-call (B) baseline lands
// (board 11609d1f). The board states the lifecycle in as many words: "Consume
// and unlink the per-call baseline at the Post that read it, as (A) does (P4)."
// A per-call transient that outlives its call is exactly the shared-state shape
// this board item exists to remove (P4: transient state is removed by the
// mechanical event that ends its life).
//
// EXPECTED SHAPE — MEASURE, DO NOT ASSUME, and this pin is the one test here
// that may ALREADY be green: the sibling PIN-KEY's own note ("nor because lane
// B's Post consumed the shared per-run (B) baseline out from under lane A")
// suggests today's Post already unlinks the run-keyed baseline, in which case
// this passes for the run-keyed shape and is a REGRESSION pin for the per-call
// one. If instead the run-keyed baseline survives its Post, the failing line is
// `assert.deepEqual(after.map(recordName), [], ...)`, holding
// `sterling-enforce-<tag>-<runId>.json`.
//
// SABOTAGE (once green): remove the unlink at the end of the (B) Post, or make
// the Post read a baseline it does not own.
// =========================================================================

test('PIN-B-BASELINE-PER-CALL-CONSUMED: the Post that read a (B) baseline consumes and unlinks it (P4) — no per-call baseline outlives its call', { skip: GIT_SKIP }, () => {
  const fx = makeGitProject();
  const { dir, cleanup } = fx;
  try {
    const L = lane('consume');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre writes this call\'s (B) baseline');
    assert.ok(baselineRecords(fx).length >= 1, 'PRECONDITION: the baseline exists after Pre');

    const post = h17(dir, 'PostToolUse', L);
    assert.equal(post.code, 0, `nothing changed in the window, so this call allows — actual ${post.code}, stderr: ${oneLine(post.stderr)}`);

    const after = baselineRecords(fx);
    assert.deepEqual(
      after.map(recordName),
      [],
      'the Post that READ this call\'s (B) baseline must consume and unlink it (P4) — a surviving baseline is the shared state board 11609d1f exists to remove'
    );
  } finally {
    cleanup();
  }
});

// =========================================================================
// PIN-B-BASELINE-DEGRADED-LOUD — RED until the per-call (B) baseline lands
// (board 11609d1f). The fix must degrade the way the (A) side already does:
// when tool_use_id is unusable (ABSENT, empty/whitespace, or non-string) the (B)
// verdict still denies where it denies today, AND any (B) action taken under a
// shared key SAYS SO — naming tool_use_id as the reason and the shared-baseline
// exposure as the consequence. A silent fall back to a per-run key is the
// defect, not a degradation: it reopens the laundering hole for every lane at
// once, invisibly.
//
// CONTROL ARM, PLACED FIRST, because "it denied" has more than one possible
// cause here: degraded mode is a blanket-denial mode, so a deny proves nothing
// on its own. The control runs a lane with a USABLE tool_use_id and NO tamper
// and requires exit 0 — proving this fixture is not one that denies whatever you
// do to it, so the treatment arms' denials are about the tamper.
//
// EXPECTED FAILURE SHAPE (RED TODAY): for each of the three unusable shapes the
// `r.code === 2` half is expected GREEN (a modified (B) path denies today
// regardless), and the RED assertions are the two stderr matches — today's (B)
// message has no notion of tool_use_id and says nothing about the baseline being
// shared. `assert.match(r.stderr, /tool_use_id/, ...)` is the first to fire.
//
// WORDING IS NOT PINNED, the CONTENT is: the message must name the field
// (`tool_use_id`) and must name the shared/per-run nature of the baseline it
// fell back to (or refused to use). The regexes are deliberately loose for that
// reason — a fix may phrase it however it likes, as long as a reader learns both
// facts.
//
// SABOTAGE (once green): make callKey return a constant for an unusable
// tool_use_id with no degrade note — i.e. a per-run key under another name. The
// stderr assertions go red while the exit code stays 2, which is precisely the
// silent-degradation defect.
// =========================================================================

const UNUSABLE_IDS = [
  ['ABSENT', {}],
  ['EMPTY STRING', { tool_use_id: '' }],
  ['WHITESPACE', { tool_use_id: '   ' }],
  ['NON-STRING', { tool_use_id: 42 }],
];

test('PIN-B-BASELINE-DEGRADED-LOUD: CONTROL — a USABLE tool_use_id with no tamper ALLOWS, so a denial below is about the tamper, not the mode', { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    writeFileSync(settingsPath(dir), X_BYTES);
    const L = lane('degraded-control');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre with a usable tool_use_id');
    const r = h17(dir, 'PostToolUse', L);
    assert.equal(r.code, 0, `CONTROL: an untampered window with a usable tool_use_id must ALLOW — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
  } finally {
    cleanup();
  }
});

for (const [label, idInput] of UNUSABLE_IDS) {
  test(`PIN-B-BASELINE-DEGRADED-LOUD: an ${label} tool_use_id still denies a (B) tamper AND names the shared-baseline exposure — never a silent per-run fallback`, { skip: GIT_SKIP }, () => {
    const { dir, cleanup } = makeGitProject();
    try {
      const settings = settingsPath(dir);
      writeFileSync(settings, X_BYTES);
      const degraded = { agent_id: 'a1', ...idInput };

      assert.equal(h17(dir, 'PreToolUse', degraded).code, 0, 'Pre runs in degraded mode');
      writeFileSync(settings, Y_BYTES); // the audited command tampers with a (B) path

      const r = h17(dir, 'PostToolUse', degraded);

      assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
      assert.equal(r.code, 2, `a (B) tamper must still deny in degraded mode — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
      assert.match(r.stderr, /tool_use_id/, `DEGRADED-LOUD: the (B) stage names the unusable field as the reason — stderr: ${oneLine(r.stderr)}`);
      assert.match(
        r.stderr,
        /shared|per-run|per run|run-keyed|run keyed/i,
        `DEGRADED-LOUD: and names the CONSEQUENCE — that the baseline in play is shared across every lane in this run rather than keyed to this call — so a reader learns the exposure instead of inferring it. Wording is free, both facts are not. stderr: ${oneLine(r.stderr)}`
      );
    } finally {
      cleanup();
    }
  });
}
