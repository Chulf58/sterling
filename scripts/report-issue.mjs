// report-issue.mjs: file a scrubbed Sterling defect report as a GitHub issue on
// Chulf58/sterling (decision projects-file-sterling-issues-as-scrubbed-github-issues-automatically).
// Run from the project root of the project that hit the defect.
//
//   report-issue --title T --component C --severity BLOCKED|WORKAROUND|FRICTION \
//                --observed O --expected E --evidence L [--evidence L ...] [--dry-run]
//   report-issue --flush     send the reports queued in .sterling/pending-issue-reports.jsonl
//   report-issue --list      the open sterling-report issues (authoring-side intake)
//
// Default mode: validate and scrub (scripts/lib/issue-report.mjs), print the
// body, flush the queue, then search the repo for the report's fingerprint. An
// open match gets a comment; a closed match gets a new issue saying 'Recurs
// after #N'; no match gets a new issue. The body is printed again once sent.
//
// Transport is plain `gh api --hostname github.com` with a `gh --version` and
// `gh auth status` preflight, the scripts/lib/work-pr.mjs pattern. Never
// `gh issue create` (it needs a git binary gh can run, which Windows gh.exe on
// WSL lacks; finding work-mode-pr-create-fails-under-wsl-gh-exe-and-leaves-loop-unarmed-september-2026),
// never a REST token. When gh is missing, not logged in, or a call fails, the
// report is appended to the queue with one loud line naming the gh that ran.
//
// Exit codes: 0 sent (or dry run), 1 queued or a gh failure, 2 refused.
// Builtins only: bundled to bin/report-issue.mjs.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { pluginRoot } from './hooks/lib/plugin-root-walk.mjs';
import { isInstalledCopy } from './lib/installed-copy.mjs';
import { resolveStoreWritePath } from './lib/store-path.mjs';
import {
  ReportRefusal,
  STERLING_ISSUE_HOST,
  STERLING_ISSUE_REPO,
  detectHost,
  fingerprint,
  fingerprintLine,
  labelsFor,
  projectSlug,
  renderBody,
  validateReport,
  withRecurrence,
} from './lib/issue-report.mjs';

const QUEUE_NAME = 'pending-issue-reports.jsonl';

function refuse(message) {
  console.error(message);
  process.exit(2);
}

// ---------- arguments ----------

const VALUE_FLAGS = ['title', 'component', 'severity', 'observed', 'expected', 'evidence'];
const MODE_FLAGS = ['dry-run', 'flush', 'list'];

/** `--name value` and `--name=value`; --evidence repeats, every other flag is
 * refused when given twice, and an unknown flag is refused. */
function parseArgs(argv) {
  const values = { evidence: [] };
  const modes = new Set();
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    const m = tok.match(/^--([a-z-]+)(?:=([\s\S]*))?$/);
    if (!m) refuse(`report-issue: unexpected argument '${tok}'. Every value follows its flag, e.g. --title "<text>".`);
    const [, name, inline] = m;
    if (MODE_FLAGS.includes(name)) {
      if (inline !== undefined) refuse(`report-issue: --${name} takes no value.`);
      modes.add(name);
      continue;
    }
    if (!VALUE_FLAGS.includes(name)) refuse(`report-issue: unknown flag --${name}. Flags: ${[...VALUE_FLAGS, ...MODE_FLAGS].map((f) => `--${f}`).join(' ')}`);
    const value = inline ?? argv[++i];
    if (value === undefined) refuse(`report-issue: --${name} needs a value.`);
    if (name === 'evidence') values.evidence.push(value);
    else if (values[name] !== undefined) refuse(`report-issue: --${name} given more than once.`);
    else values[name] = value;
  }
  if (modes.size > 1) refuse(`report-issue: --${[...modes].join(' and --')} cannot be combined.`);
  const mode = [...modes][0] ?? 'file';
  const given = Object.keys(values).filter((k) => (k === 'evidence' ? values.evidence.length > 0 : true));
  if ((mode === 'flush' || mode === 'list') && given.length > 0) refuse(`report-issue: --${mode} takes no report fields (got --${given.join(', --')}).`);
  return { mode, values };
}

