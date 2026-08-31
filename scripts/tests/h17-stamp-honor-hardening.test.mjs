// H17 stamp-honor HARDENING — decision h17-stamp-honor-loud-restore (4d9b76e8)
// + six adjudicated review fixes. NOT YET IMPLEMENTED (a parallel fix is
// landing in scripts/hooks/h17-bash-write-sweep.mjs; this file is authored
// BLIND to that hook per H4 — no hook source was read to write these pins).
//
// PINS COVERED (from the test-writer brief, 2026-08-22):
//   H1 — a Post deny under a broken store (store/resolveRun throws) for an
//        unstamped in-window tracked enforcement change must be LOUD: stderr
//        carries BOTH the environment-defect wording
//        "Enforcement verification failed (store/resolveRun threw (" AND the
//        restored path, in the same deny message — restore is never
//        invisible just because the store is broken.
//   H2 — when a (A) tracked restore succeeds AND the (B) gitignored-baseline
//        stage independently denies in the SAME Post call, the
//        restore_performed maintenance item for the (A)-restored path must
//        still exist afterward (the mint is not skipped/short-circuited by a
//        second, unrelated deny reason).
//   H3 — SKIPPED. "brief-throw keeps its label" requires knowing which
//        internal label a brief-resolution throw carries today; that is
//        hook-internal knowledge unreachable while blind per H4. Not
//        written, per the test-writer brief's explicit instruction.
//   H4 — an attested DELETION (`{path, deleted:true}`) for a tracked
//        enforcement file deleted DURING the window (after Pre, before
//        Post — not pre-existing dirt) is honored: the file is NOT
//        resurrected by a restore, and no deny names it.
//   H5 — an in-window UNTRACKED directory under the enforcement surface with
//        EVERY child file stamp-attested (sha256 over raw bytes) survives a
//        Post sweep whole; the SAME shape with one unstamped child is swept
//        (directory removed recursively) and denied, exactly as an
//        unattested untracked directory is today (AC3(c) shape).
//
// Harness is a faithful, byte-for-byte copy of
// scripts/tests/h17-stamp-honor.test.mjs's fixture (temp git repo,
// projectTag-derived baseline/dirty temp paths, Pre-then-mutate-then-Post
// invocation, stamp fabrication helpers) so this file stays behaviorally
// consistent with its sibling. RUN COMMAND (node toolchain adapter): `node
// --test scripts/tests/h17-stamp-honor-hardening.test.mjs`.
//
// Per-test EXPECTED FAILURE SHAPE is documented immediately above each test.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
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

// Mirrors h17-stamp-honor.test.mjs's node-adapter brief fixture exactly.
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

// run git in `dir` (setup helper — never silently swallows a setup failure: P5)
function git(dir, args, { must = false } = {}) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (must) assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r;
}

// Build a git-backed project with a live Sterling store + active run — a
// faithful mirror of h17-stamp-honor.test.mjs's makeGitProject (same
// fixture shape, same .gitignore, same TRACKED hooks/ + src/ + tests/
// layout, same GITIGNORED .claude/agents + .claude/settings.local.json +
// .sterling/ layout, same projectTag-derived baseline/dirty temp paths).
function makeGitProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h17-stamp-hard-'));
  const runId = 'r-h17sh-' + randomUUID().slice(0, 8);

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

  // gitignored (B) baseline surface — present so the (B) stage can snapshot
  // a baseline at Pre (mirrors enforcement.test.mjs's AC8 fixture).
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
  const cleanup = () => {
    closeStore();
    rmSync(dir, { recursive: true, force: true });
    rmSync(baselinePath, { force: true });
    rmSync(dirtyPath, { force: true });
  };
  return { dir, store, runId, dbPath, baselinePath, dirtyPath, closeStore, cleanup };
}

// run h17 in Pre (snapshot) or Post (verify+sweep) mode. agent_id via `over`.
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
      tool_input: { command: 'node --test src/x.mjs' },
      ...(event === 'PostToolUse' ? { tool_response: { stdout: '', stderr: '' } } : {}),
      ...over,
    },
    dir
  );
}

