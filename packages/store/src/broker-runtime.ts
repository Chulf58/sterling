// The hook store broker's local runtime files (decision
// hook-store-broker-whole-method-rpc-over-local-socket, point 3): where the
// sockets and registry files live, how they are validated, and the storage
// identity both sides compare. Shared by the MCP server (which publishes) and
// the hook client (which discovers); the wire shapes are in @sterling/schemas.
//
// Directory: $XDG_RUNTIME_DIR/sterling when XDG_RUNTIME_DIR is an absolute
// Linux path, otherwise /tmp/sterling-<uid>. A path on a Windows drive mount
// (/mnt/<letter>/...) is never used, because AF_UNIX on WSL DrvFs is unverified.
// The directory must be a real directory (not a symlink) owned by this user
// with no group or other permission bits; it is created 0700 when absent and
// refused by name when it is anything else. Each registry file and socket must
// be owned by this user, not a symlink, and carry no group or other bits.
//
// Lifecycle: a server publishes its registry file atomically (temp file plus
// rename) once it listens, and removes its own file and socket at shutdown.
// Nothing here removes another server's files: a stale entry is skipped by the
// client after a failed connect, never swept.
import { createHash } from 'node:crypto';
import { closeSync, constants as FS, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BROKER_DISCOVERY_MAX_ENTRIES, BROKER_REGISTRY_MAX_BYTES, brokerRegistrationSchema, type BrokerIdentity, type BrokerRegistration } from '@sterling/schemas';
import { readPgCredentials } from './pg-bridge.js';

/** The broker's runtime directory cannot be used; nothing was created or connected. */
export class BrokerRuntimeDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrokerRuntimeDirError';
  }
}

const uid = (): number | undefined => (typeof process.getuid === 'function' ? process.getuid() : undefined);

function onWindowsDrive(path: string): boolean {
  return /^\/mnt\/[a-zA-Z](\/|$)/.test(path);
}

/** The directory to use, before validation: $XDG_RUNTIME_DIR/sterling or /tmp/sterling-<uid>. Undefined where Unix sockets and uids do not exist. */
export function brokerDirPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const id = uid();
  if (id === undefined) return undefined;
  const xdg = env.XDG_RUNTIME_DIR;
  if (xdg && xdg.startsWith('/') && !onWindowsDrive(xdg)) return join(xdg, 'sterling');
  return `/tmp/sterling-${id}`;
}

/** Throws BrokerRuntimeDirError unless `path` is owned by this user, not a symlink, of the given kind, with no group or other bits. */
export function assertPrivate(path: string, kind: 'directory' | 'file' | 'socket'): void {
  let st;
  try {
    st = lstatSync(path);
  } catch (e) {
    throw new BrokerRuntimeDirError(`broker ${kind} ${path} cannot be read (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`);
  }
  if (st.isSymbolicLink()) throw new BrokerRuntimeDirError(`broker ${kind} ${path} is a symlink; refused`);
  const isKind = kind === 'directory' ? st.isDirectory() : kind === 'file' ? st.isFile() : st.isSocket();
  if (!isKind) throw new BrokerRuntimeDirError(`broker ${kind} ${path} is not a ${kind}; refused`);
  if (st.uid !== uid()) throw new BrokerRuntimeDirError(`broker ${kind} ${path} is owned by uid ${st.uid}, not this user (${uid()}); refused`);
  if ((st.mode & 0o077) !== 0) throw new BrokerRuntimeDirError(`broker ${kind} ${path} has mode ${(st.mode & 0o777).toString(8)}; group and other bits must be clear; refused`);
}

/**
 * The validated runtime directory, or undefined where the broker is not
 * available (no uids). `create` makes it 0700 when absent (a server); a
 * client passes false and gets undefined when it does not exist yet.
 */
