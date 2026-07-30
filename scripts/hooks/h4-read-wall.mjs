// H4 — test-writer read wall (spec §6 H4). PreToolUse Read|Grep, blocking exit-2.
// Declared in the test-writer's frontmatter only: the test-writer never reads
// implementation — tests derive from the brief, not from the code under test.
// Allowed: test paths (per the adapter's test-path globs, §9.1), docs, anything
// outside the repository, and locate-only Grep (files_with_matches/count) anywhere.
// Denied: repo source CONTENT — via Read or content-mode Grep alike (the r-ea9e
// bypass: a denied Read re-fetched through Grep with -C context lines).
import { matchesGlob } from '@sterling/schemas';
import { readStdin, deny, allow, loadConfig, repoRel } from './lib/common.mjs';

const input = readStdin();

let target = input.tool_input?.file_path; // Read
if (input.tool_name === 'Grep') {
  const mode = input.tool_input?.output_mode;
  if (mode === undefined || mode === 'files_with_matches' || mode === 'count') allow(); // locating shows no content
  // content mode (or an unrecognized future mode — fail closed, P5) crosses the wall
  target = input.tool_input?.path;
  const fwd = target ? String(target).replace(/\\/g, '/').replace(/\/+$/, '') : '';
  const isAbs = /^[A-Za-z]:/.test(fwd) || fwd.startsWith('/');
  const isRepoRoot = isAbs
    ? fwd.toLowerCase() === String(input.cwd).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    : !repoRel(fwd, input.cwd); // a relative path stays in-repo; '.', './' resolve to the root
  if (!target || isRepoRoot) {
    // NAME THE OBSERVED MODE. The recognized set is checked above and anything
    // else falls closed into this branch — so an unrecognized value (a typo like
    // 'files_with_match', or a future mode) lands here and used to be told to
    // "locate with output_mode files_with_matches", which is what the caller
    // believes it just did. It then reissues the same call or scopes a path it
    // never needed to scope. The fail-closed routing is right; the silence was not.
    const known = "'files_with_matches', 'count', or omitted";
    const modeNote =
      mode === undefined || mode === 'content'
        ? `output_mode was ${mode === undefined ? 'omitted' : "'content'"}`
        : `output_mode '${mode}' is NOT a value this gate recognizes (${known} locate without showing content) and unrecognized values fail CLOSED into the content path — if you meant to locate only, that is why this denied`;
    deny(
      `H4: unscoped content-mode Grep is a read of repo source (§6 H4) — ${modeNote}. ` +
        `${!target ? 'No path was given' : `the path resolved to the repo ROOT ('${target}')`}, so the read is unscoped. ` +
        `Locate with output_mode files_with_matches, or scope content to a test/doc file.`
    );
  }
}

const rel = repoRel(target, input.cwd);
if (!rel) allow(); // outside the repo (platform docs, references) is not implementation

const DOC_RE = /\.(md|txt|rst|adoc)$/i;
if (DOC_RE.test(rel) || rel.startsWith('docs/')) allow();

// A BLOCKING gate that cannot evaluate must DENY, not void itself: loadConfig's
// JSON.parse throws on a corrupt .sterling/config.json, and an uncaught throw
// exits 1 — non-blocking — which would let the test-writer read source (the read
// wall silently voided). Any unexpected error → fail-closed deny (the F5 class,
// which the audit's F5 scoped only to H3/H8; deny()/allow() process.exit before
// reaching the catch, so control flow is unaffected).
try {
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
    `H4: '${rel}' is implementation — the test-writer never reads code (§6 H4). Tests are specified from the brief + ACs + prior tests + handoffs; reading the implementation would anchor the oracle to it. Content-mode Grep is the same wall; files_with_matches Grep is allowed for locating.`
  );
} catch (e) {
  deny(`H4: read-wall evaluation failed (${(e && e.message) || e}) — failing closed (P5)`);
}
