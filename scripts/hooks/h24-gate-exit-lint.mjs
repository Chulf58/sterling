// H24 — gate-invocation exit lint (board 7d88b237). PreToolUse Bash|PowerShell,
// BLOCKING. Measured incident (retro 2026-08-17-1820): a failing suite exited
// 100, but the harness read exit 0 because '; echo $?' had been appended after
// the gate — a red suite was reported as passing, and the companion assessment's
// own author committed the same violation the same day. This hook denies a
// declared GATE invocation — the values of config.toolchains[].run_commands,
// UNION the builtin floor ['node --test', 'npm test', 'npm run check'] — when it
// is followed, AT TOP LEVEL, by ';' or '||': both swallow the gate's real exit
// code. '&&' and pipes are deliberately ALLOWED — '&&' propagates a red exit,
// and pipes are the evidence-free noisy class the success-predicate task (board
// babf3a9e) owns, not this lint. A gate that IS the final command is always
// allowed, wherever it sits in a '&&' chain or after a ';'. Governing decision:
// knowledge_get 6cdd1b02-4d4f-4d7d-b9cd-2887265e7f90 (slug
// gate-exit-lint-h24-masked-exit-codes) is the authority on semantics; the
// frozen suite (scripts/tests/h24-gate-exit-lint.test.mjs) is authoritative
// where more specific.
//
// Scope choices pinned by the decision — do not widen without a new one:
//  - quote-aware top-level scan: separators sitting inside '...'/"..." never
//    count (mirrors the quote-tracking idiom in h14-bash-allowlist.mjs /
//    h15-store-guard.mjs; the SEGMENTATION here is this hook's own, since it
//    must track WHICH separator follows each segment, not just split on one).
//  - subshell '(' ... ')' contents are OPAQUE: never parsed for a masking
//    separator, even a naive read would see one inside — a deliberate scope
//    choice, not an oversight (rejected: also denying inside subshells).
//  - fail posture: a corrupt/unreadable/absent config degrades to the BUILTIN
//    FLOOR ONLY — still enforcing the universal gates, never fully open, and
//    never denying every command over a config typo (the F5 fail-open class,
//    anti_pattern e13f0fb5, stays closed WITHOUT converting this lint into a
//    Bash-wide wedge; rejected: fail closed by denying all Bash on corrupt
//    config).
//  - malformed (non-JSON) stdin or a non-Bash/PowerShell tool_name degrades to
//    a silent allow — this lint only ever inspects an actual shell command
//    string, and a hook that cannot evaluate its own input must not crash into
//    a nonzero exit any more than it should wrongly deny.
//
// DISCLOSED under-deny gaps (review 2026-08-21) — every one fails toward
// ALLOW, so a real mask can escape but a legitimate command is never wrongly
// blocked; widening any of these needs a new decision, not a drive-by:
//  - NEWLINES are not separators: 'gate\necho $?' masks exactly like ';' but
//    is allowed — deliberate, because newline-blindness is also what keeps
//    heredoc bodies (which this scanner does not understand) from producing
//    false denials.
//  - a single '&' (backgrounding) is not treated as masking; only '&&' is
//    recognized, as a non-masking chain.
//  - an env-var/wrapper prefix hides the gate ('FOO=1 node --test x; ...'
//    allows) — consistent with the segment-STARTS-WITH rule.
//  - backticks are untracked: a backticked gate escapes, and a ';' inside
//    backticks is the one constructible FALSE-DENY ('node --test x --grep
//    \`a;b\`') — exotic, accepted alongside the '(...)' opacity choice, which
//    also makes '$( )' contents opaque.
import { readStdin, deny, allow, loadConfig } from './lib/common.mjs';
import { parseConfig } from '@sterling/schemas';

const BUILTIN_FLOOR = ['node --test', 'npm test', 'npm run check'];

let input;
try {
  input = readStdin();
} catch {
  allow(); // malformed (non-JSON) stdin — nothing to lint, never a crash exit
}

// This lint only ever inspects an executed shell command string.
if (input.tool_name !== 'Bash' && input.tool_name !== 'PowerShell') allow();

