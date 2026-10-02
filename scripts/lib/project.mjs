// Shared plumbing for conductor-invoked [S] scripts: target-project resolution,
// config, store, args.
import { readFileSync, existsSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { parseConfig } from '@sterling/schemas';
import { SterlingStore, MountedStores, resolveDomainMounts, missingDomainWarning } from '@sterling/store';
import { resolveStoreWritePath } from './store-path.mjs';

// ONE exact-token flag parser for every sanctioned CLI (decision
// sanctioned-script-store-writes-one-containment-helper-one-arg-parser, R5).
// `name` is accepted THREE ways: bare ('lane', the record's own signature and
// the frozen pins' shape, gets '--' prepended), already double-dashed
// ('--lane', the pre-existing long-flag convention), or already
// single-dashed ('-m', the pre-existing SHORT-flag convention — commit-
// reviewed.mjs's `-m`/`--message`). A name that ALREADY starts with '-' (one
// dash or two) is used AS-IS and never re-prefixed — `'-m'.startsWith('--')`
// is false, so the old two-dash-only check turned '-m' into '---m' and broke
// every short-flag caller.
// Only a name with NO leading dash at all gets '--' prepended.
function normalizeFlag(name) {
  return name.startsWith('-') ? name : `--${name}`;
}

// Recognises BOTH VALUE spellings: `--name value` (split form) and
// `--name=value` (equals form). Returns:
//   - undefined  when the flag is absent, or when a split-form flag is the
//     LAST token with nothing after it (never a string either way).
//   - ''         when the equals form was given with no value (`--name=`) — a
//     BAD VALUE, deliberately distinct from undefined/absent, because a bare
//     declaration and an empty explicit one are different claims. Refusing an
//     empty value is the CALLER's job (arg() only reports what was said).
//   - the string value otherwise (only the FIRST '=' separates — a value that
//     itself contains '=' survives verbatim).
//
// THROWS (never silently swallows) on two shapes:
//   - a split-form 'value' that is itself another flag ('--lane --other', or
//     the single-dash form '-m -v') — never read as a value, because handing
//     it back would silently consume the next flag as this one's argument.
//     Matched by /^-{1,2}[A-Za-z]/: one or two leading dashes immediately
//     followed by a letter — '-m'/'--lane' match (flag-shaped), a bare '--'
//     or a negative number like '-5'/'-1.5' do NOT (no letter follows the
//     dash(es)), so a legitimate negative-number value still parses. A bare
//     '--' is left to the CALLER to refuse if it cares — this parser only refuses
//     values that look like a NAMED flag, not merely dash-shaped ones.
//   - DUPLICATE occurrences of the same flag, in ANY spelling combination
//     (`--lane=a --lane b`) — never first-or-last-wins. There is no way for a
//     caller to tell "one occurrence" from "we picked one of many" once the
//     parser has already collapsed them to a single return value, so it
//     throws rather than choosing.
const FLAG_SHAPED_VALUE = /^-{1,2}[A-Za-z]/;
function occurrences(flag, argv) {
  const eq = `${flag}=`;
  const found = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === flag) {
      const next = argv[i + 1];
      if (next !== undefined && FLAG_SHAPED_VALUE.test(next)) {
        throw new Error(`${flag}: the value '${next}' looks like another flag — refusing to read it as ${flag}'s value`);
      }
      found.push(next); // undefined for a trailing flag with nothing after it
    } else if (tok.startsWith(eq)) {
      found.push(tok.slice(eq.length));
    }
  }
  return found;
}

// Presence-only scan (BOTH spellings, `--name` and `--name=...`) with NO
// inspection of what follows a split-form occurrence — a pure boolean/verb
// flag (e.g. `--release --reason "<why>"`) has nothing to do with what token
// happens to come after it, so hasFlag() must never apply arg()'s "a value
// that looks like another flag is refused" rule to its OWN following token.
// That rule belongs to VALUE extraction (occurrences/arg), not presence.
function presenceCount(flag, argv) {
  const eq = `${flag}=`;
  let count = 0;
  for (const tok of argv) {
    if (tok === flag || tok.startsWith(eq)) count++;
  }
  return count;
}

export function arg(name, argv = process.argv.slice(2)) {
  const flag = normalizeFlag(name);
  const found = occurrences(flag, argv);
  if (found.length > 1) {
    throw new Error(`${flag}: given more than once (${found.length} occurrences) — refusing rather than silently taking the first or last value`);
  }
  return found.length ? found[0] : undefined;
}

// Presence check recognising BOTH spellings (`--name` and `--name=...`) as
// present — the exact bug this parser exists to close: the old bare
// `argv.includes('--lane')` presence test missed `--lane=research` entirely,
// silently narrowing a claimed discharge (board a506e9a7). Duplicates refuse
// here too, for the same reason arg() refuses them.
export function hasFlag(name, argv = process.argv.slice(2)) {
  const flag = normalizeFlag(name);
  const count = presenceCount(flag, argv);
  if (count > 1) {
    throw new Error(`${flag}: given more than once (${count} occurrences) — refusing rather than silently taking the first or last value`);
  }
  return count === 1;
}

export function argAll(name, argv = process.argv.slice(2)) {
  const out = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === name && argv[i + 1]) out.push(argv[++i]);
  return out;
}

export function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

