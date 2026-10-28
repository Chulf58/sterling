// The sender's delivery journal for wake-project and notify-project (multi-session toolkit
// slice 3, decision sterling-ports-ch-hub-s-whole-multi-session-toolkit-session).
//
// WHERE: <sender's store root>/.sterling/transient/multi-session-deliveries.json. A delivery is
// the sender's own state: the target's runtime owns the target's records and a sender writes
// nothing there, and there is no hub project. Every checkout of the sending project shares the
// one journal (the store root), so a crash in one is recovered from any.
//
// STATE MACHINE, one record per prompt, keyed by its OpenCode message id (msg_…):
//   sending    written (atomically, under the journal lock) BEFORE the POST: the prompt may be out
//   delivered  the reply named the session and delivery 'queue', or a receipt was found
//              (the message id in the session's inbox or message list)
//   uncertain  the POST may have reached the server (apiSend's uncertain: a timeout, a reset after
//              the send, a 5xx, an unusable reply)
//   failed     the POST provably never reached the server; nothing was sent
//   abandoned  never delivered and never will be: its session is gone, or the checkout's owner
//              changed before a receipt or a resend
// A crash between the POST and the outcome leaves `sending`, which reads exactly as `uncertain`.
// RECOVERY: the next delivery run to the same checkout reconciles every sending/uncertain record
// first: a receipt settles it as delivered; with none it is resent with the SAME message id after
// a full admission (the server dedupes POST /prompt by message id, finding 0ded033d), so a prompt
// that did land is never shown twice. Records end in a terminal state and are pruned after
// RETAIN_MS; pending ones are never pruned.
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeFileAtomic } from './atomic-write.mjs';
import { withFileLock } from './file-lock.mjs';

export const JOURNAL_REL = '.sterling/transient/multi-session-deliveries.json';
export const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;
export const STATES = new Set(['sending', 'delivered', 'uncertain', 'failed', 'abandoned']);
export const PENDING = new Set(['sending', 'uncertain']);
const MSG_RE = /^msg_[A-Za-z0-9]+$/;

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
let lastMs = 0;
let counter = 0;
/**
 * A new OpenCode-shaped ascending message id: msg_ + 12 hex digits of (ms * 4096 + counter) +
 * 14 random base62 characters, the shape the server's own ascending ids have, so the prompt
 * sorts by its send time among the session's messages.
 */
export function newMessageId(now = Date.now()) {
  if (now !== lastMs) {
    lastMs = now;
    counter = 0;
  }
  counter += 1;
  const time = (BigInt(now) * 4096n + BigInt(counter)) & 0xffffffffffffn;
  const random = [...randomBytes(14)].map((b) => BASE62[b % 62]).join('');
  return `msg_${time.toString(16).padStart(12, '0')}${random}`;
}

export const journalPath = (storeRoot) => join(storeRoot, JOURNAL_REL);

function load(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return { version: 1, records: {} };
    throw e;
  }
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`the delivery journal ${path} is not valid JSON; fix it by hand (removing it forgets which prompts may have been sent)`);
  }
  if (j?.version !== 1 || j.records === null || typeof j.records !== 'object' || Array.isArray(j.records)) {
    throw new Error(`the delivery journal ${path} has an unexpected shape; fix it by hand (removing it forgets which prompts may have been sent)`);
  }
  for (const [id, r] of Object.entries(j.records)) {
    if (!MSG_RE.test(id) || r?.id !== id || !STATES.has(r.state)) throw new Error(`the delivery journal ${path} holds a malformed record ${JSON.stringify(id)}; fix it by hand`);
  }
  return j;
}

/** The journal at `storeRoot`. Every change runs under its lock; `now` stamps the records. */
export function deliveryJournal(storeRoot, { now = Date.now, waitMs = 5_000 } = {}) {
  const path = journalPath(storeRoot);
  const update = (fn) => withFileLock(`${path}.lock`, () => {
    const j = load(path);
    const out = fn(j);
    const t = now();
    for (const [id, r] of Object.entries(j.records)) {
      if (!PENDING.has(r.state) && t - Date.parse(r.updated_at) > RETAIN_MS) delete j.records[id];
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileAtomic(path, `${JSON.stringify(j, null, 2)}\n`);
    return out;
  }, { waitMs });
  return {
    path,
    load: () => load(path),
    /** The pending records (sending, uncertain) for one target checkout. */
    pending: (project, checkout) => Object.values(load(path).records).filter((r) => PENDING.has(r.state) && r.project === project && r.checkout === checkout),
    /** Saves a record as `sending` before its POST: a new one, or a resend of a pending one. */
    sending: (record) => update((j) => {
      const had = j.records[record.id];
      if (had && !PENDING.has(had.state)) throw new Error(`delivery ${record.id} is already ${had.state}; it is not sent again`);
      const t = new Date(now()).toISOString();
      j.records[record.id] = { ...had, ...record, state: 'sending', attempts: (had?.attempts ?? 0) + 1, created_at: had?.created_at ?? t, updated_at: t };
      return j.records[record.id];
    }),
    /** Moves a record to `state`, with why; a terminal record never moves again. */
    settle: (id, state, why) => update((j) => {
      if (!STATES.has(state) || state === 'sending') throw new Error(`not a settled delivery state: ${state}`);
      const r = j.records[id];
      if (!r) throw new Error(`no delivery ${id} in the journal`);
      if (!PENDING.has(r.state)) throw new Error(`delivery ${id} is already ${r.state}`);
      Object.assign(r, { state, updated_at: new Date(now()).toISOString() });
      if (why) r.why = why;
      else delete r.why;
      return r;
    }),
  };
}
