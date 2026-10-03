// issue-report.mjs: the pure half of bin/report-issue.mjs (decision
// projects-file-sterling-issues-as-scrubbed-github-issues-automatically). It
// validates a Sterling defect report, scrubs every field, normalizes the title,
// computes the fingerprint and renders the issue body. No fs, no network, no
// process state: the CLI (scripts/report-issue.mjs) passes in the project root,
// the home dir and a predicate that says whether a repo-relative path exists in
// the running Sterling copy.
//
// The repo is public, so the scrub is fail-closed for what it can see: the
// project root and the home dir (with any path below them, spaces included),
// UUIDs, and every whitespace-free token holding a / or \ that is not a file
// Sterling ships or a Sterling-owned .sterling/ name. That blanks harmless
// tokens such as "and/or" too. What it does NOT guarantee: any other path that
// contains spaces is cut at each space, so the words between them stay
// ("/mnt/d/Acme Client Billing/x.ts" keeps "Client"). The printed body shows
// the result before it is sent. Known residual risk (accepted in the
// decision): a quoted Sterling message that embeds a project record title
// passes the scrub.
//
// Builtins only: bin/report-issue.mjs bundles this module.
import { createHash } from 'node:crypto';

/** Where reports are filed. The one place the repo is named. */
export const STERLING_ISSUE_HOST = 'github.com';
export const STERLING_ISSUE_REPO = 'Chulf58/sterling';

export const SEVERITIES = ['BLOCKED', 'WORKAROUND', 'FRICTION'];

export const CAPS = { title: 120, component: 80, observed: 600, expected: 400, evidenceLine: 300, evidenceLines: 12 };

/** Top-level directories of the Sterling repo whose files a report may cite. */
export const STERLING_PREFIXES = ['scripts/', 'packages/', 'hooks/', 'bin/', 'mcp/', 'opencode/', 'agent-templates/', 'skills/', 'templates/', 'commands/', 'tui/', '.claude-plugin/'];

/** The names under a project's .sterling/ that Sterling itself writes. A
 * .sterling/ path is kept only when it is exactly one of these (a directory
 * with nothing below it, or a file); every other .sterling/ path is project
 * territory (domains/<name>/, transient/<file>, a file a project put there). */
export const STERLING_STATE_NAMES = [
  'config.json',
  'sterling.db',
  'sterling.db-wal',
  'sterling.db-shm',
  'plan-lock.json',
  'synced-version',
  'pending-issue-reports.jsonl',
  'pending-issue-reports.jsonl.lock',
  'maintenance-worker.log',
  'maintenance-worker.jsonl',
  'update-complete.json',
  'enforcement-baseline.json',
  'agents-md-migration-preview.diff',
  'transient',
  'runs',
  'delivery-audit',
  'opencode',
];

/** A report the script will not file; the message names the remedy. */
export class ReportRefusal extends Error {}

const PLACEHOLDER = '<project-path>';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const DELIMS = `\\s"'\`<>()\\[\\]{},;|`;
const TOKEN_RE = new RegExp(`[^${DELIMS}]+`, 'g');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The spellings one absolute root can appear in: as given, and for a WSL
 * /mnt/<drive>/... path its Windows forms with either separator. */
function rootVariants(dir) {
  if (typeof dir !== 'string' || !dir.startsWith('/') || dir === '/') return [];
  const clean = dir.replace(/\/+$/, '');
  const out = [clean];
  const m = clean.match(/^\/mnt\/([a-z])(\/.*)?$/i);
  if (m) {
    const rest = m[2] ?? '';
    out.push(`${m[1]}:${rest.replace(/\//g, '\\')}`, `${m[1]}:${rest}`);
  }
  return out;
}

/** A repo-relative path (optionally with :line or :line-line) that Sterling ships. */
function isSterlingPath(token, sterlingPathExists) {
  const path = token.replace(/[.,:;!?]+$/, '').replace(/:\d+(?:-\d+)?$/, '');
  if (!/^[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]*)+$/.test(path)) return false;
  if (path.split('/').some((seg) => seg === '..' || seg === '.')) return false;
  if (path.startsWith('.sterling/')) return STERLING_STATE_NAMES.includes(path.slice('.sterling/'.length).replace(/\/$/, ''));
  return STERLING_PREFIXES.some((p) => path.startsWith(p)) && sterlingPathExists(path.replace(/\/+$/, ''));
}

/** Scrub one field. In order: the project root and the home dir (with any
 * path below them, in POSIX and WSL-Windows spellings) become <project-path>;
 * UUIDs become <id>; then every remaining token holding a / or \ that is not a
 * Sterling path becomes <project-path> (absolute POSIX, Windows, UNC, URLs and
 * project-relative paths alike). */
