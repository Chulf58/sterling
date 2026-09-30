// Command-class skip predicate for H23 (ruling h23-output-axis-hazards-only-skip-
// listings-advisory-label, knowledge_get 5564361d v2). Its own module because
// the hook body reads stdin and exits at import time, so nothing can import a
// function from the hook file itself; the tests import this one.

/** Program basenames whose OUTPUT is VCS or listing output: it echoes paths and
 *  prose the store is about, so it matched constantly and pointed at nothing
 *  relevant. */
export const LISTING_COMMANDS = new Set(['git', 'ls', 'find', 'grep', 'rg']);

// A command line is a sequence of segments joined by && || ; | a newline or a
// lone & (background). `2>&1`, `>&2` and `&>` are redirections, not joins.
// The split is naive about quotes on purpose: a quoted separator only produces
// an extra segment whose program is not a listing one, which fails OPEN.
const SEGMENT_SPLIT = /&&|\|\||[;|\n]|(?<![>&])&(?![>&\d])/;

// One leading prefix that does not change which program produces the output:
// an env assignment (`FOO=bar `) or `sudo `.
const SEGMENT_PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+|sudo\s+)/;

// The program token: quoted (may hold spaces, e.g. "C:\Program Files\...") or bare.
const PROGRAM_TOKEN = /^(?:"([^"]*)"|'([^']*)'|(\S+))/;

// `find` actions that run another program whose output is not a listing.
const FIND_RUNS_PROGRAM = /\s-(?:exec|execdir|ok|okdir)(?=\s|$)/;

function programOf(segment) {
  let rest = segment.trim();
  for (let m = rest.match(SEGMENT_PREFIX); m; m = rest.match(SEGMENT_PREFIX)) rest = rest.slice(m[0].length);
  const m = rest.match(PROGRAM_TOKEN);
  if (!m) return null;
  const token = m[1] ?? m[2] ?? m[3];
  const name = token.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
  return { name, rest };
}

/** True when every segment of the command line is a listing program (after
 *  stripping env/sudo prefixes, any directory, a case difference and `.exe`),
 *  and at least one is. A bare `cd <dir>` segment is neutral. A `find` that
 *  runs another program (-exec, -execdir, -ok, -okdir) is not a listing. Any
 *  other segment, or one that cannot be parsed, makes the command NOT a
 *  listing: when in doubt, H23 runs. */
export function isListingCommand(command) {
  let listing = 0;
  for (const segment of String(command ?? '').split(SEGMENT_SPLIT)) {
    if (segment.trim() === '') continue;
    const program = programOf(segment);
    if (!program) return false;
    if (program.name === 'cd') continue;
    if (!LISTING_COMMANDS.has(program.name)) return false;
    if (program.name === 'find' && FIND_RUNS_PROGRAM.test(program.rest)) return false;
    listing += 1;
  }
  return listing > 0;
}
