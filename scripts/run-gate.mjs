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

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
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

const result = spawnSync(commandText, {
  cwd,
  shell: true,
  encoding: 'utf8',
});

const stdout = result.stdout ?? '';
const stderr = result.stderr ?? '';
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);

const combined = stdout + stderr;
const exitCode = result.status;

const failures = [];
if (exitCode !== 0) {
  failures.push(`exit code ${exitCode === null ? `(terminated by signal ${result.signal})` : exitCode} — non-zero`);
}

if (predicate) {
  if (predicate.output_regex) {
    if (!new RegExp(predicate.output_regex).test(combined)) {
      failures.push(`output_regex '${predicate.output_regex}' did not match the combined stdout+stderr`);
    }
  }
  if (predicate.output_regex_absent) {
    if (new RegExp(predicate.output_regex_absent).test(combined)) {
      failures.push(`output_regex_absent '${predicate.output_regex_absent}' matched the combined stdout+stderr (forbidden text present)`);
    }
  }
  if (predicate.artifact) {
    const artifactPath = join(cwd, predicate.artifact.path);
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
  process.exit(typeof exitCode === 'number' && exitCode !== 0 ? exitCode : 1);
}

if (predicate) {
  process.stderr.write(`run-gate: '${commandKey}' passed — exit code 0 and every declared success_predicates criterion satisfied.\n`);
} else {
  process.stderr.write(`run-gate: '${commandKey}' passed — exit code alone governs (no success_predicates declared for this key).\n`);
}
process.exit(0);
