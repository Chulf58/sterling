// H17 — BACKSLASH NON-INJECTIVITY (a literal backslash byte in a POSIX filename
// must never collapse two DISTINCT files onto one authorization key).
//
// THE DEFECT THIS FILE PINS (reverted twice; this is the third attempt at a
// correct fix, and this file exists so a future attempt cannot silently
// regress it). On POSIX a backslash is a perfectly legal filename byte — only
// `/` and NUL are forbidden. Somewhere in H17's path handling (the per-call
// STATE record for the (A) tracked-write sweep, and/or the (B) content
// baseline's collection walk) a path gets its backslashes turned into forward
// slashes — most plausibly via the shared cross-platform path-normalization
// invariant (packages/schemas, CLAUDE.md invariant #2: "every path is
// stored/compared repo-relative with forward slashes"), which is CORRECT for
// a Windows-style separator but WRONG when the backslash is not a separator
// at all but a literal byte inside a POSIX filename. The observable
// consequence: `hooks/a\b.mjs` and `hooks/a/b.mjs` (or `.claude/agents/a\b.md`
// and `.claude/agents/a/b.md`) can be made to share one authorization key, so
// a tamper/attestation on one compares as "unchanged" against its sibling's
// bytes and a restore can land on the WRONG PATH — a silent-tamper hole.
//
// REQUIRED (SPEC-LEVEL) BEHAVIOUR PINNED HERE, PER SITE (SPEC CLARIFIED,
// research_finding 75e1926a — roster-correctness + Codex outside-family
// review, both converged, superseding this file's own earlier "kept distinct
// OR refused" framing):
//   PIN-A (the (A) per-call STATE record) — the two paths must be kept
//     DISTINCT identities: each restores to its OWN pre-image, its sibling
//     is never touched. A restore that writes one path's original bytes into
//     the OTHER path is the silent-tamper hole this pin catches.
//   PIN-B (the (B) baseline COLLECTION walk) — FAIL-CLOSED DENY, not distinct
//     keying: 75e1926a traces the collision through THREE sites, and shows a
//     per-key validator is DEAD CODE on this flow because `toRel()` already
//     collapses `\` to `/` (correctly, for Windows) before any validator
//     runs — so the only fix that closes the hole at its actual site is
//     `collectBaseline` refusing a backslash-bearing directory-entry name on
//     sight, on POSIX, before `toRel` ever sees it. The refusal must not
//     mutate the tree (fail-closed means deny the call, not rewrite the path).
//
// TWO PINS, per the assignment:
//   PIN-A-STATE-KEY  — the (A) tracked-write sweep's per-call STATE record
//                       (a porcelain/git-tracked path under hooks/, the
//                       enforcement surface H17's (A) side watches).
//   PIN-B-BASELINE-KEY — the (B) content baseline's COLLECTION walk of
//                       `.claude/agents/**` (gitignored, recursive readdir).
//                       This is the one the assignment says was missing.
// Both are skipped entirely on native Windows: NTFS forbids a literal
// backslash byte in a filename (it IS the separator there), so the injection
// this file exists to pin is meaningless on that platform.
//
// Neither pin asserts a specific internal function, map shape, or filename —
// per H4, this file was authored BLIND to scripts/hooks/h17-bash-write-sweep.mjs;
// every expectation is the OBSERVABLE restore/deny/untouched-sibling behaviour
// through the real Pre/Post hook invocations, never a peek at an internal key.
//
// HARNESS is a faithful copy of scripts/tests/h17-percall-baseline.test.mjs's
// and scripts/tests/h17-baseline-ancestor.test.mjs's idiom (makeGitProject,
// one tool_use_id per lane carried by both its Pre and its Post, oneLine,
// GIT_SKIP, spawnSync against scripts/hooks/h17-bash-write-sweep.mjs, the
// SterlingStore import pattern, NOW constant) — NOT imported, since neither
// file exports anything.
//
// STATUS (2026-08-26, fix now APPLIED): PIN-B is red-on-HEAD / green-on-fixed
// and mutation-verified — it carries the teeth. PIN-A passes on HEAD too (the
// (A) collision is interface-unfalsifiable — see its own block below) and is a
// deny-behaviour regression guard, not a fix-isolating pin. Do not make any pin
// pass by editing this file — fix the hook, or (if truly wrong) bring the
// disagreement back for review.
//
// RUN COMMAND (node toolchain adapter):
//   node --test scripts/tests/h17-backslash-non-injectivity.test.mjs

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
// classifier. Every assertion here is expected to fail today, so this is
// load-bearing. Flatten whitespace, NEVER truncate.
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

