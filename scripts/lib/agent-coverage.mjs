// Registry-coverage scan (board 6ce18724, research_finding 0038af7c) — the
// AUTHORING side of the agent-currency blind spot.
//
// /sterling:update's agent sync fans out over the SHARED PROJECT REGISTRY, so
// it can report "N projects synced" but can never report what it does not know
// about: a project with Sterling agents installed but ABSENT from the registry
// is never visited, and its .claude/agents/ freeze at install date however
// current the clone is (measured 2026-08-28: 9 projects on this machine carry
// Sterling agents, the registry knew 7, and the two it did not know had been
// frozen 43 and 80 days). This walks the roots that already hold known projects
// and names the ones the registry is missing, so the blind spot becomes a
// number someone can read.
//
// IT REPORTS. It never writes, never re-registers, never blocks — registry
// self-heal was ruled OUT for this build (user, 2026-08-29). Kept OUT of
// lib/update.mjs's live fan-out path deliberately: the scan is pure and
// testable, and update.mjs is builtins-only at load time (it must load on an
// unbuilt clone), which this module is not — runUpdate imports it dynamically,
// after its own build step.
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseInstalledHeader } from './agent-distribution.mjs';

/** The comparison form for a project directory: resolved, forward slashes, no
 *  trailing separator (the POSIX path invariant), case-folded on Windows
 *  exactly as scripts/update.mjs's own registry `norm` does. Two legal
 *  spellings of one directory must never read as two projects — a coverage
 *  report that cries wolf on a trailing slash is a report nobody reads.
 *
 *  SYMLINKS RESOLVE TOO, when the path EXISTS. `resolve` is textual, so a
 *  project reached through a symlinked parent (routine on this machine's
 *  WSL/Windows path topology: /home/<u>/link -> /mnt/c/Users/<u>) normalizes to
 *  a different string than the registry's spelling of the same directory, and
 *  the scan then reports a registered project as unregistered — a FALSE POSITIVE
 *  in a report whose only value is being believed. realpathSync touches the
 *  filesystem and throws on a missing path, so it is guarded: a path that cannot
 *  be resolved falls back to the textual form, i.e. exactly the previous
 *  behaviour. The fallback can only ever re-introduce the false positive; it can
 *  never hide a genuinely unregistered project, because realpath is injective
 *  over existing directories. */
export function normalizeProjectPath(p) {
  const raw = resolve(String(p));
  let real = raw;
  try {
    real = realpathSync(raw);
  } catch {
    // missing / broken symlink component / unreadable — keep the textual form
  }
  const s = real.replace(/\\/g, '/').replace(/\/+$/, '');
  return isCaseInsensitivePath(s) ? s.toLowerCase() : s;
}

/** Case-folding follows the FILESYSTEM, not the process platform. Under WSL
 *  `process.platform === 'linux'`, yet /mnt/<drive>/ is DrvFs — the same
 *  case-insensitive Windows volume this repo lives on — so a registry path
 *  spelled /mnt/c/Users/... and a walked path spelled /mnt/c/users/... are one
 *  directory that a platform-keyed fold reports as two, i.e. a registered
 *  project named as unregistered. That is the 1:1 Windows/Linux parity
 *  requirement failing on the very machine the measurement came from. Two
 *  entries differing only by case cannot coexist on such a volume, so folding
 *  them together cannot merge distinct projects. */
function isCaseInsensitivePath(s) {
  return process.platform === 'win32' || /^\/mnt\/[a-z]\//i.test(s);
}

/** De-duplicate roots by the SAME identity the project comparison uses, keeping
 *  each root's first-seen spelling for walking and reporting. `new Set` over raw
 *  strings misses two legal spellings of one directory (on win32
 *  `dirname(cwd)` and `dirname(repo_path)` differ in case and separator), and a
 *  root walked twice doubles `scanned` and lists every finding twice. */
export function dedupeRoots(roots = []) {
  const seen = new Set();
  const out = [];
  for (const root of roots) {
    const key = normalizeProjectPath(root);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(root);
  }
  return out;
}

/** The agent names in a directory that Sterling actually generated. A
 *  hand-written .claude/agents is not Sterling's business — the same
 *  never-judge-a-foreign-file rule syncAgents applies (agent-distribution.mjs
 *  `foreign_file`). */
