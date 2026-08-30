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
//
// --base ALSO PUBLISHES THE REVIEWABLE PATCH (board f24d42b2). Roster reviewers
// hold no Bash grant, so "run `git diff <base>`" is an unsatisfiable brief
// instruction and the conductor was hand-materializing the diff — the exact
// two-step remembered procedure with a temp file that decision 4977a96c
// rejected for the selection input, and it failed the same two ways (untracked
// files under-counted; line numbers passed where CONTENT was required, which
// silenced the security reviewer). One command now does both, from ONE
// snapshot, and names the artifact in `review_artifact` inside this JSON
// document — never as a prose line, because callers parse stdout as JSON.
//
// ORDER IS FAIL-CLOSED: capture one snapshot → derive BOTH views from it →
// stage → atomically publish → and only THEN emit the selection JSON. A
// failure to build, hash or publish exits non-zero with NO usable selection on
// stdout: a selection that promises a patch nobody wrote is how the reviewer
// ends up guessing again.
import { readFileSync } from 'node:fs';
import { arg, fail, openProject, requireRun, requireBrief } from './lib/project.mjs';
import { selectReviewers } from './lib/reviewer-selection.mjs';
import { captureDiffSnapshot, diffJsonFromSnapshot } from './lib/diff-json.mjs';
import { publishReviewPatch, quoteDisplayPath } from './lib/review-patch.mjs';

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
let snapshot;
try {
  snapshot = base ? captureDiffSnapshot({ cwd, base }) : undefined;
  diff = base ? diffJsonFromSnapshot(snapshot) : JSON.parse(readFileSync(diffJson, 'utf8'));
} catch (e) {
  fail(`could not build the diff-json (${base ? `--base ${base}` : `--diff-json ${diffJson}`}): ${e.message}`);
}

// --diff-json mode publishes NO artifact, and says so LOUDLY rather than
// leaving a silent absence. A pre-built added-lines file cannot yield a
// complete patch — it has no removed lines, no headers and no deletions — and
// rendering one from it would ship exactly the lossy artifact that let real
// HIGH findings through a first review. Refusing the mode outright was the
// alternative and was rejected: --diff-json is a supported, tested input, and
// breaking it to add an artifact would disturb selection behaviour this change
// is not allowed to touch. `review_artifact` is therefore an explicit null (the
// same shape the brief-less selection already uses for `brief`), plus a stderr
// note — a reader can tell "no artifact" from "artifact missing".
let review_artifact = null;
if (base) {
  try {
    const published = publishReviewPatch({ cwd, snapshot, runId: run?.id });
    // `omitted` rides INSIDE the JSON, always present (empty when nothing was
    // dropped). stderr alone was a silent gap for the machine reader: callers
    // parse stdout — which is the entire argument for review_artifact existing
    // — so a conductor building a brief could not see that the artifact
    // UNDER-REPRESENTS the change. The stderr line stays for the human running
    // the command interactively; the path is C-quoted there because a raw
    // newline in a filename fakes an extra diagnostic line on a terminal
    // exactly the way it fakes a stanza in a patch.
    review_artifact = { ...published.artifact, omitted: published.omitted };
    for (const o of published.omitted) {
      process.stderr.write(
        `reviewer-selection: untracked ${quoteDisplayPath(o.path)} is not representable in a patch (${o.reason}) — OMITTED from the artifact, still counted in the selection\n`
      );
    }
  } catch (e) {
    fail(`could not publish the reviewable patch artifact (--base ${base}): ${e.message}`);
  }
} else {
  process.stderr.write(
    'reviewer-selection: --diff-json mode publishes no review_artifact (a pre-built added-lines file cannot yield a complete patch) — use --base <ref> to get one\n'
  );
}

console.log(
  JSON.stringify(
    {
      ...selectReviewers({ config, diff, brief }),
      brief: run ? { run_id: run.id, risk_flags: brief.risk_flags ?? [] } : null,
      review_artifact,
    },
    null,
    2
  )
);
