// Shared hook plumbing. Hooks import workspace packages at AUTHOR time; the
// ship step esbuild-bundles them so the runtime is standalone (invariant 4).
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeRepoPath, toRepoRelative } from '@sterling/schemas';
import { SterlingStore } from '@sterling/store';

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
 * Nearest ancestor of `from` holding .sterling/sterling.db, or null when the walk
 * reaches the filesystem root without finding one (= not a Sterling project, so
 * hooks stay silent — P1, no ceremony outside Sterling repos).
 *
 * Keyed on the DB FILE, deliberately NOT on a bare .sterling DIRECTORY: ~/.sterling
 * exists on every machine (it holds the domain stores + registry.db) and is
 * emphatically not a project root — a walk that stopped at the directory would
 * resolve the entire enforcement surface against a store that isn't there.
 */
export function projectRoot(from) {
  if (!from) return null;
  let dir = resolve(String(from));
  for (;;) {
    if (existsSync(join(dir, '.sterling', 'sterling.db'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null; // filesystem root — bounded, never walks forever
    dir = parent;
  }
}

/**
 * Hook stdin, with cwd NORMALIZED TO THE PROJECT ROOT.
 *
 * Every consumer in this layer already treats input.cwd as the project root: it
 * joins .sterling/ onto it (store, config, read-ledger, transient markers, debug
 * scope, delivery guard) and resolves repo-relative tool paths against it. The
 * platform, however, hands the hook the SHELL's working directory, which follows a
 * Bash `cd` — confirmed deterministic 2026-07-27 (board 51b1e2c0): a `cd` into any
 * subdirectory made H3 fail CLOSED on 'no Sterling store' while H7/H9/H13/H15/H16/H19
 * took their no-store branch and went SILENTLY inert, disarming the whole
 * knowledge-duty layer with no throw, no residue and no detector.
 *
 * Normalizing once at this boundary fixes every consumer instead of eleven call
 * sites. When no project is found above, cwd is left EXACTLY as given — absent and
 * unevaluable stay distinct (hooks-suite AC1), so a non-Sterling project is still
 * silently allowed rather than gated against someone else's store.
 */
export function readStdin() {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const root = projectRoot(input.cwd);
  if (root) input.cwd = root;
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

/**
 * Standardized wrapper for a gate denial caused by BROKEN INTERNAL STATE (a
 * torn ledger, a corrupt config/store, a missing transient file) rather than
 * by anything the calling agent did (board c7b81456). Motivating incident: a
 * coder burned ~205k tokens diagnosing H3's fail-closed denial over a torn
 * reads-ledger — the denial read exactly like ordinary "you never read it"
 * misconduct, so the agent tried to fix its own behavior (re-reading,
 * re-diagnosing, retrying the gate) instead of exiting blocked and letting
 * the conductor repair the environment.
 *
 * Every blocking gate that denies because it CANNOT EVALUATE (as opposed to
 * evaluating the agent's action and finding a genuine scope/contract
 * violation, which stays exactly as worded — those denials teach a fix the
 * agent can make and typically resolve via contract-violated / tests-invalid,
 * never this helper) routes its message through this ONE wrapper, so the two
 * failure classes are never visually confusable. `detail` carries the gate's
 * ORIGINAL wording verbatim (path, error text, counts) — this only wraps it,
 * it never replaces or trims it, so every existing substring assertion on a
 * wrapped message's detail keeps matching.
 *
 * AUDIENCE-AWARE (review finding F2): H3 and H15 are globally registered, so
 * they fire for the CONDUCTOR too (no `input.agent_id`) — telling the
 * conductor to "exit `blocked` and let the conductor fix the environment" is
 * self-referential nonsense. Passing an `agentId` key in `opts` (even
 * `undefined`) OPTS IN to audience-awareness: present/truthy -> the
 * agent-facing blocked-exit instruction (unchanged wording); absent/falsy ->
 * repair-facing wording that says so explicitly (there is no conductor above
 * the conductor to exit `blocked` to), since there is no one else to hand
 * the defect to. A caller that never had an audience question — every OTHER
 * hook's environmentDefectDenial calls fire only under agent-scoped
 * registration (frontmatter, never the global hooks.json), so `input.agent_id`
 * is always present there — keeps calling this with no third argument at all,
 * and gets EXACTLY the original unconditional agent-facing text: opting a
 * caller in requires naming `agentId`, never an implicit default switch, so
 * this shared-lib change carries zero blast radius into hooks this fixer
 * pass never touched (H4/H5/H14/H18).
 *
 * SELF-HEALING STATES (review finding F1): some broken states heal on the
 * very next successful action (a torn read-evidence ledger is rebuilt by the
 * next appendRead, e.g. after a Read) — "do not retry" is exactly wrong
 * there. `opts.selfHeal = { action, onRepeat }` swaps in `action` (what to do
 * now, which doubles as the repair) followed by `onRepeat` (the repeat
 * condition, e.g. "If this same TORN denial repeats after that Read") whose
 * resolution still varies by audience.
 */
export function environmentDefectDenial(gateName, detail, opts = {}) {
  const audienceAware = 'agentId' in opts;
  const { agentId, selfHeal } = opts;
  const repair = 'repair it (or restart the session) before proceeding';
  const noConductorAbove = `there is no conductor above you to exit \`blocked\` to — ${repair}.`;
  const agentFacing = `Do not diagnose, repair, or retry ${gateName} yourself — exit \`blocked\`, citing this message VERBATIM, and let the conductor fix the environment.`;
  let instruction;
  if (selfHeal) {
    const resolution = !audienceAware || agentId ? 'exit `blocked` citing it.' : noConductorAbove;
    instruction = `${selfHeal.action} ${selfHeal.onRepeat}, ${resolution}`;
  } else if (audienceAware && !agentId) {
    instruction = `This is broken state, and ${noConductorAbove}`;
  } else {
    instruction = agentFacing;
  }
  return `⚠ ENVIRONMENT DEFECT (${gateName}): this denial is about BROKEN STATE, not your conduct. ${detail} ${instruction}`;
}

export function loadConfig(cwd) {
  const p = join(cwd, '.sterling', 'config.json');
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

/** Open the project store if the project is Sterling-initialized; null otherwise. */
export function openStore(cwd) {
  const p = join(cwd, '.sterling', 'sterling.db');
  return existsSync(p) ? new SterlingStore(p) : null;
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
