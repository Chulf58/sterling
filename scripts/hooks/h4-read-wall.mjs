// H4 — test-writer read wall (spec §6 H4). PreToolUse Read, blocking exit-2.
// Declared in the test-writer's frontmatter only: the test-writer never reads
// implementation — tests derive from the brief, not from the code under test.
// Allowed: test paths (per the adapter's test-path globs, §9.1), docs, and
// anything outside the repository. Denied: repo source files.
import { matchesGlob } from '@sterling/schemas';
import { readStdin, deny, allow, loadConfig, repoRel } from './lib/common.mjs';

const input = readStdin();
const rel = repoRel(input.tool_input?.file_path, input.cwd);
if (!rel) allow(); // outside the repo (platform docs, references) is not implementation

const DOC_RE = /\.(md|txt|rst|adoc)$/i;
if (DOC_RE.test(rel) || rel.startsWith('docs/')) allow();

const config = loadConfig(input.cwd);
if (!config?.toolchains?.length) {
  deny('H4: no toolchains in .sterling/config.json — the read wall cannot resolve test globs; failing closed (P5)');
}
for (const tc of config.toolchains) {
  for (const glob of tc.test_globs ?? []) {
    if (matchesGlob(rel, glob)) allow(); // prior tests are fair game
  }
}
deny(
  `H4: '${rel}' is implementation — the test-writer never reads code (§6 H4). Tests are specified from the brief + ACs + prior tests + handoffs; reading the implementation would anchor the oracle to it.`
);
