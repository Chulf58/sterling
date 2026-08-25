// H17 (A) ATTRIBUTION RECORD — PER-CALL KEYING (board 489554d4, HIGH,
// user-filed).
//
// STATUS: the per-call keying of the (A) ATTRIBUTION RECORD (the per-run
// paths-only `.dirty.json` file, distinct from BOTH the (A) per-call STATE
// record — AC14, `sterling-enforce-<tag>-<runId>-call-<hash>.json` — and the
// (B) content baseline) IS SHIPPED in
// scripts/hooks/h17-bash-write-sweep.mjs on branch sterling/board-fanout-2.
// These pins are authored FROM THE SPEC — board 489554d4's ruling that a
// run-keyed attribution-record name is a HIGH defect, applying VERBATIM the
// same laundering argument the (A) state record's own AC14 and the (B)
// baseline's board 11609d1f already settled, to the third per-run file that
// shared the exposure — and are expected GREEN NOW, not red-first.
//
// Authored BLIND to scripts/hooks/h17-bash-write-sweep.mjs per H4 — no hook
// source was read; every expectation below comes from board 489554d4, the
// (A) state record's settled per-call argument (scripts/tests/
// h17-pre-state-snapshot.test.mjs's PIN-KEY / AC14 commentary), and the (B)
// baseline's settled per-call argument (scripts/tests/
// h17-percall-baseline.test.mjs's PIN-B-BASELINE-PER-CALL).
//
// THE DEFECT THIS KEYING CLOSES. The attribution record lists the PATHS that
// were already dirty (per `git status`) at a call's own Pre — Post consults
// it to decide whether a currently-dirty tracked path is something already
// known-dirty (look up its recorded STATE and compare) or something NEW
// (the "otherwise" arm: fresh-stamp check, else restore to HEAD and deny).
// Under a shared/run-keyed record, every concurrent lane OVERWRITES the same
// file at its own Pre. If lane B's Pre lands at a moment when path P is
// MOMENTARILY CLEAN (reverted to HEAD, about to be re-dirtied), B's Pre
// legitimately records P as ABSENT from ITS OWN pre-dirty set. Lane A's
// Post — which needs to know whether P was pre-dirty AT A's OWN PRE — then
// reads B's overwritten record instead of its own, finds P absent, and
// treats P as "clean at Pre, dirty at Post": no stamp exists, so P is
// RESTORED TO HEAD and denied — a false "genuinely new" verdict on a file
// A's Pre correctly saw was already dirty, and A's own legitimate
// pre-existing edit is destroyed by a lane it never overlapped with in
// intent.
//
// HARNESS is a faithful copy of scripts/tests/h17-pre-state-snapshot.test.mjs's
// idiom (makeGitProject, per-lane tool_use_id via `lane()`, preDirtyBundle /
// bundlePath, oneLine, GIT_SKIP) — NOT imported, since that file exports
// nothing.
//
// RUN COMMAND (node toolchain adapter):
//   node --test scripts/tests/h17-percall-attribution.test.mjs

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

// Anti-pattern ee89c3fd: raw multi-line child-process stderr interpolated
// into an assertion message that is EXPECTED to fail poisons the TAP
// crash/assertion classifier. Flatten whitespace, NEVER truncate.
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

function makeGitProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h17-pca-'));
  const runId = 'r-h17pca-' + randomUUID().slice(0, 8);

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
  // the LEGACY per-run attribution filename this project tag would have used
  // pre-fix — kept only so `attributionRecords` below can exclude it by name.
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
  const cleanup = (extraPaths = []) => {
    closeStore();
    rmSync(dir, { recursive: true, force: true });
    for (const p of tempRecords(projectTag)) rmSync(p, { force: true });
    for (const p of extraPaths) rmSync(p, { force: true });
  };
  return { dir, store, runId, dbPath, projectTag, dirtyPath, closeStore, cleanup };
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