// Opt-in worktree detection (board ks-dashboards-gap-1). A LINKED git worktree
// never has `.sterling/` (it is gitignored), so resolveProject, which reads only
// <cwd>/.sterling, reports "not an initialized project" there. Callers that can
// work from a worktree ask this first and pass the returned mainRoot to
// openProject; every other caller keeps resolveProject's behaviour unchanged.
// A linked worktree is one whose `--git-dir` differs from its `--git-common-dir`;
// the main checkout is the parent of the common dir. Returns
// { worktree, mainRoot } (real paths) for a linked worktree, or null for the
// main checkout, a non-git directory, git failing, and a bare-repo main (whose
// common dir is not `<checkout>/.git`, so there is no main checkout to name).
export function resolveLinkedWorktree(cwd = process.cwd()) {
  const r = spawnSync('git', ['rev-parse', '--git-dir', '--git-common-dir', '--show-toplevel'], { cwd, encoding: 'utf8', timeout: 30_000 });
  if (r.error || r.status !== 0) return null;
  const [gitDir, commonDir, toplevel] = r.stdout.split('\n').map((l) => l.trim());
  if (!gitDir || !commonDir || !toplevel) return null;
  const gitDirReal = realpathSync(resolve(cwd, gitDir));
  const commonReal = realpathSync(resolve(cwd, commonDir));
  if (gitDirReal === commonReal || basename(commonReal) !== '.git') return null;
  return { worktree: realpathSync(toplevel), mainRoot: dirname(commonReal) };
}

// Resolve the store path + config once; both openers share the existsSync guard,
// the single config parse, and the one P5 failure path.
//
// CONTAINMENT (decision sanctioned-script-store-writes-one-containment-
// helper-one-arg-parser, R5): dbPath is what openProject/openMounted hand to
// `new SterlingStore(dbPath)`, opened WRITABLE — a symlinked `.sterling` here
// would redirect every store write this shared opener makes, for every
// caller of openProject/openMounted. Routed through the helper so a
// symlinked component refuses before the store is ever opened.
function resolveProject(cwd) {
  let dbPath, configPath;
  try {
    dbPath = resolveStoreWritePath(cwd, '.sterling', 'sterling.db');
    configPath = resolveStoreWritePath(cwd, '.sterling', 'config.json');
  } catch (e) {
    fail(e.message);
  }
  if (!existsSync(dbPath)) fail(`no Sterling store at ${dbPath} — not an initialized project`);
  let config;
  try {
    config = parseConfig(existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {});
  } catch (e) {
    fail(`malformed .sterling/config.json — failing loud, never half-applying (P5): ${e.message}`);
  }
  return { dbPath, config };
}

// Bare project store — for project-local work: run/board/transient state and
// owner-lookup by repo file_key (a repo path only ever matches project-scoped
// records, so domain mounts buy that path nothing — §3.3).
export function openProject(cwd = process.cwd()) {
  const { dbPath, config } = resolveProject(cwd);
  return { cwd, store: new SterlingStore(dbPath), config };
}

// Domain-aware store (§3.4/P6): the project store fanned across the mounted
// domain stores (the config.stack_tags manifest, resolveDomainMounts — the same
// resolver the MCP server uses). For retrieval that must see
// shared knowledge — prep's knowledge_pack. Run/board/transient writes still
// land in the project store (MountedStores forwards them). Same return shape as
// openProject, so callers swap one for the other. A configured domain whose
// store is missing is skipped and announced on stderr, never a failure (board
// 675daf9d (c) ruling); store.missingDomains lists the skipped ones.
export function openMounted(cwd = process.cwd()) {
  const { dbPath, config } = resolveProject(cwd);
  const store = new MountedStores(dbPath, resolveDomainMounts(config), { skipMissing: true });
  for (const m of store.missingDomains) process.stderr.write(missingDomainWarning(m) + '\n');
  return { cwd, store, config };
}

// Read-only project store, for scripts that must never write (cleanup-plan).
// openProject is NOT read-only: the SterlingStore constructor sets the journal
// mode and runs its DDL and additive migrations, which write to a store whose
// schema lags the code. This copies the live store through a readOnly SQLite
// connection (VACUUM INTO a temp file) and opens SterlingStore on the copy, so
// every store read works and the live file is never opened for writing. A
// readOnly open of a WAL store may still create the -shm index file; it never
// changes the database. close() closes the copy and deletes it.
export function openProjectReadOnly(cwd = process.cwd()) {
  const { dbPath, config } = resolveProject(cwd);
  const dir = mkdtempSync(join(tmpdir(), 'sterling-readonly-'));
  const snapshot = join(dir, 'sterling.db');
  let store;
  try {
    const ro = new DatabaseSync(dbPath, { readOnly: true });
    try {
      ro.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
    } finally {
      ro.close();
    }
    store = new SterlingStore(snapshot);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    fail(`read-only snapshot of ${dbPath} failed — ${e.message}`);
  }
  const close = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { cwd, store, config, close };
}

// CONTAINMENT (decision sanctioned-script-store-writes-one-containment-
// helper-one-arg-parser, R5): the shared run-directory path builder for
// §10-adjacent scripts that read/write run-scoped files. cwd is
// always an opened project root by the time callers reach here (openProject/
// openMounted already ran), so this only throws on a genuinely malformed or
// attacked runId/tree — a caller that does not wrap the call gets a loud
// crash, which is still P5-compliant, just less polished than a clean fail().
export function runDir(cwd, runId) {
  return resolveStoreWritePath(cwd, '.sterling', 'runs', runId);
}
