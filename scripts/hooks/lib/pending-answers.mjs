// Pending answers: <project>/.sterling/transient/pending-answers.json, one entry per
// answered question form, kept until the agent resolves it as recorded or not a decision
// (decision answered-question-forms-are-kept-as-pending-answers-in-a-tra). Shared by the
// Claude Code hook (h32-pending-answers.mjs), the OpenCode plugin, the next-turn notices
// and the MCP tool pending_answers_resolve. The entry shape is pendingAnswerEntrySchema
// in packages/schemas. Builtins only: hooks and the servers vendor this module.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { withSessionEventsLock } from './session-events.mjs';

export const PENDING_ANSWERS_REL = join('.sterling', 'transient', 'pending-answers.json');
const LOCK_TIMEOUT_MS = 2000;
const NOTICE_LISTED = 5;
const CLIP = 100;

const text = (v) => (typeof v === 'string' ? v : '');

function entryId(host, callId) {
  return createHash('sha256').update(`${host}\0${callId}`).digest('hex').slice(0, 8);
}

function questionOf(q, picked) {
  const options = (Array.isArray(q?.options) ? q.options : []).map((o) => ({ label: text(o?.label), description: text(o?.description) }));
  const labels = new Set(options.map((o) => o.label));
  return {
    header: text(q?.header),
    question: text(q?.question),
    multiple: q?.multiple === true || q?.multiSelect === true,
    options,
    picks: picked.map((label) => ({ label, custom: !labels.has(label) })),
  };
}

/**
 * The entry for a Claude Code PostToolUse payload of AskUserQuestion, or null when the
 * payload carries no answered question. `tool_response.answers` maps each question's text
 * to the chosen label; a multi-select answer arrives as one string, split on ', ' when the
 * whole string is not itself a label.
 */
export function entryFromClaude(stdin, now = new Date().toISOString()) {
  const response = stdin?.tool_response;
  const questions = Array.isArray(response?.questions) ? response.questions : [];
  const answers = response?.answers && typeof response.answers === 'object' ? response.answers : {};
  const callId = text(stdin?.tool_use_id);
  if (!callId) return null;
  const built = questions.map((q) => {
    const raw = answers[text(q?.question)];
    const labels = (Array.isArray(q?.options) ? q.options : []).map((o) => text(o?.label));
    let picked = [];
    if (typeof raw === 'string' && raw !== '') picked = q?.multiSelect === true && !labels.includes(raw) ? raw.split(', ') : [raw];
    return questionOf(q, picked);
  });
  if (!built.some((q) => q.picks.length)) return null;
  return { id: entryId('claude', callId), host: 'claude', session: text(stdin?.session_id), time: now, call_id: callId, questions: built };
}

/**
 * The entry for an OpenCode execute.after call of the question tool, or null when the form
 * was not completed (a dismissed form is status 'error') or nothing was picked. The picks
 * are result.metadata.answers: one array of labels per question, in order, read from the
 * OpenCode 2.0.x binary (execute.after result = {output, content, metadata:{answers}}).
 */
export function entryFromOpenCode(call, now = new Date().toISOString()) {
  if (call?.tool !== 'question' || call.status !== 'completed') return null;
  const questions = Array.isArray(call.input?.questions) ? call.input.questions : [];
  const answers = Array.isArray(call.result?.metadata?.answers) ? call.result.metadata.answers : [];
  const callId = text(call.id);
  if (!callId) return null;
  const built = questions.map((q, i) => questionOf(q, (Array.isArray(answers[i]) ? answers[i] : []).map(String)));
  if (!built.some((q) => q.picks.length)) return null;
  return { id: entryId('opencode', callId), host: 'opencode', session: text(call.sessionID), time: now, call_id: callId, questions: built };
}

function writeAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** The unresolved entries; an unparsable or non-array file throws and is left as it is. */
export function readPendingAnswers(root) {
  const path = join(root, PENDING_ANSWERS_REL);
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${PENDING_ANSWERS_REL} is not a JSON array`);
  return parsed;
}

function locked(root, fn) {
  const path = join(root, PENDING_ANSWERS_REL);
  mkdirSync(dirname(path), { recursive: true });
  return withSessionEventsLock(path, () => fn(path), { timeoutMs: LOCK_TIMEOUT_MS });
}

/** Appends `entry` unless an entry with its id is already there (the same call seen twice); returns whether it was added. */
export function appendPendingAnswer(root, entry) {
  return locked(root, (path) => {
    const entries = readPendingAnswers(root);
    if (entries.some((e) => e.id === entry.id)) return false;
    entries.push(entry);
    writeAtomic(path, entries);
    return true;
  });
}

/**
 * Removes the entries named by `ids` (8-char ids as the notice prints them). An unknown id
 * refuses the whole call and nothing is removed. Returns the resolved entry ids.
 */
export function resolvePendingAnswers(root, ids) {
  return locked(root, (path) => {
    const entries = readPendingAnswers(root);
    const unknown = ids.filter((id) => !entries.some((e) => e.id === id));
    if (unknown.length) throw new Error(`pending_answers_resolve: no pending answer with id ${unknown.join(', ')}; the pending ids are ${entries.map((e) => e.id).join(', ') || '(none)'}`);
    writeAtomic(path, entries.filter((e) => !ids.includes(e.id)));
    return [...new Set(ids)];
  });
}

const clip = (s) => (s.length > CLIP ? `${s.slice(0, CLIP - 1)}…` : s);

/**
 * The next-turn line: how many answered forms are unrecorded, the first few by id, and the
 * resolve call. '' at zero, so a project with nothing pending sees nothing. An unreadable
 * file says so, never reads as zero.
 */
export function pendingAnswersNotice(root) {
  let entries;
  try {
    entries = readPendingAnswers(root);
  } catch (e) {
    return `PENDING ANSWERS UNREADABLE (${e?.message ?? e}): answered question forms cannot be counted; fix or delete ${PENDING_ANSWERS_REL}.`;
  }
  if (!entries.length) return '';
  const listed = entries.slice(0, NOTICE_LISTED).map((e) => {
    const q = e.questions?.[0];
    const picks = (q?.picks ?? []).map((p) => (p.custom ? `${p.label} (typed)` : p.label)).join(', ');
    return `- ${e.id} ${e.time}: ${clip(text(q?.header) || text(q?.question))} -> ${clip(picks)}${e.questions?.length > 1 ? ` (+${e.questions.length - 1} more question${e.questions.length > 2 ? 's' : ''})` : ''}`;
  });
  const more = entries.length > NOTICE_LISTED ? `\n- … and ${entries.length - NOTICE_LISTED} more` : '';
  return `PENDING ANSWERS: ${entries.length} answered question form${entries.length === 1 ? '' : 's'} not yet recorded. Each is a ruling or a confirmation; capture the decisions, then clear each with pending_answers_resolve({ids, outcome: "recorded", record_id}) or outcome "not_a_decision".\n${listed.join('\n')}${more}`;
}