const A1 = { agent_id: 'a1' };

// DELETED S4: stampPath/writeStamp/sha256Of are unused now that PIN H1 is the
// sole survivor (it never consults a stamp).

// =========================================================================
// PIN H1 — LOUD RESTORE UNDER A BROKEN STORE: an unstamped in-window tracked
// tamper still restores + denies even when store/resolveRun throws, and the
// deny message BOTH carries the pinned environment-defect wording and names
// the restored path in that SAME message — a broken store must never make
// the restore invisible.
//
// EXPECTED FAILURE SHAPE (RED): today's H17 already denies+restores under a
// corrupt store (per the sibling suite's PIN5 / enforcement.test.mjs AC9d),
// but there is no pinned requirement yet that the deny message spell out
// "Enforcement verification failed (store/resolveRun threw (" verbatim
// alongside the path. Most likely failure: `assert.match(r.stderr,
// /Enforcement verification failed \(store\/resolveRun threw \(/)` fires
// because today's message uses different wording (e.g. a generic "store
// error" phrase) — the regex simply does not match today's stderr string.
// =========================================================================

// RE-CUT per dc616f69: the restore is deleted, so the "restored path" half of
// this pin becomes "the path named in the SAME message, bytes left on disk".
// The load-bearing property is unchanged and untouched by the ruling: a broken
// store must not make the finding invisible.
test('PIN H1 (loud detection under a broken store): deny stderr carries BOTH the environment-defect wording and the offending path in the same message', { skip: GIT_SKIP }, () => {
  const { dir, cleanup, closeStore, dbPath } = makeGitProject();
  try {
    const hooksJson = join(dir, 'hooks', 'hooks.json');
    const origJson = readFileSync(hooksJson, 'utf8');

    assert.equal(h17(dir, 'PreToolUse', A1).code, 0, 'Pre snapshot succeeds');
    // unstamped in-window tracked enforcement-file change — no stamp at all
    const tampered = JSON.stringify({ hooks: {}, TAMPERED: true });
    writeFileSync(hooksJson, tampered);

    // break the store so resolveRun throws (same technique as the sibling
    // suite's PIN5 / enforcement.test.mjs AC9d): close the fixture's handle,
    // drop -wal/-shm, overwrite the db file with non-sqlite bytes.
    closeStore();
    rmSync(dbPath + '-wal', { force: true });
    rmSync(dbPath + '-shm', { force: true });
    writeFileSync(dbPath, 'this is not a sqlite database — resolveRun must throw');

    const r = h17(dir, 'PostToolUse', A1);
    assert.notEqual(r.code, 1, 'a broken store must never produce a non-blocking exit 1');
    assert.equal(r.code, 2, `detection must still deny under a broken store — ${r.stderr}`);
    // dc616f69 R11: inverted from "restored to HEAD" — the bytes stay exactly
    // as the command wrote them, and the deny must say so out loud anyway.
    assert.equal(readFileSync(hooksJson, 'utf8'), tampered, 'the tracked file is LEFT ON DISK as written despite the store throw — no restore, ever');
    assert.notEqual(readFileSync(hooksJson, 'utf8'), origJson, 'and specifically NOT put back to the committed image');
    assert.match(
      r.stderr,
      /Enforcement verification failed \(store\/resolveRun threw \(/,
      'the deny carries the pinned environment-defect wording verbatim'
    );
    assert.match(r.stderr, /hooks\.json/, 'the SAME deny message names the offending path');
  } finally {
    cleanup();
  }
});

// DELETED S4 (decision 78dc9bd6/fe861066): PIN H2, PIN H3 (already unauthored),
// PIN H4 and PIN H5a/H5b all pinned FIX-A/FIX-B stamp-honor behaviour —
// scripts/enforcement-stamp.mjs and every stamp-exemption route are deleted
// outright, so there is nothing left for any of these pins to exempt. PIN H1
// above is the sole survivor: it is comparator-independent (a broken-store
// detection-is-still-loud pin, not a stamp-honor pin) and stays exactly as
// written.
