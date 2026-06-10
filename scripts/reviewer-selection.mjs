// Reviewer selection CLI (spec §7.1) — thin wrapper; the deterministic logic
// lives in scripts/lib/reviewer-selection.mjs (pure, bundle-safe: no
// main-detection that could misfire inside esbuild-bundled hooks).
//   node scripts/reviewer-selection.mjs --diff-json <file> [--target <dir>]
//   diff-json: [{ path, added_lines: [..] }]
import { readFileSync } from 'node:fs';
import { arg, fail, openProject } from './lib/project.mjs';
import { selectReviewers } from './lib/reviewer-selection.mjs';

const diffJson = arg('--diff-json');
if (!diffJson) fail('usage: reviewer-selection.mjs --diff-json <file> [--target <dir>]', 2);

const { store, config } = openProject(arg('--target') ?? process.cwd());
store.close();
const diff = JSON.parse(readFileSync(diffJson, 'utf8'));
console.log(JSON.stringify(selectReviewers({ config, diff }), null, 2));