function sterlingAgentsIn(agentsDir) {
  const names = [];
  const damaged = [];
  for (const f of readdirSync(agentsDir)) {
    if (!f.endsWith('.md')) continue;
    let content;
    try {
      content = readFileSync(join(agentsDir, f), 'utf8');
    } catch (err) {
      // One unreadable file must not decide the whole project's verdict, and it
      // must not vanish either.
      damaged.push(`${f} (${err?.code ?? err?.message ?? err})`);
      continue;
    }
    const header = parseInstalledHeader(content);
    if (header) {
      names.push(header.template);
      continue;
    }
    // "Unparseable" is not "not ours". A zero-byte or truncated file, or one
    // still carrying the generated marker, is a DAMAGED Sterling install: left
    // in the foreign bucket it would make the project look agent-free and be
    // dropped from the report entirely. A genuinely hand-written agent still
    // stays silent (syncAgents' foreign_file rule).
    if (content.includes('sterling-generated') || content.trim() === '') {
      damaged.push(`${f} (no readable sterling-generated header)`);
    }
  }
  return { names: names.sort(), damaged };
}

/**
 * @param {{roots: string[], registeredProjects: string[]}} args
 *   `roots` are absolute directories that CONTAIN projects; a candidate project
 *   is a direct child of a root holding .claude/agents/.
 * @returns {{scanned: number, unregistered: {path: string, agents: string[]}[],
 *            unreadable_roots: {root: string, error: string}[],
 *            unreadable_projects: {path: string, error: string}[]}}
 *   `scanned` counts CANDIDATE project directories inspected — every direct
 *   child of a root holding .claude/agents/, including ones that turn out to
 *   carry only foreign agents. Callers must word it that way: it is not a count
 *   of projects with Sterling agents.
 */
export function scanAgentCoverage({ roots = [], registeredProjects = [] } = {}) {
  const registered = new Set(registeredProjects.map(normalizeProjectPath));
  const unregistered = [];
  const unreadable_roots = [];
  const unreadable_projects = [];
  let scanned = 0;
  for (const root of dedupeRoots(roots)) {
    let entries;
    try {
      entries = readdirSync(root);
    } catch (err) {
      // P5, and the whole lesson of anti_pattern 02a1ed39: a silently skipped
      // root makes "0 unregistered projects" indistinguishable from "half the
      // machine was never looked at". Report it, and keep scanning the rest.
      unreadable_roots.push({ root, error: err?.message ?? String(err) });
      continue;
    }
    for (const name of entries) {
      const projectDir = join(root, name);
      // statSync, NOT existsSync, and a dirent type check would be wrong too: a
      // symlinked project directory must be followed like any other (the
      // platform stores projects where the user put them), but existsSync
      // answers `false` for EACCES and for a symlink LOOP exactly as it does for
      // "absent" — so an inaccessible project was skipped with nothing recorded,
      // and the report then said "ok". Only ENOENT/ENOTDIR mean absent.
      const agentsDir = join(projectDir, '.claude', 'agents');
      try {
        if (!statSync(agentsDir).isDirectory()) continue;
      } catch (err) {
        if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') continue;
        unreadable_projects.push({ path: projectDir, error: err?.message ?? String(err) });
        continue;
      }
      scanned++;
      let agents;
      let damaged;
      try {
        ({ names: agents, damaged } = sterlingAgentsIn(agentsDir));
      } catch (err) {
        // Same reason as the root above: an unreadable agents directory is an
        // UNKNOWN, never an implicit "carries no Sterling agents". Reported
        // SEPARATELY from an unreadable root, because the blast radius differs
        // and the remedy reads differently: one project's coverage is unknown
        // here, whereas an unreadable root means every project beneath it went
        // uninspected.
        unreadable_projects.push({ path: projectDir, error: err?.message ?? String(err) });
        continue;
      }
      if (damaged.length) {
        // A damaged install is a coverage UNKNOWN for this project even when
        // other files there parsed: dropping it would let a zero-byte agent
        // stand in for "carries no Sterling agents", which is how a project
        // disappears from a report that then says "ok".
        unreadable_projects.push({ path: projectDir, error: `unreadable/damaged installed agent file(s): ${damaged.join(', ')}` });
      }
      if (!agents.length) continue;
      if (registered.has(normalizeProjectPath(projectDir))) continue;
      unregistered.push({ path: projectDir, agents });
    }
  }
  unregistered.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { scanned, unregistered, unreadable_roots, unreadable_projects };
}
