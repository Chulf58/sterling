#!/usr/bin/env node
// scripts/run-gate.mjs — the sanctioned success-predicate runner (board babf3a9e).
// Governing decision: knowledge_get 98549344-e355-42da-93dd-ce7c2dc4dfcb
// (slug toolchain-success-predicates-run-gate). The frozen suite
// (scripts/tests/run-gate.test.mjs) is authoritative where more specific.
//
// `node scripts/run-gate.mjs <command_key>` resolves
// config.toolchains[].run_commands[<command_key>] (first DECLARING toolchain
// wins), executes it via the shell in cwd, and judges:
//   success = (child exit 0) AND (every declared criterion in
//             config.toolchains[].success_predicates[<command_key>])
// The child's own stdout/stderr is passed through to this process's own
// streams. On failure the verdict on stderr names exactly which criterion
// failed (or that the exit code itself was non-zero); with no predicate
// declared for the key, exit code alone governs — stated explicitly. An
// unknown command_key, or a config.json that is missing/unreadable/corrupt,
// is a loud non-zero refusal — never a silent green.
//
// Deliberately standalone (no @sterling/schemas / @sterling/store import,
// unlike scripts/hooks/lib/common.mjs's readStdin): this is a plain script
// invoked directly by `node`, not a bundled hook, and the frozen tests spawn
// it with cwd already at the project root — a plain cwd-based
// .sterling/config.json read matches that contract without pulling in the
// store dependency this script never needs.
//
// spawnSync(..., { shell: true }) here is SANCTIONED, not the shell-injection
// smell the repo's anti_pattern 6e3a6def warns about: that anti-pattern
// concerns ATTACKER/model-INFLUENCEABLE command text. The string executed
// here is the project's OWN declared run_commands value read from
// .sterling/config.json — never anything from this process's argv, stdin, or
// model output — the same trust boundary every other sanctioned consumer of
// run_commands (H14's allowlist, the toolchain adapters) already relies on.
//
// Correctness-review fixes (board babf3a9e, decision 98549344), D1-D3/G1-G3:
//  - D1: judged output was silently lost to buffering. spawnSync's own
//    maxBuffer (default 1MB) is now 64MB; the child's stdout/stderr are
//    additionally routed through temp files rather than pipes, closing a
//    second, maxBuffer-independent truncation this raised (see the comment
//    at the spawn site); a spawn error (result.error) is a loud refusal,
//    never a silent pass.
//  - D2/D3: success_predicates entries are shape-validated (plain object,
//    exactly the allowed keys, non-empty string/artifact values, at least one
//    criterion) before judging, and every declared criterion is dispatched on
//    an explicit `!== undefined` check rather than truthiness — so a
//    mis-shaped predicate is refused loud instead of silently evaluating zero
//    criteria while the verdict claims full coverage.
//  - G1: a toolchain declaring success_predicates[<key>] beside no matching
//    run_commands[<key>] is refused loud, checked across every toolchain on
//    every invocation.
//  - G2: output_regex / output_regex_absent are compiled up front inside a
//    try/catch — an invalid pattern is a loud refusal, never an uncaught
//    stack.
//  - G3: artifact.path is resolved against cwd and refused if it escapes cwd
//    (mirrors the valueEscapesRoot precedent in
//    scripts/hooks/h14-bash-allowlist.mjs).

import { readFileSync, existsSync, statSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const cwd = process.cwd();
const commandKey = process.argv[2];

if (!commandKey) {
  fail('run-gate: missing <command_key> argument. Usage: node scripts/run-gate.mjs <command_key>');
}

const configPath = join(cwd, '.sterling', 'config.json');
if (!existsSync(configPath)) {
  fail(`run-gate: no .sterling/config.json found at '${configPath}' — cannot resolve run commands.`);
}

let config;
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'));
} catch (e) {
  fail(`run-gate: could not parse .sterling/config.json (${(e && e.message) || e}) — refusing rather than defaulting to a silent success.`);
}

const toolchains = Array.isArray(config?.toolchains) ? config.toolchains : [];

// G1: a toolchain declaring success_predicates[<key>] beside no matching
// run_commands[<key>] can never be judged — refuse loud, checked for every
// toolchain, whichever key is being invoked (this is a config-integrity
// check, independent of the requested commandKey).
for (const tc of toolchains) {
  const runCommands = tc?.run_commands ?? {};
  const successPredicates = tc?.success_predicates ?? {};
  for (const key of Object.keys(successPredicates)) {
    if (!Object.prototype.hasOwnProperty.call(runCommands, key)) {
      fail(
        `run-gate: invalid success_predicates — toolchain declares success_predicates['${key}'] but no run_commands['${key}'] on the same toolchain; a predicate beside no such command can never be judged.`
      );
    }
  }
}