const command = String(input.tool_input?.command ?? '');
if (!command.trim()) allow();

// GATES = builtin floor UNION config.toolchains[].run_commands values. Any
// failure below (absent .sterling/config.json, corrupt JSON, a shape
// parseConfig rejects) leaves `gates` at the floor — itself still an
// enforcing, non-empty set, never a fully-open lint.
const gates = new Set(BUILTIN_FLOOR);
try {
  const raw = loadConfig(input.cwd);
  if (raw) {
    const cfg = parseConfig(raw);
    for (const tc of cfg.toolchains) {
      for (const v of Object.values(tc.run_commands ?? {})) gates.add(v);
    }
  }
} catch {
  // corrupt/unreadable config — degrade to the builtin floor only (see header).
}

// Longest-first: keeps the matcher honest as the gate set grows (a longer
// declared gate is tried before any gate that happens to be one of its own
// leading substrings). Irrelevant for the builtin floor + this task's config,
// but cheap to get right once.
const gateList = [...gates].sort((a, b) => b.length - a.length);

// A segment INVOKES a gate when it starts with the gate string at a TOKEN
// BOUNDARY — the full gate text, followed by whitespace or end-of-segment,
// never merely a leading-character substring ('--testify' is not '--test',
// 'checker' is not 'check').
function matchGate(segment) {
  for (const g of gateList) {
    if (segment === g || (segment.startsWith(g) && /\s/.test(segment[g.length]))) return g;
  }
  return null;
}

// Quote-aware top-level scan. Returns an ordered list of {segment, sep}, where
// `sep` is the TOP-LEVEL separator immediately following that segment — ';',
// '||', '&&', '|', or null for the final segment (end of command) — so the
// caller can tell "a gate followed by a masking separator" from "a gate
// followed by an allowed one" without re-scanning. Separators inside a single-
// or double-quoted span never count; a '(' ... ')' subshell span is consumed
// whole, opaque to everything inside it (quotes and separators alike) — the
// deliberate scope choice above.
function scanTopLevel(cmd) {
  const items = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (inSingle) {
      current += c;
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      current += c;
      if (c === '"' && cmd[i - 1] !== '\\') inDouble = false;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      current += c;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      current += c;
      continue;
    }
    if (c === '(') {
      // Opaque subshell span: consume through the matching close paren
      // (tracking nested parens) without interpreting anything inside as a
      // quote or a separator.
      let depth = 1;
      let span = c;
      i++;
      while (i < cmd.length && depth > 0) {
        const ch = cmd[i];
        span += ch;
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        i++;
      }
      i--; // outer loop's i++ accounts for the next character
      current += span;
      continue;
    }
    if (c === '&' && cmd[i + 1] === '&') {
      items.push({ segment: current, sep: '&&' });
      current = '';
      i++;
      continue;
    }
    if (c === '|' && cmd[i + 1] === '|') {
      items.push({ segment: current, sep: '||' });
      current = '';
      i++;
      continue;
    }
    if (c === ';') {
      items.push({ segment: current, sep: ';' });
      current = '';
      continue;
    }
    if (c === '|') {
      items.push({ segment: current, sep: '|' });
      current = '';
      continue;
    }
    current += c;
  }
  items.push({ segment: current, sep: null });
  return items;
}

// The two constructs that swallow a preceding command's exit code. '&&' and a
// lone '|' are deliberately excluded — see header.
const MASKING = new Set([';', '||']);

for (const { segment, sep } of scanTopLevel(command)) {
  if (!sep || !MASKING.has(sep)) continue; // no masking separator follows this segment
  const trimmed = segment.trim();
  if (!trimmed) continue;
  const gate = matchGate(trimmed);
  if (!gate) continue;
  deny(
    `H24: gate invocation masked — '${gate}' is followed at top level by '${sep}', which swallows the gate's real exit code.\n` +
      `Command: ${command}\n` +
      `Never append ';' or '||' after a gate — a red suite must never read green. ` +
      `Run the gate as the last command, or chain with '&&' — a red exit propagates. ` +
      `Board 7d88b237.`
  );
}

allow();