// ---------- gh ----------

/** The gh that PATH resolves to (the first hit), or null. Named in every
 * failure line, because on WSL it is often a Windows gh.exe. */
function resolveGhPath() {
  const names = process.platform === 'win32' ? ['gh.exe', 'gh.cmd', 'gh'] : ['gh', 'gh.exe'];
  for (const dir of String(process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

class TransportError extends Error {}

const oneLine = (r) => (r.stderr || r.stdout || String(r.error?.message ?? '') || `exit ${r.status}`).trim().replace(/\s*\n\s*/g, ' | ');

function makeGh() {
  const path = resolveGhPath();
  const run = (args) => spawnSync(path, args, { encoding: 'utf8', timeout: 120_000, env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
  return {
    path,
    /** null when gh can run and is logged in to github.com, else the reason. */
    preflight() {
      if (!path) return 'gh not found on PATH';
      const version = run(['--version']);
      if (version.error || version.status !== 0) return `gh at ${path} could not run (${oneLine(version)})`;
      const auth = run(['auth', 'status', '--hostname', STERLING_ISSUE_HOST]);
      if (auth.status !== 0) return `gh at ${path} is not logged in to ${STERLING_ISSUE_HOST} (${oneLine(auth)}); run: gh auth login --hostname ${STERLING_ISSUE_HOST}`;
      return null;
    },
    /** `gh api --hostname github.com --method <m> <path> -f k=v ...`, parsed JSON. */
    api(method, apiPath, fields = []) {
      const args = ['api', '--hostname', STERLING_ISSUE_HOST, '--method', method, apiPath, ...fields.flatMap(([k, v]) => ['-f', `${k}=${v}`])];
      const r = run(args);
      if (r.error || r.status !== 0) throw new TransportError(`gh at ${path}: ${method} ${apiPath} failed (${oneLine(r)})`);
      try {
        return JSON.parse(r.stdout);
      } catch (e) {
        throw new TransportError(`gh at ${path}: ${method} ${apiPath} returned unparseable JSON (${e.message})`);
      }
    },
  };
}

// ---------- project and stamps ----------

const projectRoot = process.cwd();
let sterlingDir;
let queuePath;
try {
  sterlingDir = resolveStoreWritePath(projectRoot, '.sterling');
  queuePath = resolveStoreWritePath(projectRoot, '.sterling', QUEUE_NAME);
} catch (e) {
  refuse(`report-issue: ${e.message}`);
}
if (!existsSync(sterlingDir)) refuse(`report-issue: ${projectRoot} is not a Sterling project (.sterling/ missing). Run it from the project root.`);

function projectName() {
  const configPath = join(sterlingDir, 'config.json');
  if (!existsSync(configPath)) return basename(projectRoot);
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (e) {
    refuse(`report-issue: cannot parse ${configPath} (${e.message}). Fix the file, then rerun.`);
  }
  return typeof config?.project_name === 'string' && config.project_name.trim() ? config.project_name : basename(projectRoot);
}

function stamps() {
  const root = pluginRoot(import.meta.url);
  if (!root) refuse('report-issue: cannot find the Sterling plugin root (.claude-plugin/plugin.json above this script), so the report cannot be stamped.');
  let version;
  try {
    version = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version;
  } catch (e) {
    refuse(`report-issue: cannot read the Sterling version from ${join(root, '.claude-plugin', 'plugin.json')} (${e.message}).`);
  }
  if (typeof version !== 'string' || !version) refuse(`report-issue: ${join(root, '.claude-plugin', 'plugin.json')} has no version.`);
  let head = null;
  if (!isInstalledCopy(root)) {
    const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
    head = r.status === 0 && r.stdout.trim() ? r.stdout.trim() : 'unknown (git rev-parse failed)';
  }
  return { root, version, head, host: detectHost(process.env), project: projectSlug(projectName()) };
}

// ---------- queue ----------

/** The queued entries; a malformed line refuses (exit 2) and leaves the file as it is. */
function readQueue() {
  if (!existsSync(queuePath)) return [];
  const lines = readFileSync(queuePath, 'utf8').split('\n');
  const entries = [];
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    let e;
    try {
      e = JSON.parse(line);
    } catch (err) {
      refuse(`report-issue: .sterling/${QUEUE_NAME} line ${i + 1} is not JSON (${err.message}). Fix or delete that line, then rerun.`);
    }
    const ok = e && typeof e.fingerprint === 'string' && typeof e.title === 'string' && typeof e.body === 'string' && Array.isArray(e.labels);
    if (!ok) refuse(`report-issue: .sterling/${QUEUE_NAME} line ${i + 1} lacks fingerprint/title/body/labels. Fix or delete that line, then rerun.`);
    entries.push(e);
  });
  return entries;
}

function writeQueue(entries) {
  if (entries.length === 0) {
    rmSync(queuePath, { force: true });
    return;
  }
  const tmp = resolveStoreWritePath(projectRoot, '.sterling', `${QUEUE_NAME}.tmp`);
  writeFileSync(tmp, entries.map((e) => `${JSON.stringify(e)}\n`).join(''));
  renameSync(tmp, queuePath);
}

function enqueue(entry, reason) {
  appendFileSync(queuePath, `${JSON.stringify(entry)}\n`);
  console.error(`report-issue: QUEUED, not filed: ${reason}. The report is in .sterling/${QUEUE_NAME} (${readQueue().length} pending); the next report or report-issue --flush sends it.`);
}

// ---------- send ----------

/** Search, then comment / file anew. Prints the body before and after. Throws TransportError. */
function send(gh, entry, { printBefore = true } = {}) {
  if (printBefore) console.log(`report-issue: sending to ${STERLING_ISSUE_REPO}:\n${entry.body}\n`);
  const q = `repo:${STERLING_ISSUE_REPO} is:issue "sterling-fp-${entry.fingerprint}" in:body`;
  const found = gh.api('GET', 'search/issues', [['q', q], ['per_page', '100']]);
  if (!Array.isArray(found?.items)) throw new TransportError(`gh at ${gh.path}: search/issues returned no items array`);
  const line = fingerprintLine(entry.fingerprint);
  const matches = found.items.filter((i) => !i?.pull_request && typeof i?.body === 'string' && i.body.split('\n').some((l) => l.trim() === line));
  for (const m of matches) {
    if (!Number.isInteger(m.number) || !['open', 'closed'].includes(m.state)) throw new TransportError(`gh at ${gh.path}: search/issues returned a malformed item ${JSON.stringify({ number: m.number, state: m.state })}`);
  }
  const open = matches.filter((m) => m.state === 'open').sort((a, b) => a.number - b.number);
  if (open.length) {
    const body = `Seen again.\n\n${entry.body}`;
    const c = gh.api('POST', `repos/${STERLING_ISSUE_REPO}/issues/${open[0].number}/comments`, [['body', body]]);
    if (typeof c?.html_url !== 'string') throw new TransportError(`gh at ${gh.path}: the comment call returned no html_url`);
    console.log(`report-issue: open issue #${open[0].number} has this fingerprint; commented: ${c.html_url}\n${body}`);
    return;
  }
  const closed = matches.sort((a, b) => b.number - a.number)[0];
  const body = closed ? withRecurrence(entry.body, closed.number) : entry.body;
  const fields = [['title', entry.title], ['body', body], ...entry.labels.map((l) => ['labels[]', l])];
  const issue = gh.api('POST', `repos/${STERLING_ISSUE_REPO}/issues`, fields);
  if (!Number.isInteger(issue?.number) || typeof issue?.html_url !== 'string') throw new TransportError(`gh at ${gh.path}: the create call returned no issue number/html_url`);
  console.log(`report-issue: filed #${issue.number}${closed ? ` (recurs after #${closed.number})` : ''}: ${issue.html_url}\n${body}`);
}

/** Send the queue in order; on the first failure keep it and the rest. Returns the failure or null. */
function flush(gh) {
  const pending = readQueue();
  for (let i = 0; i < pending.length; i++) {
    try {
      send(gh, pending[i]);
    } catch (e) {
      if (!(e instanceof TransportError)) throw e;
      writeQueue(pending.slice(i));
      return e.message;
    }
  }
  writeQueue([]);
  return null;
}

// ---------- modes ----------

const { mode, values } = parseArgs(process.argv.slice(2));

if (mode === 'list') {
  const gh = makeGh();
  const reason = gh.preflight();
  if (reason) {
    console.error(`report-issue: cannot list: ${reason}.`);
    process.exit(1);
  }
  let issues;
  try {
    issues = gh.api('GET', `repos/${STERLING_ISSUE_REPO}/issues`, [['labels', 'sterling-report'], ['state', 'open'], ['per_page', '100']]);
  } catch (e) {
    if (!(e instanceof TransportError)) throw e;
    console.error(`report-issue: cannot list: ${e.message}.`);
    process.exit(1);
  }
  if (!Array.isArray(issues)) {
    console.error(`report-issue: gh at ${gh.path}: the issue list was not an array.`);
    process.exit(1);
  }
  console.log(`report-issue: ${issues.length} open sterling-report issue(s) on ${STERLING_ISSUE_REPO}:`);
  for (const i of issues) console.log(`#${i.number} [${(i.labels ?? []).map((l) => l?.name ?? l).join(', ')}] ${i.title}  ${i.html_url}`);
  console.log(`report-issue: ${readQueue().length} report(s) pending locally in .sterling/${QUEUE_NAME}`);
  process.exit(0);
}

if (mode === 'flush') {
  const pending = readQueue();
  if (pending.length === 0) {
    console.log('report-issue: nothing pending.');
    process.exit(0);
  }
  const gh = makeGh();
  const reason = gh.preflight();
  if (reason) {
    console.error(`report-issue: NOT FLUSHED: ${reason}. ${pending.length} report(s) stay in .sterling/${QUEUE_NAME}.`);
    process.exit(1);
  }
  const failure = flush(gh);
  if (failure) {
    console.error(`report-issue: NOT FLUSHED: ${failure}. ${readQueue().length} report(s) stay in .sterling/${QUEUE_NAME}.`);
    process.exit(1);
  }
  console.log(`report-issue: flushed ${pending.length} report(s).`);
  process.exit(0);
}

const st = stamps();
let report;
try {
  report = validateReport(values, { projectRoot, home: homedir(), sterlingPathExists: (rel) => existsSync(join(st.root, rel)) });
} catch (e) {
  if (e instanceof ReportRefusal) refuse(e.message);
  throw e;
}
const entry = {
  v: 1,
  queued_at: new Date().toISOString(),
  fingerprint: fingerprint(report.component, report.title),
  title: report.title,
  labels: labelsFor(report.severity, st.project),
  body: renderBody(report, st),
};

if (mode === 'dry-run') {
  console.log(`report-issue: DRY RUN, nothing sent. Body:\n${entry.body}\n`);
  console.log(`report-issue: would file to ${STERLING_ISSUE_REPO}: title '${entry.title}', labels ${entry.labels.join(', ')}.`);
  console.log(`report-issue: it would search for sterling-fp-${entry.fingerprint}: an open match gets a comment, a closed match a new issue saying 'Recurs after #N', no match a new issue.`);
  process.exit(0);
}

readQueue();
console.log(`report-issue: report to file:\n${entry.body}\n`);
const gh = makeGh();
const reason = gh.preflight();
if (reason) {
  enqueue(entry, reason);
  process.exit(1);
}
const flushFailure = flush(gh);
if (flushFailure) {
  enqueue(entry, flushFailure);
  process.exit(1);
}
try {
  send(gh, entry, { printBefore: false });
} catch (e) {
  if (!(e instanceof TransportError)) throw e;
  enqueue(entry, e.message);
  process.exit(1);
}
