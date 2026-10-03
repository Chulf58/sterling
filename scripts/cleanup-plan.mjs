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
// A reference is a mention of the filename, the stem, the stem's PascalCase or
// camelCase form, or (for a .gd file) the class_name the file declares. A
// generic basename (README, index, main) names every such file in the repo, so
// only a path-qualified mention counts for it.
// The paths of one deletable article die together: a reference from another
// path of the same article that is itself being deleted does not keep a path.
// A reference from any other file does, and a path that stays (keep, release)
// is such a file, so what a kept path names stays with it.
// Only `delete` paths reach the top-level delete_paths list. An article whose
// every path is absent is not a candidate at all (decision
// cleanup-plan-skips-deprecated-articles-whose-files-are-all-gone): its files
// are already deleted, the store keeps it as history, and nothing is left to
// plan. A path that cannot be statted for any reason but ENOENT counts as
// present. The planner opens a read-only copy of the store and never writes to it.
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join, posix } from 'node:path';
import { spawnSync } from 'node:child_process';
import { arg, openProjectReadOnly } from './lib/project.mjs';

// A capped query that silently dropped a live co-owner would turn a release
// into a delete, so a full window refuses instead of planning.
const ARTICLE_CAP = 10000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const LIST_LIMIT = 5;
// Stems (compared case-insensitively) that name a role, not a feature: a
// mention of the bare name says nothing about one particular file. Below the
// repo root they are searched path-qualified everywhere and by bare name or
// stem only inside their own directory; at the root they keep the bare-name
// search everywhere, because a root file is imported from any directory.
// mod and __init__ are not here: they never appear in a reference at all (a
// reference is `mod oldfeat;` or `import oldpkg`), so they keep the bare-name
// search and gain the directory name below.
const GENERIC_STEMS = new Set(['readme', 'index', 'main', 'changelog', 'license', 'contributing']);
// Stems whose file is reached through its directory's name (`mod oldfeat;`,
// `import oldpkg`, `from './legacy'`) rather than through a path: the directory
// name is a needle too. It only widens the search, so it can only keep more.
const DIRECTORY_NAMED_STEMS = new Set(['index', 'mod', '__init__']);

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

