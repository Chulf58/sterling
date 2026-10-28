// tmux readers for the multi-session window launcher (slice 6 of the multi-session toolkit, decision
// sterling-ports-ch-hub-s-whole-multi-session-toolkit-session), ported from CH.Hub's office/lib/windows.mjs and the
// session listing of its scripts/open-session-window.mjs.
//
// A window is a tmux session whose pane runs OpenCode. Sessions are matched by their folder (#{session_path},
// realpathed), never by name, and every row carries the session's immutable id ($7) and the server's identity, read in
// one call, so a row is never a name joined to an id from another moment.
//
// THE SERVER IS ALWAYS NAMED: every call here takes the socket and passes -S, so no reading depends on TMUX. A server
// is identified by its pid AND its start time (#{pid}, #{start_time}): a pid alone can be reused by a later server at
// the same socket (anti-pattern 8e603e23), the pair cannot within one second of the clock.
//
// `deps.tmux(args)` resolves { code, stdout, stderr } and never throws. A tmux that cannot be read throws: no listing
// is never an empty one. Only a server that is not running (no server, no socket file, a socket nobody listens on)
// reads as no sessions.
//
// NOT ported: CH.Hub's owner-launcher wrapper forms (scripts/wake-open-owner.sh), which Sterling does not have; a pane
// counts as OpenCode only when its program word is called opencode (the binary templates/launcher-tmux.sh and this
// launcher both start directly).
import { basename, isAbsolute, join } from 'node:path';

// tmux 3.4: "no server running on <socket>", or "error connecting to <socket> (<errno text>)" when the socket file is
// missing or nobody listens on it. Any other errno (a permission error) is an unreadable server, never an absent one.
const NO_SERVER = /no server running on |error connecting to .* \((?:No such file or directory|Connection refused)\)/;
// What tmux prints for #{session_id}: a dollar sign and a number.
export const TMUX_ID_RE = /^\$\d+$/;
const PID_RE = /^[1-9]\d*$/;

// Read only the program word, respecting shell quotes and escapes without evaluating it.
const commandWord = (command) => {
  let word = '', quote = '';
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (!quote && /[\s;&|<>()]/.test(c)) return word || null;
    if (c === '\\' && quote !== "'" && (!quote || /["\\$`\n]/.test(command[i + 1] ?? ''))) {
      if (++i === command.length) return null;
      if (command[i] !== '\n') word += command[i];
    } else if (c === quote) quote = '';
    else if (!quote && (c === '"' || c === "'")) quote = c;
    else word += c;
  }
  return quote || !word ? null : word;
};

/** A pane runs OpenCode when the program word of its start command is called opencode. */
export const isOpencodeCommand = (cmd) => {
  // Ignore surrounding record whitespace, but keep a leading newline as an empty command.
  let command = String(cmd).trimEnd().replace(/^[^\S\r\n]+/, '');
  // tmux serializes a stored shell string as one double-quoted word. Decode that layer once, then read its program.
  if (/^"(?:[^"\\]|\\.)*"$/s.test(command)) {
    const decoded = commandWord(command);
    if (decoded === null) return false;
    command = decoded.replace(/^[^\S\r\n]+/, '');
  }
  const program = commandWord(command);
  return program !== null && basename(program) === 'opencode';
};

/** The tmux error text of a failed call. */
const errorText = (r) => (r.stderr || r.stdout || '').trim();

/**
 * Every session of the tmux server `deps.tmux` reaches: [{ id, name, dir, serverPid, attached, windows }]. `dir` is the
 * session's folder, realpathed; a folder that is gone keeps its raw path (it cannot be a checkout). Any other failure to
 * resolve it throws, because it is then unknown whether the session is a checkout's window.
 */
