// scripts/test-repair.mjs — VISIBLE REPAIR half of decision
// frozen-test-repair-signatures-plus-visible-repair (knowledge_get
// 7a4c3fb6-dc23-4c2f-9369-d2592132f408; board a06e4a1c).
//
// The conductor stays sanctioned to hand-repair a demonstrably buggy frozen
// test (H5 rides coder/debugger frontmatter only; the conductor is exempt by
// construction) but the repair must stop being invisible: it records a
// test_repair session event — the repaired test path + the evidence for why
// the TEST, not the code, was wrong — mirroring scripts/no-capture.mjs's
// writer-script shape (a CLI, not a hook, appending to the same
// .sterling/transient/session-events.json register H10 reads).
//
// Unlike no-capture.mjs, this register specifically claims a FROZEN-TEST
// repair, not an arbitrary edit, so the declared --path must match one of
// the project's configured toolchain test_globs (@sterling/schemas
// matchesGlob — the SAME single definition of "what is a test file" H5/H4
// consume, never a private notion of "looks like a test"). No configured
// toolchains at all (no .sterling/config.json) fails closed (P5): there is
// nothing to verify the claim against, so the script must not silently
// accept it.
//   node scripts/test-repair.mjs --path <repo-relative test path> --evidence "<why the test was wrong>"
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { matchesGlob, normalizeRepoPath } from '@sterling/schemas';
import { arg, fail } from './lib/project.mjs';

const rawPath = arg('--path');
const evidence = arg('--evidence');
const target = process.cwd();

if (!rawPath || !rawPath.trim()) {
  fail('test-repair: --path "<repo-relative test path>" is required');
}
// Path invariant (invariant 2): the register — and H10's exact-match against
// touch paths — hold repo-relative POSIX only. A backslash/absolute/escaping
// form would land raw, match no touch, and report success while covering
// nothing (review finding 2026-08-21).
let path;
try {
  path = normalizeRepoPath(rawPath);
} catch (e) {
  fail(`test-repair: --path '${rawPath}' is not a repo-relative path: ${(e && e.message) || e}`);
}
if (!evidence || !evidence.trim()) {
  fail('test-repair: --evidence "<why the TEST was wrong>" is required');
}

const configPath = join(target, '.sterling', 'config.json');
if (!existsSync(configPath)) {
  fail('test-repair: no .sterling/config.json — no configured test_globs to verify the path against; failing closed (P5)');
}

let config;
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'));
} catch (e) {
  fail(`test-repair: malformed .sterling/config.json — failing closed (P5): ${e.message}`);
}

const toolchains = Array.isArray(config?.toolchains) ? config.toolchains : [];
const matches = toolchains.some((tc) => (tc.test_globs ?? []).some((glob) => matchesGlob(path, glob)));
if (!matches) {
  fail(
    `test-repair: '${path}' matches no configured toolchain test_globs — this register is FROZEN-TEST repairs only, ` +
      `never an arbitrary edit`
  );
}

const eventsPath = join(target, '.sterling', 'transient', 'session-events.json');
mkdirSync(dirname(eventsPath), { recursive: true });
const events = existsSync(eventsPath) ? JSON.parse(readFileSync(eventsPath, 'utf8')) : [];
const at = new Date().toISOString();
const detail = `${path} — ${evidence}`;
events.push({ kind: 'test_repair', detail, at });
writeFileSync(eventsPath, JSON.stringify(events));
console.log(JSON.stringify({ repaired: path, evidence, at }));