let commandText;
let predicate;
const declaredKeys = new Set();
for (const tc of toolchains) {
  const runCommands = tc?.run_commands ?? {};
  for (const key of Object.keys(runCommands)) declaredKeys.add(key);
  // First DECLARING toolchain wins.
  if (commandText === undefined && Object.prototype.hasOwnProperty.call(runCommands, commandKey)) {
    commandText = runCommands[commandKey];
    predicate = tc?.success_predicates?.[commandKey];
  }
}

if (commandText === undefined) {
  fail(
    `run-gate: unknown command_key '${commandKey}' — no toolchain declares it under run_commands. ` +
      `Declared keys: ${[...declaredKeys].join(', ') || '(none)'}.`
  );
}

// D2: shape-validate the selected key's predicate object before judging —
// zero silently-skipped criteria while the verdict claims full coverage.
const ALLOWED_PREDICATE_KEYS = new Set(['output_regex', 'output_regex_absent', 'artifact']);
const ALLOWED_ARTIFACT_KEYS = new Set(['path', 'min_bytes']);

function invalid(detail) {
  fail(`run-gate: invalid success_predicates for '${commandKey}' — ${detail}`);
}

if (predicate !== undefined) {
  if (typeof predicate !== 'object' || predicate === null || Array.isArray(predicate)) {
    invalid(`expected a plain object, got ${Array.isArray(predicate) ? 'array' : typeof predicate} (${JSON.stringify(predicate)}).`);
  }
  for (const key of Object.keys(predicate)) {
    if (!ALLOWED_PREDICATE_KEYS.has(key)) {
      invalid(`unknown key '${key}'; allowed keys: output_regex, output_regex_absent, artifact.`);
    }
  }

  let criteriaCount = 0;

  if (predicate.output_regex !== undefined) {
    if (typeof predicate.output_regex !== 'string' || predicate.output_regex === '') {
      invalid(`output_regex must be a non-empty string, got ${JSON.stringify(predicate.output_regex)}.`);
    }
    criteriaCount++;
  }

  if (predicate.output_regex_absent !== undefined) {
    if (typeof predicate.output_regex_absent !== 'string' || predicate.output_regex_absent === '') {
      invalid(`output_regex_absent must be a non-empty string, got ${JSON.stringify(predicate.output_regex_absent)}.`);
    }
    criteriaCount++;
  }

  if (predicate.artifact !== undefined) {
    const artifact = predicate.artifact;
    if (typeof artifact !== 'object' || artifact === null || Array.isArray(artifact)) {
      invalid(`artifact must be an object, got ${Array.isArray(artifact) ? 'array' : typeof artifact} (${JSON.stringify(artifact)}).`);
    }
    for (const key of Object.keys(artifact)) {
      if (!ALLOWED_ARTIFACT_KEYS.has(key)) {
        invalid(`unknown key 'artifact.${key}'; allowed keys: path, min_bytes.`);
      }
    }
    if (typeof artifact.path !== 'string' || artifact.path === '') {
      invalid(`artifact.path must be a non-empty string, got ${JSON.stringify(artifact.path)}.`);
    }
    if (artifact.min_bytes !== undefined) {
      if (typeof artifact.min_bytes !== 'number' || !Number.isFinite(artifact.min_bytes) || artifact.min_bytes < 0) {
        invalid(`artifact.min_bytes must be a non-negative number, got ${JSON.stringify(artifact.min_bytes)}.`);
      }
    }
    criteriaCount++;
  }

  if (criteriaCount === 0) {
    invalid('the predicate object declares no criteria (must include at least one of output_regex, output_regex_absent, artifact).');
  }
}

// G2: compile the declared regexes up front — an invalid pattern is a loud
// refusal, never an uncaught stack surfacing later during judging.
let outputRegex;
let outputRegexAbsent;
if (predicate !== undefined) {
  if (predicate.output_regex !== undefined) {
    try {
      outputRegex = new RegExp(predicate.output_regex);
    } catch (e) {
      invalid(`output_regex is not a valid regular expression: '${predicate.output_regex}' (${(e && e.message) || e}).`);
    }
  }
  if (predicate.output_regex_absent !== undefined) {
    try {
      outputRegexAbsent = new RegExp(predicate.output_regex_absent);
    } catch (e) {
      invalid(`output_regex_absent is not a valid regular expression: '${predicate.output_regex_absent}' (${(e && e.message) || e}).`);
    }
  }
}

// G3: resolve artifact.path against cwd and refuse when it escapes cwd
// (mirrors valueEscapesRoot in scripts/hooks/h14-bash-allowlist.mjs).
let artifactPath;
if (predicate !== undefined && predicate.artifact !== undefined) {
  const resolvedArtifactPath = resolve(cwd, predicate.artifact.path);
  const rel = relative(cwd, resolvedArtifactPath);
  if (rel === '..' || rel.startsWith('..' + sep)) {
    invalid(`artifact.path '${predicate.artifact.path}' resolves outside cwd ('${resolvedArtifactPath}').`);
  }
  artifactPath = resolvedArtifactPath;
}

