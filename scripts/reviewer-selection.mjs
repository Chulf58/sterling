// Reviewer selection CLI (spec §7.1) — thin wrapper; the deterministic logic
// lives in scripts/lib/reviewer-selection.mjs (pure, bundle-safe: no
// main-detection that could misfire inside esbuild-bundled hooks).
// The brief is reviewer-selection's first signal source (§7.1): the active
// run's brief (or --run's) is loaded from the store so risk_flags reach
// selection; with no run (direct mode) there is no brief. The output's
// `brief` field states which brief informed the selection — a flag-less
// selection is auditable, never silent.
//
// Diff input — exactly ONE of:
//   --base <ref>      build the diff-json from git vs <ref>, INCLUDING untracked
//                     new files (scripts/lib/diff-json.mjs) — the sanctioned
//                     producer that fixes the hand-built blind spots (board 09c237d6)
//   --diff-json <file>  a pre-built [{ path, added_lines: [<content>] }] file
//   node scripts/reviewer-selection.mjs (--base <ref> | --diff-json <file>) [--run <id>] [--target <dir>]
import { readFileSync } from 'node:fs';
import { arg, fail, openProject, requireRun, requireBrief } from './lib/project.mjs';
import { selectReviewers } from './lib/reviewer-selection.mjs';
import { buildDiffJson } from './lib/diff-json.mjs';

const diffJson = arg('--diff-json');
const base = arg('--base');
if ((diffJson ? 1 : 0) + (base ? 1 : 0) !== 1) {
  fail('usage: reviewer-selection.mjs (--base <ref> | --diff-json <file>) [--run <id>] [--target <dir>] — provide exactly one diff input', 2);
}

const cwd = arg('--target') ?? process.cwd();
const { store, config } = openProject(cwd);
const runId = arg('--run');
const run = runId ? requireRun(store, runId) : store.getRun();
const brief = run ? requireBrief(store, run) : undefined;
store.close();

let diff;
try {
  diff = base ? buildDiffJson({ cwd, base }) : JSON.parse(readFileSync(diffJson, 'utf8'));
} catch (e) {
  fail(`could not build the diff-json (${base ? `--base ${base}` : `--diff-json ${diffJson}`}): ${e.message}`);
}
console.log(
  JSON.stringify(
    {
      ...selectReviewers({ config, diff, brief }),
      brief: run ? { run_id: run.id, risk_flags: brief.risk_flags ?? [] } : null,
    },
    null,
    2
  )
);
