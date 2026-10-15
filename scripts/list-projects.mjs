// /sterling:projects — list the machine-global project registry (decision foreign_8f9e6db2).
// Read-only by default; stale-at-read: a project whose repo_path no longer exists
// is flagged MISSING (the registry stores no liveness). `--prune-missing` removes
// ONLY entries whose path is gone (human-gated; never live projects).
// `--remove <path>` previews deleting <path>/.sterling and unregistering the
// project; `--remove <path> --apply` does it, backup first, refusing while the
// store is open (decision remove-a-project-store-list-projects-remove-backup-first-refuse-if-open,
// GitHub #109). The script never prompts; the caller asks the user between the two.
//   node scripts/list-projects.mjs [--prune-missing]
//   node scripts/list-projects.mjs --remove <path> [--apply]
import { statSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { ProjectRegistry, registryPath, resolveDomainMounts, openForeignDbReadOnly } from '@sterling/store';
import { parseConfig, sameLocationAnyHost } from '@sterling/schemas';
import { LAUNCHER_GITIGNORE_ENTRIES } from './lib/launchers.mjs';
import { UPDATE_LAUNCHER_NAME } from './lib/update-launcher.mjs';

function usage(msg) {
  console.error(`list-projects REFUSED: ${msg}\nusage: list-projects.mjs [--prune-missing] | --remove <path> [--apply]`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = { prune: false, remove: undefined, apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--prune-missing') out.prune = true;
    else if (a === '--apply') out.apply = true;
    else if (a === '--remove') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) usage('--remove needs a path');
      if (out.remove !== undefined) usage('--remove given more than once');
      out.remove = v;
    } else usage(`unknown argument '${a}'`);
  }
  if (out.apply && out.remove === undefined) usage('--apply needs --remove <path>');
  if (out.prune && out.remove !== undefined) usage('--prune-missing and --remove cannot be combined');
  return out;
}

/** Files init writes outside .sterling. Listed by the preview, never deleted. */
const LEFTOVER_NAMES = ['AGENTS.md', 'CLAUDE.md', '.opencode', '.claude', ...LAUNCHER_GITIGNORE_ENTRIES, UPDATE_LAUNCHER_NAME];

const STORE_FILES = ['sterling.db', 'sterling.db-wal', 'sterling.db-shm'];


function listProjects(prune) {
  if (prune) {
    let removed = 0;
    for (const p of registry.list()) {
      if (!existsSync(p.repo_path)) {
        registry.remove(p.repo_path);
        removed++;
      }
    }
    console.log(`Pruned ${removed} missing project${removed === 1 ? '' : 's'}.\n`);
  }

  const rows = registry.list();
  if (!rows.length) {
    console.log('No projects registered yet — run /sterling:init in a project to register it.');
    return;
  }

  console.log(`${rows.length} registered Sterling project${rows.length === 1 ? '' : 's'}:\n`);
  for (const p of rows) {
    const live = existsSync(p.repo_path);
    const tags = p.stack_tags.length ? p.stack_tags.join(', ') : '—';
    const tools = p.toolchains.length ? p.toolchains.join(', ') : '—';
    const seen = p.last_seen_at ? p.last_seen_at.slice(0, 10) : 'never';
    console.log(`${live ? '•' : '✗'} ${p.name}  (${p.repo_path})${live ? '' : '  — MISSING'}`);
    console.log(`    domains/tags: [${tags}]   toolchains: [${tools}]   sterling: ${p.sterling_version ?? '?'}`);
    console.log(`    first init: ${p.first_init_at.slice(0, 10)}   last init: ${p.last_init_at.slice(0, 10)}   last seen: ${seen}`);
  }
  const missing = rows.filter((p) => !existsSync(p.repo_path)).length;
  if (missing && !prune) {
    console.log(`\n${missing} project${missing === 1 ? '' : 's'} MISSING (path gone). Prune with: node "<Sterling root>/bin/list-projects.mjs" --prune-missing`);
  }
}

// ── --remove ──────────────────────────────────────────────────────────────────