// The PER-CALL attribution record(s): any `.dirty.json` temp file for this
// project tag OTHER than the legacy per-run name. Naming-agnostic on
// purpose — this file pins the OBSERVABLE consequence of per-call keying,
// never a filename the fix is free to choose.
function attributionRecords(fx) {
  const legacy = recordName(fx.dirtyPath);
  return tempRecords(fx.projectTag).filter((p) => recordName(p).endsWith('.dirty.json') && recordName(p) !== legacy);
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

function bundlePath(dir) {
  return join(dir, 'hooks', 'h3-contract-gate.mjs');
}

function preDirtyBundle(dir, bytes) {
  const p = bundlePath(dir);
  writeFileSync(p, bytes);
  return p;
}

// =========================================================================
// PIN-A-ATTRIBUTION-PER-CALL — REWRITTEN per coordinator correction: the
// first version's failure was a FIXTURE sequencing defect, not an
// implementation gap. hooks/** is NOT denied unconditionally — it is marked
// for the coverage check, and a COVERED, UNCHANGED pre-dirty path ALLOWS
// (decision 7021526c / the PIN-ALLOW property). The prior version's extra
// path Q (hooks/hooks.json) reached Post dirty without ever being recorded
// in A's Pre, which is itself a spurious clean-at-Pre-style deny unrelated
// to the attribution-adoption property this pin exists to isolate. Dropped
// entirely — single victim P only.
//
// EXACT SEQUENCE (single victim P, no Q):
//   P = hooks/h3-contract-gate.mjs, committed clean by makeGitProject
//       (tracked-in-HEAD is essential: restoreTracked does
//       `git checkout HEAD -- P`)
//   1. writeFileSync(P, conductorBytes)  — conductor dirties P
//   2. Pre LA                            — A records P dirty in A's own
//                                           per-call attribution record
//   3. writeFileSync(P, committedBytes)  — P momentarily CLEAN (the race
//                                           window)
//   4. Pre LB                            — B's Pre snapshots a clean tree,
//                                           records NO P; under a run-keyed
//                                           record this OVERWRITES the
//                                           shared file, stripping P's
//                                           coverage
//   5. writeFileSync(P, conductorBytes)  — conductor work re-appears; P is
//                                           dirty again at A's Post
//   6. Post LA                           — the audited command wrote
//                                           nothing
// Post B is deliberately NEVER run (it would unlink the shared record,
// surfacing as "absent at Post" instead of a clean DELETE) and no stamp is
// fabricated (that would divert to the attested arm) — both would mask the
// property under test.
//
// EXPECTED (GREEN NOW, implementation shipped): A's own per-call attribution
// record is untouched by B's Pre, so A's Post finds P covered by ITS OWN
// record, compares against A's own per-call STATE record, sees P UNCHANGED
// across A's window, and ALLOWS without consulting a stamp — P's conductor
// bytes survive.
//
// SABOTAGE: drop the call-key from the attribution-record filename (key it
// by project tag + runId only again). Then B's Pre OVERWRITES the single
// shared record with no P entry; A's Post reads that shared record,
// coveringPre resolves to null, falls into the clean-at-Pre arm, and
// restoreTracked reverts P to committedBytes and denies — BOTH assertions
// below flip (bytes equal committedBytes instead of conductorBytes; exit
// code 2 instead of 0).
// =========================================================================

test(
  "PIN-A-ATTRIBUTION-PER-CALL: Pre A records P dirty, P goes momentarily clean for Pre B, P is re-dirtied, then Post A — A's own per-call attribution record is what Post A consults, not B's overwriting one",
  { skip: GIT_SKIP },
  () => {
    const fx = makeGitProject();
    const { dir, cleanup } = fx;
    try {
      const P = bundlePath(dir);
      const committedBytes = readFileSync(P, 'utf8');
      const conductorBytes = '// conductor uncommitted work — must survive\n';

      const LA = lane('attrA');
      const LB = lane('attrB');
      assert.notEqual(LA.tool_use_id, LB.tool_use_id, 'PRECONDITION: two lanes, two tool_use_ids');

      writeFileSync(P, conductorBytes); // 1. conductor dirties P

      assert.equal(h17(dir, 'PreToolUse', LA).code, 0, "2. A's Pre records P dirty in A's own per-call attribution record"); // 2
      const [attrA] = attributionRecords(fx);
      assert.ok(attrA, "PRECONDITION: A's Pre must write its own per-call attribution record");

      writeFileSync(P, committedBytes); // 3. P momentarily CLEAN — the race window

      assert.equal(h17(dir, 'PreToolUse', LB).code, 0, "4. B's Pre snapshots a clean tree and records NO P"); // 4

      writeFileSync(P, conductorBytes); // 5. conductor work re-appears; P is dirty again at A's Post

      const r = h17(dir, 'PostToolUse', LA); // 6. the audited command wrote nothing
      assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');

      assert.equal(existsSync(P), true, 'THE LOAD-BEARING PROPERTY: P still exists');
      assert.equal(
        readFileSync(P, 'utf8'),
        conductorBytes,
        `board 489554d4 invariant: the conductor's bytes SURVIVE, never HEAD-restored — actual bytes: ${JSON.stringify(readFileSync(P, 'utf8'))}, stderr: ${oneLine(r.stderr)}`
      );
      assert.equal(
        r.code,
        0,
        `CONTROL: a COVERED, UNCHANGED pre-dirty path ALLOWS (decision 7021526c / PIN-ALLOW) — actual ${r.code}, stderr: ${oneLine(r.stderr)}`
      );

      // CONSUME sub-pin (P4): the Post that read A's per-call attribution
      // record must consume and unlink it — the same lifecycle discipline
      // already established for the (A) state record and the (B) baseline.
      assert.equal(
        existsSync(attrA),
        false,
        "CONSUME: the Post that read A's per-call attribution record must unlink it — a surviving record is exactly the shared-state shape board 489554d4 exists to remove"
      );
    } finally {
      cleanup();
    }
  }
);

// =========================================================================
// PIN-A-ATTRIBUTION-DEGRADED-LOUD — mirrors PIN-B-BASELINE-DEGRADED-LOUD's
// idiom exactly, applied to the (A) attribution record. When tool_use_id is
// unusable, H17 keeps its old blanket pre-existing denial for a
// changed-in-window pre-dirty enforcement path AND says so — naming
// tool_use_id as the reason and the shared/per-run attribution exposure as
// the consequence. A silent fall back to a per-run key is the defect, not a
// degradation: it reopens exactly the laundering hole PIN-A-ATTRIBUTION-
// PER-CALL closes, invisibly, for every lane at once.
//
// CONTROL ARM, PLACED FIRST, because "it denied" has more than one possible
// cause here: degraded mode is a blanket-denial mode, so a deny proves
// nothing on its own. The control runs a lane with a USABLE tool_use_id and
// NO tamper and requires exit 0 — proving this fixture is not one that
// denies whatever you do to it, so the treatment arms' denials are about the
// tamper.
//
// EXPECTED (GREEN NOW): for each of the four unusable shapes, `r.code === 2`
// is expected true (a changed pre-dirty enforcement path denies in degraded
// mode regardless), and the stderr names BOTH the unusable field and the
// shared/per-run attribution exposure.
//
// WORDING IS NOT PINNED, the CONTENT is — the regexes are loose on purpose.
//
// SABOTAGE: make the (A) attribution record's call-key derivation return a
// constant for an unusable tool_use_id with NO degrade note (i.e. a per-run
// key under another name, applied silently). The exit code stays 2 but the
// stderr assertions go red — precisely the silent-degradation defect this
// pin exists to catch.
// =========================================================================

const UNUSABLE_IDS = [
  ['ABSENT', {}],
  ['EMPTY STRING', { tool_use_id: '' }],
  ['WHITESPACE', { tool_use_id: '   ' }],
  ['NON-STRING', { tool_use_id: 42 }],
];

test("PIN-A-ATTRIBUTION-DEGRADED-LOUD: CONTROL — a USABLE tool_use_id with no tamper ALLOWS, so a denial below is about the tamper, not the mode", { skip: GIT_SKIP }, () => {
  const { dir, cleanup } = makeGitProject();
  try {
    const L = lane('attr-degraded-control');
    assert.equal(h17(dir, 'PreToolUse', L).code, 0, 'Pre with a usable tool_use_id');
    const r = h17(dir, 'PostToolUse', L);
    assert.equal(r.code, 0, `CONTROL: an untampered window with a usable tool_use_id must ALLOW — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
  } finally {
    cleanup();
  }
});

for (const [label, idInput] of UNUSABLE_IDS) {
  test(`PIN-A-ATTRIBUTION-DEGRADED-LOUD: an ${label} tool_use_id still denies a changed pre-dirty enforcement path AND names the shared-attribution exposure — never a silent per-run fallback`, { skip: GIT_SKIP }, () => {
    const { dir, cleanup } = makeGitProject();
    try {
      const bundle = bundlePath(dir);
      preDirtyBundle(dir, '// conductor rebuild, not yet committed\n');
      const degraded = { agent_id: 'a1', ...idInput };

      assert.equal(h17(dir, 'PreToolUse', degraded).code, 0, 'Pre runs in degraded mode');
      writeFileSync(bundle, '// tampered in-window\n'); // the audited command changes a pre-dirty enforcement path

      const r = h17(dir, 'PostToolUse', degraded);

      assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
      assert.equal(r.code, 2, `a changed pre-dirty enforcement path must still deny in degraded mode — actual ${r.code}, stderr: ${oneLine(r.stderr)}`);
      assert.match(r.stderr, /tool_use_id/, `DEGRADED-LOUD: the (A) attribution stage names the unusable field as the reason — stderr: ${oneLine(r.stderr)}`);
      assert.match(
        r.stderr,
        /shared|per-run|per run|run-keyed|run keyed/i,
        `DEGRADED-LOUD: and names the CONSEQUENCE — that the attribution record in play is shared across every lane in this run rather than keyed to this call — so a reader learns the exposure instead of inferring it. Wording is free, both facts are not. stderr: ${oneLine(r.stderr)}`
      );
    } finally {
      cleanup();
    }
  });
}

// =========================================================================
// PIN-A-ATTRIBUTION-DEGRADED-MISSING-LOUD — covers the DENY-PATH half of the
// degraded-loud disclosure: a `+ sharedNote` was just appended to the
// missing-record AND corrupt-record EARLY-DENY compositions Post uses when
// it cannot read the (A) attribution record at all. That is a DIFFERENT
// deny path than PIN-A-ATTRIBUTION-DEGRADED-LOUD above (which tampers a
// pre-dirty enforcement path and hits the blanket "changed in degraded
// mode" denial) — this one fires because the record itself is gone or
// unreadable by the time Post looks for it.
//
// Under an unusable tool_use_id, Pre writes the (A) attribution record
// under the null key — the SAME legacy per-run filename (fx.dirtyPath)
// every degraded lane in this run would collide on. Deleting or corrupting
// that record before Post runs forces Post's missing/corrupt-record early
// deny, which must now name that shared/per-run fallback as part of why the
// record went missing — not just "absent at Post" in isolation.
//
// CONTROL FIRST: exit code 2 pins the VERDICT — a missing/corrupt
// attribution record must still deny, exactly as before this disclosure
// fix landed. The two stderr matches that follow pin the DISCLOSURE the fix
// adds ON TOP of that unchanged verdict.
//
// SABOTAGE: drop the `+ sharedNote` from the missing-record (and
// corrupt-record) deny composition, or force sharedNote = ''. Exit stays 2
// (the control keeps passing — the verdict never moved), but the
// /shared|per-run/ match goes red — proving these pins guard DISCLOSURE,
// not the verdict.
// =========================================================================

test('PIN-A-ATTRIBUTION-DEGRADED-MISSING-LOUD: a degraded-mode attribution record ABSENT at Post still denies AND names the shared/per-run fallback exposure', { skip: GIT_SKIP }, () => {
  const fx = makeGitProject();
  const { dir, cleanup } = fx;
  try {
    const degraded = { agent_id: 'a1' }; // ABSENT tool_use_id — unusable, forces degraded mode

    assert.equal(
      h17(dir, 'PreToolUse', degraded).code,
      0,
      "Pre runs in degraded mode and writes the (A) attribution record under the null key — the legacy per-run path"
    );
    assert.equal(
      existsSync(fx.dirtyPath),
      true,
      'PRECONDITION: degraded-mode Pre must write the shared/per-run attribution record at the legacy path'
    );

    rmSync(fx.dirtyPath, { force: true }); // the record vanishes before Post consults it

    const r = h17(dir, 'PostToolUse', degraded);

    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(
      r.code,
      2,
      `CONTROL: a missing attribution record at Post must still deny — the verdict is unchanged by the disclosure fix — actual ${r.code}, stderr: ${oneLine(r.stderr)}`
    );
    assert.match(
      r.stderr,
      /tool_use_id/,
      `DEGRADED-LOUD (missing-record): the deny still names the unusable field as the reason for degraded mode — stderr: ${oneLine(r.stderr)}`
    );
    assert.match(
      r.stderr,
      /shared|per-run|per run|run-keyed|run keyed/i,
      `DEGRADED-LOUD (missing-record): and now ALSO names the shared/per-run fallback that made the record collide-prone in the first place — wording is free, both facts are not. stderr: ${oneLine(r.stderr)}`
    );
  } finally {
    cleanup();
  }
});

test('PIN-A-ATTRIBUTION-DEGRADED-CORRUPT-LOUD: a degraded-mode attribution record CORRUPTED at Post still denies AND names the shared/per-run fallback exposure', { skip: GIT_SKIP }, () => {
  const fx = makeGitProject();
  const { dir, cleanup } = fx;
  try {
    const degraded = { agent_id: 'a1' }; // ABSENT tool_use_id — unusable, forces degraded mode

    assert.equal(
      h17(dir, 'PreToolUse', degraded).code,
      0,
      "Pre runs in degraded mode and writes the (A) attribution record under the null key — the legacy per-run path"
    );
    assert.equal(
      existsSync(fx.dirtyPath),
      true,
      'PRECONDITION: degraded-mode Pre must write the shared/per-run attribution record at the legacy path'
    );

    writeFileSync(fx.dirtyPath, '{ not valid json,,,'); // the record is corrupted before Post consults it

    const r = h17(dir, 'PostToolUse', degraded);

    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(
      r.code,
      2,
      `CONTROL: a corrupt attribution record at Post must still deny — the verdict is unchanged by the disclosure fix — actual ${r.code}, stderr: ${oneLine(r.stderr)}`
    );
    assert.match(
      r.stderr,
      /tool_use_id/,
      `DEGRADED-LOUD (corrupt-record): the deny still names the unusable field as the reason for degraded mode — stderr: ${oneLine(r.stderr)}`
    );
    assert.match(
      r.stderr,
      /shared|per-run|per run|run-keyed|run keyed/i,
      `DEGRADED-LOUD (corrupt-record): and now ALSO names the shared/per-run fallback that made the record collide-prone in the first place — wording is free, both facts are not. stderr: ${oneLine(r.stderr)}`
    );
  } finally {
    cleanup();
  }
});