// Native Windows makes this pin meaningless (backslash IS the separator, so
// `writeFileSync(join(dir,'a\\b.mjs'))` would create a subdirectory `a`
// containing `b.mjs`, not a literal-backslash filename) and NTFS forbids the
// byte outright. Skip loudly rather than fake it — P5.
const BACKSLASH_SKIP = (() => {
  if (process.platform === 'win32') {
    return 'a literal backslash byte is illegal in NTFS filenames and IS the path separator on native Windows — this POSIX-only injection cannot be constructed there';
  }
  try {
    const d = mkdtempSync(join(tmpdir(), 'sterling-bslash-probe-'));
    // 'a\\b.probe' is the JS source for the 7-byte string a \ b . p r o b e —
    // ONE path segment holding a literal backslash byte, not two segments.
    const literalName = 'a\\b.probe';
    const p = join(d, literalName);
    writeFileSync(p, 'x');
    const listed = readdirSync(d);
    const ok = existsSync(p) && readFileSync(p, 'utf8') === 'x' && listed.includes(literalName) && listed.length === 1;
    rmSync(d, { recursive: true, force: true });
    return ok ? false : `a literal-backslash filename could not be created/verified as ONE entry on this filesystem (readdir saw: ${listed?.join(', ')})`;
  } catch (e) {
    return `a literal-backslash filename is unavailable on this host (${e.code ?? e.message})`;
  }
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
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h17-bslash-'));
  const runId = 'r-h17bs-' + randomUUID().slice(0, 8);

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

const SKIP = { skip: GIT_SKIP || BACKSLASH_SKIP };

// =========================================================================
// PIN-A-STATE-KEY-BACKSLASH-NON-INJECTIVITY — the (A) tracked-write sweep's
// per-call STATE tracking (the porcelain-derived dirty-set H17 uses to
// attribute a newly-dirty enforcement-surface path to the command's own
// window) must not conflate `hooks/a\b.mjs` (literal backslash byte) with
// `hooks/a/b.mjs` (a real subdirectory). Both are committed, tracked, clean
// at HEAD. Only the backslash-named file is tampered inside lane L's own
// window; the real-subdirectory sibling is never touched by this test.
//
// A correct (non-colliding) implementation: Post denies (hooks/ changed
// inside the window) and leaves `hooks/a\b.mjs` exactly as the command wrote
// it, leaving `hooks/a/b.mjs` completely untouched throughout.
//
// RE-CUT 2026-08-30 per dc616f69 (the (A) arm stops restoring). This block
// USED to assert `hooks/a\b.mjs` is "restored to ITS OWN pre-image, never the
// sibling's bytes via a colliding key". `restoreTracked` is deleted, so the
// self-restore assertion is inverted to leave-as-written.
//
// *** AND THE HONEST CONSEQUENCE, WHICH MUST NOT BE PAPERED OVER: after the
// excision NO ASSERTION IN THIS BLOCK GOES RED UNDER A KEY COLLISION ALONE. ***
// The header below already recorded that the collision is
// INTERFACE-UNFALSIFIABLE on the (A) surface (both HEAD and the fixed hook DENY
// via different internal paths, identical observable). The restore was the LAST
// place a collision could still have shown itself on disk — "restored to the
// SIBLING's bytes" was a real, observable failure mode — and deleting the
// restore deletes that observability with it. What remains (sibling untouched,
// tampered path untouched) is now true BY DELETION for every path in the repo,
// so it is a regression tripwire against a restore arm returning, NOT evidence
// about key identity. A denial-CONTENT oracle (does the message name
// `hooks/a\b.mjs` or the normalized `hooks/a/b.mjs`?) is the only candidate
// left, and it is NOT authored here: it asserts against wording this slice is
// still settling, and a red from it could not be told apart from ordinary
// path-printing behaviour that predates this ruling. THE REAL TEETH REMAIN
// PIN-B BELOW (the (B) collectBaseline readdir throw — red-on-HEAD,
// green-on-fixed, mutation-verified), which this ruling does not touch.
//
// HONEST STATUS — THIS TEST IS A DENY-BEHAVIOUR REGRESSION GUARD, NOT A
// FIX-ISOLATING PIN. It was authored blind expecting RED-on-HEAD, but a
// debugger investigation (2026-08-26) PROVED it is GREEN on pristine HEAD too:
// the (A) validateStateKey backslash reject is INTERFACE-UNFALSIFIABLE. A
// recorded backslash path cannot populate the normalized preState slot (the
// collision) without ALSO tripping the fail-closed "no pre-state entry" throw,
// so both HEAD and the fixed hook DENY (exit 2) — via different internal paths,
// but identical observable. There is no one-line sabotage of the validator that
// flips this test alone; do NOT claim there is. What it still legitimately
// guards: a backslash-tampered tracked enforcement file is DENIED and its
// real-subdirectory sibling is left untouched — a true invariant worth pinning
// against future regression, just not attributable to the validateStateKey edit.
// The validateStateKey/validateBaselineKey rejects are kept as DEFENSE-IN-DEPTH
// (see the annotated hook comments: attacker-writable os.tmpdir() records, and a
// future refactor normalizing preDirty or softening that throw would unmask a
// real silent-tamper false-ALLOW). THE REAL TEETH FOR THE FIX LIVE IN PIN-B
// BELOW (the (B) collectBaseline readdir throw: red-on-HEAD, green-on-fixed,
// mutation-verified) — the surface where the collision IS interface-observable.
// =========================================================================

test(
  "PIN-A-STATE-KEY-BACKSLASH-NON-INJECTIVITY: hooks/a\\b.mjs (literal backslash) and hooks/a/b.mjs (real subdir) never share one (A) state-tracking identity",
  SKIP,
  () => {
    const fx = makeGitProject();
    const { dir, cleanup } = fx;
    try {
      const AB_BYTES = '// AB — hooks/a\\b.mjs, a literal-backslash filename that owns its own identity\n';
      const AB_TAMPERED = "// AB — TAMPERED inside lane L's own window\n";
      const SUBB_BYTES = '// SUBB — hooks/a/b.mjs, a real subdirectory file that must never be touched\n';
      assert.notEqual(AB_BYTES, SUBB_BYTES, 'PRECONDITION: the two siblings hold distinct bytes so a cross-path swap is observable');

      const abPath = join(dir, 'hooks', 'a\\b.mjs'); // ONE path segment: literal backslash byte
      const subDir = join(dir, 'hooks', 'a');
      const subPath = join(subDir, 'b.mjs');
      mkdirSync(subDir, { recursive: true });
      writeFileSync(abPath, AB_BYTES);
      writeFileSync(subPath, SUBB_BYTES);
      git(dir, ['add', '-A'], { must: true });
      git(dir, ['commit', '-q', '-m', 'add colliding-key siblings under hooks/'], { must: true });
      assert.equal(
        porcelain(dir),
        '',
        'PRECONDITION AND CAUSE ISOLATION: both siblings are committed and tracked, tree starts clean — nothing here is decided by pre-existing dirt'
      );

      const L = lane('state-key');
      assert.equal(h17(dir, 'PreToolUse', L).code, 0, "Pre observes both hooks/ paths clean and tracked");

      writeFileSync(abPath, AB_TAMPERED); // tamper ONLY the backslash-named file, inside L's own window
      // the real-subdirectory sibling is deliberately never touched by this test

      const post = h17(dir, 'PostToolUse', L);
      assert.notEqual(post.code, 1, 'a security gate never fails with a non-blocking exit 1');
      assert.equal(
        post.code,
        2,
        `hooks/ is enforcement surface and hooks/a\\b.mjs changed inside lane L's own window — must deny — actual ${post.code}, stderr: ${oneLine(post.stderr)}`
      );

      assert.equal(
        readFileSync(subPath, 'utf8'),
        SUBB_BYTES,
        "PIN (sibling untouched): hooks/a/b.mjs was never touched by this test and must remain byte-identical to SUBB_BYTES — now defended BY DELETION of the restore chain (dc616f69 R11) rather than by key identity, so read this as a tripwire against a restore arm returning, never as evidence that the keys stayed distinct"
      );
      assert.equal(
        readFileSync(abPath, 'utf8'),
        AB_TAMPERED,
        "PIN (left as written, dc616f69 R11 — inverted from 'restored to ITS OWN pre-image'): hooks/a\\b.mjs keeps exactly the bytes the command wrote. The old assertion's discriminating power — a colliding key restoring the SIBLING's bytes here — died with the restore, which is why the honest header above declines to claim this block still catches a collision"
      );
    } finally {
      cleanup();
    }
  }
);

// =========================================================================
// PIN-B-BASELINE-KEY-BACKSLASH-NON-INJECTIVITY — SPEC CLARIFIED (research_finding
// 75e1926a, roster-correctness + Codex outside-family review, both converged):
// the required fix is FAIL-CLOSED DENY, not "kept distinct". The (B) content
// baseline's COLLECTION walk (`.claude/agents/**`, gitignored, recursive
// readdirSync) must REFUSE a backslash-bearing directory-entry name on sight,
// on POSIX, BEFORE any path built from it is ever used as a map key — never
// collect it under a distinct key, never normalize it. This mirrors PIN-A's
// deny shape exactly (75e1926a: "COMPLETE FIX ... mirroring the validators,
// throw the same fail-closed deny").
//
// WHY "kept distinct" was rejected as a satisfying fix: 75e1926a traces the
// non-injectivity through THREE sites, not two — `toRel()` normalizes `\` to
// `/` (needed for Windows, where backslash IS the separator and is illegal in
// an NTFS filename, so this normalize is safe there and must stay), and
// `collectBaseline` keys its (B) content map by `toRel(cwd, abs)` — so on
// POSIX the collision happens BEFORE any per-key validator ever runs; a
// validator-only reject is dead code on this flow. The only fix that closes
// the hole at its actual site is refusing the raw `de.name` the instant
// `collectBaseline`'s own readdir walk sees a backslash byte in it.
//
// CONTROL ARM, PLACED FIRST, because "Pre denied" has more than one possible
// cause here: a fixture-level misconfiguration could deny for an unrelated
// reason, in which case the treatment arm's denial would prove nothing about
// the backslash entry specifically. The control runs the identical fixture
// MINUS the backslash-bearing file (only the real subdirectory sibling
// present) and requires Pre to ALLOW, so the treatment arm's denial below is
// legible as being ABOUT the backslash entry.
//
// THE PROPERTY THAT CANNOT BE FAKED BY A DENY THAT ALSO CORRUPTS: a fail-closed
// refusal must refuse the CALL, not mutate the tree. Both on-disk siblings —
// the refused backslash file and the legitimate real-subdirectory file — must
// be byte-identical to what they were before Pre ran; a "deny that also
// deletes/rewrites/normalizes the offending path in place" is not fail-closed,
// it is a different, undisclosed mutation smuggled in behind a correct exit code.
//
// EXPECTED FAILURE SHAPE (RED TODAY — 75e1926a states attempt 2's validator
// reject is dead code on this exact flow, so on unfixed HEAD `collectBaseline`
// still reaches `toRel`, the collision, and an ALLOW): `assert.equal(pre.code,
// 2, ...)` fires first, holding actual `0`.
//
// SABOTAGE (once green): remove the backslash reject from collectBaseline's
// `.claude/agents/**` readdir walk (i.e. let a `de.name` containing `\`
// reach `toRel`/the map key unchecked). Pre goes back to exit 0 and the
// collision reappears — this assertion must flip RED under that one-line
// change; the two untouched-sibling assertions stay green (deletion alone
// doesn't move them), which is expected and does not make them hollow — they
// pin a DIFFERENT property (no mutation on deny) that this sabotage does not
// touch.
// =========================================================================

test(
  'PIN-B-BASELINE-KEY-BACKSLASH-NON-INJECTIVITY: CONTROL — Pre ALLOWS a normal .claude/agents/** containing only a real subdirectory file, no backslash entry present',
  SKIP,
  () => {
    const { dir, cleanup } = makeGitProject();
    try {
      const SUBB2_BYTES = '# SUBB2 — .claude/agents/a/b.md, a real subdirectory file that must never be touched\n';
      const subDir2 = join(dir, '.claude', 'agents', 'a');
      mkdirSync(subDir2, { recursive: true });
      writeFileSync(join(subDir2, 'b.md'), SUBB2_BYTES);

      const M0 = lane('baseline-key-control');
      const pre0 = h17(dir, 'PreToolUse', M0);
      assert.equal(
        pre0.code,
        0,
        `CONTROL: Pre must ALLOW when .claude/agents/** contains a real subdirectory file and no backslash-bearing entry — actual ${pre0.code}, stderr: ${oneLine(pre0.stderr)}`
      );
    } finally {
      cleanup();
    }
  }
);

test(
  'PIN-B-BASELINE-KEY-BACKSLASH-NON-INJECTIVITY: a backslash-bearing .claude/agents/a\\b.md is refused FAIL-CLOSED at Pre — never collected, never normalized, and the tree is left untouched',
  SKIP,
  () => {
    const { dir, cleanup } = makeGitProject();
    try {
      const AB2_BYTES = '# AB2 — .claude/agents/a\\b.md, a literal-backslash filename refused on sight\n';
      const SUBB2_BYTES = '# SUBB2 — .claude/agents/a/b.md, a real subdirectory file that must never be touched\n';
      assert.notEqual(AB2_BYTES, SUBB2_BYTES, 'PRECONDITION: the two siblings hold distinct bytes so any mutation on deny is observable');

      const agentsDir = join(dir, '.claude', 'agents');
      const abPath2 = join(agentsDir, 'a\\b.md'); // ONE path segment: literal backslash byte
      const subDir2 = join(agentsDir, 'a');
      const subPath2 = join(subDir2, 'b.md');
      mkdirSync(subDir2, { recursive: true });
      writeFileSync(abPath2, AB2_BYTES);
      writeFileSync(subPath2, SUBB2_BYTES);

      assert.equal(
        existsSync(abPath2) && existsSync(subPath2),
        true,
        'PRECONDITION: both siblings exist on disk before Pre ever runs'
      );
      assert.equal(
        porcelain(dir),
        '',
        'PRECONDITION AND CAUSE ISOLATION: .claude/agents/** is gitignored, so nothing here is decided by the (A) tracked-write sweep'
      );

      const M = lane('baseline-key');
      const pre = h17(dir, 'PreToolUse', M);

      assert.notEqual(pre.code, 1, 'a security gate never fails with a non-blocking exit 1');
      assert.equal(
        pre.code,
        2,
        `FAIL-CLOSED: collectBaseline's .claude/agents/** walk must refuse the backslash-bearing entry a\\b.md the moment its readdir sees it — never collected, never normalized to a shared key — actual ${pre.code}, stderr: ${oneLine(pre.stderr)}`
      );

      assert.equal(
        readFileSync(abPath2, 'utf8'),
        AB2_BYTES,
        'the denied Pre must not mutate the very file it refused — fail-closed means REFUSE THE CALL, never write, delete, or normalize the offending path in place'
      );
      assert.equal(
        readFileSync(subPath2, 'utf8'),
        SUBB2_BYTES,
        'the denied Pre must not touch the legitimate real-subdirectory sibling either — refusing the backslash entry denies the WHOLE call, it does not selectively mutate anything else on disk'
      );
    } finally {
      cleanup();
    }
  }
);

// =========================================================================
// PIN-C-SETTINGS-KEY-BACKSLASH-NON-INJECTIVITY — the (B) baseline surface's
// OTHER collection site: `.claude/settings*.json`. H17 collects these files
// into the (B) content baseline the same way it collects `.claude/agents/**`
// (PIN-B above). This is the FOURTH normalization site the outside-family
// review found, distinct from PIN-B's `.claude/agents/**` readdir walk: a
// POSIX top-level `.claude` directory entry whose name LEXICALLY matches
// `settings*.json` (starts with "settings", ends with ".json") but contains a
// literal backslash byte in between (e.g. `.claude/settings\evil.json`) must
// be REFUSED FAIL-CLOSED at Pre (exit 2) the instant the settings-loop's own
// readdir/glob sees it — never silently skipped from the baseline.
//
// WHY SILENT OMISSION IS THE HOLE, NOT MERE MISS: the shared glob matcher
// normalizes `\` -> `/` internally (correct for Windows, where backslash IS
// the separator — CLAUDE.md invariant #2). Without a guard, a name like
// `settings\evil.json` gets rewritten to `settings/evil.json` before the
// glob test runs, that rewritten form FAILS the `settings*.json` glob (it now
// has a `/` in it), and the file is silently OMITTED from the baseline
// entirely — not denied, not collected, just invisible. A file invisible to
// the baseline is a file whose tampering neither Pre nor Post can ever see.
// This mirrors PIN-B's fix shape exactly: refuse the raw directory-entry name
// on sight, on POSIX, before it is ever run through the glob/normalize path.
//
// CONTROL ARM, PLACED FIRST, for the same reason as PIN-B's: "Pre allowed"
// alone doesn't prove the settings-loop guard is even reachable in this
// fixture. The control is the UNMODIFIED default fixture — makeGitProject()
// already writes a normal `.claude/settings.local.json` with no backslash —
// and requires Pre to ALLOW, so the treatment arm's DENIAL below is legible
// as being ABOUT the backslash-bearing settings file specifically, not about
// the settings surface being denied unconditionally.
//
// THE PROPERTY THAT CANNOT BE FAKED BY A DENY THAT ALSO CORRUPTS: exactly
// PIN-B's shape — a fail-closed refusal must refuse the CALL, not mutate the
// tree. Both the legitimate `.claude/settings.local.json` and the offending
// `.claude/settings\evil.json` must be byte-identical to what they were
// before Pre ran.
//
// SABOTAGE (once green): remove the backslash reject from the settings-loop's
// `.claude/settings*.json` collection walk (i.e. let a raw entry name
// containing `\` reach the glob-normalize path unchecked, where it silently
// fails the glob and is dropped). Pre goes back to exit 0 for the treatment
// arm and the backslash-bearing settings file is silently omitted from the
// baseline again — this assertion must flip RED under that one-line change.
// The untouched-bytes assertions are not expected to move under this
// particular sabotage (an omission doesn't mutate anything either); they pin
// the separate no-corruption property, same division as PIN-B.
// =========================================================================

test(
  'PIN-C-SETTINGS-KEY-BACKSLASH-NON-INJECTIVITY: CONTROL — Pre ALLOWS the normal .claude/settings.local.json baseline surface, no backslash-bearing settings file present',
  SKIP,
  () => {
    const { dir, cleanup } = makeGitProject();
    try {
      const N = lane('settings-key-control');
      const pre0 = h17(dir, 'PreToolUse', N);
      assert.equal(
        pre0.code,
        0,
        `CONTROL: Pre must ALLOW when .claude/settings*.json contains only the normal settings.local.json and no backslash-bearing entry — actual ${pre0.code}, stderr: ${oneLine(pre0.stderr)}`
      );
    } finally {
      cleanup();
    }
  }
);

test(
  'PIN-C-SETTINGS-KEY-BACKSLASH-NON-INJECTIVITY: a backslash-bearing .claude/settings\\evil.json is refused FAIL-CLOSED at Pre — never collected into the baseline, never normalized, and the tree is left untouched',
  SKIP,
  () => {
    const { dir, cleanup } = makeGitProject();
    try {
      const LOCAL_BYTES = readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8');
      const EVIL_BYTES = '{"evil":"settings\\\\evil.json, a literal-backslash filename lexically matching settings*.json, refused on sight"}\n';
      assert.notEqual(LOCAL_BYTES, EVIL_BYTES, 'PRECONDITION: the two settings files hold distinct bytes so any mutation on deny is observable');

      const claudeDir = join(dir, '.claude');
      const localPath = join(claudeDir, 'settings.local.json');
      const evilPath = join(claudeDir, 'settings\\evil.json'); // ONE path segment: "settings" + literal backslash + "evil.json"
      writeFileSync(evilPath, EVIL_BYTES);

      assert.equal(
        existsSync(localPath) && existsSync(evilPath),
        true,
        'PRECONDITION: both settings files exist on disk before Pre ever runs'
      );

      const M = lane('settings-key');
      const pre = h17(dir, 'PreToolUse', M);

      assert.notEqual(pre.code, 1, 'a security gate never fails with a non-blocking exit 1');
      assert.equal(
        pre.code,
        2,
        `FAIL-CLOSED: the settings-loop's .claude/settings*.json collection must refuse the backslash-bearing entry settings\\evil.json the moment its readdir/glob sees it — never collected, never silently omitted via a failed post-normalize glob test — actual ${pre.code}, stderr: ${oneLine(pre.stderr)}`
      );

      assert.equal(
        readFileSync(evilPath, 'utf8'),
        EVIL_BYTES,
        'the denied Pre must not mutate the very file it refused — fail-closed means REFUSE THE CALL, never write, delete, or normalize the offending path in place'
      );
      assert.equal(
        readFileSync(localPath, 'utf8'),
        LOCAL_BYTES,
        'the denied Pre must not touch the legitimate settings.local.json either — refusing the backslash entry denies the WHOLE call, it does not selectively mutate anything else on disk'
      );
    } finally {
      cleanup();
    }
  }
);