/** lstat, or undefined when the path does not exist; any other error is thrown. */
function lstatOrUndefined(p) {
  try {
    return lstatSync(p);
  } catch (e) {
    if (e?.code === 'ENOENT') return undefined;
    throw e;
  }
}

/** Is p the directory dir or inside it (plain path comparison of absolute paths)? */
function isWithin(p, dir) {
  const rel = relative(dir, p);
  // Segment comparison: a child named '..shared' is inside, only '..' itself or '../x' is out.
  return !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/** p and, when it exists, its realpath: a path is inside dir if either form is. */
function pathForms(p) {
  const forms = [p];
  try {
    forms.push(realpathSync(p));
  } catch (e) {
    if (e?.code !== 'ENOENT') throw e;
  }
  return forms;
}

/** /proc, or the directory STERLING_PROC_ROOT names (a test seam for a fake /proc). */
const PROC = process.env.STERLING_PROC_ROOT ?? '/proc';

/** A pid that vanished mid-scan: not a failure of the check. */
const vanished = (e) => e?.code === 'ENOENT' || e?.code === 'ESRCH';

/** Does pid run as this user (real or effective uid)? Undefined when it vanished. */
function ownedByMe(pid) {
  const me = process.getuid();
  try {
    const m = readFileSync(`${PROC}/${pid}/status`, 'utf8').match(/^Uid:\s+(\d+)\s+(\d+)/m);
    if (m) return Number(m[1]) === me || Number(m[2]) === me;
  } catch (e) {
    if (vanished(e)) return undefined;
  }
  try {
    return statSync(`${PROC}/${pid}`).uid === me;
  } catch (e) {
    if (vanished(e)) return undefined;
    throw e;
  }
}

/** The command name from /proc/<pid>/comm, else the basename of argv[0] from
 *  cmdline; undefined when neither can be read. */
function nameOf(pid) {
  try {
    const comm = readFileSync(`${PROC}/${pid}/comm`, 'utf8').trim();
    if (comm) return comm;
  } catch {
    // fall back to cmdline
  }
  try {
    const argv0 = readFileSync(`${PROC}/${pid}/cmdline`, 'utf8').split('\0')[0];
    if (argv0) return basename(argv0);
  } catch {
    // unknown
  }
  return undefined;
}

/** Command names that could hold a Sterling store open (user-ruled 2026-10-15). */
const STERLING_CAPABLE = new Set(['node', 'bun', 'opencode', 'claude', 'sqlite3']);

/** Could this process hold a Sterling store? An unknown name counts as yes. */
function couldBeSterling(name) {
  return name === undefined || STERLING_CAPABLE.has(name) || /sterling/i.test(name);
}

function commOf(pid) {
  try {
    return readFileSync(`${PROC}/${pid}/comm`, 'utf8').trim();
  } catch {
    return '?'; // the process exited; the pid is still the evidence
  }
}

/**
 * Processes holding any of `files` open, from /proc/<pid>/fd readlinks. Best
 * effort: it cannot see a session that starts later or a Windows-side handle.
 * A process of THIS user whose fds cannot be read (EACCES/EPERM) is returned in
 * `sameUserBlind` with `possiblySterling` set when its command name is node,
 * bun, opencode, claude or sqlite3, contains "sterling", or cannot be read; the
 * caller refuses on those (a Sterling session runs as the user) and warns on the
 * rest. A same-uid process may be uninspectable for unrelated reasons, e.g.
 * (sd-pam), fusermount3 and browser sandboxes;
 * as the user. Other users' uninspectable processes are only counted. A pid
 * that vanishes (ENOENT/ESRCH) is skipped. Returns { ran: false, reason } when
 * /proc cannot be listed, so the caller refuses instead of claiming the check ran.
 */
function openHolders(files) {
  let pids;
  try {
    pids = readdirSync(PROC).filter((d) => /^\d+$/.test(d));
  } catch (e) {
    return { ran: false, reason: `${PROC} is not readable (${e.code ?? e.message})` };
  }
  const wanted = new Set(files);
  const holders = [];
  const sameUserBlind = [];
  let otherUserBlind = 0;
  const blind = (pid, e) => {
    const mine = ownedByMe(pid);
    if (mine === undefined) return;
    if (mine) {
      const name = nameOf(pid);
      sameUserBlind.push({ pid: Number(pid), command: name ?? 'unknown', possiblySterling: couldBeSterling(name), reason: e.code ?? e.message });
    }
    else otherUserBlind++;
  };
  for (const pid of pids) {
    if (Number(pid) === process.pid) continue;
    let fds;
    try {
      fds = readdirSync(`${PROC}/${pid}/fd`);
    } catch (e) {
      if (!vanished(e)) blind(pid, e);
      continue;
    }
    for (const fd of fds) {
      let link;
      try {
        link = readlinkSync(`${PROC}/${pid}/fd/${fd}`);
      } catch (e) {
        if (vanished(e)) continue; // the fd or the process closed between the listing and the readlink
        blind(pid, e);
        break;
      }
      const file = link.endsWith(' (deleted)') ? link.slice(0, -' (deleted)'.length) : link;
      if (wanted.has(file)) holders.push({ pid: Number(pid), command: commOf(pid), file });
    }
  }
  return { ran: true, holders, sameUserBlind, otherUserBlind };
}

function utcStamp(d) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/**
 * Everything --remove knows about a target, and every reason --apply would
 * refuse. Identity and open checks run before the store is opened for the
 * preview; --apply calls this again before copying and again before deleting.
 */
function inspect(input, stamp) {
  const refusals = [];
  const abs = resolve(input);
  const t = { input, path: abs, refusals };

  const st = lstatOrUndefined(abs);
  if (!st) refusals.push(`${abs} does not exist`);
  else if (st.isSymbolicLink()) refusals.push(`${abs} is a symlink; pass the real directory`);
  else if (!st.isDirectory()) refusals.push(`${abs} is not a directory`);
  else {
    const real = realpathSync(abs);
    if (real !== abs) refusals.push(`${abs} resolves through a symlink to ${real}; pass the canonical path`);
    t.real = real;
  }

  const rows = registry.list().filter((r) => {
    if (sameLocationAnyHost(r.repo_path, abs) || (t.real && sameLocationAnyHost(r.repo_path, t.real))) return true;
    if (!t.real) return false;
    try {
      return realpathSync(r.repo_path) === t.real;
    } catch (e) {
      if (e?.code === 'ENOENT') return false;
      throw e;
    }
  });
  if (rows.length > 1) refusals.push(`${rows.length} registry rows match this path (${rows.map((r) => `${r.name} at ${r.repo_path}`).join('; ')}); the target is ambiguous`);
  t.row = rows.length === 1 ? rows[0] : undefined;
  t.name = t.row?.name ?? basename(abs);
  if (!t.real) return t;

  const dir = join(t.real, '.sterling');
  t.sterlingDir = dir;
  const sst = lstatOrUndefined(dir);
  if (!sst) {
    // No store left but exactly one row: --apply only unregisters (a delete whose
    // unregister failed is finished this way). Several rows are refused above.
    if (rows.length === 1) t.unregisterOnly = true;
    else if (rows.length === 0) refusals.push(`nothing to remove: ${dir} does not exist and no registry row matches ${abs}`);
    return t;
  }
  if (sst.isSymbolicLink()) refusals.push(`${dir} is a symlink; refusing to delete through it`);
  else if (!sst.isDirectory()) refusals.push(`${dir} is not a directory`);
  if (!sst || sst.isSymbolicLink() || !sst.isDirectory()) return t;

  let raw;
  const cfgPath = join(dir, 'config.json');
  try {
    raw = JSON.parse(readFileSync(cfgPath, 'utf8'));
  } catch (e) {
    refusals.push(e?.code === 'ENOENT' ? `no ${cfgPath}; this is not a Sterling store` : `${cfgPath} is unreadable: ${e.message}`);
  }
  if (raw !== undefined) {
    if (raw?.storage === 'postgres') refusals.push(`the config says storage 'postgres'; this command removes local SQLite stores only`);
    if (typeof raw?.backup_path !== 'string' || !raw.backup_path.trim()) {
      refusals.push(`no backup_path in ${cfgPath}; the backup cannot be skipped`);
    } else {
      t.backupRoot = resolve(t.real, raw.backup_path);
      const safe = t.name.replace(/[^A-Za-z0-9._-]+/g, '-');
      t.backupDest = join(t.backupRoot, `removed-${safe}-${stamp}`);
      if (pathForms(t.backupRoot).some((p) => isWithin(p, dir))) refusals.push(`backup_path ${t.backupRoot} is inside ${dir}; the backup would be deleted with it`);
    }
  }

  if (pathForms(registryPath()).some((p) => isWithin(p, dir))) refusals.push(`the project registry ${registryPath()} is inside ${dir}`);

  // Another registered project that mounts a domain store inside the target.
  for (const other of registry.list()) {
    if (rows.some((r) => r.repo_path === other.repo_path) || !existsSync(other.repo_path)) continue;
    let otherRaw;
    try {
      otherRaw = JSON.parse(readFileSync(join(other.repo_path, '.sterling', 'config.json'), 'utf8'));
    } catch (e) {
      if (e?.code === 'ENOENT') continue; // no config, nothing mounted
      refusals.push(`cannot read the config of registered project ${other.name} (${other.repo_path}): ${e.message}; the mount check could not run`);
      continue;
    }
    let mounts;
    try {
      mounts = resolveDomainMounts(parseConfig(otherRaw));
    } catch (e) {
      refusals.push(`cannot parse the config of registered project ${other.name} (${other.repo_path}): ${e.message}; the mount check could not run`);
      continue;
    }
    for (const m of mounts) {
      const p = resolve(other.repo_path, m.dbPath);
      if (pathForms(p).some((f) => isWithin(f, dir))) refusals.push(`registered project ${other.name} (${other.repo_path}) mounts domain '${m.name}' at ${p}, inside ${dir}`);
    }
  }

  t.storeFiles = STORE_FILES.map((f) => join(dir, f));
  const open = openHolders(t.storeFiles);
  if (!open.ran) refusals.push(`the open-store check could not run: ${open.reason}`);
  else {
    for (const h of open.holders) refusals.push(`process ${h.pid} (${h.command}) has ${h.file} open; close that session first`);
    t.openWarnings = [];
    for (const b of open.sameUserBlind) {
      if (b.possiblySterling) refusals.push(`process ${b.pid} (${b.command}) runs as this user, could hold a Sterling store, and its open files cannot be read (${b.reason}); the open check cannot clear it`);
      else t.openWarnings.push(`process ${b.pid} (${b.command}) runs as this user and its open files cannot be read (${b.reason}); not a command that holds a Sterling store, so it does not refuse`);
    }
    t.uninspectable = open.otherUserBlind;
  }
  return t;
}

/** Test seam: STERLING_TEST_BEFORE_STORE_READ names a CommonJS module run after
 *  the sidecar checks and before the open, to simulate a writer starting then. */
function testHookBeforeStoreRead() {
  const hook = process.env.STERLING_TEST_BEFORE_STORE_READ;
  if (hook) createRequire(import.meta.url)(resolve(hook));
}

/**
 * Record counts by type and open board items. Never deletes or writes any file
 * in the target: a -wal without a -shm would make a read-only open create the
 * -shm, so the counts are skipped then. Every other topology reads through
 * openForeignDbReadOnly, which creates nothing (immutable when there is no -wal).
 * A sidecar that appears during the read is reported and left in place.
 */
function storeSummary(dir) {
  const dbPath = join(dir, 'sterling.db');
  if (!existsSync(dbPath)) return { error: 'no sterling.db' };
  const hadWal = existsSync(`${dbPath}-wal`);
  const hadShm = existsSync(`${dbPath}-shm`);
  if (hadWal && !hadShm) return { error: 'a -wal exists without a -shm, and reading would create the -shm; skipped' };
  testHookBeforeStoreRead();
  let db;
  const out = {};
  try {
    db = openForeignDbReadOnly(dbPath, 2000);
    out.byType = Object.fromEntries(db.prepare('SELECT type, COUNT(*) AS n FROM records GROUP BY type ORDER BY type').all().map((r) => [r.type, r.n]));
    out.openBoardItems = db.prepare("SELECT COUNT(*) AS n FROM records WHERE type = 'todo' AND lifecycle = 'live' AND json_extract(body, '$.source') = 'user'").get().n;
  } catch (e) {
    out.error = e.message;
  } finally {
    db?.close();
  }
  const appeared = [['-wal', hadWal], ['-shm', hadShm]].filter(([x, had]) => !had && existsSync(`${dbPath}${x}`)).map(([x]) => `sterling.db${x}`);
  if (appeared.length) out.appeared = appeared;
  return out;
}

function dryRunRemove(input) {
  const t = inspect(input, utcStamp(new Date()));
  console.log(`Remove preview (dry run; nothing is changed)\n`);
  if (t.unregisterOnly && !t.refusals.length) {
    console.log(`Registry: registered under ${t.row.name} (${t.row.repo_path})`);
    console.log(`Store already removed (${t.sterlingDir} does not exist); --apply only unregisters ${t.row.name}. No backup and no open check are needed, because nothing is deleted.`);
    return 0;
  }
  console.log(`Directory to delete: ${t.sterlingDir ?? `${t.path}/.sterling`}`);
  console.log(`Registry: ${t.row ? `registered under ${t.row.name} (${t.row.repo_path})` : 'not registered'}`);
  if (t.sterlingDir && existsSync(t.sterlingDir) && lstatSync(t.sterlingDir).isDirectory()) {
    const s = storeSummary(t.sterlingDir);
    if (s.error) console.log(`Records: could not be read (${s.error})`);
    else {
      const parts = Object.entries(s.byType).map(([k, n]) => `${k} ${n}`);
      console.log(`Records by type: ${parts.length ? parts.join(', ') : 'none'}`);
      console.log(`Open board items: ${s.openBoardItems}`);
    }
    if (s.appeared) console.log(`  ${s.appeared.join(', ')} appeared during the read (a writer may have started); left in place`);
    const others = readdirSync(t.sterlingDir, { withFileTypes: true }).filter((e) => !STORE_FILES.includes(e.name)).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    console.log(`Other entries inside .sterling (deleted too): ${others.length ? others.join(', ') : 'none'}`);
  }
  if (t.real) {
    const left = LEFTOVER_NAMES.filter((n) => existsSync(join(t.real, n)));
    console.log(`Left in place outside .sterling (never deleted): ${left.length ? left.join(', ') : 'none'}`);
    if (left.includes('.opencode')) console.log(`  .opencode is still active: OpenCode loads ancestor configs into nested projects, so remove it by hand if that matters`);
  }
  console.log(`Backup destination: ${t.backupDest ?? 'none (see refusals)'}`);
  if (t.uninspectable === undefined) console.log(`Open check: did not run`);
  else {
    console.log(`Open check: ran over /proc (best effort). A process of this user that cannot be inspected refuses when its command is node, bun, opencode, claude or sqlite3, contains "sterling", or cannot be read; ${t.uninspectable} process(es) of other users could not be inspected and do not refuse. A Windows-side handle or a later session is not seen`);
    for (const w of t.openWarnings) console.log(`  warning: ${w}`);
  }
  if (t.refusals.length) {
    console.log(`\n--apply would REFUSE:`);
    for (const r of t.refusals) console.log(`  - ${r}`);
    return 1;
  }
  console.log(`\n--apply would proceed: back up, verify, delete ${t.sterlingDir}, ${t.row ? 'unregister' : 'nothing to unregister'}.`);
  return 0;
}

/** Every entry under dir as `rel` → `kind:size`, symlinks not followed. */
function tree(dir, rel = '', out = new Map()) {
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    const st = lstatSync(join(dir, r));
    if (st.isDirectory()) {
      out.set(r, 'dir');
      tree(dir, r, out);
    } else out.set(r, `${st.isSymbolicLink() ? 'link' : 'file'}:${st.size}`);
  }
  return out;
}

