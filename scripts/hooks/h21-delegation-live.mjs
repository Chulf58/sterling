// H21 — mid-session delegation watch (decision 9042abeb, closing the deferral
// in 8b00e77a on observed under-correction, user-approved 2026-08-10). A
// conductor-side PreToolUse hook, ADVISORY-ONLY: it can see that an article
// write or a hand-work call fired but never whether a dac3d2c6 exception
// applies, so it never denies (the H19 lesson, bf87898c). Three mechanisms:
//   (A) ARTICLE-WRITE WATCH — every knowledge_update/append/edit (either MCP
//       prefix) advises with decision dac3d2c6, its three exceptions, and a
//       running per-session count in .sterling/transient/article-writes.json.
//   (B) HAND-WORK STREAK — Read/Grep/Glob accumulate a transient streak
//       (distinct read paths + search count) in
//       .sterling/transient/hand-work-streak.json; crossing
//       config.delegation_watch.streak_threshold injects ONE moment-3
//       advisory (decision 677f1639) per streak episode.
//   (C) STREAK RESET — a Task/Agent dispatch resets the hand-work streak (a
//       fresh episode can nag again later) but never resets the
//       article-writes tally, which is a whole-session count.
// SUBAGENT EXCLUSION: input.agent_id present -> exit 0, no output, no files
// touched at all (Layer-0 finding 1c526e6d: subagent hook stdin always
// carries agent_id on this CLI).
// Fail-open throughout (P5, but advisory-only so nothing is ever silently
// ungated): a corrupt transient file or config degrades to a fresh default
// rather than throwing; an unexpected internal failure still exits 0 (never
// 2, this hook never denies) after a loud non-blocking stderr note.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readStdin, loadConfig } from './lib/common.mjs';
import { parseConfig } from '@sterling/schemas';

const input = readStdin();

// (agent_id present) — a subagent-originated call. Exit before ANY file
// touch so a subagent's reads/writes never pollute the conductor's own
// transient counters.
if (input.agent_id) process.exit(0);

const transientDir = join(input.cwd, '.sterling', 'transient');
const articleWritesPath = join(transientDir, 'article-writes.json');
const streakPath = join(transientDir, 'hand-work-streak.json');

/** Self-healing read: a missing or corrupt transient file degrades to the
 *  caller's fallback rather than throwing (advisory-only, never a crash). */
function readJsonSafe(path, fallback) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(path, value) {
  mkdirSync(transientDir, { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

/** A corrupt .sterling/config.json must never deny — degrade to the parsed
 *  defaults exactly as an absent config would. */
function safeConfig() {
  try {
    return parseConfig(loadConfig(input.cwd) ?? {});
  } catch {
    return parseConfig({});
  }
}

function emit(ctx) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: ctx } }));
}

const ARTICLE_WRITE_RE = /^(mcp__sterling__|mcp__plugin_sterling_sterling__)(knowledge_update|knowledge_append|knowledge_edit)$/;
const toolName = input.tool_name ?? '';

try {
  if (ARTICLE_WRITE_RE.test(toolName)) {
    const prior = readJsonSafe(articleWritesPath, null);
    const count = prior && prior.session_id === input.session_id && Number.isFinite(prior.count) ? prior.count + 1 : 1;
    writeJson(articleWritesPath, { session_id: input.session_id, count });
    emit(
      `H21 article-write watch: this is hand-run article write #${count} this session (decision dac3d2c6 — article ` +
        `application is librarian-shaped). Hand-run writes are for the three named exceptions only: (1) a small ` +
        `authored create, (2) a write needing live adjudication, (3) a single small-record touch. Bulkier article ` +
        `reconciles should batch through the librarian dispatch instead — it runs on a cheaper model in parallel, ` +
        `and the conductor's context window is the session's scarcest and most expensive resource.`
    );
    process.exit(0);
  }

  if (toolName === 'Task' || toolName === 'Agent') {
    // Streak reset (mechanism C) — a fresh episode can nag again later in
    // the same session. Article-writes is a whole-session tally and is
    // deliberately NOT touched here.
    writeJson(streakPath, { session_id: input.session_id, read_paths: [], searches: 0, nagged: false });
    process.exit(0);
  }

  if (toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob') {
    const threshold = safeConfig().delegation_watch.streak_threshold;
    let streak = readJsonSafe(streakPath, null);
    if (!streak || streak.session_id !== input.session_id) {
      streak = { session_id: input.session_id, read_paths: [], searches: 0, nagged: false };
    }
    if (toolName === 'Read') {
      const fp = input.tool_input?.file_path;
      if (fp && !streak.read_paths.includes(fp)) streak.read_paths.push(fp);
    } else {
      streak.searches += 1;
    }
    const streakCount = streak.read_paths.length + streak.searches;
    let ctx = null;
    if (!streak.nagged && streakCount >= threshold) {
      streak.nagged = true;
      ctx =
        `H21 hand-work streak: ${streakCount} distinct hand-work action(s) (reads + searches) since the last ` +
        `dispatch — moment 3 of decision 677f1639: hand-work that needed only its CONCLUSION was a dispatch. ` +
        `Every hand-read lands file contents in the conductor's own context window — the session's scarcest ` +
        `and most expensive resource; a subagent (opus for judgment, sonnet for mechanical) returns only the ` +
        `conclusion. Delegate the remaining reads/searches.`;
    }
    writeJson(streakPath, streak);
    if (ctx) emit(ctx);
    process.exit(0);
  }

  // An unrelated tool_name — no action, no output, no files.
  process.exit(0);
} catch (e) {
  // Advisory-only: never deny (this hook never exits 2). A loud, non-blocking
  // trail beats a silent swallow, but the tool call itself must still proceed.
  process.stderr.write(`H21: delegation-live watch failed: ${(e && e.message) || e}`);
  process.exit(0);
}
