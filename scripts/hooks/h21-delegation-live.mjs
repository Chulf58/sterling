// H21 — mid-session delegation watch (decision 9042abeb, closing the deferral
// in 8b00e77a on observed under-correction, user-approved 2026-08-10). A
// conductor-side PreToolUse hook, ADVISORY-ONLY: it can see that an article
// write or a hand-work call fired but never whether a dac3d2c6 exception
// applies, so it never denies (the H19 lesson, bf87898c). Three mechanisms:
//   (A) ARTICLE-WRITE WATCH — PRECISION FIX (feedback: was call-counting, so
//       it advised on every knowledge_update/append/edit regardless of size,
//       ~zero true positives). Now SIZE-WEIGHTED: every hand-run write
//       (either MCP prefix) still bumps a whole-session {count, bytes} tally
//       in .sterling/transient/article-writes.json, but the advisory only
//       fires when a SINGLE write's serialized tool_input exceeds
//       config.delegation_watch.write_bytes_advise (default 2000 bytes) OR
//       the session's cumulative hand-run bytes cross
//       config.delegation_watch.session_bytes_advise (default 8000 bytes) —
//       advising on the write that crosses it, not before. Both fields are
//       optional in config (absence falls back to the documented defaults,
//       never a crash) and are read directly off the raw config (not through
//       the zod-validated config, which does not yet declare them) so a
//       corrupt or non-numeric value degrades to the default rather than
//       throwing. The advisory still cites decision dac3d2c6 and its three
//       exceptions, and now names the byte trigger.
//   (B) HAND-WORK STREAK — Read/Grep/Glob accumulate a transient streak
//       (distinct read paths + search count) in
//       .sterling/transient/hand-work-streak.json; crossing
//       config.delegation_watch.streak_threshold injects ONE moment-3
//       advisory (decision 677f1639) per streak episode. PRECISION FIX:
//       Read calls on the exempt binary/image extensions
//       (.png/.jpg/.jpeg/.gif/.webp) never count toward the streak — they
//       neither advance nor reset it (a plate-inspection run of image Reads
//       structurally cannot be delegated to a text-only subagent). The
//       exemption is scoped to exactly those five extensions; any other
//       extension (including other image formats such as .svg) still counts.
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
// A payload with no cwd of its own (scripts/tests/h21-precision.test.mjs's
// sized/read fixtures send only {tool_name, tool_input}, relying on the
// spawned process's own working directory) falls back to process.cwd() —
// readStdin()'s project-root normalization only rewrites a PRESENT cwd, it
// never invents one.
if (!input.cwd) input.cwd = process.cwd();

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

/** AC1 size thresholds (config.delegation_watch.{write_bytes_advise,
 *  session_bytes_advise}) — read off the RAW config, not the zod-validated
 *  one, because the shared schema does not yet declare these two fields (an
 *  unknown key there is silently stripped by parseConfig's object schema).
 *  Fail-open: a missing section, a corrupt config.json, or a non-numeric
 *  value all degrade to the documented defaults rather than throwing. */
function sizeThresholds() {
  let dw = {};
  try {
    dw = loadConfig(input.cwd)?.delegation_watch ?? {};
  } catch {
    dw = {};
  }
  const writeThreshold = Number.isFinite(dw.write_bytes_advise) ? dw.write_bytes_advise : 2000;
  const sessionThreshold = Number.isFinite(dw.session_bytes_advise) ? dw.session_bytes_advise : 8000;
  return { writeThreshold, sessionThreshold };
}

/** The only byte-denominated signal available to a PreToolUse hook for a
 *  knowledge_update/append/edit call: the serialized size of its tool_input
 *  (documented fixture assumption, scripts/tests/h21-precision.test.mjs). */
function toolInputBytes(toolInput) {
  try {
    return JSON.stringify(toolInput ?? {}).length;
  } catch {
    return 0;
  }
}

function emit(ctx) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: ctx } }));
}

// AC2 streak exemption: reads of these exact extensions never count toward
// the hand-work streak (scoped precisely — .svg and anything else not on
// this list still counts).
const EXEMPT_READ_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
function fileExt(p) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(p ?? ''));
  return m ? m[1].toLowerCase() : '';
}

const ARTICLE_WRITE_RE = /^(mcp__sterling__|mcp__plugin_sterling_sterling__)(knowledge_update|knowledge_append|knowledge_edit)$/;
const toolName = input.tool_name ?? '';

try {
  if (ARTICLE_WRITE_RE.test(toolName)) {
    const prior = readJsonSafe(articleWritesPath, null);
    const validPrior =
      prior && prior.session_id === input.session_id && Number.isFinite(prior.count) && Number.isFinite(prior.bytes);
    const count = validPrior ? prior.count + 1 : 1;
    const priorBytes = validPrior ? prior.bytes : 0;
    const writeBytes = toolInputBytes(input.tool_input);
    const sessionBytes = priorBytes + writeBytes;
    writeJson(articleWritesPath, { session_id: input.session_id, count, bytes: sessionBytes });

    const { writeThreshold, sessionThreshold } = sizeThresholds();
    const overWrite = writeBytes > writeThreshold;
    const overSession = sessionBytes > sessionThreshold;
    if (overWrite || overSession) {
      const sizeReason = overWrite
        ? `this write is ${writeBytes} bytes, over the per-write advisory threshold (write_bytes_advise=${writeThreshold} bytes)`
        : `this session's cumulative hand-run write bytes just crossed the session advisory threshold (session_bytes_advise=${sessionThreshold} bytes, now ${sessionBytes} bytes)`;
      emit(
        `H21 article-write watch: ${sizeReason} — hand-run article write #${count} this session (decision dac3d2c6 — ` +
          `article application is librarian-shaped). Hand-run writes are for the three named exceptions only: (1) a ` +
          `small authored create, (2) a write needing live adjudication, (3) a single small-record touch. Bulkier ` +
          `article reconciles should batch through the librarian dispatch instead — it runs on a cheaper model in ` +
          `parallel, and the conductor's context window is the session's scarcest and most expensive resource.`
      );
    }
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
      // Exempt image extensions never count toward the streak — they neither
      // advance it nor reset anything (a plate-inspection run of image Reads
      // interleaved with real work must not inflate or disturb the count).
      if (fp && !EXEMPT_READ_EXTS.has(fileExt(fp)) && !streak.read_paths.includes(fp)) streak.read_paths.push(fp);
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
