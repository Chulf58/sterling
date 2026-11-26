// H19 prompt surface now drains only H10's independent immutable notices.
import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { readStdin, allow, warnNonBlocking } from './lib/common.mjs';
import { noticesDir, deliveryDir, mergeGuardMarks } from './lib/delivery.mjs';
import { ledgerPath, pruneUnhashed } from './lib/ledger.mjs';
import { pendingAnswersNotice } from './lib/pending-answers.mjs';

// Antigravity CLI (agy): this hook also drains the agy context queue, the
// `agy-*` notices lib/common.mjs writes for what a PreToolUse or PostToolUse
// hook would have injected on Claude Code. agy fires PreInvocation before EVERY
// model call; on all but a main conversation's first call of a prompt the input
// carries agy_queue_only, and only this conversation's agy-* notices drain. An
// agy entry's `guards` are the delivery marks its hook deferred (lib/common.mjs
// agyDeferGuardWrite); they are merged only after this hook's envelope is out.
const input = readStdin({ agyEveryInvocation: true });
const queueOnly = input.agy_queue_only === true;
// Another agy conversation's queue (a subagent running beside this one, or an agy
// session beside a Claude Code one in the same checkout) is left for that
// conversation to drain, whichever host drains here, unless it has sat for a day.
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
  const guards = [];
  const agyTexts = new Set();
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
        if (name.startsWith('agy-') && Date.now() - statSync(file).mtimeMs < AGY_QUEUE_STALE_MS) continue;
        rmSync(file, { force: true });
        continue;
      }
      files.push(file);
      if (Array.isArray(notice.guards)) guards.push(...notice.guards);
      const text = notice.text;
      // Two agy hooks on one tool call (H19 on PreToolUse and PostToolUse) can
      // queue the same text in separate entries: inject it once, but drain both
      // entries and merge both entries' guard marks.
      if (name.startsWith('agy-') && typeof text === 'string' && text) {
        if (agyTexts.has(text)) continue;
        agyTexts.add(text);
      }
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
  // Not on agy (the tool that clears it is not served there), and a failure here costs only this line.
  if (!queueOnly && input.host !== 'agy') {
    try {
      const pendingAnswers = pendingAnswersNotice(input.cwd);
      if (pendingAnswers) texts.push(pendingAnswers);
    } catch (e) {
      texts.push(`PENDING ANSWERS UNAVAILABLE (${(e && e.message) || e}): answered question forms cannot be counted this turn.`);
    }
  }
  if (!texts.length) allow();
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: texts.join('\n\n') } }), (err) => {
    if (err) { process.stderr.write(`H19 notice drain: write failed: ${(err && err.message) || err}\n`); process.exit(0); }
    // Delivered now: merge the marks the queued hooks deferred. Only a guard under
    // this checkout's delivery directory is touched; a failed merge costs at most
    // one repeated delivery, never the injected text.
    const delivery = resolve(deliveryDir(input.cwd)) + sep;
    for (const g of guards) {
      try {
        if (typeof g?.path === 'string' && resolve(g.path).startsWith(delivery)) mergeGuardMarks(g.path, g.guard);
        else process.stderr.write(`H19 notice drain: skipped a queued guard outside ${delivery}: ${String(g?.path)}\n`);
      } catch (e) { process.stderr.write(`H19 notice drain: merging delivered marks into ${String(g?.path)} failed: ${(e && e.message) || e}\n`); }
    }
    for (const file of files) rmSync(file, { force: true, recursive: file === legacy });
    process.exit(0);
  });
} catch (e) { warnNonBlocking(`H19 notice drain failed: ${(e && e.message) || e}`); }
