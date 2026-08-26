#!/usr/bin/env node
// scripts/mutation-run.mjs — CONDUCTOR-ONLY clean-room mutation runner (S0).
//
// ============================================================================
// THIS IS NOT AN AGENT CAPABILITY. Run it by hand, as the conductor, only.
// Decision 02e03ed8 [clean-room-mutation-runs-via-conductor-only-helper] makes
// that an OPERATIONAL boundary, not a claim of containment: "The helper must not
// be advertised or granted as an agent capability", and "Do NOT add an
// agent-facing H14 allowance". No H14 command shape is added for this file, and
// none may be added without a new ruling.
//
// !! UNENFORCED AS SHIPPED — READ THIS BEFORE TRUSTING THE CONTAINMENT BELOW.
// Decision 02e03ed8 requires that "the helper plus its manifest are themselves
// protected as enforcement surface, conductor-modifiable only". THAT PROTECTION
// IS NOT IN PLACE. scripts/mutation-run.mjs matches nothing in
// ENFORCEMENT_SURFACE (scripts/hooks/lib/contract.mjs), H17 guards hooks/**
// only, and H5 guards *.test.mjs only — so an agent with scripts/** in scope can
// edit the MANIFEST below and the conductor would then execute agent-authored
// code out of repo with an arbitrary string rewrite. The ARGV containment is
// real; the MANIFEST containment is the load-bearing half and is currently only
// this comment. CLOSING IT means adding 'scripts/mutation-run.mjs' to
// ENFORCEMENT_SURFACE, which today reds a FROZEN pin
// (scripts/tests/enforcement.test.mjs, the "ENFORCEMENT_SURFACE stays the
// declared triple" assertions) — that pin has to be re-cut deliberately first.
// UNTIL THEN: re-read the MANIFEST before every run. This notice is stated in
// the negative on purpose (anti_pattern 586bccdc: a security comment asserting a
// protection nothing implements is worse than the gap, because it stops the next
// reader from looking).
// ============================================================================
//
// WHAT IT DOES, AS ONE OPERATION: copy a NAMED hook bundle and a NAMED test into
// ONE mkdtemp() fixture OUTSIDE the repo, apply ONE byte-expected mutation to the
// COPY, run the test twice (control = unmutated copy, mutant = mutated copy) with
// STERLING_HOOKS_DIR set INSIDE this process, report BOTH verdicts, and DELETE
// the fixture in `finally`.
//
// WHY IT EXISTS. Decision 23afbc83 mandates clean-room mutation verification and
// anti_pattern 37b3cb0a [BLOCK] forbids mutating in place or touching the live
// enforcement surface — but research_finding 01cab59b measured that no location
// satisfies H14 + H5 + H15 + H17 jointly, and 02e03ed8 found the decisive fourth
// gate: H14 rejects an ENV-VAR ASSIGNMENT PREFIX, so `STERLING_HOOKS_DIR=<dir>
// node --test <file>` is unrunnable from any agent seat at all. Setting the seam
// INSIDE this process via spawnSync's `env` is the whole point of the file.
//
// SCOPE: the SMALLEST FIRST STEP named by 02e03ed8 — a FIXED-PURPOSE runner for
// the ONE stalled routing mutation. Generalizing this into the manifest-driven
// runner for all mutations is the full solution and is EXPLICITLY DEFERRED. Do
// not add ids, flags, paths, patch inputs or env inputs here to make it general;
// that is a different ruling's work.
//
// CONTAINMENT (02e03ed8's list, each mapped to the code below):
//   * fixed mutation IDs in a checked-in manifest   -> MANIFEST (frozen, below)
//   * exact source/test allowlist + byte-expected   -> resolveAllowlisted(), applyMutation()
//   * mkdtemp() outside the repo                    -> makeFixture()
//   * shell:false, fixed node exe, fixed arg list   -> runArm()
//   * refuse symlinks / live enforcement surface    -> resolveAllowlisted(), fixtureWrite()
//   * snapshot live hooks/** before and after       -> snapshotHooks() + the final compare
//   * cleanup in finally, failure and timeout too   -> the try/finally in main()
// KNOWN AND ACCEPTED: there is no SIGINT/SIGTERM handler, so Ctrl-C mid-run
// leaves the fixture behind. It sits in tmpdir(), outside governed territory, so
// it does not reproduce the residue harm measured in research_finding 01cab59b.
// Nothing is read from argv except one manifest id. No path, command, patch or
// environment assignment can be passed in.
//
// EXIT CODES: 0 = KILLED (the mutation was observed). 1 = SURVIVED or
// INCONCLUSIVE. 2 = REFUSED (a containment check said no). P5: an unreadable
// result is never reported as a pass.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIVE_HOOKS = join(REPO_ROOT, 'hooks');
const RUN_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// THE MANIFEST — the checked-in allowlist. One entry, by design (see SCOPE).
// Every path is repo-relative POSIX. `find` is the BYTE-EXPECTED text: if it is
// not present EXACTLY ONCE in the copied source, the run REFUSES rather than
// applying a fuzzy match.
//
// The hook copied is the BUNDLE (hooks/), not the source (scripts/hooks/):
// scripts/hooks/h24-gate-exit-lint.mjs imports './lib/common.mjs' and
// '@sterling/schemas', so it is not relocatable outside the workspace, while the
// esbuild bundle is standalone by invariant 4. hooks/** is READ ONLY here and is
// snapshotted at both ends.
// ---------------------------------------------------------------------------
const MANIFEST = Object.freeze({
  's0-routing-seam': Object.freeze({
    summary:
      'S0 routing pin: the STERLING_HOOKS_DIR read in the h24 suite is what routes the spawn to a relocated hook. Removing it is the sabotage named in scripts/tests/mutation-arm-s0-hooks-dir-routing.test.mjs (AC4) and by board 5402a024 precondition P1.',
    rationale_ref: 'decision 1dab2a9f / 02e03ed8; board 5402a024 P1; pin AC4',
    hook_src: 'hooks/h24-gate-exit-lint.mjs',
    hook_fixture_name: 'h24-gate-exit-lint.mjs',
    test_src: 'scripts/tests/h24-gate-exit-lint.test.mjs',
    // Depth matters: the copied suite computes its own root as <file>/../.., so
    // the copy must sit two levels below each arm's root for the MUTATED copy to
    // resolve its hard-coded 'scripts/hooks' INSIDE the fixture (where it does
    // not exist) and never into the live repo.
    test_fixture_rel: 'scripts/tests/fixture-suite.test.mjs',
    find: "const HOOKS = process.env.STERLING_HOOKS_DIR || join(root, 'scripts', 'hooks');",
    replace: "const HOOKS = join(root, 'scripts', 'hooks');",
    expect:
      'CONTROL green (the seam finds the relocated bundle); MUTANT red (the hard-coded path is absent inside the fixture, so every spawn is a module-not-found).',
  }),
});

