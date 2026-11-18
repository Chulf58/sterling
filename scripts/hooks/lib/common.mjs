// Shared hook plumbing. Hooks import workspace packages at AUTHOR time; the
// ship step esbuild-bundles them so the runtime is standalone (invariant 4).
import { readFileSync, existsSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeRepoPath, toRepoRelative } from '@sterling/schemas';
import { SterlingStore } from '@sterling/store';
import { resolveStoreRoute } from '@sterling/store/routing';
import { openRoutedForHook } from './broker-client.mjs';
import { isSterlingRoot, storeBackend } from './store-backend.mjs';
import { resolveProjectRoots, storeRootFor } from '../../lib/worktree-root.mjs';
import { hookRoots } from './hook-roots.mjs';

export { storeBackend } from './store-backend.mjs';

/**
 * WHICH LINES an Edit/MultiEdit changed, as merged 1-based [start, end] ranges
 * (board b7269100). PURE — takes the post-edit CONTENT, so the caller owns the
 * file read and this stays unit-testable.
 *
 * Why it exists: a reconcile item said only that a file changed. On a 2717-line
 * file that fires against every article owning the path regardless of whether the
 * changed lines are anywhere near what those articles assert, and a consuming
 * project audited 27 items to find that only FOUR needed a prose change. Naming
 * the lines lets a reader dismiss an irrelevant item in seconds instead of
 * re-reading an article.
 *
 * The material was always there and always discarded: PostToolUse carries the
 * tool_input of the very call that fired the hook, so new_string (or edits[]) is
 * in hand, and locating it in the post-edit file gives the range.
 *
 * APPROXIMATE BY CONSTRUCTION, and that is acceptable for a hint that only has to
 * be good enough to triage: a new_string occurring more than once resolves to the
 * FIRST occurrence, and a Write (whole-file replace) carries no new_string at all
 * so it yields nothing rather than a guess. An empty new_string (a pure deletion)
 * is skipped — indexOf('') is 0 and would report a bogus range at line 1.
 */
