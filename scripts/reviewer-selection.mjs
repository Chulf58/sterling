// Reviewer selection [S] (spec §7.1) — deterministic, never hand-picked.
// Inputs: brief risk flags (when a brief is given) + greppable diff signals
// (config-driven patterns). Logs why each reviewer was AND wasn't dispatched —
// a wrong skip is auditable, never silent. Signal sets start over-inclusive.
//
// Library form for callers (H10, step-8 pipeline); CLI:
//   node scripts/reviewer-selection.mjs --diff-json <file> [--target <dir>]
//   diff-json: [{ path, added_lines: [..] }]
import { readFileSync } from 'node:fs';
import { matchesGlob } from '@sterling/schemas';

export function selectReviewers({ config, diff, brief }) {
  const rs = config.reviewer_selection;
  const decisions = [];
  const decide = (reviewer, dispatch, why) => decisions.push({ reviewer, dispatch, why });

  const codeTouching = diff.length > 0;
  decide('correctness', codeTouching, codeTouching ? 'always runs on code-touching diffs (the floor)' : 'no code-touching diff');

  const pathHit = (patterns) => diff.find((f) => patterns.some((p) => new RegExp(p).test(f.path)));
  const contentHit = (patterns) =>
    diff.find((f) => (f.added_lines ?? []).some((l) => patterns.some((p) => new RegExp(p).test(l))));

  const secPath = pathHit(rs.security_path_patterns);
  const secContent = contentHit(rs.security_content_patterns);
  const depManifest = diff.find((f) => rs.dependency_manifests.some((g) => matchesGlob(f.path, g) || f.path.endsWith(g)));
  const secFlag = brief?.risk_flags?.includes('security_relevant');
  if (secFlag || secPath || secContent || depManifest) {
    decide(
      'security',
      true,
      secFlag
        ? 'brief risk flag security_relevant'
        : secPath
          ? `path signal: '${secPath.path}'`
          : secContent
            ? `content signal in '${secContent.path}'`
            : `dependency manifest touched: '${depManifest.path}'`
    );
  } else {
    decide('security', false, 'no security path/content/dependency/brief-flag signal');
  }

  const perfFlag = brief?.risk_flags?.includes('perf_sensitive');
  const perfPath = pathHit(rs.perf_path_patterns);
  const perfContent = contentHit(rs.perf_content_patterns);
  if (perfFlag || perfPath || perfContent) {
    decide('performance', true, perfFlag ? 'brief risk flag perf_sensitive' : perfPath ? `path signal: '${perfPath.path}'` : `content signal in '${perfContent.path}'`);
  } else {
    decide('performance', false, 'no perf signal implicated');
  }

  const addedTotal = diff.reduce((n, f) => n + (f.added_lines?.length ?? 0), 0);
  const newExports = diff.reduce(
    (n, f) => n + (f.added_lines ?? []).filter((l) => /^\s*export\s/.test(l)).length,
    0
  );
  if (addedTotal >= rs.skeptic_diff_size_threshold || newExports >= rs.skeptic_new_export_threshold) {
    decide('skeptic', true, `size/new-export threshold: ${addedTotal} added lines, ${newExports} new exports`);
  } else {
    decide('skeptic', false, `under thresholds (${addedTotal} added lines, ${newExports} new exports)`);
  }

  return {
    dispatch: decisions.filter((d) => d.dispatch).map(({ reviewer, why }) => ({ reviewer, why })),
    skipped: decisions.filter((d) => !d.dispatch).map(({ reviewer, why }) => ({ reviewer, why })),
  };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  const { arg, openProject } = await import('./lib/project.mjs');
  const diffJson = arg('--diff-json');
  if (!diffJson) {
    console.error('usage: reviewer-selection.mjs --diff-json <file> [--target <dir>]');
    process.exit(2);
  }
  const { store, config } = openProject(arg('--target') ?? process.cwd());
  store.close();
  const diff = JSON.parse(readFileSync(diffJson, 'utf8'));
  console.log(JSON.stringify(selectReviewers({ config, diff }), null, 2));
}