export async function listSessions(deps, socket) {
  const r = await deps.tmux(['-S', socket, 'list-sessions', '-F', '#{session_id}\t#{session_name}\t#{session_path}\t#{session_attached}\t#{session_windows}\t#{pid}\t#{start_time}']);
  if (r.code !== 0) {
    if (NO_SERVER.test(r.stderr || '')) return [];
    throw new Error(`tmux -S ${socket} list-sessions failed: ${errorText(r)}`);
  }
  const out = [];
  for (const line of r.stdout.split('\n')) {
    if (line === '') continue;
    const [id, name, path, attached, windows, serverPid, serverStart] = line.split('\t');
    if (!TMUX_ID_RE.test(id ?? '') || !name || !path || ![attached, windows].every((n) => /^\d+$/.test(n ?? '')) || !PID_RE.test(serverPid ?? '') || !PID_RE.test(serverStart ?? '')) {
      throw new Error(`tmux list-sessions: unexpected line ${JSON.stringify(line)}`);
    }
    let dir = path;
    try {
      dir = await deps.realpath(path);
    } catch (e) {
      if (e?.code !== 'ENOENT' && e?.code !== 'ENOTDIR') throw new Error(`cannot resolve the folder of tmux session ${name} (${path}), so it is not known whether it is a checkout's window: ${e?.message ?? e}`);
    }
    out.push({ id, name, dir, serverPid, serverStart, attached: Number(attached), windows: Number(windows) });
  }
  return out;
}

/** The ids of the sessions holding at least one OpenCode pane, from one list-panes -a. */
export async function opencodeSessionIds(deps, socket) {
  const r = await deps.tmux(['-S', socket, 'list-panes', '-a', '-F', '#{session_id}\t#{pane_id}\t#{pane_start_command}']);
  if (r.code !== 0) {
    if (NO_SERVER.test(r.stderr || '')) return new Set();
    throw new Error(`tmux -S ${socket} list-panes failed: ${errorText(r)}`);
  }
  const ids = new Set();
  for (const line of r.stdout.split('\n')) {
    if (line === '') continue;
    const [id, pane, ...cmd] = line.split('\t');
    if (!TMUX_ID_RE.test(id ?? '') || !/^%\d+$/.test(pane ?? '') || cmd.length === 0) throw new Error(`tmux list-panes: unexpected line ${JSON.stringify(line)}`);
    if (isOpencodeCommand(cmd.join('\t'))) ids.add(id);
  }
  return ids;
}

/** The socket of tmux's default server for user `uid`: $TMUX_TMPDIR (else /tmp), tmux-<uid>/default. */
export const defaultSocket = (env, uid) => join(env.TMUX_TMPDIR || '/tmp', `tmux-${uid}`, 'default');

/** The socket a plain `tmux` reaches here: the server TMUX names (inside tmux), else the default one. */
export function environmentSocket(env, uid) {
  if (!env.TMUX) return defaultSocket(env, uid);
  // TMUX is <socket>,<server pid>,<session index>; the socket path may itself hold a comma.
  const m = /^(.+),\d+,-?\d+$/.exec(env.TMUX);
  if (!m || !isAbsolute(m[1])) throw new Error(`TMUX is ${JSON.stringify(env.TMUX)}, which names no tmux socket`);
  return m[1];
}

/** Whether a listed session row belongs to the server `server` ({ pid, start }). */
export const sameServer = (row, server) => row.serverPid === server.pid && row.serverStart === server.start;

/** One shell word: single-quoted, so a bare $7 does not read as a shell variable and a path with a space stays whole. */
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * A tmux command that runs `command` on the server at `socket` only while that server is still the one `server`
 * ({ pid, start }) names: same pid and same start time. The check runs server-side (if-shell -F), so no restart can
 * land between a client-side look and the command; a restarted server at the same socket can reuse the session id and
 * even the pid. On a mismatch it prints server_restarted and fails.
 */
export function guardedCommand(socket, server, command) {
  return ['-S', socket, 'if-shell', '-F', `#{&&:#{==:#{pid},${server.pid}},#{==:#{start_time},${server.start}}}`, command, `display-message -p server_restarted ; run-shell 'exit 1'`];
}
