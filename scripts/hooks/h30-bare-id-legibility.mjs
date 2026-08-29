// H30 — BARE-ID LEGIBILITY ADVISORY on the AskUserQuestion surface (board
// 6510a9da, slice S3 of objective human-readable-ids). PreToolUse
// AskUserQuestion, joining the existing entry after h20-mechanism-axis.
// ADVISORY, NEVER A BLOCK: no path here exits 2, and none exits 1 either —
// a normal lint finding is not an internal hook failure, so this emits
// hookSpecificOutput.additionalContext and exits 0 (H25's pattern), never
// warnNonBlocking.
//
// GOVERNING RULING: knowledge_get 2e8c30e4-36e6-4c18-8ce8-98f7c1d5e1da (slug
// human-readable-ids-for-board-items), layer S3 — "an advisory hook flags a
// bare id in a user-facing question with no gloss beside it". The defect is
// NOT cosmetic: the conduct rules route every user decision through the
// AskUserQuestion form precisely so rulings are not missed in prose, and
// that mechanism is defeated at the last inch when the question names
// something the user cannot identify — they are asked to rule on "board
// 17204d1e" and, in their own words, have "no way of knowing what that
// refers to". An unanswerable question is worse than an unasked one,
// because it manufactures a ruling from someone who could not see what they
// were ruling on.
//
// WHY THE MESSAGE SAYS WHAT IT SAYS — THE TIMING IS LOAD-BEARING. A
// NON-BLOCKING PreToolUse additionalContext reaches the model WITH the tool
// result, i.e. AFTER the user has already answered (research_finding
// 63a9646d-2f0d-406e-8a36-9e95d0b11dbd, the same probe H20 records in its
// own header). There is no proven non-blocking pre-answer surface, and S3
// forbids blocking. So an advisory phrased as "do better next time" would
// change no outcome and would be ceremony (P1). The ONE outcome this hook
// can buy is forcing a READABLE RE-ASK before the answer is treated as
// authoritative — so that is exactly what it says, and it discloses its own
// post-answer timing rather than pretending to be a gate.
//
// WHY A SEPARATE HOOK AND NOT AN ARM OF H20: H20 has many early allow()
// exits and unrelated store-relevance logic (axis extraction, three
// relevance floors, the deny-once ledger); composing a focused scanner
// through them is larger and riskier than one small independent hook.
//
// WHY IT IS NOT A SECOND COPY OF THE PROSE-CITATION WARNING (board
// c3705a15, citedIdWarnings in packages/mcp-server/src/tools.ts): the two
// fire on DISJOINT events and answer DIFFERENT questions. That arm runs at
// RECORD-WRITE time and asks "does this citation RESOLVE"; this one runs at
// QUESTION time and asks "is this identifier INTELLIGIBLE to the person
// being asked". One event never produces both warnings. The primitives are
// reused (buildResolver's mounted id/alias universe), the wording is not.
//
// PRECISION IS THE WHOLE DESIGN. Raw 8-hex hits flag dates (20260829),
// short commit SHAs, checksums, deadbeef/cafebabe, 8-digit colours — firing
// on all of those is precisely the cry-wolf failure that trains a reader to
// ignore the channel (the H26 lesson board 6510a9da names: "two advisories
// on one subject is how a channel gets ignored"). So a candidate enters the
// advisory ONLY when EITHER it resolves uniquely through the mounted
// record/alias universe, OR it sits in an explicit Sterling CITATION
// CONTEXT. This deliberately biases toward MISSED warnings over false
// alarms — that bias is intentional.
//
// NAMED RESIDUAL: an AMBIGUOUS 8-char prefix (one matching several records)
// is NOT admitted by the resolution branch, because the ruling's admission
// test is "resolves UNIQUELY". Such a prefix is arguably even less readable
// than a resolving one, and it is usually still caught by the citation-
// context branch ("board <hex>"); a bare ambiguous prefix with no trigger
// word beside it is a known, accepted miss.
import { readStdin, allow, openStore, loadConfig } from './lib/common.mjs';
import { MountedStores, resolveDomainMounts } from '@sterling/store';
import { parseConfig } from '@sterling/schemas';
import { buildResolver } from '../lib/citations.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// THE UUID ALTERNATIVE COMES FIRST so a full id is consumed whole and its
// own first 8 characters are never separately reported as a second finding.
// The trailing class excludes '-' as well as alphanumerics, so a bare 8-hex
// run that is really the head of a longer dashed id can never match on its
// own.
const CANDIDATE_RE =
  /(?<![0-9A-Za-z])(?:[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}|[0-9A-Fa-f]{8})(?![0-9A-Za-z-])/g;

