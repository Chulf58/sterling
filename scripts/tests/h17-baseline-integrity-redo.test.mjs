// H17 BASELINE-INTEGRITY REDO — the (B) empty-at-rest baseline denial (board
// 880e0d7a) and the (A) `file_unattested` marker (board fabf21d8).
//
// WHAT THIS FILE PINS
//   A) An EMPTY-AT-REST (B) content baseline — a stable, well-formed `{}` an
//      audited agent can write into the temp record itself — must DENY, and
//      must remove NOTHING. Before the fix every live (B) file read as an
//      "unauthorized addition" against the empty baseline and was DELETED, so
//      the laundering primitive was also a destructive one.
//   B) The `file_unattested` marker in an (A) per-call state record is
//      ACCEPTED by the record validator (not refused as a stray field) and is
//      honoured by the comparison, plus the validator's two refusal shapes
//      (a non-literal marker value; a record carrying BOTH a digest and the
//      marker).
//
// WHICH BINARY THIS SPAWNS: the SOURCE hook, `scripts/hooks/h17-bash-write-sweep.mjs`
// (see HOOKS below) — never the esbuild-bundled `hooks/` copy. A stale bundle
// therefore cannot explain a failure here, and conversely a green here says
// nothing about the bundle that is actually installed.
//
// HARNESS is the idiom of scripts/tests/h17-percall-baseline.test.mjs
// (makeGitProject, one tool_use_id per lane carried by BOTH its Pre and its
// Post, oneLine, GIT_SKIP). It is copied rather than imported because that file
// exports nothing.
//
// THE TEMP RECORDS ARE FOUND BY SHAPE, NEVER BY FILENAME. `baselineRecord` and
// `stateRecord` below identify the (B) content baseline and the (A) per-call
// state record by the structure of their parsed contents. This is deliberate
// and must be preserved: the (B) baseline's key was changed once already
// (board 11609d1f, run-keyed -> per-call), and a filename-shaped finder turns
// every future re-key into a silently PASSING test that no longer finds
// anything to tamper with.
//
// Authored BLIND to the hook source per H4 — no implementation file was read.
//
// RUN COMMAND (node toolchain adapter):
//   node --test scripts/tests/h17-baseline-integrity-redo.test.mjs

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

// Derived from this file's own location — NEVER a hard-coded absolute path.
// The staged draft of this suite carried `/mnt/c/Users/cuj/Sterling` literally,
// which passes on exactly one machine and is a silent whole-file failure on
// every other (and on the native-Windows half of the standing 1:1 parity
// requirement).
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-06-10T12:00:00.000Z';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

// anti-pattern ee89c3fd: raw multi-line child-process stderr interpolated into
// an assertion message that FAILS poisons the TAP crash/assertion classifier,
// so a red pin reads as a CRASH instead of an assertion failure. Flatten
// whitespace, NEVER truncate.
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
    incidental_scope: ['src/types.ts'],
    out_of_scope: ['src/legacy/**'],
    phases: [{ phase_id: 'p1', goal: 'g', subtasks: [], ac_ids: ['AC1'], difficulty: { level: 'normal', reasons: [] }, model_hint: 'sonnet' }],
    decisions_made: [],
  };
}

const GIT_SKIP = (() => {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0 ? false : 'git not available';
})();

