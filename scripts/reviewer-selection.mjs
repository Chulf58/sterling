// Reviewer selection CLI (spec §7.1) — thin wrapper; the deterministic logic
// lives in scripts/lib/reviewer-selection.mjs (pure, bundle-safe: no
// main-detection that could misfire inside esbuild-bundled hooks).
// The brief is reviewer-selection's first signal source (§7.1): the active
// run's brief (or --run's) is loaded from the store so risk_flags reach
// selection; with no run (direct mode) there is no brief. The output's
// `brief` field states which brief informed the selection — a flag-less
// selection is auditable, never silent.
//   node scripts/reviewer-selection.mjs --diff-json <file> [--run <id>] [--target <dir>]
//   diff-json: [{ path, added_lines: [..] }]
import { readFileSync } from 'node:fs';
import { arg, fail, openProject, requireRun, requireBrief } from './lib/project.mjs';
import { selectReviewers } from './lib/reviewer-selection.mjs';

const diffJson = arg('--diff-json');
if (!diffJson) fail('usage: reviewer-selection.mjs --diff-json <file> [--run <id>] [--target <dir>]', 2);

const { store, config } = openProject(arg('--target') ?? process.cwd());
const runId = arg('--run');
const run = runId ? requireRun(store, runId) : store.getRun();
const brief = run ? requireBrief(store, run) : undefined;
store.close();

const diff = JSON.parse(readFileSync(diffJson, 'utf8'));
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