export function scrub(text, { projectRoot, home, sterlingPathExists }) {
  let out = String(text);
  const roots = [...rootVariants(projectRoot), ...rootVariants(home)].sort((a, b) => b.length - a.length);
  for (const r of roots) {
    const re = new RegExp(`${escapeRe(r)}(?=$|[\\\\/:${DELIMS}])(?:[\\\\/][^${DELIMS}]*)?`, /^[a-z]:/i.test(r) ? 'gi' : 'g');
    out = out.replace(re, PLACEHOLDER);
  }
  out = out.replace(UUID_RE, '<id>');
  return out.replace(TOKEN_RE, (tok) => (/[\\/]/.test(tok) && !isSterlingPath(tok, sterlingPathExists) ? PLACEHOLDER : tok));
}

const EVIDENCE_HELP =
  `Each --evidence line is either a Sterling repo-relative path:line under ${STERLING_PREFIXES.join(' ')} that Sterling ships ` +
  '(e.g. scripts/lib/work-pr.mjs:99 or scripts/lib/work-pr.mjs:99-109), or a "double-quoted message" Sterling printed.';

function checkEvidenceLine(line, n, ctx) {
  if (line.length > CAPS.evidenceLine) throw new ReportRefusal(`report-issue: evidence line ${n} is ${line.length} chars, over the ${CAPS.evidenceLine}-char cap. Remedy: quote only the part of the message that shows the defect.`);
  const ref = line.match(/^([A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+):\d+(?:-\d+)?$/);
  if (ref && STERLING_PREFIXES.some((p) => ref[1].startsWith(p)) && !ref[1].split('/').includes('..') && ctx.sterlingPathExists(ref[1])) return line;
  const quoted = line.match(/^"([^\n]+)"$/);
  if (quoted) return `"${scrub(quoted[1], ctx)}"`;
  throw new ReportRefusal(`report-issue: evidence line ${n} ('${line}') is neither a Sterling path:line nor a quoted message. Remedy: ${EVIDENCE_HELP}`);
}

/** Validate raw CLI input and return the scrubbed report, or throw ReportRefusal.
 * Caps are measured on the trimmed input, before the scrub. */
export function validateReport(input, ctx) {
  const fields = {};
  for (const f of ['title', 'component', 'severity', 'observed', 'expected']) {
    const v = typeof input[f] === 'string' ? input[f].trim() : '';
    if (!v) throw new ReportRefusal(`report-issue: --${f} is required. Remedy: pass --${f} "<text>".`);
    fields[f] = v;
  }
  if (!SEVERITIES.includes(fields.severity)) {
    throw new ReportRefusal(`report-issue: --severity must be one of ${SEVERITIES.join('|')}, got '${fields.severity}'. Remedy: BLOCKED stops the work, WORKAROUND has a way around it, FRICTION slows it down.`);
  }
  for (const f of ['title', 'component', 'observed', 'expected']) {
    if (fields[f].length > CAPS[f]) throw new ReportRefusal(`report-issue: --${f} is ${fields[f].length} chars, over the ${CAPS[f]}-char cap. Remedy: shorten it.`);
  }
  const evidence = (input.evidence ?? []).map((l) => String(l).trim());
  if (evidence.length === 0) throw new ReportRefusal(`report-issue: at least one --evidence line is required. ${EVIDENCE_HELP}`);
  if (evidence.length > CAPS.evidenceLines) throw new ReportRefusal(`report-issue: ${evidence.length} --evidence lines, over the cap of ${CAPS.evidenceLines}. Remedy: keep the lines that locate the defect.`);
  return {
    title: scrub(fields.title, ctx),
    component: scrub(fields.component, ctx),
    severity: fields.severity,
    observed: scrub(fields.observed, ctx),
    expected: scrub(fields.expected, ctx),
    evidence: evidence.map((l, i) => checkEvidenceLine(l, i + 1, ctx)),
  };
}

/** The title with its variable parts (UUIDs, paths, hex ids, digits) as #, so
 * two reports of one defect share a fingerprint. */
export function normalizeTitle(title) {
  return String(title)
    .toLowerCase()
    .replace(UUID_RE, '#')
    .replace(/<project-path>|<id>/g, '#')
    .replace(new RegExp(`[^${DELIMS}]*[\\\\/][^${DELIMS}]*`, 'g'), '#')
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{6,}\b/g, '#')
    .replace(/\d+/g, '#')
    .replace(/#+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 12 hex of sha1(component|normalized title). */
export function fingerprint(component, title) {
  return createHash('sha1').update(`${String(component).trim().toLowerCase()}|${normalizeTitle(title)}`).digest('hex').slice(0, 12);
}

/** The visible body line the dedup search matches. */
export const fingerprintLine = (fp) => `Fingerprint: sterling-fp-${fp}`;

/** The visible body line that carries the labels, so the classification
 * survives when GitHub refuses or drops them for an account that may not set labels. */
export const labelsLine = (labels) => `Labels: ${labels.join(', ')}`;

/** The index of the last line for which `isFp(trimmed line)` holds (the renderer writes the fingerprint line last), or -1. */
const lastFingerprintAt = (lines, isFp) => {
  for (let i = lines.length - 1; i >= 0; i--) if (isFp(lines[i].trim())) return i;
  return -1;
};

const FINGERPRINT_ANY = /^Fingerprint: sterling-fp-[0-9a-f]{12}$/;

/** The tokens of the `Labels:` line that sits directly above the body's
 * fingerprint line, as written, or null when there is none. A `Labels:` line
 * anywhere else is user text and is not read. */
export function parseLabelsLine(body) {
  const lines = String(body).split('\n');
  const at = lastFingerprintAt(lines, (l) => FINGERPRINT_ANY.test(l));
  if (at < 1) return null;
  const m = lines[at - 1].replace(/\r$/, '').match(/^Labels: (.*)$/);
  return m ? m[1].split(',').map((l) => l.trim()) : null;
}

/** The labels a report carries when its Labels line is exactly `sterling-report`,
 * one `severity:` label and one `project:` label (any order), returned in that
 * order; null for any other line. --apply-labels acts on nothing else, because
 * the body it reads is text anyone could have written. */
export function reportLabels(body) {
  const tokens = parseLabelsLine(body);
  if (!tokens || tokens.length !== 3) return null;
  const report = tokens.filter((l) => l === 'sterling-report');
  const severity = tokens.filter((l) => /^severity:(?:blocked|workaround|friction)$/.test(l));
  const project = tokens.filter((l) => /^project:[a-z0-9._-]{1,40}$/.test(l));
  return report.length === 1 && severity.length === 1 && project.length === 1 ? [report[0], severity[0], project[0]] : null;
}

/** `body` with a `Labels:` line directly above its fingerprint line (or at the
 * end when it has no fingerprint line), unless that line is already there. For
 * queued reports written before the line existed; the fingerprint is untouched. */
export function withLabelsLine(body, labels, fp) {
  const lines = body.split('\n');
  const fpLine = fingerprintLine(fp);
  const at = lastFingerprintAt(lines, (l) => l === fpLine);
  if (at < 0) {
    const last = [...lines].reverse().find((l) => l.trim() !== '');
    return last?.startsWith('Labels: ') ? body : `${body}\n\n${labelsLine(labels)}`;
  }
  if (at > 0 && lines[at - 1].startsWith('Labels: ')) return body;
  lines.splice(at, 0, labelsLine(labels));
  return lines.join('\n');
}

/** A body for a new issue whose fingerprint matched closed issue #n. */
export const withRecurrence = (body, n) => `Recurs after #${n}.\n\n${body}`;

/** Free text in a fence longer than any backtick run inside it, so markdown,
 * links and @mentions in a report render inert. */
function fence(text) {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const f = '`'.repeat(Math.max(3, longest + 1));
  return `${f}text\n${text}\n${f}`;
}

/** One-line free text as inline code, delimited by a backtick run longer than
 * any inside it, so an @mention or markdown in it renders inert. Whitespace
 * runs collapse to one space so the span cannot break across a blank line. */
function inlineCode(text) {
  const t = text.replace(/\s+/g, ' ');
  const longest = Math.max(0, ...(t.match(/`+/g) ?? []).map((r) => r.length));
  const d = '`'.repeat(longest + 1);
  const pad = t.startsWith('`') || t.endsWith('`') ? ' ' : '';
  return `${d}${pad}${t}${pad}${d}`;
}

/** The issue body. stamps: { version, head (null on an installed copy), host, project }. */
export function renderBody(report, stamps, { recursAfter } = {}) {
  const body = [
    `Component: ${inlineCode(report.component)}`,
    `Severity: ${report.severity}`,
    `Sterling version: ${stamps.version}${stamps.head ? ` (HEAD ${stamps.head})` : ''}`,
    `Host: ${stamps.host}`,
    `Project: ${stamps.project}`,
    '',
    '### Observed',
    fence(report.observed),
    '',
    '### Expected',
    fence(report.expected),
    '',
    '### Evidence',
    fence(report.evidence.join('\n')),
    '',
    labelsLine(labelsFor(report.severity, stamps.project)),
    fingerprintLine(fingerprint(report.component, report.title)),
  ].join('\n');
  return recursAfter ? withRecurrence(body, recursAfter) : body;
}

/** 'opencode' or 'claude-code', with scripts/rotation-note.mjs's precedence:
 * OPENCODE=1 with an id-shaped OPENCODE_SESSION_ID wins; otherwise OpenCode
 * only when CLAUDE_CODE_SESSION_ID is unset. */
export function detectHost(env) {
  const shape = /^[A-Za-z0-9_-]{1,128}$/;
  const claude = (env.CLAUDE_CODE_SESSION_ID ?? '').trim();
  const opencode = (env.OPENCODE_SESSION_ID ?? '').trim();
  const opencodeShell = env.OPENCODE === '1' && shape.test(opencode);
  return opencodeShell || (!claude && (opencode || env.OPENCODE === '1')) ? 'opencode' : 'claude-code';
}

/** The project name as a label-safe slug. */
export function projectSlug(name) {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return slug || 'unnamed';
}

export function labelsFor(severity, projectName) {
  return ['sterling-report', `severity:${severity.toLowerCase()}`, `project:${projectSlug(projectName)}`];
}
