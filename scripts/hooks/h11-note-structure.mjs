// H11 — note structuring (spec §6 H11, §3.2.6). PostToolUse on
// mcp__sterling__knowledge_create (type=note), non-blocking.
//
// PLATFORM DELTA (verified at step 5, flagged for approval): the spec names a
// prompt-type (Haiku) handler, but current prompt hooks are READ-ONLY (policy
// decisions; cannot write records). Degraded-loud fallback implemented here:
// a command hook that runs the Haiku extraction via headless `claude -p
// --model haiku` and writes the candidates through the one validated store
// path, each flagged derived_unconfirmed + citing the note. Extraction
// failure or an unavailable CLI records check_skipped {note-structuring-h11}
// — never a silent skip. Extractor overridable via STERLING_H11_EXTRACTOR
// (also how tests inject a deterministic extractor).
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readStdin, allow, openStore } from './lib/common.mjs';

const input = readStdin();
if (input.tool_input?.type !== 'note') allow();

const noteText = input.tool_input?.fields?.raw_text;
let noteId;
try {
  const response = JSON.parse(input.tool_response?.content?.[0]?.text ?? '{}');
  noteId = response.record?.id;
} catch {
  /* fall through to loud skip */
}

const store = openStore(input.cwd);
if (!store) allow();

function skipLoud(reason) {
  store.recordCheckSkipped('note-structuring-h11', reason, store.getRun()?.id, new Date().toISOString());
  store.close();
  process.stderr.write(`H11 degraded loudly (${reason}) — note captured, extraction skipped (check_skipped recorded)`);
  process.exit(0);
}

if (!noteText || !noteId) skipLoud('note_payload_unreadable');

const PROMPT = [
  'Extract durable knowledge candidates from this raw note. Return ONLY a JSON array (no prose, no fences).',
  'Each element: {"type":"decision","fields":{"title","statement","alternatives_rejected":[],"rationale"}}',
  'or {"type":"anti_pattern","fields":{"title","trigger","guidance","wrong_way","right_way","source_evidence"}}.',
  'Only include candidates genuinely supported by the note text; an empty array is a fine answer.',
  `NOTE: ${noteText}`,
].join('\n');

const extractor = process.env.STERLING_H11_EXTRACTOR;
const result = extractor
  ? spawnSync(process.execPath, [extractor], { input: PROMPT, encoding: 'utf8', timeout: 90_000 })
  : spawnSync('claude', ['-p', PROMPT, '--model', 'haiku'], { encoding: 'utf8', timeout: 90_000, shell: true });

if (result.error || result.status !== 0) skipLoud(extractor ? 'extractor_failed' : 'claude_cli_unavailable');

let candidates;
try {
  candidates = JSON.parse(String(result.stdout).trim());
  if (!Array.isArray(candidates)) throw new Error('not an array');
} catch {
  skipLoud('extraction_unparseable');
}

const created = [];
const now = new Date().toISOString();
for (const cand of candidates) {
  try {
    const record = store.create({
      id: randomUUID(),
      type: cand.type,
      created_at: now,
      updated_at: now,
      author: 'agent:note-structurer',
      status: 'active',
      superseded_by: null,
      links: [{ rel: 'cites', target_id: noteId }],
      scope: 'project',
      stack_tags: [],
      derived_unconfirmed: true, // §3.2.6: lower-trust; excluded from retrieval unless opted in
      ...cand.fields,
    });
    created.push(record.id);
  } catch (e) {
    process.stderr.write(`H11: candidate rejected by schema (${e.message}); skipping it\n`);
  }
}
if (created.length) store.appendNoteDerived(noteId, created);
store.close();
console.log(`H11: ${created.length} derived_unconfirmed candidate(s) extracted from note ${noteId}`);
allow();
