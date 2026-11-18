// H19 prompt surface now drains only H10's independent immutable notices.
import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readStdin, allow, warnNonBlocking } from './lib/common.mjs';
import { noticesDir } from './lib/delivery.mjs';
import { ledgerPath, pruneUnhashed } from './lib/ledger.mjs';

// Antigravity CLI (agy): this hook also drains the agy context queue, the
// `agy-*` notices lib/common.mjs writes for what a PreToolUse or PostToolUse
// hook would have injected on Claude Code. agy fires PreInvocation before EVERY
// model call; on all but a main conversation's first call of a prompt the input
// carries agy_queue_only, and only this conversation's agy-* notices drain.
const input = readStdin({ agyEveryInvocation: true });
const queueOnly = input.agy_queue_only === true;
// Another agy conversation's queue (a subagent running beside this one) is left
// for that conversation to drain, unless it has sat for a day.
const AGY_QUEUE_STALE_MS = 24 * 60 * 60 * 1000;
try {
  if (!queueOnly) {
    try { pruneUnhashed(ledgerPath(input.cwd, undefined, undefined)); }
    catch (e) { process.stderr.write(`H19 notice drain: ledger prune failed: ${(e && e.message) || e}\n`); }
  }
  const dir = noticesDir(input.cwd);
  let names = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); }
  catch (e) { if (e?.code !== 'ENOENT') throw e; }
  if (queueOnly) names = names.filter((n) => n.startsWith('agy-'));
  const files = [];
  const texts = [];
  const hasSession = typeof input.session_id === 'string' && input.session_id.length > 0;
  for (const name of names) {
    const file = join(dir, name);
    try {
      const notice = JSON.parse(readFileSync(file, 'utf8'));
      // A session-keyed notice (H10's fan-out deferral) describes live
      // dispatches of the session that wrote it; nothing prunes notices at
      // session start, so in any other session it is stale: removed, never
      // delivered (decision h10-deferral-is-conductor-facing-degradations-stay-loud).
      if (hasSession && typeof notice.session_id === 'string' && notice.session_id !== input.session_id) {
        if (input.host === 'agy' && name.startsWith('agy-') && Date.now() - statSync(file).mtimeMs < AGY_QUEUE_STALE_MS) continue;
        rmSync(file, { force: true });
        continue;
      }
      files.push(file);
      const text = notice.text;
      if (typeof text === 'string' && text) texts.push(text);
      else texts.push('ⓘ STERLING: removed malformed immutable notice; its contents were unreadable.');
    } catch (e) {
      if (e?.code === 'ENOENT') continue;
      files.push(file);
      texts.push('ⓘ STERLING: removed malformed immutable notice; its contents were unreadable.');
    }
  }
  const legacy = join(input.cwd, '.sterling', 'transient', 'delivery', 'pending.json');
  let legacyExists = false;
  if (!queueOnly) {
    try { statSync(legacy); legacyExists = true; }
    catch (e) { if (e?.code !== 'ENOENT') throw e; }
  }
  if (legacyExists) {
    let legacyMessage;
    try {
      const entries = JSON.parse(readFileSync(legacy, 'utf8'));
      const count = Array.isArray(entries) ? entries.length : 0;
      legacyMessage = `ⓘ STERLING: removed obsolete delayed delivery queue with ${count} pending entr${count === 1 ? 'y' : 'ies'}; none were delivered.`;
    } catch (e) {
      if (e?.code === 'ENOENT') legacyMessage = null;
      else legacyMessage = 'ⓘ STERLING: removed obsolete delayed delivery queue; its contents were unreadable and none were delivered.';
    }
    if (legacyMessage) texts.unshift(legacyMessage);
    files.push(legacy);
  }
  if (!texts.length) allow();
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: texts.join('\n\n') } }), (err) => {
    if (err) { process.stderr.write(`H19 notice drain: write failed: ${(err && err.message) || err}\n`); process.exit(0); }
    for (const file of files) rmSync(file, { force: true, recursive: file === legacy });
    process.exit(0);
  });
} catch (e) { warnNonBlocking(`H19 notice drain failed: ${(e && e.message) || e}`); }
