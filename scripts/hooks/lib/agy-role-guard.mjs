// Antigravity CLI (agy) read-only role guard (decision
// antigravity-cli-agy-read-only-role-guard-read-the-agent-role, user-ruled
// 2026-11-18, "Build it, fail open loudly"; measured in research_finding
// how-does-an-antigravity-cli-agy-plugin-load-manifest-hooks-j phase E).
//
// agy's hook stdin carries no agent identity (phase D), and an agent's tools:
// list cannot restrict MCP tools (phase C), so on Claude Code and OpenCode a
// read-only role is kept from the store by its tool grant, and on agy only by
// this guard. agy stores the agent.md BODY as raw protobuf bytes under
// 'System Prompt' in ~/.gemini/antigravity-cli/conversations/<conversationId>.db
// before that conversation's first tool call, and every generated Sterling
// agent.md body starts with `STERLING-ROLE: <agent name>`. The guard reads that
// file (and its -wal sibling) as BYTES with readFileSync. It never opens it as
// SQLite: a writable open mutates a WAL database (anti-pattern 8616e72d).
//
// The path and format are undocumented. When either cannot be read, the call is
// ALLOWED and the caller warns once per conversation that read-only roles are
// unenforced; it never denies on doubt (an agy format change must not stop the
// implementor and librarian writing).
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readStoreWriteToolNames } from '../../lib/store-write-tools.mjs';

/** The roles that never write the store. */
export const READ_ONLY_ROLES = new Set(['reviewer', 'researcher', 'scout', 'sparring', 'preflight']);

/** The MCP server entry names that are Sterling's on agy: the bare entry (agent-scoped servers, phase C) and the plugin-prefixed one (plugin servers, phase B). */
const STERLING_SERVERS = new Set(['sterling', 'sterling_sterling']);

/** Test seam: the directory holding agy's per-conversation databases. */
export const CONVERSATIONS_DIR_ENV = 'STERLING_AGY_CONVERSATIONS_DIR';

export function conversationsDir(env = process.env) {
  return env[CONVERSATIONS_DIR_ENV] || join(homedir(), '.gemini', 'antigravity-cli', 'conversations');
}

/**
 * The store-write tool names as a Set, from the one shared reader
 * (scripts/lib/store-write-tools.mjs, which OpenCode's storeWriteTools uses too).
 * Throws when it has none.
 */
export function storeWriteToolNames(pluginRoot) {
  const names = new Set(readStoreWriteToolNames(pluginRoot));
  if (!names.size) throw new Error('agent-templates/implementor.md disallowedTools names no mcp__sterling__ tool');
  return names;
}

const SYSTEM_PROMPT = Buffer.from('System Prompt', 'latin1');
const MARKER = Buffer.from('STERLING-ROLE: ', 'latin1');

/**
 * Every role named by a `STERLING-ROLE: <role>` line that OPENS a 'System
 * Prompt' value in `bytes`: the field name, the protobuf tag 0x12 of the value,
 * its varint length, then the body's first line. Anchoring on the record keeps a
 * role quoted elsewhere in the conversation (a message, a tool result) from
 * counting.
 */
export function rolesInConversationBytes(bytes) {
  const roles = [];
  for (let at = bytes.indexOf(SYSTEM_PROMPT); at !== -1; at = bytes.indexOf(SYSTEM_PROMPT, at + 1)) {
    let i = at + SYSTEM_PROMPT.length;
    if (bytes[i] !== 0x12) continue;
    i += 1;
    let n = 0;
    while (n < 10 && i < bytes.length && bytes[i] & 0x80) {
      i += 1;
      n += 1;
    }
    i += 1; // the varint's last byte
    if (!bytes.subarray(i, i + MARKER.length).equals(MARKER)) continue;
    const role = /^[A-Za-z0-9_/-]+/.exec(bytes.subarray(i + MARKER.length, i + MARKER.length + 128).toString('latin1'))?.[0];
    if (role) roles.push(role.split('/').pop());
  }
  return roles;
}

/**
 * The verdict for one agy MCP call `toolName` (mcp__<server>__<tool>) in
 * conversation `conversationId`:
 *   { action: 'allow' }                      not a Sterling store write, or a writing role
 *   { action: 'deny', role, reason }         a read-only role calling a store write
 *   { action: 'warn', cause }                the role could not be read: allow, and warn
 * `writeTools` is a function returning the store-write tool names (it may throw).
 */
export function agyRoleVerdict({ toolName, conversationId, dir = conversationsDir(), writeTools }) {
  const m = /^mcp__(.+?)__(.+)$/.exec(String(toolName ?? ''));
  if (!m || !STERLING_SERVERS.has(m[1])) return { action: 'allow' };
  let writes;
  try {
    writes = writeTools();
  } catch (e) {
    return { action: 'warn', cause: `the store-write tool list could not be read (${(e && e.message) || e})` };
  }
  if (!writes.has(m[2])) return { action: 'allow' };
  if (typeof conversationId !== 'string' || !/^[A-Za-z0-9-]+$/.test(conversationId)) {
    return { action: 'warn', cause: `the hook input carries no usable conversationId (${JSON.stringify(conversationId)})` };
  }
  const db = join(dir, `${conversationId}.db`);
  const roles = [];
  try {
    roles.push(...rolesInConversationBytes(readFileSync(db)));
    if (existsSync(`${db}-wal`)) roles.push(...rolesInConversationBytes(readFileSync(`${db}-wal`)));
  } catch (e) {
    return { action: 'warn', cause: `the conversation file ${db} could not be read (${(e && e.code) || (e && e.message) || e})` };
  }
  const distinct = [...new Set(roles)];
  if (distinct.length === 0) return { action: 'warn', cause: `no STERLING-ROLE line opens the agent's system prompt in ${db}` };
  if (distinct.length > 1) return { action: 'warn', cause: `the conversation file names more than one role (${distinct.join(', ')})` };
  const role = distinct[0];
  if (!READ_ONLY_ROLES.has(role)) return { action: 'allow' };
  return {
    action: 'deny',
    role,
    reason:
      `H15: the ${role} agent is read-only and may not call ${m[2]}, which writes the Sterling store. ` +
      'Put what you would record into your report; the conductor writes the store.',
  };
}

/** The warning queued once per conversation when the role cannot be read. */
export function unenforcedWarning(cause) {
  return `ⓘ STERLING: read-only roles are unenforced on agy: ${cause}. A reviewer, researcher, scout, sparring or preflight agent in this conversation is not stopped from writing the store.`;
}