// ---------------------------------------------------------------------------
// Refusals and small helpers
// ---------------------------------------------------------------------------
// A refusal THROWS rather than calling process.exit(): process.exit() skips
// `finally`, so an exiting refusal raised after the fixture exists would leave
// exactly the undeleted residue this runner is built to prevent. main() cleans
// up first, then reports the refusal.
class Refusal extends Error {}

function refuse(message) {
  throw new Refusal(message);
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// CONTAINMENT USES TWO CONTAINMENT TESTS, DELIBERATELY, because the two
// polarities fail in opposite directions and NTFS is case-insensitive while
// POSIX is not (standing Windows/Linux 1:1 parity requirement — most users are
// on Windows, where a TMPDIR differing only in case is reachable):
//   * isStrictlyInside — for "this MUST be inside X" (a false POSITIVE would let
//     a write escape the fixture), so it is exact and case-sensitive.
//   * couldBeInside — for "this must NOT be inside X" (a false NEGATIVE would
//     let a fixture land inside the repo), so it matches case-insensitively too.
// Collapsing them into one comparison makes one of the two fail open.
function containment(parent, child) {
  const p = resolve(parent).replace(/[\\/]+$/, '');
  const c = resolve(child).replace(/[\\/]+$/, '');
  return { p, c };
}

function isStrictlyInside(parent, child) {
  const { p, c } = containment(parent, child);
  return c === p || c.startsWith(p + sep);
}

function couldBeInside(parent, child) {
  if (isStrictlyInside(parent, child)) return true;
  const { p, c } = containment(parent, child);
  const lp = p.toLowerCase();
  const lc = c.toLowerCase();
  return lc === lp || lc.startsWith(lp + sep);
}

// Resolve a repo-relative allowlisted path: it must exist, be a regular file,
// sit inside the repo, and no component of it may be a symlink. A symlinked
// component is exactly how a "copy this named file" step gets pointed somewhere
// it was never allowed to read.
function resolveAllowlisted(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.includes('..')) {
    refuse(`manifest path is not a plain repo-relative path: ${JSON.stringify(relPath)}`);
  }
  const abs = resolve(REPO_ROOT, relPath);
  if (!isStrictlyInside(REPO_ROOT, abs)) refuse(`manifest path resolves outside the repo: ${relPath}`);

  let walked = REPO_ROOT;
  for (const part of relPath.split('/')) {
    walked = join(walked, part);
    let st;
    try {
      st = lstatSync(walked);
    } catch {
      refuse(`allowlisted path does not exist: ${relPath} (missing at ${walked})`);
    }
    if (st.isSymbolicLink()) refuse(`allowlisted path traverses a SYMLINK at ${walked} — refusing to copy it`);
  }
  if (!lstatSync(abs).isFile()) refuse(`allowlisted path is not a regular file: ${relPath}`);
  return abs;
}