// An explicit Sterling citation immediately before the identifier — "board
// 5f3e2a1c", "decision `2e8c30e4`", "(knowledge_get 2e8c30e4)". The gap is
// bounded and NEWLINE-FREE so a trigger word elsewhere in the field can
// never reach across prose to admit an unrelated hex run.
const CITATION_CONTEXT_RE =
  /\b(?:board|todo|task|maintenance|decision|anti_pattern|article|feature_article|finding|research_finding|brief|knowledge_get)\b[^\n]{0,12}$/i;

// Words that NAME A TYPE rather than a thing. A phrase built only from
// these is not a gloss: "board item (17204d1e)" tells the reader nothing
// the bare id did not. Compared after a crude plural fold, so "items"/"ids"
// count too.
const GENERIC_TYPE_WORDS = new Set(['board', 'item', 'record', 'decision', 'todo', 'task', 'id', 'uuid']);
// Ordinary connective filler, which likewise cannot carry a name on its own.
const FILLER_WORDS = new Set(['the', 'a', 'an', 'this', 'that', 'these', 'those', 'for', 'of', 'and', 'or', 'in', 'on', 'to', 'our', 'its', 'is', 'are', 'we', 'you', 'i', 'it']);

/** The visible fields of ONE AskUserQuestion sub-question, kept SEPARATE.
 *  Deliberately NOT concatenated (unlike delivery.mjs's outgoingProposalText,
 *  which joins them for keyword matching): concatenation would let a readable
 *  name in option A "gloss" a bare id in option B, which is exactly the
 *  laundering this advisory exists to catch. Each entry carries a human label
 *  so the finding can say WHERE it was seen. */
function visibleFields(questions) {
  const out = [];
  for (const [qi, q] of (Array.isArray(questions) ? questions : []).entries()) {
    const where = questions.length > 1 ? ` (question ${qi + 1})` : '';
    if (typeof q?.question === 'string') out.push({ label: `the question text${where}`, text: q.question });
    if (typeof q?.header === 'string') out.push({ label: `the question header${where}`, text: q.header });
    for (const [oi, o] of (Array.isArray(q?.options) ? q.options : []).entries()) {
      if (typeof o?.label === 'string') out.push({ label: `option ${oi + 1}'s label${where}`, text: o.label });
      if (typeof o?.description === 'string') out.push({ label: `option ${oi + 1}'s description${where}`, text: o.description });
    }
  }
  return out.filter((f) => f.text.trim());
}

/** STRUCTURAL ONLY — this never claims to have proved the phrase is the
 *  record's CORRECT name; it only asks whether a human-readable phrase sits
 *  where the render convention `name (id8)` puts one. A gloss counts when,
 *  in the SAME field and on the SAME line, the id is parenthesized and
 *  IMMEDIATELY preceded by a word that carries a letter and is more than a
 *  generic type word. Clipped names pass — names clip, ids never do.
 *
 *  "IMMEDIATELY" IS THE LOAD-BEARING WORD, and it must be read as the token
 *  ADJACENT to the '(' rather than as "somewhere on the line". Scoring the
 *  whole preceding line instead lets an ordinary sentence verb launder a
 *  type word: "Should we close board item (17204d1e)?" contains "should"
 *  and "close", neither of them generic, so a line-scoped test calls it
 *  glossed — while the phrase actually touching the id is "board item",
 *  which tells the reader nothing the bare id did not. Measured against
 *  exactly that case while building this hook. */
function isGlossed(text, start, end) {
  if (text[start - 1] !== '(' || text[end] !== ')') return false;
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const phrase = text.slice(lineStart, start - 1).trim();
  if (!phrase) return false;
  const tokens = phrase
    .split(/[^A-Za-z0-9_-]+/)
    .map((t) => t.toLowerCase().replace(/^-+|-+$/g, ''))
    .filter(Boolean);
  const last = tokens[tokens.length - 1];
  if (!last || !/[a-z]/.test(last)) return false; // "question 2 (id)" names nothing
  if (/^[0-9a-f]{8}$/.test(last)) return false; // another bare id is not a name for this one
  const folded = last.length > 3 && last.endsWith('s') ? last.slice(0, -1) : last;
  return !GENERIC_TYPE_WORDS.has(folded) && !FILLER_WORDS.has(folded);
}