// What a reference to the path looks like: its basename, the basename without
// the extension, that stem in PascalCase and camelCase (foo_bar -> FooBar,
// fooBar), and for a .gd file every `class_name` it declares, which is the name
// other scripts use and `extends`. A generic basename below the repo root
// (GENERIC_STEMS) gets the path-qualified forms searched everywhere (the full
// repo-relative path, and its last directory segment plus the basename and plus
// the stem) and the bare basename and stem searched only in `local`, the files
// under its own directory. index, mod and __init__ also get their directory
// name. `what` words the evidence for the printed reason. Returns
// { needles, local, localDir, what } or { error } when the file cannot be read
// for its class_name.
function needlesFor(path) {
  const base = basename(path);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const dirPath = posix.dirname(path);
  const inRoot = dirPath === '.';
  const dirSegment = inRoot ? '' : basename(dirPath);
  const lower = stem.toLowerCase();
  let needles;
  let local = [];
  let what = 'its filename, stem or declared class';
  if (GENERIC_STEMS.has(lower) && !inRoot) {
    needles = [path, `${dirSegment}/${base}`, `${dirSegment}/${stem}`];
    local = [base, stem];
    what = `its path (a generic name, so searched path-qualified everywhere and by bare name or stem only in its own directory ${dirPath}/)`;
  } else {
    const words = stem.split(/[^A-Za-z0-9]+/).filter(Boolean);
    const pascal = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('');
    const camel = pascal ? pascal[0].toLowerCase() + pascal.slice(1) : '';
    needles = [base, stem, pascal, camel];
  }
  if (DIRECTORY_NAMED_STEMS.has(lower) && dirSegment) {
    needles.push(dirSegment);
    what = local.length ? `${what}, and by its directory name` : 'its filename, stem, declared class or directory name';
  }
  if (base.endsWith('.gd')) {
    let text;
    try {
      text = readFileSync(join(target, path), 'utf8');
    } catch (e) {
      return { error: `could not read the file to find its class_name (${e.code ?? e.message})` };
    }
    for (const m of text.matchAll(/^\s*class_name\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) needles.push(m[1]);
  }
  return { needles: [...new Set(needles.filter(Boolean))], local: [...new Set(local)], localDir: dirPath, what };
}

// Other files (tracked, plus untracked files git does not ignore) that mention
// any needle. Fixed-string match, no regex over file text, one search per
// needle so the reason can say which needle matched. Returns
// { refs: Map<file, Set<needle matched there>>, what } or { error }.
function referencesTo(path) {
  const n = needlesFor(path);
  if (n.error) return { error: n.error };
  const refs = new Map();
  const search = (needle, pathspec) => {
    const r = runGit(['grep', '-l', '-z', '--untracked', '--fixed-strings', '-e', needle, '--', ...pathspec]);
    if (r.error) return `git grep could not be run (${r.error.message})`;
    if (r.status === 1) return null;
    if (r.status !== 0) return `git grep failed (exit ${r.status}): ${firstLine(r.stderr)}`;
    for (const f of r.stdout.split('\0')) {
      if (!f || f === path) continue;
      if (!refs.has(f)) refs.set(f, new Set());
      refs.get(f).add(needle);
    }
    return null;
  };
  for (const needle of n.needles) {
    const error = search(needle, []);
    if (error) return { error };
  }
  for (const needle of n.local) {
    const error = search(needle, [`:(literal)${n.localDir}/`]);
    if (error) return { error };
  }
  return { refs, what: n.what };
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

  const isGone = (path) => {
    try {
      lstatSync(join(target, path));
      return false;
    } catch (e) {
      return e.code === 'ENOENT';
    }
  };

  let gitWhy;
  // The verdict that needs no reference comparison, or { refs, matched } when
  // the path is on disk, unowned and has to be weighed against its referrers.
  const preliminary = (a, path) => {
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
    const { refs, what, error } = referencesTo(path);
    if (error) return ['keep', `reference check could not run: ${error}`];
    return { refs, what };
  };

  // Every path of one deletable article, to its [bucket, reason]. The paths that
  // are only waiting on their referrers form the dying group; a path with a
  // referrer outside the group is kept and leaves the group, which can put a
  // referrer of another path outside it, so this runs until nothing changes.
  const classifyArticle = (a) => {
    const verdicts = new Map();
    const group = new Map();
    for (const path of new Set(a.files.map((f) => f.path))) {
      const r = preliminary(a, path);
      if (Array.isArray(r)) verdicts.set(path, r);
      else group.set(path, r);
    }
    for (let changed = true; changed; ) {
      changed = false;
      for (const [path, { refs }] of group) {
        const outside = [...refs.keys()].filter((f) => !group.has(f));
        if (!outside.length) continue;
        const matched = [...new Set(outside.flatMap((f) => [...refs.get(f)]))];
        verdicts.set(path, ['keep', `referenced by ${outside.length} other file(s): ${listed(outside)} (matched ${listed(matched)})`]);
        group.delete(path);
        changed = true;
      }
    }
    for (const [path, { refs, what }] of group) {
      const ownDeleted = refs.size ? '; references from this article\'s own deleted files do not count' : '';
      verdicts.set(path, ['delete', `on disk, no live owner, and no other tracked file references ${what}${ownDeleted}`]);
    }
    return verdicts;
  };

  const candidates = articles
    .filter((a) => (a.state === 'deprecated' || a.state === 'dormant') && !a.files.every((f) => isGone(f.path)))
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
        const verdicts = classifyArticle(a);
        for (const path of new Set(a.files.map((f) => f.path))) {
          const [bucket, reason] = verdicts.get(path);
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