// Every write this script performs goes through here, so no write can land on
// the live enforcement surface (or anywhere else in the repo) even by mistake.
function fixtureWrite(fixtureRoot, absPath, contents) {
  const abs = resolve(absPath);
  if (!isStrictlyInside(fixtureRoot, abs)) refuse(`refusing to write outside the fixture: ${abs}`);
  if (couldBeInside(REPO_ROOT, abs)) refuse(`refusing to write inside the live repo: ${abs}`);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
}

function fixtureCopy(fixtureRoot, absFrom, absTo) {
  const to = resolve(absTo);
  if (!isStrictlyInside(fixtureRoot, to)) refuse(`refusing to copy outside the fixture: ${to}`);
  if (couldBeInside(REPO_ROOT, to)) refuse(`refusing to copy into the live repo: ${to}`);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(absFrom, to);
  // "Copy exactly" is asserted, not assumed.
  if (sha256(readFileSync(absFrom)) !== sha256(readFileSync(to))) {
    refuse(`the fixture copy of ${absFrom} does not hash-match its source`);
  }
}

// ---------------------------------------------------------------------------
// Live enforcement-surface snapshot — CONTENT hashes, not mtime+size (board
// 5402a024 precondition P3: the mtime+size form is defeatable).
// ---------------------------------------------------------------------------
function snapshotHooks(dir = LIVE_HOOKS, prefix = '') {
  const out = {};
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const st = lstatSync(abs);
    // The TARGET is part of the sentinel, not just the fact of being a link: a
    // symlink RETARGETED mid-run hashes identically under a bare 'symlink'
    // marker, and the surface-changed check below would never fire.
    if (st.isSymbolicLink()) out[rel] = `symlink:${readlinkSync(abs)}`;
    else if (st.isDirectory()) Object.assign(out, snapshotHooks(abs, rel));
    else out[rel] = sha256(readFileSync(abs));
  }
  return out;
}

function diffSnapshots(before, after) {
  const changed = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[key] !== after[key]) changed.push(key);
  }
  return changed.sort();
}

// ---------------------------------------------------------------------------
// One arm: run the copied suite once, with the seam set INSIDE this process.
// ---------------------------------------------------------------------------
function runArm({ armRoot, testPath, hooksDir }) {
  const env = { ...process.env };
  // node:test treats an inherited NODE_TEST_CONTEXT as a recursive invocation:
  // it skips running files and emits NO `# pass`/`# fail` counters at all, so
  // BOTH arms would silently report nothing. Scrubbing this is load-bearing.
  for (const key of Object.keys(env)) {
    if (key.startsWith('NODE_TEST')) delete env[key];
  }
  // THE SEAM. H14 rejects an env-assignment prefix on a command line, which is
  // why this is set here and not by a caller (decision 02e03ed8).
  env.STERLING_HOOKS_DIR = hooksDir;

  // Fixed executable, fixed argument list, shell:false. `--test-reporter tap` is
  // required, not cosmetic: the default reporter prints `ℹ pass N`, never the
  // `# pass N` lines parsed below (same reason scripts/adapters/node.mjs passes it).
  const r = spawnSync(process.execPath, ['--test', '--test-reporter', 'tap', testPath], {
    cwd: armRoot,
    env,
    shell: false,
    encoding: 'utf8',
    timeout: RUN_TIMEOUT_MS,
  });

  const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const count = (label) => {
    const m = text.match(new RegExp(`^# ${label} (\\d+)$`, 'm'));
    return m ? Number(m[1]) : null;
  };
  return {
    status: r.status,
    timedOut: r.error?.code === 'ETIMEDOUT',
    pass: count('pass'),
    fail: count('fail'),
    tail: text.slice(-2000).trim(),
  };
}