export function brokerDir({ create, env = process.env }: { create: boolean; env?: NodeJS.ProcessEnv }): string | undefined {
  const dir = brokerDirPath(env);
  if (dir === undefined) return undefined;
  try {
    lstatSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new BrokerRuntimeDirError(`broker directory ${dir} cannot be read (${(e as Error).message})`);
    if (!create) return undefined;
    mkdirSync(dir, { mode: 0o700 });
  }
  assertPrivate(dir, 'directory');
  return dir;
}

/** The project key in registry file names: the first 16 hex of sha256(canonical root). */
export function brokerProjectKey(root: string): string {
  return createHash('sha256').update(realpathSync(root)).digest('hex').slice(0, 16);
}

export function brokerSocketPath(dir: string, instanceId: string): string {
  return join(dir, `${instanceId}.sock`);
}

export function brokerRegistrationPath(dir: string, root: string, instanceId: string): string {
  return join(dir, `${brokerProjectKey(root)}.${instanceId}.json`);
}

/** Publish `reg` atomically (temp file 0600, then rename). */
export function publishBrokerRegistration(dir: string, root: string, reg: BrokerRegistration): string {
  const path = brokerRegistrationPath(dir, root, reg.instance_id);
  const tmp = join(dir, `.${reg.instance_id}.json.tmp`);
  writeFileSync(tmp, JSON.stringify(brokerRegistrationSchema.parse(reg)), { mode: 0o600 });
  renameSync(tmp, path);
  return path;
}

/** Remove this server's own registry file and socket. Never touches another instance's files. */
export function removeOwnBrokerFiles(dir: string, root: string, instanceId: string): void {
  rmSync(brokerRegistrationPath(dir, root, instanceId), { force: true });
  rmSync(brokerSocketPath(dir, instanceId), { force: true });
}

function readBounded(path: string): string {
  const fd = openSync(path, FS.O_RDONLY | FS.O_NOFOLLOW);
  try {
    const size = fstatSync(fd).size;
    if (size > BROKER_REGISTRY_MAX_BYTES) throw new BrokerRuntimeDirError(`broker registry file ${path} is ${size} bytes, over the ${BROKER_REGISTRY_MAX_BYTES}-byte bound; refused`);
    const buf = Buffer.alloc(size);
    let off = 0;
    while (off < size) {
      const n = readSync(fd, buf, off, size - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Every registration published for `root` in `dir`, newest first, at most
 * BROKER_DISCOVERY_MAX_ENTRIES files read. A file that fails validation is
 * listed in `refused` with the reason and is never removed.
 */
export function listBrokerRegistrations(dir: string, root: string): { registrations: BrokerRegistration[]; refused: { file: string; reason: string }[] } {
  const prefix = `${brokerProjectKey(root)}.`;
  const names = readdirSync(dir).filter((n) => n.startsWith(prefix) && n.endsWith('.json')).slice(0, BROKER_DISCOVERY_MAX_ENTRIES);
  const found: { reg: BrokerRegistration; mtime: number }[] = [];
  const refused: { file: string; reason: string }[] = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      assertPrivate(path, 'file');
      const reg = brokerRegistrationSchema.parse(JSON.parse(readBounded(path)));
      if (name !== `${prefix}${reg.instance_id}.json`) throw new BrokerRuntimeDirError(`names instance ${reg.instance_id}, not the one in its file name`);
      found.push({ reg, mtime: lstatSync(path).mtimeMs });
    } catch (e) {
      refused.push({ file: path, reason: (e as Error).message });
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return { registrations: found.map((f) => f.reg), refused };
}

/** The storage identity both sides compare: the database label and the two schema names. Never includes a credential. */
export function brokerStorageIdentity(route: { credentialsPath: string; metaSchema: string; projectSchema: string }): BrokerIdentity['storage'] {
  const c = readPgCredentials(route.credentialsPath);
  return { backend: 'postgres', database: `${c.host}:${c.port}/${c.database}`, meta_schema: route.metaSchema, project_schema: route.projectSchema };
}
