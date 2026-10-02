// Pending notices: written by any handler, shown to the model by the context
// handler at the next turn, pruned at the end of the next execution.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const NOTICES_REL = '.sterling/transient/opencode-notices.json';

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

function readNotices(root) {
  const p = join(root, NOTICES_REL);
  if (!existsSync(p)) return [];
  const parsed = JSON.parse(readFileSync(p, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${NOTICES_REL} is not a JSON array`);
  return parsed;
}

export function addNotice(root, text, now = new Date().toISOString()) {
  const notices = readNotices(root);
  if (notices.some((n) => n.text === text && !n.shown_at)) return;
  notices.push({ id: randomUUID(), at: now, text });
  writeJsonAtomic(join(root, NOTICES_REL), notices);
}

/** Notices to show now. Each is stamped shown_at the first time; it stays visible for the rest of that execution and is pruned at its end. */
export function takeNotices(root, now) {
  const notices = readNotices(root);
  if (!notices.length) return [];
  let changed = false;
  for (const n of notices) {
    if (!n.shown_at) {
      n.shown_at = now;
      changed = true;
    }
  }
  if (changed) writeJsonAtomic(join(root, NOTICES_REL), notices);
  return notices;
}

export function pruneShownNotices(root) {
  const notices = readNotices(root);
  const left = notices.filter((n) => !n.shown_at);
  if (left.length === notices.length) return;
  if (left.length) writeJsonAtomic(join(root, NOTICES_REL), left);
  else rmSync(join(root, NOTICES_REL), { force: true });
}
