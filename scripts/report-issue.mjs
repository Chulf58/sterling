// report-issue.mjs: file a scrubbed Sterling defect report as a GitHub issue on
// Chulf58/sterling (decision projects-file-sterling-issues-as-scrubbed-github-issues-automatically).
// Run from the project root of the project that hit the defect.
//
//   report-issue --title T --component C --severity BLOCKED|WORKAROUND|FRICTION \
//                --observed O --expected E --evidence L [--evidence L ...] [--dry-run]
//   report-issue --flush     send the reports queued in .sterling/pending-issue-reports.jsonl
//   report-issue --list      the open reports, found by their fingerprint marker (authoring-side intake)
//   report-issue --apply-labels   a repo maintainer: create and set the labels each open report's Labels line names
//
// Default mode: validate and scrub (scripts/lib/issue-report.mjs), print the
// body, flush the queue, then search the repo for the report's fingerprint. An
// open match gets a comment; a closed match gets a new issue saying 'Recurs
// after #N'; no match gets a new issue. The body is printed again once sent.
//
// Labels: an account without write access to the repo can neither create nor set
// labels (GitHub refuses the create or drops them silently). So the body always
// carries a visible `Labels:` line; a create tries the labels first and, on a
// 4xx that is not an auth failure, is retried ONCE without them; a create that
// succeeds with labels missing says so. Reports are found by the fingerprint
// marker in the body, never by label. --apply-labels is the maintainer's way to
// turn the Labels lines into real labels.
//
// Transport is plain `gh api --hostname github.com` with a `gh --version` and
// `gh auth status` preflight, the scripts/lib/work-pr.mjs pattern. Never
// `gh issue create` (it needs a git binary gh can run, which Windows gh.exe on
// WSL lacks; finding work-mode-pr-create-fails-under-wsl-gh-exe-and-leaves-loop-unarmed-september-2026),
// never a REST token. When gh is missing, not logged in, or a call fails, the
// report is appended to the queue with one loud line naming the gh that ran.
//
// Every run that sends or queues holds .sterling/pending-issue-reports.jsonl.lock
// (an O_EXCL create) for its whole read-send-rewrite; a lock held by a live
// process refuses the run, and one left by a dead process is removed with a
// loud line. After each successful send the queue is re-read and only that
// entry is removed, so an append that lands meanwhile survives and a flush
// killed mid-run re-sends nothing it already sent.
//
// Exit codes: 0 sent (or dry run), 1 queued or a gh failure, 2 refused.
// Builtins only: bundled to bin/report-issue.mjs.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  parseLabelsLine,
  projectSlug,
  renderBody,
  scrub,
  validateReport,
  withLabelsLine,
  withRecurrence,
} from './lib/issue-report.mjs';

const QUEUE_NAME = 'pending-issue-reports.jsonl';
const LOCK_NAME = `${QUEUE_NAME}.lock`;

function refuse(message) {
  console.error(message);
  process.exit(2);
}

// ---------- arguments ----------

const VALUE_FLAGS = ['title', 'component', 'severity', 'observed', 'expected', 'evidence'];
const MODE_FLAGS = ['dry-run', 'flush', 'list', 'apply-labels'];

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
  if ((mode === 'flush' || mode === 'list' || mode === 'apply-labels') && given.length > 0) refuse(`report-issue: --${mode} takes no report fields (got --${given.join(', --')}).`);
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

/** A gh failure. `status` is the HTTP status gh printed ("... (HTTP 422)"), or null when there is none (gh missing, network down, bad JSON). */
class TransportError extends Error {
  constructor(message, status = null) {
    super(message);
    this.status = status;
  }
}

/** The HTTP status of a failed `gh api` call: gh prints "gh: <message> (HTTP 422)" on stderr and the response body on stdout. */
function httpStatus(r) {
  const m = `${r.stderr ?? ''}\n${r.stdout ?? ''}`.match(/\(HTTP (\d{3})\)/);
  if (m) return Number(m[1]);
  try {
    const n = Number(JSON.parse(r.stdout)?.status);
    return Number.isInteger(n) && n >= 100 && n <= 599 ? n : null;
  } catch {
    return null;
  }
}

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
      if (r.error || r.status !== 0) throw new TransportError(`gh at ${path}: ${method} ${apiPath} failed (${oneLine(r)})`, r.error ? null : httpStatus(r));
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