function applyRemove(input) {
  const stamp = utcStamp(new Date());
  const steps = [];
  const result = { remove: resolve(input), apply: true, steps, ok: false };
  const finish = (code) => {
    result.ok = code === 0;
    console.log(JSON.stringify(result, null, 2));
    return code;
  };

  const t = inspect(input, stamp);
  if (t.refusals.length) {
    steps.push({ step: 'validate', ok: false, refusals: t.refusals });
    return finish(1);
  }
  steps.push({ step: 'validate', ok: true, ...(t.openWarnings?.length ? { warnings: t.openWarnings } : {}), mode: t.unregisterOnly ? 'unregister-only' : 'remove', target: t.sterlingDir, registered: t.row ? t.row.repo_path : null });
  if (t.unregisterOnly) return finish(unregister(t, steps));

  try {
    mkdirSync(t.backupRoot, { recursive: true });
    if (existsSync(t.backupDest)) throw new Error(`${t.backupDest} already exists`);
    cpSync(t.sterlingDir, t.backupDest, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true, preserveTimestamps: true });
    steps.push({ step: 'backup', ok: true, destination: t.backupDest });
  } catch (e) {
    steps.push({ step: 'backup', ok: false, destination: t.backupDest, error: e.message, note: 'nothing was deleted; a partial copy may remain at the destination' });
    return finish(1);
  }

  try {
    const src = tree(t.sterlingDir);
    const dst = tree(t.backupDest);
    const diff = [...new Set([...src.keys(), ...dst.keys()])].filter((k) => src.get(k) !== dst.get(k));
    if (diff.length) throw new Error(`the copy differs from the source at: ${diff.slice(0, 10).join(', ')}`);
    for (const f of ['sterling.db', 'sterling.db-wal']) {
      const a = join(t.sterlingDir, f);
      if (!existsSync(a)) continue;
      if (!readFileSync(a).equals(readFileSync(join(t.backupDest, f)))) throw new Error(`${f} in the copy is not byte-identical`);
    }
    steps.push({ step: 'verify', ok: true, entries: src.size });
  } catch (e) {
    steps.push({ step: 'verify', ok: false, error: e.message, note: 'nothing was deleted' });
    return finish(1);
  }

  const again = inspect(input, stamp);
  if (again.refusals.length || again.real !== t.real || again.row?.repo_path !== t.row?.repo_path) {
    steps.push({ step: 'recheck', ok: false, refusals: again.refusals.length ? again.refusals : ['the target or its registry row changed during the backup'], note: 'nothing was deleted; the backup remains' });
    return finish(1);
  }
  steps.push({ step: 'recheck', ok: true });

  try {
    rmSync(t.sterlingDir, { recursive: true });
    steps.push({ step: 'delete', ok: true, deleted: t.sterlingDir });
  } catch (e) {
    steps.push({ step: 'delete', ok: false, error: e.message, note: `the delete may be partial; the verified backup is at ${t.backupDest}` });
    return finish(1);
  }

  return finish(unregister(t, steps));
}

/** Remove the target's registry row (or note there is none); returns the exit code. */
function unregister(t, steps) {
  if (!t.row) {
    steps.push({ step: 'unregister', ok: true, skipped: 'not registered' });
    return 0;
  }
  try {
    if (!registry.remove(t.row.repo_path)) throw new Error(`no row for ${t.row.repo_path} was found to remove`);
    steps.push({ step: 'unregister', ok: true, removed: t.row.repo_path });
    return 0;
  } catch (e) {
    steps.push({
      step: 'unregister',
      ok: false,
      error: e.message,
      note: `the registry row for ${t.row.repo_path} remains${t.unregisterOnly ? '' : '; .sterling is deleted and backed up'}. Re-run list-projects.mjs --remove ${t.path} --apply: with .sterling gone it only unregisters.`,
    });
    return 1;
  }
}

// Runs last, after every module-level constant is initialized.
const args = parseArgs(process.argv.slice(2));
const registry = new ProjectRegistry(registryPath());
try {
  if (args.remove !== undefined) process.exitCode = args.apply ? applyRemove(args.remove) : dryRunRemove(args.remove);
  else listProjects(args.prune);
} finally {
  registry.close();
}
