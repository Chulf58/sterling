// H5 — frozen-test gate (spec §6 H5). PreToolUse Edit|Write, blocking exit-2.
// Test paths come from the adapter's test-path globs, baked into project config
// (§9.1: the single definition of "what is a test file").
import { matchesGlob } from '@sterling/schemas';
import { readStdin, deny, allow, loadConfig, repoRel } from './lib/common.mjs';

const input = readStdin();

// A BLOCKING gate that cannot evaluate must DENY, not void itself: loadConfig's
// JSON.parse throws on a corrupt .sterling/config.json, and an uncaught throw
// exits 1 — non-blocking — which would let the coder edit a FROZEN test (the
// TDD oracle silently defeated). Any unexpected error → fail-closed deny (the
// F5 class; deny()/allow() process.exit before reaching the catch, so control
// flow is unaffected).
try {
  const config = loadConfig(input.cwd);
  if (!config?.toolchains?.length) {
    deny('H5: no toolchains in .sterling/config.json — the frozen-test gate cannot resolve test globs; failing closed (P5)');
  }

  const rel = repoRel(input.tool_input?.file_path, input.cwd);
  if (!rel) allow();

  for (const tc of config.toolchains) {
    for (const glob of tc.test_globs ?? []) {
      if (matchesGlob(rel, glob)) {
        deny(
          `H5: '${rel}' is a test path ('${glob}', ${tc.adapter} toolchain) — tests are frozen during the fix loop. If you believe a test is wrong, exit tests-invalid with evidence; never edit it silently.`
        );
      }
    }
  }
  allow();
} catch (e) {
  deny(`H5: frozen-test evaluation failed (${(e && e.message) || e}) — failing closed (P5)`);
}