/** Whether `pid` names a running process (EPERM: it runs as another user). */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** A holder writes its pid right after the O_EXCL create, so a lock with no
 * readable pid is taken as held unless it is older than this. */
const UNREADABLE_LOCK_STALE_MS = 60_000;

/** Take the queue lock for the rest of this process (released on exit), or
 * refuse (exit 2) while another live run holds it. A lock whose pid is not
 * running is removed with a loud line and taken. Two runs that find the same
 * stale lock at the same instant can both remove it; the window is the gap
 * between one run's removal and its create. */
function acquireQueueLock() {
  const lockPath = resolveStoreWritePath(projectRoot, '.sterling', LOCK_NAME);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' });
      process.on('exit', () => rmSync(lockPath, { force: true }));
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let holder = null;
    try {
      holder = JSON.parse(readFileSync(lockPath, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      if (!(e instanceof SyntaxError)) throw e;
    }
    const pid = Number.isInteger(holder?.pid) && holder.pid > 0 ? holder.pid : null;
    let stale;
    if (pid !== null) stale = !pidAlive(pid);
    else {
      try {
        stale = Date.now() - statSync(lockPath).mtimeMs > UNREADABLE_LOCK_STALE_MS;
      } catch (e) {
        if (e.code === 'ENOENT') continue;
        throw e;
      }
    }
    if (!stale) {
      refuse(
        `report-issue: .sterling/${LOCK_NAME} is held by ${pid !== null ? `pid ${pid}` : 'a run whose pid is not yet written'}, another report-issue sending or queueing reports. ` +
          `Nothing was sent or queued. Rerun once it finishes; if no report-issue is running, delete ${lockPath}.`
      );
    }
    rmSync(lockPath, { force: true });
    console.error(`report-issue: removed a stale lock .sterling/${LOCK_NAME} (${pid !== null ? `pid ${pid} is not running` : 'no pid, older than 60s'}); a previous run was killed mid-flush.`);
  }
  refuse(`report-issue: could not take .sterling/${LOCK_NAME} after removing a stale one; another run took it first. Rerun.`);
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

/** A 4xx an unlabelled create might get past: 403 and 404 for an account that may not set labels, 422 for labels that do not
 * exist. 401 is an auth failure and 408 and 429 are timing; none of those is retried unlabelled. */
const labelRefusal = (status) => Number.isInteger(status) && status >= 400 && status < 500 && ![401, 408, 429].includes(status);

/** Create the issue with its labels; when GitHub rejects that with such a client
 * error, retry ONCE without them. A rejected create made no issue, so the retry
 * cannot post twice. Any other failure (5xx, network, auth) propagates. */
function createIssue(gh, entry, body) {
  const createPath = `repos/${STERLING_ISSUE_REPO}/issues`;
  const plain = [['title', entry.title], ['body', body]];
  try {
    return gh.api('POST', createPath, [...plain, ...entry.labels.map((l) => ['labels[]', l])]);
  } catch (e) {
    if (!(e instanceof TransportError) || !labelRefusal(e.status) || entry.labels.length === 0) throw e;
    console.error(`report-issue: GitHub refused the create with labels (HTTP ${e.status}); retrying once without them.`);
    try {
      return gh.api('POST', createPath, plain);
    } catch (retry) {
      if (!(retry instanceof TransportError)) throw retry;
      throw new TransportError(`${retry.message}; the create with labels had been refused first (HTTP ${e.status})`, retry.status);
    }
  }
}

/** Search, then comment / file anew. Prints the body before and after. Throws TransportError. */
function send(gh, queued, { printBefore = true } = {}) {
  // A queued report written before the Labels line existed gets it now; its fingerprint is unchanged.
  const entry = { ...queued, body: withLabelsLine(queued.body, queued.labels, queued.fingerprint) };
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
  const issue = createIssue(gh, entry, body);
  if (!Number.isInteger(issue?.number) || typeof issue?.html_url !== 'string') throw new TransportError(`gh at ${gh.path}: the create call returned no issue number/html_url`);
  console.log(`report-issue: filed #${issue.number}${closed ? ` (recurs after #${closed.number})` : ''}: ${issue.html_url}\n${body}`);
  // Without write access GitHub drops the labels and still creates the issue: the response says which it kept.
  if (entry.labels.length > 0 && Array.isArray(issue.labels)) {
    const kept = new Set(issue.labels.map((l) => String(l?.name ?? l).toLowerCase()));
    if (!entry.labels.every((l) => kept.has(l.toLowerCase()))) {
      console.log(`report-issue: filed without labels: GitHub did not accept the labels (${entry.labels.join(', ')}); they are in the issue body as the Labels line. A maintainer can apply them with report-issue --apply-labels.`);
    }
  }
}

/** Drop the first queued entry equal to `sent` from the queue as it is NOW,
 * keeping anything appended since the flush read it. */
function removeSent(sent) {
  const key = JSON.stringify(sent);
  const current = readQueue();
  const i = current.findIndex((e) => JSON.stringify(e) === key);
  if (i >= 0) current.splice(i, 1);
  writeQueue(current);
}

/** Send the queue in order, removing each entry once it is sent; on the first
 * failure the entry and the rest stay queued. Caller holds the queue lock.
 * Returns the failure or null. */
function flush(gh) {
  for (const entry of readQueue()) {
    try {
      send(gh, entry);
    } catch (e) {
      if (!(e instanceof TransportError)) throw e;
      return e.message;
    }
    removeSent(entry);
  }
  return null;
}

// ---------- modes ----------

const { mode, values } = parseArgs(process.argv.slice(2));

const FINGERPRINT_LINE_RE = /^Fingerprint: sterling-fp-[0-9a-f]{12}$/m;

/** The open reports on the repo, found by the fingerprint marker in the body and
 * not by label (an account that cannot set labels files reports with none). The
 * search is a loose match on the marker text; the Fingerprint line is checked
 * here, so an issue that only mentions a fingerprint is left out. Throws TransportError. */
function openReports(gh) {
  const found = gh.api('GET', 'search/issues', [['q', `repo:${STERLING_ISSUE_REPO} is:issue is:open "sterling-fp-" in:body`], ['per_page', '100']]);
  if (!Array.isArray(found?.items)) throw new TransportError(`gh at ${gh.path}: search/issues returned no items array`);
  const reports = found.items.filter((i) => !i?.pull_request && Number.isInteger(i?.number) && typeof i?.body === 'string' && FINGERPRINT_LINE_RE.test(i.body.replace(/\r/g, '')));
  return { reports: reports.sort((a, b) => a.number - b.number), more: found.total_count > found.items.length };
}

const labelNames = (issue) => (issue.labels ?? []).map((l) => String(l?.name ?? l));

if (mode === 'list') {
  const gh = makeGh();
  const reason = gh.preflight();
  if (reason) {
    console.error(`report-issue: cannot list: ${reason}.`);
    process.exit(1);
  }
  let found;
  try {
    found = openReports(gh);
  } catch (e) {
    if (!(e instanceof TransportError)) throw e;
    console.error(`report-issue: cannot list: ${e.message}.`);
    process.exit(1);
  }
  console.log(`report-issue: ${found.reports.length} open sterling-report issue(s) on ${STERLING_ISSUE_REPO}:`);
  for (const i of found.reports) {
    const real = labelNames(i);
    const inBody = real.length === 0 ? parseLabelsLine(i.body) : null;
    const shown = real.length > 0 ? real.join(', ') : inBody?.length ? `labels in body, not applied: ${inBody.join(', ')}` : 'no labels';
    console.log(`#${i.number} [${shown}] ${i.title}  ${i.html_url}`);
  }
  if (found.more) console.log('report-issue: the search returned more than one page; only the first 100 are shown.');
  console.log(`report-issue: ${readQueue().length} report(s) pending locally in .sterling/${QUEUE_NAME}`);
  process.exit(0);
}

const LABEL_COLORS = { 'sterling-report': '5319e7', 'severity:blocked': 'd73a4a', 'severity:workaround': 'fbca04', 'severity:friction': 'c5def5' };

/** Whether this status means the account may not change labels on the repo. */
const noPermission = (status) => [401, 403, 404].includes(status);

if (mode === 'apply-labels') {
  const gh = makeGh();
  const reason = gh.preflight();
  if (reason) {
    console.error(`report-issue: cannot apply labels: ${reason}.`);
    process.exit(1);
  }
  const repoLabels = `repos/${STERLING_ISSUE_REPO}/labels`;
  const known = new Set();
  const attempt = (what, fn) => {
    try {
      return fn();
    } catch (e) {
      if (!(e instanceof TransportError)) throw e;
      if (noPermission(e.status)) {
        refuse(
          `report-issue: --apply-labels refused: GitHub answered HTTP ${e.status} when ${what}. This account cannot change labels on ${STERLING_ISSUE_REPO}. A maintainer of the repo must run report-issue --apply-labels. Nothing in any issue body was edited.`
        );
      }
      console.error(`report-issue: --apply-labels failed ${what}: ${e.message}.`);
      process.exit(1);
    }
  };
  const labelExists = (name) => {
    if (known.has(name)) return true;
    try {
      gh.api('GET', `${repoLabels}/${encodeURIComponent(name)}`);
    } catch (e) {
      if (e instanceof TransportError && e.status === 404) return false;
      throw e;
    }
    known.add(name);
    return true;
  };
  const found = attempt('listing the reports', () => openReports(gh));
  let applied = 0;
  for (const issue of found.reports) {
    const wanted = parseLabelsLine(issue.body) ?? [];
    const have = new Set(labelNames(issue).map((l) => l.toLowerCase()));
    const missing = wanted.filter((l) => !have.has(l.toLowerCase()));
    if (missing.length === 0) continue;
    for (const name of missing) {
      if (attempt(`checking label '${name}'`, () => labelExists(name))) continue;
      attempt(`creating label '${name}'`, () => gh.api('POST', repoLabels, [['name', name], ['color', LABEL_COLORS[name] ?? 'ededed']]));
      known.add(name);
      console.log(`report-issue: created label '${name}'.`);
    }
    attempt(`setting labels on #${issue.number}`, () => gh.api('POST', `repos/${STERLING_ISSUE_REPO}/issues/${issue.number}/labels`, missing.map((l) => ['labels[]', l])));
    console.log(`report-issue: #${issue.number}: set ${missing.join(', ')}.`);
    applied++;
  }
  if (found.more) console.log('report-issue: the search returned more than one page; only the first 100 were handled. Run it again after labelling.');
  console.log(`report-issue: labels applied to ${applied} of ${found.reports.length} open report(s).`);
  process.exit(0);
}

if (mode === 'flush') {
  acquireQueueLock();
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
const scrubCtx = { projectRoot, home: homedir(), sterlingPathExists: (rel) => existsSync(join(st.root, rel)) };
let report;
try {
  report = validateReport(values, scrubCtx);
} catch (e) {
  if (e instanceof ReportRefusal) refuse(e.message);
  throw e;
}
// The project name feeds the Project and Labels lines, so it takes the same scrub as the report fields.
const stamped = { ...st, project: scrub(st.project, scrubCtx) };
const entry = {
  v: 1,
  queued_at: new Date().toISOString(),
  fingerprint: fingerprint(report.component, report.title),
  title: report.title,
  labels: labelsFor(report.severity, stamped.project),
  body: renderBody(report, stamped),
};

if (mode === 'dry-run') {
  console.log(`report-issue: DRY RUN, nothing sent. Body:\n${entry.body}\n`);
  console.log(`report-issue: would file to ${STERLING_ISSUE_REPO}: title '${entry.title}', labels ${entry.labels.join(', ')} (retried once without them if GitHub refuses them; they are also in the body).`);
  console.log(`report-issue: it would search for sterling-fp-${entry.fingerprint}: an open match gets a comment, a closed match a new issue saying 'Recurs after #N', no match a new issue.`);
  process.exit(0);
}

acquireQueueLock();
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
