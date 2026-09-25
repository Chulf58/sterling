// Handoff projection CLI (decision
// init-prepares-opencode-portable-agents-and-target-handoff-projections):
//   node scripts/handoff-projection.mjs [<project root>]
// Projects a TARGET project's own store into committed architecture.md /
// rulings.md indexes and docs/sterling/<type>/<slug>.md record files (see
// scripts/lib/handoff-projection.mjs), and registers those files in the target's
// config.generated_projections. Run by /sterling:init and the /sterling:update
// fan-out; safe to run by hand.
//
// The first stdout line is always `handoff projection: <STATUS> — <detail>`.
// Exit codes:
//   0  written | unchanged | SKIPPED (the Sterling clone itself — it owns
//      different projections, produced by architecture-projection.mjs and
//      rulings-projection.mjs)
//   2  REFUSED, STANDING — store_authority is not 'primary' (refinement (f)). A
//      declared state of this project, not a defect: nothing was written, and
//      nothing here can change until the authority does.
//   3  REFUSED, ACTIONABLE — nothing was written, and the user can fix it: no
//      store; an empty store while exports exist; a hand-written file in the way;
//      a symlink or non-directory on the way; a generated path the target's own
//      ignore rules cover. /sterling:update withholds its
//      completion marker, so the next update retries.
//   1  failed part-way — the export may be INCOMPLETE; rerun after fixing
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProject } from './lib/project.mjs';
import { ContainmentError, existsContained, readContained, writeContained, unlinkContained } from './lib/contained-fs.mjs';
import { buildHandoffFiles, planHandoff, registeredProjections, isSterlingClone } from './lib/handoff-projection.mjs';
import { ignoredPaths, ignoredRemedy } from './lib/git-ignore-check.mjs';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(process.argv[2] ?? process.cwd());
const fwd = (p) => p.replace(/\\/g, '/');

const STANDING = 2;
const ACTIONABLE = 3;
function refuse(detail, code = ACTIONABLE) {
  console.log(`handoff projection: REFUSED — ${detail}`);
  console.log('Nothing was written; existing exports are untouched.');
  process.exit(code);
}

// The clone detection and the store probe read TARGET paths: both go through
// contained-fs, and a containment failure is an actionable refusal (Sol re-check).
let cloneTarget;
let storePresent;
try {
  cloneTarget = isSterlingClone(target, pluginRoot);
  storePresent = cloneTarget || existsContained(target, '.sterling/sterling.db', 'file');
} catch (err) {
  if (!(err instanceof ContainmentError)) throw err;
  refuse(`${err.message} (every read, write and removal stays inside the project).`);
}
if (cloneTarget) {
  console.log(`handoff projection: SKIPPED — ${fwd(target)} is a Sterling clone; its architecture.md and rulings.md come from scripts/architecture-projection.mjs and scripts/rulings-projection.mjs, never from this script.`);
  process.exit(0);
}
if (!storePresent) {
  refuse(`no Sterling store at ${fwd(join(target, '.sterling', 'sterling.db'))} — run /sterling:init in that project first.`);
}

const { store, config } = openProject(target);
let records;
try {
  if (config.store_authority !== 'primary') {
    refuse(`store_authority is '${config.store_authority}' in .sterling/config.json — only the primary store may produce the committed exports (decision 'Citation and projection authority is per-store'); a secondary store projects a smaller document over a shared file.`, STANDING);
  }
  records = store.query({ types: ['feature_article', 'decision', 'anti_pattern'], cap: 1_000_000 });
} finally {
  store.close();
}

const { files, recordCount } = buildHandoffFiles(records);
let plan;
try {
  plan = planHandoff(target, files);
} catch (err) {
  if (!(err instanceof ContainmentError)) throw err;
  refuse(`${err.message} (every read, write and removal stays inside the project).`);
}
// An empty store may only CREATE the "No records yet" indexes (a genuinely new
// project) or find them unchanged. If it would replace or remove ANY existing
// export — record files or the root indexes alone — the store is empty or not
// the one that produced them, so nothing is touched (Sol review HIGH).
if (recordCount === 0) {
  const replaced = [...plan.write.filter((rel) => existsContained(target, rel, 'file')), ...plan.remove];
  if (replaced.length) {
    refuse(`the store holds no articles, decisions or anti-patterns, but existing exports would be replaced or removed (${replaced.join(', ')}) — refusing to wipe them from an empty or foreign store.`);
  }
}
// Every generated path must be committable: refuse, naming the rule, if the
// target's own ignore rules cover one (never edit them). Outside a git work tree
// there is nothing to commit into, and that is said, not skipped silently.
const ignore = ignoredPaths(target, [...files.keys()]);
const notes = ignore.checked ? [] : [`  note: the ignore-rule check was skipped (${ignore.reason})`];
if (ignore.checked && ignore.ignored.length) refuse(ignoredRemedy(ignore.ignored));
if (plan.foreign.length) {
  refuse(`${plan.foreign.join(', ')} exist${plan.foreign.length === 1 ? 's' : ''} and ${plan.foreign.length === 1 ? 'was' : 'were'} not generated by Sterling — move or rename ${plan.foreign.length === 1 ? 'it' : 'them'}, then rerun.`);
}

const done = { written: [], removed: [] };
try {
  for (const rel of plan.write) {
    writeContained(target, rel, files.get(rel));
    done.written.push(rel);
  }
  for (const rel of plan.remove) {
    unlinkContained(target, rel);
    done.removed.push(rel);
  }
  const configRel = '.sterling/config.json';
  const raw = existsContained(target, configRel, 'file') ? readContained(target, configRel) : '';
  const parsed = raw ? JSON.parse(raw) : {};
  const next = registeredProjections(parsed.generated_projections, files, done.removed);
  if (JSON.stringify(next) !== JSON.stringify(parsed.generated_projections ?? [])) {
    parsed.generated_projections = next;
    writeContained(target, configRel, JSON.stringify(parsed, null, 2) + (raw.endsWith('\n') || !raw ? '\n' : ''));
    done.registered = true;
  }
} catch (err) {
  console.log(`handoff projection: FAILED — the export is INCOMPLETE (${done.written.length} of ${plan.write.length} file(s) written, ${done.removed.length} of ${plan.remove.length} removed): ${err?.message ?? err}`);
  process.exit(1);
}

const changed = done.written.length + done.removed.length;
const summary = `${recordCount} record(s); ${done.written.length} written, removed ${done.removed.length}, ${plan.unchanged.length} unchanged${done.registered ? '; config.generated_projections updated' : ''}`;
console.log(`handoff projection: ${changed || done.registered ? 'written' : 'unchanged'} — ${summary}`);
for (const rel of done.written) console.log(`  wrote ${rel}`);
for (const rel of done.removed) console.log(`  removed ${rel}`);
for (const note of notes) console.log(note);
