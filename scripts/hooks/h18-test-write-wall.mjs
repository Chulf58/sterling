// H18 — test-writer WRITE wall (spec §6, audit finding 6/43). PreToolUse
// Write|MultiEdit, blocking exit-2. Declared in the test-writer's frontmatter
// only. The test-writer had a Write grant but NO gate on it — it could write any
// file anywhere (source, config, the enforcement surface itself), silently
// defeating H3/H5/H7 which never fire on its writes. Its ONE legitimate output
// is TEST files (the toolchain test-path globs, §9.1); everything else is denied.
//
// Two denials, mirroring H3: (1) enforcement-surface self-protection is
// UNCONDITIONAL — the bundled hooks dir + the shared ENFORCEMENT_SURFACE globs
// are never test-writer-writable, even if a (misconfigured, over-broad) test glob
// would otherwise match them; (2) a non-test path is denied — tests derive at
// their test paths, source/docs/config belong to the coder/conductor.
// Deliberately store-free beyond config: it must gate even if the store is down.
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchesGlob } from '@sterling/schemas';
import { readStdin, deny, allow, loadConfig, repoRel } from './lib/common.mjs';
import { isEnforcementSurface } from './lib/contract.mjs';

const input = readStdin();
const toolPath = input.tool_input?.file_path;
if (!toolPath) allow(); // no path (e.g. a MultiEdit with an odd shape) — nothing to gate here

// A BLOCKING gate that cannot evaluate must DENY, not void itself: an uncaught
// throw exits 1, which the platform treats as non-blocking (a corrupt
// .sterling/config.json makes loadConfig's JSON.parse throw). Any unexpected
// error → fail-closed deny (mirrors the F5 hardening of H3/H8). deny()/allow()
// process.exit before reaching the catch, so control flow is unaffected.
try {
  // (1) enforcement-surface self-protection (unconditional, like H3): the bundled
  // hooks directory is never agent-writable.
  const fwd = String(toolPath).replace(/\\/g, '/');
  const hooksDir = dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/'); // bundled: <plugin>/hooks
  if (fwd === hooksDir || fwd.startsWith(hooksDir + '/')) {
    deny(`H18 [self-protection]: '${toolPath}' is inside the bundled hooks directory — the enforcement surface is never test-writer-writable (§6)`);
  }

  const rel = repoRel(toolPath, input.cwd);
  if (!rel) {
    deny(`H18: '${toolPath}' is outside the repository — the test-writer writes ONLY test files inside the repo (§6 H18)`);
  }
  if (isEnforcementSurface(rel)) {
    deny(`H18 [self-protection]: '${rel}' is enforcement surface (${['.claude/settings*.json', '.claude/agents/**', '.sterling/config.json'].join(', ')}) — never test-writer-writable, in any mode (§6)`);
  }

  // (2) test-path allowlist: the write must match a declared toolchain test glob.
  const config = loadConfig(input.cwd);
  if (!config?.toolchains?.length) {
    deny('H18: no toolchains in .sterling/config.json — cannot resolve test globs to authorize the write; failing closed (P5)');
  }
  for (const tc of config.toolchains) {
    for (const glob of tc.test_globs ?? []) {
      if (matchesGlob(rel, glob)) allow(); // a test file — the test-writer's legitimate output
    }
  }
  // NAME THE GLOBS. Two causes reach here: the path really is source/docs/config,
  // OR it IS a test file whose location or extension no declared test_glob matches
  // (a tests/ directory nobody declared, .test.ts against a **/*.test.mjs glob, or
  // a toolchain whose test_globs is absent — the `?? []` above matches nothing while
  // the toolchains guard still passes). In the second case the old message asserted
  // a falsehood about the file and closed with "author the tests at their test
  // paths", which is what the caller just tried — the effective paths being the one
  // thing withheld. The sibling H5 denial already names its matched glob, so this
  // was inconsistent inside one enforcement pair.
  const declared = config.toolchains.flatMap((tc) => (tc.test_globs ?? []).map((g) => `${g} (${tc.adapter})`));
  deny(
    `H18: '${rel}' matches NO declared test glob — the test-writer writes ONLY test files (§9.1). ` +
      `Compared against: ${declared.length ? declared.join(', ') : '(none — every declared toolchain has an empty test_globs)'}. ` +
      `If this IS meant to be a test, its path or extension does not match any of those — author it at a path that does. ` +
      `If it is genuinely source, docs or config, that belongs to the coder/conductor: exit contract-violated naming the file.`
  );
} catch (e) {
  deny(`H18: write-gate evaluation failed (${(e && e.message) || e}) — failing closed (P5)`);
}