export function changedLineRanges(toolInput, content) {
  if (typeof content !== 'string') return [];
  const pieces = [];
  if (typeof toolInput?.new_string === 'string') pieces.push(toolInput.new_string);
  for (const e of Array.isArray(toolInput?.edits) ? toolInput.edits : []) {
    if (typeof e?.new_string === 'string') pieces.push(e.new_string);
  }
  const ranges = [];
  for (const p of pieces) {
    if (!p) continue;
    const idx = content.indexOf(p);
    if (idx === -1) continue; // a later edit moved it; no honest range to report
    const start = content.slice(0, idx).split('\n').length;
    ranges.push([start, start + p.split('\n').length - 1]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    // Adjacent ranges join: "12-14, 15-18" is noise where "12-18" is a fact.
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged;
}

/** "12" for a single line, "12-18" for a span, comma-joined. */
export function formatLineRanges(ranges) {
  return (ranges ?? []).map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ');
}

/**
 * Nearest ancestor of `from` that is a Sterling project root, or null when the
 * walk reaches the filesystem root without finding one (= not a Sterling
 * project, so hooks stay silent — P1, no ceremony outside Sterling repos).
 *
 * The anchor is .sterling/config.json, and .sterling/sterling.db is still
 * accepted (lib/store-backend.mjs isSterlingRoot): a project whose stores live
 * in Postgres has a config and no SQLite file, and a walk keyed on the file
 * alone would read it as "not a Sterling project" and go silent (issue
 * Chulf58/sterling#26 item 5c).
 *
 * Deliberately NOT keyed on a bare .sterling DIRECTORY: ~/.sterling exists on
 * every machine (it holds the domain stores + registry.db, never a config.json)
 * and is emphatically not a project root — a walk that stopped at the directory
 * would resolve the entire enforcement surface against a store that isn't there.
 */
export function projectRoot(from) {
  return resolveProjectRoots(from, isSterlingRoot)?.storeRoot ?? null;
}

export { hookProjectRoot } from './hook-roots.mjs';

/**
 * The git checkout a session in `from` works in, or null outside a Sterling
 * project. It is projectRoot(from) except in a linked git worktree (outside the
 * main checkout or nested in it), where the store stays at the main checkout and
 * the worktree's own .sterling/transient, HEAD and files are this session's
 * (scripts/lib/worktree-root.mjs resolveProjectRoots).
 */
export function checkoutRoot(from) {
  return resolveProjectRoots(from, isSterlingRoot)?.checkoutRoot ?? null;
}

/** Where a session's transient state lives: <checkout>/.sterling/transient. */
export function transientDir(checkout) {
  return join(checkout, '.sterling', 'transient');
}

/**
 * Hook stdin, with cwd NORMALIZED TO THE SESSION'S CHECKOUT and the store root
 * added as input.storeRoot.
 *
 * Every consumer in this layer joins .sterling/ onto input.cwd for transient state
 * (markers, registers, ledgers, delivery guard) and resolves repo-relative tool
 * paths and git against it. The platform, however, hands the hook the SHELL's
 * working directory, which follows a Bash `cd` — confirmed deterministic 2026-07-27
 * (board 51b1e2c0): a `cd` into any subdirectory made the hooks take their no-store
 * branch and go SILENTLY inert. Normalizing once at this boundary fixes every
 * consumer instead of eleven call sites.
 *
 * The roots come from hook-roots.mjs hookRoots: in a linked worktree outside the
 * main checkout, input.cwd is the worktree and input.storeRoot the main checkout,
 * whose store, config and board the session shares (loadConfig, openStore and
 * openStoreOrDegrade map a worktree to it themselves); everywhere else both are the
 * project root by the plain ancestor walk, nested .claude/worktrees/* included.
 * When no project is found above, cwd is left EXACTLY as given and storeRoot equals
 * it — absent and unevaluable stay distinct (hooks-suite AC1), so a non-Sterling
 * project is still silently allowed rather than gated against someone else's store.
 */
export function readStdin() {
  let input = JSON.parse(readFileSync(0, 'utf8'));
  if (isAgyInput(input)) input = adoptAgyInput(input);
  const roots = hookRoots(input.cwd);
  if (roots) input.cwd = roots.checkoutRoot;
  input.storeRoot = roots ? roots.storeRoot : input.cwd;
  return input;
}

/**
 * WRITE-THEN-EXIT — the exit helpers, as ONE state machine (decision
 * `hook-stdout-exit-after-write-callback-bound-exit-deny-stays-synchronous`).
 *
 * THE INVARIANT: a process that has handed a payload to stdout exits only after
 * the stream has reported that payload handed off (the write callback), so the
 * exit never truncates the envelope; and exactly ONE stdout envelope leaves a
 * process — a second non-empty payload is suppressed and disclosed on stderr,
 * because Claude Code parses this stdout as ONE JSON object and `{…}{…}` parses
 * as nothing at all, destroying the first envelope rather than adding to it.
 * Bookkeeping that records 'delivered' runs in `onWritten`, exactly once, only
 * after a SUCCESSFUL hand-off, so a failed write leaves those records eligible
 * for re-delivery. A failed write (a synchronous throw, a callback error, or a
 * stream 'error' — all settled ONCE per write) exits non-zero: a requested 0
 * becomes 1, never a clean 0 over a lost envelope.
 *
 * MEASURED, which is why this is not ceremony (2026-09-07, WSL2 Linux, Node
 * v24.14.0, child spawned with stdout piped): a bare `process.stdout.write(p)`
 * followed by `process.exit(0)` is intact at 16/64/128 KiB and TRUNCATED above
 * that — 146,176 of 262,144 bytes at 256 KiB, 146,176–182,720 of 1,048,576 at
 * 1 MiB, reader-timing dependent. The callback form is intact from 64 KiB to
 * 4 MiB, and intact against a reader paused 300 ms. The truncation is NOT
 * Windows-only, as was assumed: Node calls `_handle.setBlocking(true)` for fd
 * 1/2 pipes only on win32, so Linux is the exposed platform here.
 *
 * WHAT IT DOES NOT GUARANTEE, stated flat because an over-claiming comment on a
 * delivery surface is worse than none:
 *   • that the READER CONSUMED the bytes — the callback proves hand-off to the
 *     underlying resource, nothing about the other end;
 *   • completion when the reader never drains. There is deliberately NO timer:
 *     Claude Code's own hook timeout governs, and an exit-1-after-partial-write
 *     would lose the same envelope while adding an underivable policy constant;
 *   • the native-Windows arm — unmeasured (no node.exe on the authoring machine);
 *   • stderr payloads above the synchronous window (deny/warnNonBlocking below
 *     stay synchronous, and their messages are bounded far under it);
 *   • a `deny()` issued while a stdout write is pending TRUNCATES that envelope,
 *     by design — a block is never lowered to wait for an advisory payload.
 *
 * WHY deny()/warnNonBlocking() ARE NOT ON THIS PATH: they are non-returning
 * control flow across the whole suite (H3, H15, H17 and every other gate rely on
 * `deny()` never returning), so converting them would need a suite-wide
 * control-flow migration — and a blocking exit must never become asynchronous.
 * Their only change is pending-awareness, below.
 *
 * The state lives per instance so tests build their own with stubs; there is
 * deliberately no test-only reset.
 */
export function makeExitHelpers({ stdout, stderr, exit }) {
  let stdoutWritten = false; // a non-empty payload was ATTEMPTED (not necessarily delivered)
  let pending = 0; // writes handed to the stream and not yet settled
  let exitCode = 0; // the code the settled write will exit with
  let finished = false; // the FIRST actual exit wins

  // Every disclosure is best-effort: a stderr write that throws must never
  // change the outcome the caller asked for.
  const note = (message) => {
    try {
      stderr.write(message);
    } catch {
      /* there is nothing left to say it on */
    }
  };

  function finish() {
    if (finished) return;
    finished = true;
    exit(exitCode);
  }

  /**
   * Put `payload` on stdout and exit `code` once the stream has taken it.
   * An EMPTY payload with nothing pending exits synchronously (this is what
   * keeps allow() non-returning for every unmigrated caller); an empty payload
   * while a write is in flight is a no-op — that write's exit carries.
   */
  function exitAfterWrite(payload, code, { onWritten } = {}) {
    const text = typeof payload === 'string' ? payload : String(payload ?? '');

    if (!text) {
      if (pending > 0) return; // the in-flight write owns the exit
      exitCode = code;
      finish();
      return;
    }

    if (stdoutWritten) {
      note(
        `hook stdout: a SECOND stdout payload was SUPPRESSED — the first write already owns this process's single envelope, and two JSON objects on stdout parse as nothing at all. Dropped payload: ${text.slice(0, 400)}`
      );
      // Nothing pending means the first write already settled and exited; this
      // is a no-op there, and the in-flight case is carried by that write.
      // The suppressed call's `code` is NOT honoured (disclosed, not raised):
      // the first envelope's exit stands, because a delivered envelope outranks
      // a later advisory code — an exit-1 hook's stdout is not read as an
      // envelope. A block is never requested this way: deny() is the primitive.
      if (pending === 0) finish();
      return;
    }

    // BOTH SET BEFORE THE ATTEMPT: a write that throws may already have emitted
    // a partial JSON prefix (so the one-envelope rule must already hold), and an
    // injected stream may call its callback SYNCHRONOUSLY (so `pending` must
    // already be counted when settle runs).
    stdoutWritten = true;
    exitCode = code;
    pending += 1;

    let settled = false;
    const settle = (err) => {
      if (settled) return; // Node may report one failure via BOTH the callback and 'error'
      settled = true;
      try {
        if (typeof stdout.removeListener === 'function') {
          try {
            stdout.removeListener('error', onError);
          } catch {
            /* best effort */
          }
        }
        if (err) {
          // A clean 0 would tell the platform the envelope landed. It did not.
          if (exitCode === 0) exitCode = 1;
          note(
            `hook stdout: the payload could NOT be written (${(err && err.message) || err}) — exiting ${exitCode}; the envelope was not delivered and any delivery bookkeeping was skipped, so its records stay eligible.`
          );
        } else if (typeof onWritten === 'function') {
          try {
            onWritten();
          } catch (e) {
            note(
              `hook stdout: post-write bookkeeping threw (${(e && e.message) || e}) — the payload above STANDS and the exit code is unchanged.`
            );
          }
        }
      } finally {
        // ONE decrement, ONE exit, whatever happened above.
        pending -= 1;
        finish();
      }
    };
    const onError = (err) => settle(err || new Error('stdout error'));
    if (typeof stdout.once === 'function') stdout.once('error', onError);

    try {
      stdout.write(text, (err) => settle(err || null));
    } catch (e) {
      settle(e || new Error('stdout write threw'));
    }
  }

  /** Exit 0 — pending-aware: with a write in flight, that write's exit carries. */
  function allow() {
    return exitAfterWrite('', 0);
  }

  /**
   * Block: exit 2 with the rule named on stderr (§6 — exit 1 is non-blocking by
   * platform semantics). The message write is BEST-EFFORT and the exit is not:
   * a stderr failure costs the reader the reason, never the block — a denial
   * voided by its own disclosure is the fail-open this whole layer exists to
   * prevent.
   */
  function deny(message) {
    if (pending > 0) {
      note(
        `hook stdout: a BLOCKING denial was issued while a stdout write was still in flight — that payload is TRUNCATED by design (a block is never lowered, and stdout is ignored on exit 2).\n`
      );
    }
    note(message);
    // The block takes the shared exit latch itself — NOT through finish(), whose
    // code is the stdout write's — so a write settling afterwards in an
    // injected instance can never add a second exit (Codex review 01a07a8b).
    finished = true;
    exit(2);
  }

  /**
   * Non-blocking internal failure: loud on stderr, exit 1 (P5: visible, never a
   * silent gate-void). PENDING-AWARE: with a stdout write in flight this
   * discloses and RETURNS, letting that write's exit carry — a delivered
   * envelope outranks an advisory failure, and an exit-1 hook's stdout is not
   * the envelope Claude Code reads.
   */
  function warnNonBlocking(message) {
    if (pending > 0) {
      note(
        `${message}\nhook stdout: the above is DISCLOSED ONLY — a stdout payload is already in flight and its own exit (${exitCode}) carries, because a delivered envelope outranks an advisory failure.\n`
      );
      return;
    }
    note(message);
    finished = true; // same latch, same reason as deny()
    exit(1);
  }

  return { exitAfterWrite, allow, deny, warnNonBlocking };
}

/** The process-bound instance. Every hook imports these names; tests build their own. */
export const { exitAfterWrite, allow, deny, warnNonBlocking } = makeExitHelpers({
  stdout: process.stdout,
  stderr: process.stderr,
  exit: (code) => process.exit(code),
});

// loadConfig and openStore take a store root or a linked worktree's checkout root
// (storeRootFor maps the second to the first; anything else answers for itself).
export function loadConfig(cwd) {
  const p = join(storeRootFor(cwd), '.sterling', 'config.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

/**
 * Which of the given repo-relative paths git ignores, as a Set (board 1de3653b:
 * an ignored path is never governed territory, so the H19 frontier signal and
 * the H10 article demand must not fire on it — measured at ~20 false
 * firings/session on render output across the 2026-08-14→20 feedback batch).
 *
 * Returns null when git cannot answer (no repo, no git, timeout) — the CALLER
 * owns the degrade, and it must degrade TOWARD signaling (treat nothing as
 * ignored), never toward silence. Exit 0 = some ignored, 1 = none ignored;
 * both are answers. Anything else is a failure.
 */
export function gitIgnored(paths, cwd) {
  const list = (paths ?? []).filter(Boolean);
  if (!list.length) return new Set();
  const res = spawnSync('git', ['check-ignore', '-z', '--stdin'], {
    cwd,
    input: list.join('\0') + '\0',
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (res.status !== 0 && res.status !== 1) return null;
  return new Set((res.stdout || '').split('\0').filter(Boolean));
}

/** Synchronous sleep for the store busy-retry (no async in a hook body). */
export function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Retry a store op past a transient SQLITE_BUSY (the live MCP server can hold a
 * brief lock); a persistent / non-busy throw (corrupt db) propagates — the
 * caller decides the terminal state (blocking gates deny, P5).
 */
export function withRetry(fn) {
  let last;
  for (let i = 0; i < 5; i++) {
    try {
      return fn();
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (!/SQLITE_BUSY|database is locked|is locked|busy/i.test(msg)) throw e;
      last = e;
      sleepMs(25 * (i + 1));
    }
  }
  throw last;
}

/**
 * Open the project store, or null when the project has none.
 *
 * SQLite storage (lib/store-backend.mjs storeBackend): today's open exactly —
 * the file at .sterling/sterling.db, or null when it is absent.
 *
 * Postgres storage goes through the session's hook store broker when one
 * answers, else its own connection after a DEGRADED line (lib/broker-client.mjs
 * openRoutedForHook), and NEVER returns null:
 * a project whose config says 'postgres' is a Sterling project, so "no store"
 * there would be a silent allow. Every failure throws a named error
 * (StoreUnreachableError, StoreSettingsError, ProjectIdentityError,
 * PostgresStoreNotMovedError, ...) and nothing is written or created. A
 * blocking hook turns the throw into a deny; an advisory hook uses
 * openStoreOrDegrade below. The route is resolved (pure: files only) before
 * anything connects, so a caller that runs its cheap event exclusions first
 * pays the Postgres connect only on the events it acts on.
 */
export function openStore(dir) {
  const cwd = storeRootFor(dir);
  if (storeBackend(cwd) === 'routed') {
    const route = resolveStoreRoute(cwd);
    if (route?.storage === 'postgres') return openRoutedForHook(cwd).store;
  }
  const p = join(cwd, '.sterling', 'sterling.db');
  return existsSync(p) ? new SterlingStore(p) : null;
}

/** `Name: message` for a store failure; the class name is preferred because ProjectModeError and ProjectIdentityError keep name 'Error'. */
export function namedError(e) {
  const name = e?.constructor?.name && e.constructor.name !== 'Object' ? e.constructor.name : (e?.name ?? 'Error');
  return `${name}: ${e?.message ?? String(e)}`;
}

/** The one stderr line an advisory hook prints when a routed (Postgres-storage) project store cannot be opened. */
export function storeUnavailableLine(who, e) {
  return `${who}: DEGRADED — the project store could not be opened, so this hook did nothing this time (${namedError(e)}).\n`;
}

/**
 * For ADVISORY hooks: `open(cwd)` (openStore by default), and on a routed
 * project a failure prints storeUnavailableLine and exits 1 (non-blocking but
 * loud, P5) instead of reading as "not a Sterling project". A SQLite project
 * keeps today's behaviour exactly: the open runs unguarded.
 */
export function openStoreOrDegrade(cwd, who, open = openStore) {
  if (storeBackend(storeRootFor(cwd)) === 'sqlite') return open(cwd);
  try {
    return open(cwd);
  } catch (e) {
    warnNonBlocking(storeUnavailableLine(who, e));
    return null; // reached only when a stdout write is already in flight, whose own exit carries
  }
}

/**
 * Repo-relative POSIX form of a tool path (absolute or relative), or null when
 * the path is outside the repository (§3.2 path invariant at the hook boundary).
 */
export function repoRel(toolPath, cwd) {
  if (!toolPath) return null;
  const fwd = String(toolPath).replace(/\\/g, '/');
  try {
    if (/^[A-Za-z]:/.test(fwd) || fwd.startsWith('/')) return toRepoRelative(fwd, cwd);
    return normalizeRepoPath(fwd);
  } catch {
    return null;
  }
}

// ── Antigravity CLI (agy) arm ────────────────────────────────────────────────
//
// THE THIRD HOST (board 792619d3; contract: research_finding
// how-does-an-antigravity-cli-agy-plugin-load-manifest-hooks-j, phases A and B,
// measured on agy 1.5.11). agy runs the same bundles from the plugin's ROOT
// hooks.json. Its stdin is camelCase and carries `hookEventName`; Claude Code's
// and OpenCode's carry `hook_event_name`, so that one field is the detection and
// nothing on their path changes. adoptAgyInput rewrites the agy payload into the
// shape every hook already reads (hook_event_name, session_id, tool_name,
// tool_input, ...) and takes over stdout and stderr, so the Claude-shaped output
// each hook writes is translated ONCE, at process exit, into agy's envelope for
// the event (agyEnvelope). No hook file carries an agy branch.
//
// WHY AT EXIT: the hooks write their envelopes several ways (exitAfterWrite, a
// bare process.stdout.write, deny() on stderr with exit 2), and agy reads one
// JSON object from an exit-0 hook. A non-zero exit is logged and IGNORED there,
// so H15's exit-2 deny would fail open. Capturing the writes and emitting from
// the 'exit' listener covers every path and turns exit 2 into a JSON deny with
// exit 0.
//
// NOT GUARANTEED: Stop's {"decision":"continue"} and a PreToolUse `reason` on an
// allow are written per the docs and are unmeasured; PostToolUse has no context
// channel (its output is `{}`), so what a hook adds there (H19's Read/Edit/Bash
// delivery, H23) reaches nothing under agy; H20's updatedInput has no mapping and
// is dropped; a hook's onWritten bookkeeping runs when its write is captured,
// before the envelope leaves at exit.

const AGY_EVENTS = {
  SessionStart: 'SessionStart',
  PreInvocation: 'UserPromptSubmit',
  PreToolUse: 'PreToolUse',
  PostToolUse: 'PostToolUse',
  Stop: 'Stop',
};

/** True for an agy hook payload: camelCase hookEventName and no Claude Code hook_event_name. */
export function isAgyInput(raw) {
  return raw !== null && typeof raw === 'object' && typeof raw.hookEventName === 'string' && !('hook_event_name' in raw);
}

/**
 * An agy toolCall as Claude Code's {tool_name, tool_input}. The measured names
 * come first; the docs' names (view_file, write_to_file, replace_file_content,
 * multi_replace_file_content) were not seen emitted and are mapped too, so the
 * store guard keeps holding if a later agy emits them. An unknown tool passes
 * through under its own name with its own args.
 */
export function agyToolCall(name, rawArgs) {
  const a = rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
  switch (name) {
    case 'run_command':
      return { tool_name: 'Bash', tool_input: { command: a.CommandLine } };
    case 'read_file':
    case 'view_file':
      return { tool_name: 'Read', tool_input: { file_path: a.Path ?? a.AbsolutePath } };
    case 'write_file':
    case 'write_to_file':
      return { tool_name: 'Write', tool_input: { file_path: a.Path ?? a.TargetFile, content: a.Content ?? a.CodeContent } };
    case 'edit_file':
    case 'replace_file_content':
      return {
        tool_name: 'Edit',
        tool_input: { file_path: a.Path ?? a.TargetFile, old_string: a.Target ?? a.TargetContent, new_string: a.Replacement ?? a.ReplacementContent },
      };
    case 'multi_replace_file_content':
      return {
        tool_name: 'MultiEdit',
        tool_input: {
          file_path: a.TargetFile,
          edits: (Array.isArray(a.ReplacementChunks) ? a.ReplacementChunks : []).map((c) => ({ old_string: c?.TargetContent, new_string: c?.ReplacementContent })),
        },
      };
    case 'invoke_subagent':
      return { tool_name: 'Task', tool_input: { prompt: a.Prompt, description: a.Role, subagent_type: a.TypeName } };
    case 'send_message':
      return { tool_name: 'SendMessage', tool_input: { to: a.Recipient, message: a.Message } };
    case 'ask_question':
      return { tool_name: 'AskUserQuestion', tool_input: a };
    // From the docs only (neither was emitted in the measured turns).
    case 'search_web':
      return { tool_name: 'WebSearch', tool_input: { query: a.query } };
    case 'read_url_content':
      return { tool_name: 'WebFetch', tool_input: { url: a.Url } };
    case 'call_mcp_tool': {
      // Arguments arrives as an object or as JSON text; text that is not JSON
      // is handed on unparsed under its own key rather than dropped.
      let args = a.Arguments;
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          args = { Arguments: a.Arguments };
        }
      }
      return { tool_name: `mcp__${a.ServerName}__${a.ToolName}`, tool_input: args !== null && typeof args === 'object' ? args : {} };
    }
    default:
      return { tool_name: name, tool_input: a };
  }
}

/**
 * The agy payload as the Claude Code input the hooks read, plus `skip`: a reason
 * this event must not reach the hook at all (it then exits with the event's
 * neutral envelope), or null.
 *
 * SKIPS, each mirroring what Claude Code never fires:
 *   • a SUBAGENT conversation's SessionStart, PreInvocation and Stop. agy runs a
 *     subagent as its own conversation with its own SessionStart and Stop, which
 *     Claude Code never fires for a subagent (H1 and H10 are the conductor's).
 *     The signal is the measured one: lastUserInput is "" in a subagent
 *     conversation and carries the user's prompt in the main one. No better
 *     signal was measured (the child's id is not on the parent's tool events);
 *   • PreInvocation past the first model call: it fires once PER MODEL CALL
 *     (invocationNum 0, 1, 2, ...) and maps from UserPromptSubmit, which fires
 *     once per prompt;
 *   • PostToolUse for a FAILED call (non-empty error), which on Claude Code fires
 *     PostToolUseFailure instead. Only a failed subagent call is passed on, as
 *     PostToolUseFailure, because H22 is the only hook registered for it.
 */
export function normalizeAgyInput(raw) {
  const event = raw.hookEventName;
  const input = {
    hook_event_name: AGY_EVENTS[event] ?? event,
    session_id: raw.conversationId,
    transcript_path: raw.transcriptPath,
    cwd: typeof raw.cwd === 'string' ? raw.cwd : Array.isArray(raw.workspacePaths) ? raw.workspacePaths[0] : undefined,
    host: 'agy',
  };
  const subagent = raw.lastUserInput === '';
  if (event === 'SessionStart') {
    input.source = 'startup';
    if (subagent) return { input, skip: 'subagent conversation' };
  } else if (event === 'PreInvocation') {
    input.prompt = raw.lastUserInput;
    if (subagent) return { input, skip: 'subagent conversation' };
    if (raw.invocationNum !== 0) return { input, skip: 'not the first model call of the prompt' };
  } else if (event === 'Stop') {
    input.stop_hook_active = raw.continuationActive === true;
    if (subagent) return { input, skip: 'subagent conversation' };
  } else if (event === 'PreToolUse' || event === 'PostToolUse') {
    Object.assign(input, agyToolCall(raw.toolCall?.name, raw.toolCall?.args));
    input.tool_use_id = raw.toolCall?.id;
    if (event === 'PostToolUse' && typeof raw.error === 'string' && raw.error !== '') {
      if (input.tool_name !== 'Task') return { input, skip: 'failed tool call' };
      input.hook_event_name = 'PostToolUseFailure';
      input.error = raw.error;
    }
  }
  return { input, skip: null };
}

/** The model-facing texts in a Claude-shaped hook stdout: additionalContext, then systemMessage; plain text is context as-is. */
function agyContextTexts(out) {
  const text = out.trim();
  if (!text) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [text]; // plain stdout is context on Claude Code's SessionStart and UserPromptSubmit
  }
  if (parsed === null || typeof parsed !== 'object') return [text];
  const texts = [];
  const ctx = parsed.hookSpecificOutput?.additionalContext;
  if (typeof ctx === 'string' && ctx.trim()) texts.push(ctx);
  if (typeof parsed.systemMessage === 'string' && parsed.systemMessage.trim()) texts.push(parsed.systemMessage);
  return texts;
}

/**
 * The agy stdout envelope and exit code for a hook that wrote `out` and `err`
 * and exited `code`, on the agy event `event`. Exit 2 is Claude Code's block:
 * a PreToolUse deny, or a Stop continue unless agy already continued once
 * (continuationActive), the loop guard Claude Code's stop_hook_active gives.
 * A block on any other event and every other non-zero exit stay as they are
 * (agy logs them). SessionStart and PreInvocation carry context only through
 * injectSteps (a bare systemMessage was measured to be dropped).
 */
export function agyEnvelope({ event, continuationActive = false, out = '', err = '', code = 0 }) {
  const json = (o) => ({ text: JSON.stringify(o), code: 0 });
  if (code === 2) {
    const reason = err.trim() || 'A Sterling hook blocked this without giving a reason.';
    if (event === 'PreToolUse') return json({ decision: 'deny', reason });
    if (event === 'Stop') return continuationActive ? json({ decision: 'allow' }) : json({ decision: 'continue', reason });
    return { text: '', code };
  }
  if (code !== 0) return { text: '', code };
  const texts = agyContextTexts(out);
  if (event === 'SessionStart' || event === 'PreInvocation') {
    return json(texts.length ? { injectSteps: texts.map((t) => ({ systemMessage: { systemMessage: t } })) } : {});
  }
  if (event === 'PreToolUse') return json(texts.length ? { decision: 'allow', reason: texts.join('\n\n') } : { decision: 'allow' });
  if (event === 'Stop') return json({ decision: 'allow' });
  return json({});
}

/** Write all of `text` to `fd` synchronously, waiting out EAGAIN on a non-blocking pipe. */
function writeAllSync(fd, text) {
  const buf = Buffer.from(text, 'utf8');
  let off = 0;
  while (off < buf.length) {
    try {
      off += writeSync(fd, buf, off, buf.length - off);
    } catch (e) {
      if (e?.code !== 'EAGAIN') throw e;
      sleepMs(5);
    }
  }
}

/**
 * Take over this process's stdout and stderr for agy and return the normalized
 * input. stdout writes are captured (their callbacks still fire, so the
 * write-then-exit helpers settle as usual); stderr is captured and still
 * written, because agy logs it. A skipped event exits here with its neutral
 * envelope.
 */
export function adoptAgyInput(raw) {
  const { input, skip } = normalizeAgyInput(raw);
  const out = [];
  const err = [];
  const text = (chunk) => (typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
  process.stdout.write = (chunk, encoding, callback) => {
    out.push(text(chunk));
    const done = typeof encoding === 'function' ? encoding : callback;
    if (typeof done === 'function') process.nextTick(done, null);
    return true;
  };
  const writeErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    err.push(text(chunk));
    return writeErr(chunk, ...rest);
  };
  process.on('exit', (code) => {
    const envelope = agyEnvelope({ event: raw.hookEventName, continuationActive: raw.continuationActive === true, out: out.join(''), err: err.join(''), code });
    try {
      if (envelope.text) writeAllSync(1, envelope.text);
      process.exitCode = envelope.code;
    } catch (e) {
      writeErr(`Sterling agy adapter: the hook envelope could not be written (${(e && e.message) || e}), so agy proceeds as if no hook ran.\n`);
      process.exitCode = 1;
    }
  });
  if (skip) allow();
  return input;
}