// D1: the judged text must never be silently lost to buffering. Two DISTINCT
// truncation mechanisms are in play, and both are closed here:
//  (a) spawnSync's own maxBuffer (default 1MB) — raised to 64MB so a
//      genuinely verbose command's captured output isn't capped away.
//  (b) a measured Node runtime behavior, independent of maxBuffer: when a
//      child's stdout is a PIPE (spawnSync's default), writes are
//      ASYNCHRONOUS — a child that calls process.exit() immediately after a
//      large stdout.write() can have that write truncated before the OS
//      pipe ever sees the rest of it, regardless of how large maxBuffer is
//      set (probed directly: identical truncation length at maxBuffer 1MB
//      and 64MB). Routing the child's stdout/stderr through TEMP FILES
//      instead of pipes sidesteps this: Node's docs state process.stdout is
//      SYNCHRONOUS when the underlying fd is a regular file (POSIX and
//      Windows), so a fast-exiting child's writes are not lost.
// A spawn error (result.error) is a loud refusal, never a silent pass.
const uniqueTag = `${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`;
const stdoutTmpPath = join(tmpdir(), `run-gate-stdout-${uniqueTag}.tmp`);
const stderrTmpPath = join(tmpdir(), `run-gate-stderr-${uniqueTag}.tmp`);

let stdoutFd;
let stderrFd;
let result;
try {
  stdoutFd = openSync(stdoutTmpPath, 'w');
  stderrFd = openSync(stderrTmpPath, 'w');
  result = spawnSync(commandText, {
    cwd,
    shell: true,
    stdio: ['ignore', stdoutFd, stderrFd],
    maxBuffer: 64 * 1024 * 1024,
  });
} finally {
  if (stdoutFd !== undefined) closeSync(stdoutFd);
  if (stderrFd !== undefined) closeSync(stderrFd);
}

function readCaptured(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  } finally {
    try {
      unlinkSync(path);
    } catch {}
  }
}

const stdout = readCaptured(stdoutTmpPath);
const stderr = readCaptured(stderrTmpPath);

if (result.error) {
  fail(`run-gate: spawn error — ${result.error.code ?? '(no code)'}: ${result.error.message ?? result.error}`);
}

// Pass-through writes use process.exitCode below (never process.exit()
// immediately after) — the same async-pipe truncation risk applies to THIS
// process's own stdout/stderr once a caller captures them without its own
// large maxBuffer (the frozen suite's harness does not set one). Setting
// exitCode and letting the event loop drain naturally, instead of forcing an
// immediate exit, ensures a large pass-through write is not itself truncated
// by the same Node behavior this fix closes for the inner child.
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);

const combined = stdout + stderr;
const exitCode = result.status;

const failures = [];
if (exitCode !== 0) {
  failures.push(`exit code ${exitCode === null ? `(terminated by signal ${result.signal})` : exitCode} — non-zero`);
}

// D3: explicit `!== undefined` dispatch — with the validation above, every
// declared criterion is either refused loudly (before this point) or
// actually evaluated here, never silently skipped by a truthiness guard.
if (predicate !== undefined) {
  if (predicate.output_regex !== undefined) {
    if (!outputRegex.test(combined)) {
      failures.push(`output_regex '${predicate.output_regex}' did not match the combined stdout+stderr`);
    }
  }
  if (predicate.output_regex_absent !== undefined) {
    if (outputRegexAbsent.test(combined)) {
      failures.push(`output_regex_absent '${predicate.output_regex_absent}' matched the combined stdout+stderr (forbidden text present)`);
    }
  }
  if (predicate.artifact !== undefined) {
    if (!existsSync(artifactPath)) {
      failures.push(`artifact '${predicate.artifact.path}' does not exist`);
    } else if (predicate.artifact.min_bytes !== undefined) {
      const size = statSync(artifactPath).size;
      if (size < predicate.artifact.min_bytes) {
        failures.push(`artifact '${predicate.artifact.path}' is ${size} bytes, below min_bytes ${predicate.artifact.min_bytes}`);
      }
    }
  }
}

if (failures.length) {
  process.stderr.write(`run-gate: FAILED for '${commandKey}' — ${failures.join('; ')}.\n`);
  // process.exitCode, never process.exit() here — see the D1 comment above
  // the spawn: an explicit exit() immediately after a large pass-through
  // write can truncate it before the OS pipe drains. Setting exitCode and
  // letting the process end naturally once the event loop is empty flushes
  // every pending write first.
  process.exitCode = typeof exitCode === 'number' && exitCode !== 0 ? exitCode : 1;
} else {
  if (predicate !== undefined) {
    process.stderr.write(`run-gate: '${commandKey}' passed — exit code 0 and every declared success_predicates criterion satisfied.\n`);
  } else {
    process.stderr.write(`run-gate: '${commandKey}' passed — exit code alone governs (no success_predicates declared for this key).\n`);
  }
  process.exitCode = 0;
}
