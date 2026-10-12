// Pending notices: written by any handler, appended once to the conductor's next
// prompt by the context handler (context.mjs onPrompt), and pruned at the end of
// the execution that showed them (settle.mjs).
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

/**
 * The notices not shown yet, each stamped shown_at `now`. They are delivered once, into
 * the prompt that starts an execution, which keeps them in the conversation, so a shown
 * notice is never returned again; it is pruned at that execution's end.
 */
export function takeNotices(root, now) {
  const notices = readNotices(root);
  const fresh = notices.filter((n) => !n.shown_at);
  if (!fresh.length) return [];
  for (const n of fresh) n.shown_at = now;
  writeJsonAtomic(join(root, NOTICES_REL), notices);
  return fresh;
}

export function pruneShownNotices(root) {
  const notices = readNotices(root);
  const left = notices.filter((n) => !n.shown_at);
  if (left.length === notices.length) return;
  if (left.length) writeJsonAtomic(join(root, NOTICES_REL), left);
  else rmSync(join(root, NOTICES_REL), { force: true });
}