/** The id universe: the project store fanned across its MOUNTED domain
 *  stores, so a legitimately domain-scoped citation resolves too.
 *  skipMissing is not optional here — §2.3 lazy creation would otherwise
 *  have a read-only advisory MATERIALIZE a domain store as a side effect.
 *  Any failure degrades to the project store alone; a hook never throws. */
function openUniverse(cwd) {
  const dbPath = join(cwd ?? '.', '.sterling', 'sterling.db');
  if (!existsSync(dbPath)) return null;
  try {
    return new MountedStores(dbPath, resolveDomainMounts(parseConfig(loadConfig(cwd) ?? {})), { skipMissing: true });
  } catch {
    return openStore(cwd);
  }
}

let input;
try {
  input = readStdin();
} catch {
  allow(); // malformed (non-JSON) stdin — nothing to check, never a crash
}

try {
  const fields = visibleFields(input.tool_input?.questions);
  if (!fields.length) allow(); // not the question surface — inert, never half-scanned

  // Scan for candidates BEFORE opening anything: the overwhelmingly common
  // question mentions no hex at all, and that case must cost nothing.
  const found = [];
  for (const field of fields) {
    for (const m of field.text.matchAll(CANDIDATE_RE)) {
      const start = m.index;
      const end = start + m[0].length;
      if (isGlossed(field.text, start, end)) continue; // a name is already beside it
      const lineStart = field.text.lastIndexOf('\n', start - 1) + 1;
      found.push({
        id: m[0],
        where: field.label,
        cited: CITATION_CONTEXT_RE.test(field.text.slice(lineStart, start)),
      });
    }
  }
  if (!found.length) allow();

  const store = openUniverse(input.cwd);
  if (!store) allow(); // not a Sterling project — no id universe, no ceremony (P1)

  let resolve;
  try {
    ({ resolve } = buildResolver(store));
  } catch {
    resolve = () => undefined; // unreadable store: fall back to citation context alone
  }

  // ADMISSION. A candidate earns a warning only if it is genuinely a Sterling
  // identifier: it RESOLVES UNIQUELY (an 'ambiguous' prefix is not a unique
  // resolve — see the NAMED RESIDUAL above), or a trigger word beside it says
  // the author meant it as one. Everything else — dates, commit SHAs,
  // checksums — stays silent by design.
  const seen = new Set();
  const findings = [];
  for (const f of found) {
    const key = f.id.toLowerCase();
    if (seen.has(key)) continue;
    const row = resolve(key);
    const resolves = row && row !== 'ambiguous';
    if (!resolves && !f.cited) continue;
    seen.add(key);
    findings.push(
      `  - '${f.id}' in ${f.where} — ${resolves ? `a ${row.type} in this store` : 'cited as a Sterling record'}, shown with no human-readable name beside it`
    );
  }
  if (!findings.length) allow();

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: input.hook_event_name,
        additionalContext:
          `H30 BARE-ID LEGIBILITY ADVISORY — POST-ANSWER, NOT A GATE (it cannot arrive before the user answers; ` +
          `decision human-readable-ids-for-board-items, layer S3). You put a choice to the user naming identifier(s) ` +
          `the reader has no way to recognise:\n${findings.join('\n')}\n` +
          `DO NOT TREAT THIS ANSWER AS A RULING. RE-ASK WITH READABLE NAMES — print the name first and keep the id ` +
          `beside it, \`name (id8)\`; names clip, ids never do. An unanswerable question is worse than an unasked one, ` +
          `because it manufactures a ruling from someone who could not see what they were ruling on. ` +
          `Bare ids stay correct for mechanically-resolved surfaces (spawn inputs, tool parameters, the id ladder) ` +
          `and for history entries pinned to what was live then — this is the HUMAN surface, so it is neither.`,
      },
    })
  );
  allow();
} catch {
  // Advisory only, and a lint finding is not an internal failure: a crash here
  // must cost the caller nothing at all, not even a stderr gate-void notice.
  allow();
}
// no close: every path above exits the process, releasing the handle (board f81b1987)