function describeArm(name, arm) {
  const counters = arm.pass === null || arm.fail === null ? 'counters UNREADABLE' : `# pass ${arm.pass}  # fail ${arm.fail}`;
  return `${name}: status=${arm.status}${arm.timedOut ? ' TIMED-OUT' : ''}  ${counters}`;
}

// ---------------------------------------------------------------------------
function main() {
  const argv = process.argv.slice(2);
  if (argv.length !== 1) {
    refuse(
      `expected exactly one argument, the mutation id. Known ids: ${Object.keys(MANIFEST).join(', ')}. ` +
        'No path, command, patch or environment assignment may be passed in (decision 02e03ed8).',
    );
  }
  const id = argv[0];
  if (!Object.prototype.hasOwnProperty.call(MANIFEST, id)) {
    refuse(`unknown mutation id ${JSON.stringify(id)}. Known ids: ${Object.keys(MANIFEST).join(', ')}.`);
  }
  const entry = MANIFEST[id];

  const hookSrc = resolveAllowlisted(entry.hook_src);
  const testSrc = resolveAllowlisted(entry.test_src);

  const before = snapshotHooks();
  if (Object.keys(before).length === 0) refuse(`the live hooks directory is empty or unreadable: ${LIVE_HOOKS}`);

  let fixtureRoot = null;
  let control = null;
  let mutant = null;
  let runError = null;
  let residue = null;

  try {
    fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'sterling-mutation-')));
    if (couldBeInside(REPO_ROOT, fixtureRoot)) {
      refuse(`the OS temp directory resolves INSIDE the repo (${fixtureRoot}) — refusing to build a fixture there`);
    }

    // Layout. The two arms get separate roots so the MUTATED copy's hard-coded
    // 'scripts/hooks' resolves to a path that does not exist inside the fixture,
    // and can never reach the live one.
    //   <fixture>/relocated-hooks/<hook>      the only hook either arm can find
    //   <fixture>/control/scripts/tests/...   byte-identical copy
    //   <fixture>/mutant/scripts/tests/...    the copy with ONE mutation applied
    const hooksDir = join(fixtureRoot, 'relocated-hooks');
    const controlRoot = join(fixtureRoot, 'control');
    const mutantRoot = join(fixtureRoot, 'mutant');

    fixtureCopy(fixtureRoot, hookSrc, join(hooksDir, entry.hook_fixture_name));

    // ONE read of the test source: BOTH arms are derived from these exact bytes,
    // so the only difference between them is the mutation. Two independent reads
    // (a copyFileSync for control, a readFileSync for the mutant) would let an
    // edit landing between them introduce a SECOND difference, and the KILLED
    // verdict would no longer be attributable to the mutated line — which is the
    // single thing this runner exists to establish.
    const sourceBytes = readFileSync(testSrc);
    const source = sourceBytes.toString('utf8');
    if (!Buffer.from(source, 'utf8').equals(sourceBytes)) {
      refuse(`${entry.test_src} is not valid UTF-8 — the control copy would not be byte-exact`);
    }

    const controlTest = join(controlRoot, entry.test_fixture_rel);
    fixtureWrite(fixtureRoot, controlTest, sourceBytes);

    // The byte-expected mutation. Exactly one occurrence or REFUSE — never a
    // fuzzy match, never a regex.
    const parts = source.split(entry.find);
    if (parts.length !== 2) {
      refuse(
        `the byte-expected mutation text was found ${parts.length - 1} time(s) in ${entry.test_src} (need exactly 1). ` +
          `Expected: ${JSON.stringify(entry.find)}. The file has drifted from the manifest — update the manifest deliberately, do not fuzzy-match.`,
      );
    }
    const mutantTest = join(mutantRoot, entry.test_fixture_rel);
    fixtureWrite(fixtureRoot, mutantTest, parts.join(entry.replace));

    control = runArm({ armRoot: controlRoot, testPath: controlTest, hooksDir });
    mutant = runArm({ armRoot: mutantRoot, testPath: mutantTest, hooksDir });
  } catch (err) {
    runError = err;
  } finally {
    // Cleanup is mandatory on EVERY path — success, refusal-free failure, and
    // timeout alike (decision 23afbc83's delete step; the residue measured in
    // research_finding 01cab59b is what this guarantees against).
    if (fixtureRoot) {
      try {
        rmSync(fixtureRoot, { recursive: true, force: true });
      } catch (err) {
        residue = `${fixtureRoot} (${err.message})`;
      }
      if (!residue && existsSync(fixtureRoot)) residue = fixtureRoot;
    }
  }

  let changed;
  try {
    changed = diffSnapshots(before, snapshotHooks());
  } catch (err) {
    console.error(`MUTATION-RUN REFUSED: the live hooks directory could not be re-snapshotted after the run: ${err.message}`);
    process.exit(2);
  }

  console.log(`mutation-run ${id} — ${entry.summary}`);
  console.log(`  mutation: ${entry.test_src}`);
  console.log(`    -  ${entry.find}`);
  console.log(`    +  ${entry.replace}`);
  console.log(`  relocated hook: ${entry.hook_src}`);
  if (control) console.log(`  ${describeArm('CONTROL (unmutated)', control)}`);
  if (mutant) console.log(`  ${describeArm('MUTANT   (mutated)  ', mutant)}`);

  if (residue) {
    console.error(`MUTATION-RUN: FIXTURE NOT DELETED — ${residue}. Remove it by hand; the delete step is mandatory.`);
  }
  if (changed.length > 0) {
    console.error(`MUTATION-RUN: the live enforcement surface CHANGED during this run: hooks/${changed.join(', hooks/')}`);
    console.error('This runner never writes to hooks/**. Investigate before trusting any verdict above.');
    process.exit(2);
  }
  if (runError instanceof Refusal) {
    console.error(`MUTATION-RUN REFUSED: ${runError.message}`);
    process.exit(2);
  }
  if (runError) {
    console.error(`MUTATION-RUN INCONCLUSIVE: ${runError.stack ?? runError.message}`);
    process.exit(1);
  }

  const unreadable = (arm) => arm.pass === null || arm.fail === null;
  if (unreadable(control) || unreadable(mutant)) {
    console.error('MUTATION-RUN INCONCLUSIVE: node:test counters could not be read from one of the arms.');
    if (unreadable(control)) console.error(`  control tail: ${control.tail}`);
    if (unreadable(mutant)) console.error(`  mutant tail: ${mutant.tail}`);
    process.exit(1);
  }
  if (control.pass < 1 || control.fail !== 0 || control.status !== 0) {
    console.error('MUTATION-RUN INCONCLUSIVE: the CONTROL arm is not green, so the mutant verdict carries no information.');
    console.error(`  control tail: ${control.tail}`);
    process.exit(1);
  }
  if (mutant.fail < 1) {
    console.error(`MUTATION-RUN VERDICT: SURVIVED — the mutation changed nothing the suite can see (# fail ${mutant.fail}).`);
    console.error(`  mutant tail: ${mutant.tail}`);
    process.exit(1);
  }
  console.log(
    `MUTATION-RUN VERDICT: KILLED — control green (# pass ${control.pass}, # fail 0) and the mutant went red (# fail ${mutant.fail}). The mutated line carries the verdict.`,
  );
  process.exit(0);
}

// Refusals raised BEFORE the fixture exists (argv, manifest, allowlist,
// snapshot) unwind to here; refusals raised after it are cleaned up and reported
// inside main().
try {
  main();
} catch (err) {
  if (err instanceof Refusal) {
    console.error(`MUTATION-RUN REFUSED: ${err.message}`);
    process.exit(2);
  }
  throw err;
}
