// Cleanup-plan evidence [S] (spec §8.4): the deletion plan's mechanical input.
// deprecated/dormant articles + deletion_candidate queue entries; the
// articles' file/dependency data is the evidence that makes deletion safe.
//   node scripts/cleanup-plan.mjs [--target <dir>]
//
// An article's files[] lists every file the feature touched, including shared
// host files that live articles also own, so it is NOT the deletion set. Each
// path of a deletable candidate lands in exactly one bucket:
//   release  another non-deprecated article also lists it: only this article's
//            ownership goes (a store edit), the file stays.
//   absent   not on disk: only the store entry goes.
//   keep     no live owner, but another file references it, or the reference
//            check could not run. Fails closed: unmeasured means kept.
//   delete   on disk, no live owner, no reference from any other file.
// Only `delete` paths reach the top-level delete_paths list. The planner opens
// a read-only copy of the store and never writes to it.
import { lstatSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { arg, openProjectReadOnly } from './lib/project.mjs';

// A capped query that silently dropped a live co-owner would turn a release
// into a delete, so a full window refuses instead of planning.
const ARTICLE_CAP = 10000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const LIST_LIMIT = 5;

const target = arg('--target') ?? process.cwd();

const firstLine = (s) => (s ?? '').trim().split('\n')[0] || 'no output';
const listed = (items) => (items.length > LIST_LIMIT ? `${items.slice(0, LIST_LIMIT).join(', ')} and ${items.length - LIST_LIMIT} more` : items.join(', '));
const runGit = (args) => spawnSync('git', args, { cwd: target, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER });

// Can the reference check run here at all? Returns null when it can, or the
// reason it cannot.
function gitUnavailable() {
  const r = runGit(['rev-parse', '--show-toplevel']);
  if (r.error) return `git could not be run (${r.error.message})`;
  if (r.status !== 0) return `git rev-parse failed: ${firstLine(r.stderr)}`;
  const top = r.stdout.trim();
  // git grep reports paths under the working directory only, so a project root
  // below the top level would miss references from the rest of the repo.
  if (realpathSync(top) !== realpathSync(target)) return `the project root is not the git top level (${top})`;
  const ls = runGit(['ls-files', '-z']);
  if (ls.error) return `git ls-files could not be run (${ls.error.message})`;
  if (ls.status !== 0) return `git ls-files failed: ${firstLine(ls.stderr)}`;
  return null;
}

// Other files (tracked, plus untracked files git does not ignore) that mention
// the path's basename, or its basename without the extension. Fixed-string
// match, no regex over file text. Returns { refs } or { error }.
function referencesTo(path) {
  const base = basename(path);
  const dot = base.lastIndexOf('.');
  const needles = dot > 0 ? [base, base.slice(0, dot)] : [base];
  const r = runGit(['grep', '-l', '-z', '--untracked', '--fixed-strings', ...needles.flatMap((n) => ['-e', n]), '--']);
  if (r.error) return { error: `git grep could not be run (${r.error.message})` };
  if (r.status === 1) return { refs: [] };
  if (r.status !== 0) return { error: `git grep failed (exit ${r.status}): ${firstLine(r.stderr)}` };
  return { refs: r.stdout.split('\0').filter((f) => f && f !== path) };
}

function buildPlan(store) {
  const articles = store.query({ types: ['feature_article'], cap: ARTICLE_CAP });
  if (articles.length >= ARTICLE_CAP) {
    throw new Error(`cleanup-plan REFUSED: ${articles.length} articles filled the ${ARTICLE_CAP} query window, so the live-owner set may be incomplete`);
  }
  // "active" = not itself a cleanup candidate — a dependent that is deprecated/dormant does not block.
  const isActive = (a) => a.state !== 'deprecated' && a.state !== 'dormant';
  const bySlugOrId = new Map(articles.flatMap((a) => [[a.slug, a], [a.id, a]]));
  // A file's live owners: every article that is not deprecated (dormant code is
  // still in the tree and may come back, so a dormant co-owner keeps it).
  const liveOwners = new Map();
  for (const a of articles) {
    if (a.state === 'deprecated') continue;
    for (const f of a.files) {
      if (!liveOwners.has(f.path)) liveOwners.set(f.path, []);
      liveOwners.get(f.path).push(a);
    }
  }

  let gitWhy;
  const classify = (a, path) => {
    const owners = (liveOwners.get(path) ?? []).filter((o) => o.id !== a.id).map((o) => o.slug);
    if (owners.length) return ['release', `also owned by live article(s) ${listed(owners)}; only this article's ownership goes`];
    let st;
    try {
      st = lstatSync(join(target, path));
    } catch (e) {
      if (e.code === 'ENOENT') return ['absent', 'not on disk; only the store entry goes'];
      return ['keep', `could not stat the file (${e.code ?? e.message})`];
    }
    if (!st.isFile()) return ['keep', 'not a regular file (a directory or a link); fs-remove deletes files only'];
    if (gitWhy === undefined) gitWhy = gitUnavailable();
    if (gitWhy) return ['keep', `reference check could not run: ${gitWhy}`];
    const { refs, error } = referencesTo(path);
    if (error) return ['keep', `reference check could not run: ${error}`];
    if (refs.length) return ['keep', `referenced by ${refs.length} other file(s): ${listed(refs)}`];
    return ['delete', 'on disk, no live owner, and no other file references it'];
  };

  const candidates = articles
    .filter((a) => a.state === 'deprecated' || a.state === 'dormant')
    .map((a) => {
      // relies_on names articles by SLUG (pinned convention, decision foreign_474b1c71); id accepted as a legacy fallback.
      const active_dependents = articles
        .filter((other) => other.id !== a.id && isActive(other) && (other.dependencies.relies_on.includes(a.slug) || other.dependencies.relies_on.includes(a.id)))
        .map((d) => ({ id: d.id, slug: d.slug }));
      // The candidate's own relied_by (skills/cleanup/SKILL.md: any active relied_by = blocked).
      const active_relied_by = a.dependencies.relied_by
        .map((ref) => bySlugOrId.get(ref))
        .filter((d) => d && d.id !== a.id && isActive(d))
        .map((d) => ({ id: d.id, slug: d.slug }));
      const deletable = active_dependents.length === 0 && active_relied_by.length === 0;
      let buckets = null;
      if (deletable) {
        buckets = { delete: [], release: [], absent: [], keep: [] };
        for (const path of new Set(a.files.map((f) => f.path))) {
          const [bucket, reason] = classify(a, path);
          buckets[bucket].push({ path, reason });
        }
      }
      return {
        article: a.id,
        slug: a.slug,
        state: a.state,
        files: a.files.map((f) => f.path),
        // Board a9280db7 (decision foreign_c48380bf): on a probe|tool article,
        // live_test_refs can be the structured not_applicable exemption
        // object instead of an array — normalize to [] so this reports no
        // traced tests rather than throwing on .flatMap.
        traced_tests: Array.isArray(a.live_test_refs) ? a.live_test_refs.flatMap((r) => r.test_paths) : [],
        active_dependents,
        active_relied_by,
        deletable,
        buckets,
      };
    });
  const delete_paths = [...new Set(candidates.flatMap((c) => (c.buckets ? c.buckets.delete.map((e) => e.path) : [])))].sort();
  const queue = store
    .query({ types: ['todo'], cap: 1000 })
    .filter((t) => t.source === 'system' && t.system_reason === 'deletion_candidate')
    .map((t) => ({ id: t.id, text: t.text, file_keys: t.file_keys ?? [] }));
  return { candidates, delete_paths, queue };
}

const { store, close } = openProjectReadOnly(target);
try {
  console.log(JSON.stringify(buildPlan(store), null, 2));
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  close();
}