function git(dir, args, { must = false } = {}) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (must) assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${oneLine(r.stderr)}`);
  return r;
}

function makeGitProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h17-redo-'));
  const runId = 'r-h17redo-' + randomUUID().slice(0, 8);
  git(dir, ['init', '-q'], { must: true });
  git(dir, ['config', 'user.email', 'h17@sterling.test'], { must: true });
  git(dir, ['config', 'user.name', 'H17 Redo'], { must: true });
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.autocrlf', 'false'], { must: true });
  writeFileSync(join(dir, '.gitignore'), ['.claude/agents/', '.claude/settings.local.json', '.sterling/', ''].join('\n'));
  mkdirSync(join(dir, 'hooks'), { recursive: true });
  writeFileSync(join(dir, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [] } }, null, 2) + '\n');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'feature.ts'), 'export const x = 1;\n');
  git(dir, ['add', '-A'], { must: true });
  git(dir, ['commit', '-q', '-m', 'init'], { must: true });

  mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'agents', 'coder.md'), '# coder (legit)\n');
  writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify({ hooks: 'enabled' }) + '\n');
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
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
  const cleanup = () => {
    try {
      store.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
    for (const p of tempRecords(projectTag)) rmSync(p, { force: true });
  };
  return { dir, store, runId, projectTag, cleanup };
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

// The (B) content baseline: the temp record whose parsed value is an object
// whose KEYS are (B)-set paths and whose VALUES are strings (content digests).
// Found by shape, never by filename — see the header.
function baselineRecord(projectTag) {
  for (const p of tempRecords(projectTag)) {
    let v;
    try {
      v = JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      continue;
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const keys = Object.keys(v);
    if (keys.length && keys.every((k) => k.startsWith('.claude/') || k.startsWith('.sterling/')) && typeof v[keys[0]] === 'string') return p;
  }
  return null;
}

// The (A) per-call STATE record: keys are dirty repo-relative paths, values are
// state OBJECTS (which is what distinguishes it from the (B) baseline's
// strings). Found by shape, never by filename — see the header.
function stateRecord(projectTag) {
  for (const p of tempRecords(projectTag)) {
    let v;
    try {
      v = JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      continue;
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const keys = Object.keys(v);
    if (keys.length && keys.every((k) => v[k] && typeof v[k] === 'object' && 'exists' in v[k])) return p;
  }
  return null;
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

// =========================================================================
// A-CONTROL (the opposite-reason arm, placed FIRST): an untampered baseline on
// an untouched tree ALLOWS. Without this, a green on the deny arm below could
// be produced by a hook that denies everything in this fixture shape.
//
// SABOTAGE: make the (B) comparison deny unconditionally (e.g. `return false`
// from the baseline-equality check) -> this arm goes RED while A-DENY stays
// green, which is exactly the ambiguity this arm exists to remove.
// =========================================================================
test('A-CONTROL: untampered (B) baseline, nothing touched -> ALLOW', { skip: GIT_SKIP }, () => {
  const fx = makeGitProject();
  try {
    const L = lane('a-control');
    assert.equal(h17(fx.dir, 'PreToolUse', L).code, 0);
    const r = h17(fx.dir, 'PostToolUse', L);
    assert.equal(r.code, 0, `control must allow — ${oneLine(r.stderr)}`);
    assert.ok(existsSync(join(fx.dir, '.claude', 'agents', 'coder.md')), 'control leaves the (B) surface intact');
  } finally {
    fx.cleanup();
  }
});

// =========================================================================
// A-DENY: a CRAFTED EMPTY-AT-REST baseline ({} written by the audited agent
// into its own os.tmpdir() record) must DENY and must remove NOTHING. Before
// the fix every live (B) file read as an "unauthorized addition" against the
// empty baseline and was DELETED.
//
// ############ DO NOT "SIMPLIFY" THIS TEST TO ITS EXIT CODE ############
// THE VERDICT OF THIS PIN IS CARRIED SOLELY BY THE THREE `existsSync`
// SURVIVAL ASSERTIONS (and the byte-equality that follows them).
//
// MEASURED by the authoring lane: with the empty-baseline guard DELETED, the
// `assert.equal(r.code, 2)` assertion below STAYS GREEN. The reason is
// mechanical — without the guard the removal arm runs FIRST, deletes all three
// (B) files as "unauthorized additions", and THEN denies anyway because those
// removals are themselves recorded as violations. Exit 2 is therefore produced
// by BOTH the fixed and the broken hook, and cannot discriminate them.
//
// The two `assert.match` arms on stderr are likewise NOT the verdict: they are
// message-shape arms, satisfiable in principle by wording alone. Anyone who
// deletes the survival assertions "because exit 2 already covers it" converts
// this file into a test that passes while the destructive laundering primitive
// it was written to catch is fully live. Delete them only together with this
// comment and a replacement discriminator that has been mutation-checked.
// ######################################################################
//
// SABOTAGE (must make this go RED): remove the empty-at-rest baseline guard, so
// a `{}` baseline is treated as a legitimate pre-image -> the three
// `existsSync` assertions fire because the files were deleted as unauthorized
// additions. (Exit 2 does not move; see above.)
// =========================================================================
test('A-DENY: crafted EMPTY {} (B) baseline -> DENY, and ZERO (B) files removed', { skip: GIT_SKIP }, () => {
  const fx = makeGitProject();
  try {
    const L = lane('a-empty');
    assert.equal(h17(fx.dir, 'PreToolUse', L).code, 0);

    const bPath = baselineRecord(fx.projectTag);
    assert.ok(bPath, 'PRECONDITION: Pre wrote a (B) content baseline this test can find BY SHAPE (if this fires, the record shape moved — repair the finder, never switch it to a filename)');
    const before = JSON.parse(readFileSync(bPath, 'utf8'));
    assert.ok(Object.keys(before).length >= 2, `PRECONDITION: the real baseline is NON-empty (${Object.keys(before).join(', ')})`);
    writeFileSync(bPath, '{}'); // the craft: stable, well-formed, empty AT REST

    const r = h17(fx.dir, 'PostToolUse', L);

    // Supporting arms — NOT the verdict (see the block above).
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `an empty-at-rest baseline must DENY — ${oneLine(r.stderr)}`);
    assert.match(r.stderr, /records ZERO enforcement files/, 'the denial names the empty baseline as the cause');
    assert.match(r.stderr, /NOTHING WAS REMOVED/, 'the denial states that no file was removed');

    // ---- THE VERDICT OF THIS PIN ----
    assert.ok(
      existsSync(join(fx.dir, '.claude', 'agents', 'coder.md')),
      'VERDICT ARM 1/3: the agent file SURVIVES — it must not be deleted as an "unauthorized addition" against a crafted-empty baseline. This assertion, not the exit code, is what goes red when the guard is removed'
    );
    assert.ok(existsSync(join(fx.dir, '.claude', 'settings.local.json')), 'VERDICT ARM 2/3: settings.local.json SURVIVES');
    assert.ok(existsSync(join(fx.dir, '.sterling', 'config.json')), 'VERDICT ARM 3/3: .sterling/config.json SURVIVES');
    assert.equal(readFileSync(join(fx.dir, '.claude', 'agents', 'coder.md'), 'utf8'), '# coder (legit)\n', 'and its bytes are untouched — survival is not enough if the content was rewritten');
  } finally {
    fx.cleanup();
  }
});

// =========================================================================
// B: a `file_unattested` marker in the (A) state record must be ACCEPTED by the
// validator (not refused as a stray field) and must never be laundered into an
// "unchanged" verdict — so a file that is byte-identical at Post still DENIES.
//
// ############ KNOWN LIMIT OF THIS PIN — READ BEFORE TRUSTING IT ############
// THIS PIN IS PARTIALLY HOLLOW AND CANNOT DETECT THE MUTATION IT LOOKS LIKE IT
// GUARDS. Here the RECORDED side carries the marker while the CURRENT side is
// recomputed live and carries a REAL digest. With BOTH equality guards stripped
// (the `sameState` marker checks at h17-bash-write-sweep.mjs :1591 and :1600)
// the comparison becomes `undefined === '<sha>'` — false — so the hook denies
// anyway. It would pass for the WRONG REASON.
//
// What it DOES pin honestly, and what keeps it in the file:
//   * the record VALIDATOR accepts the marker shape rather than refusing it as
//     an unexpected field (the `doesNotMatch` arm below);
//   * with B-CONTROL beside it, that a pre-dirty path is not itself a denial.
//
// THE LAUNDERING THIS MARKER EXISTS TO PREVENT needs BOTH sides unattested
// (`undefined === undefined` reading as "unchanged" -> ALLOW), and the CURRENT
// side cannot be crafted by hand — it is recomputed by the hook. That case is
// pinned in scripts/tests/h17-concurrent-mutation-unattested.test.mjs, by a
// live detached appender that keeps the file unstable across BOTH checkpoints.
// That file, not this one, is the load-bearing pin for the :1591/:1600 guards.
// ##########################################################################
//
// SABOTAGE (must make this go RED): make the state-record validator refuse
// `file_unattested` as an unexpected field -> the `doesNotMatch` arm fires.
// NOT a sabotage this pin can see: stripping the two `sameState` marker guards
// (measured green — see above).
// =========================================================================
test('B: a recorded file_unattested state is accepted by the validator and an untouched file still DENIES', { skip: GIT_SKIP }, () => {
  const fx = makeGitProject();
  try {
    // Make a tracked enforcement path dirty so it lands in the (A) state record.
    const hooksJson = join(fx.dir, 'hooks', 'hooks.json');
    writeFileSync(hooksJson, JSON.stringify({ hooks: { PreToolUse: [], note: 'pre-dirty' } }, null, 2) + '\n');

    const L = lane('b-unattested');
    assert.equal(h17(fx.dir, 'PreToolUse', L).code, 0);

    const sPath = stateRecord(fx.projectTag);
    assert.ok(sPath, 'PRECONDITION: Pre wrote an (A) state record');
    const states = JSON.parse(readFileSync(sPath, 'utf8'));
    assert.ok(states['hooks/hooks.json'], `PRECONDITION: the pre-dirty path is recorded (${Object.keys(states).join(', ')})`);
    assert.equal(states['hooks/hooks.json'].type, 'file', 'PRECONDITION: recorded as a file with a digest');

    // Replace the digest with the unattested marker, exactly as the hook would
    // have written it had the file been mutating throughout the snapshot.
    delete states['hooks/hooks.json'].sha256;
    states['hooks/hooks.json'].file_unattested = 'file-bytes-unstable';
    writeFileSync(sPath, JSON.stringify(states));

    // NOTHING is touched inside the window: byte-identical at Post.
    const r = h17(fx.dir, 'PostToolUse', L);
    assert.notEqual(r.code, 1, 'a security gate never fails with a non-blocking exit 1');
    assert.equal(r.code, 2, `an unattested recorded state can never be "unchanged" — must DENY (${oneLine(r.stderr)})`);
    assert.doesNotMatch(
      r.stderr,
      /unexpected field 'file_unattested'/,
      'THE HONEST ARM OF THIS PIN: it must deny because the marker is HONOURED, not because the record shape was refused as stray. If this fires, the validator has not been taught the marker'
    );
  } finally {
    fx.cleanup();
  }
});

// =========================================================================
// B-CONTROL (the opposite-reason arm): the SAME fixture with the digest LEFT IN
// PLACE must ALLOW. This is what proves the deny above is the marker's doing
// and not "any pre-dirty path denies".
//
// SABOTAGE: make any pre-dirty path deny unconditionally -> this goes RED while
// B stays green.
// =========================================================================
test('B-CONTROL: the same untouched pre-dirty file with its digest intact ALLOWS', { skip: GIT_SKIP }, () => {
  const fx = makeGitProject();
  try {
    const hooksJson = join(fx.dir, 'hooks', 'hooks.json');
    writeFileSync(hooksJson, JSON.stringify({ hooks: { PreToolUse: [], note: 'pre-dirty' } }, null, 2) + '\n');
    const L = lane('b-control');
    assert.equal(h17(fx.dir, 'PreToolUse', L).code, 0);
    const r = h17(fx.dir, 'PostToolUse', L);
    assert.equal(r.code, 0, `an untouched pre-dirty path with a real digest must ALLOW — ${oneLine(r.stderr)}`);
  } finally {
    fx.cleanup();
  }
});

// =========================================================================
// B-STRAY (the validator's other direction): a marker with a NON-LITERAL value
// must be refused BY NAME — the literal check, not "some non-empty string".
//
// This closes the gap recorded as "FINDING D — NOT PINNED" in
// scripts/tests/h17-secure-io-slice1.test.mjs (~:1653). That note was right
// that exit 2 alone is worthless here (a tampered record denies BECAUSE it was
// tampered). The discriminator is the stderr arm: the denial must name the
// literal-value check specifically, which a generic tamper/mismatch denial does
// not do.
//
// SABOTAGE (must make this go RED): relax the validator from `=== 'file-bytes-unstable'`
// to `typeof v === 'string'` -> the record is accepted as a valid unattested
// state, the denial is produced by the ordinary marker-vs-digest mismatch
// instead, and the `assert.match` on the literal-value message fires.
// =========================================================================
test('B-STRAY: a file_unattested marker whose value is not the literal denies naming the marker', { skip: GIT_SKIP }, () => {
  const fx = makeGitProject();
  try {
    const hooksJson = join(fx.dir, 'hooks', 'hooks.json');
    writeFileSync(hooksJson, JSON.stringify({ hooks: { PreToolUse: [], note: 'pre-dirty' } }, null, 2) + '\n');
    const L = lane('b-stray');
    assert.equal(h17(fx.dir, 'PreToolUse', L).code, 0);
    const sPath = stateRecord(fx.projectTag);
    assert.ok(sPath, 'PRECONDITION: Pre wrote an (A) state record');
    const states = JSON.parse(readFileSync(sPath, 'utf8'));
    delete states['hooks/hooks.json'].sha256;
    states['hooks/hooks.json'].file_unattested = 'not-the-literal';
    writeFileSync(sPath, JSON.stringify(states));
    const r = h17(fx.dir, 'PostToolUse', L);
    assert.equal(r.code, 2, `a non-literal marker must DENY — ${oneLine(r.stderr)}`);
    assert.match(
      r.stderr,
      /'file_unattested' marker is not the literal/,
      `THE VERDICT ARM: exit 2 is produced by any mismatch, so it cannot carry this pin — the denial must name the LITERAL-VALUE check. Actual stderr: ${oneLine(r.stderr)}`
    );
  } finally {
    fx.cleanup();
  }
});

// =========================================================================
// B-BOTH: a record carrying BOTH a digest and the marker is a shape no
// comparison speaks for — refused by name, never silently resolved in favour of
// one of the two fields.
//
// SABOTAGE (must make this go RED): make the validator prefer `sha256` when
// both are present (or ignore the marker when a digest exists) -> the record
// validates, the file is byte-identical, the comparison says "unchanged", the
// hook ALLOWS, and both the exit-code arm and the message arm fire.
// =========================================================================
test('B-BOTH: a file state carrying BOTH sha256 and the marker is refused by name', { skip: GIT_SKIP }, () => {
  const fx = makeGitProject();
  try {
    const hooksJson = join(fx.dir, 'hooks', 'hooks.json');
    writeFileSync(hooksJson, JSON.stringify({ hooks: { PreToolUse: [], note: 'pre-dirty' } }, null, 2) + '\n');
    const L = lane('b-both');
    assert.equal(h17(fx.dir, 'PreToolUse', L).code, 0);
    const sPath = stateRecord(fx.projectTag);
    assert.ok(sPath, 'PRECONDITION: Pre wrote an (A) state record');
    const states = JSON.parse(readFileSync(sPath, 'utf8'));
    states['hooks/hooks.json'].file_unattested = 'file-bytes-unstable';
    writeFileSync(sPath, JSON.stringify(states));
    const r = h17(fx.dir, 'PostToolUse', L);
    assert.equal(r.code, 2, `both-fields must DENY — ${oneLine(r.stderr)}`);
    assert.match(
      r.stderr,
      /BOTH a sha256 digest and the 'file_unattested' marker/,
      `THE VERDICT ARM: the denial must name the contradiction — exit 2 alone would also be produced by a hook that simply preferred one field and then found a mismatch. Actual stderr: ${oneLine(r.stderr)}`
    );
  } finally {
    fx.cleanup();
  }
});
