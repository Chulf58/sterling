// report-issue: the scrubbed Sterling defect report filed as a GitHub issue on
// Chulf58/sterling (decision projects-file-sterling-issues-as-scrubbed-github-issues-automatically).
// The pure lib (validate, scrub, normalize, fingerprint, render) is tested in
// process; the CLI is spawned with a fake `gh` first on PATH, so no test touches
// the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAPS,
  ReportRefusal,
  STERLING_ISSUE_REPO,
  detectHost,
  fingerprint,
  labelsFor,
  normalizeTitle,
  parseLabelsLine,
  withLabelsLine,
  renderBody,
  scrub,
  validateReport,
} from '../lib/issue-report.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = join(root, 'scripts', 'report-issue.mjs');
const sterlingPathExists = (rel) => existsSync(join(root, rel));

const ctx = { projectRoot: '/home/alice/work/acme-secret', home: '/home/alice', sterlingPathExists };

const good = () => ({
  title: 'H19 delivery cap drops the owning article',
  component: 'H19',
  severity: 'FRICTION',
  observed: 'The article was held back.',
  expected: 'The article is delivered.',
  evidence: ['scripts/lib/work-pr.mjs:99', '"bundle freshness: stale"'],
});

const refusal = (fn, pattern) => assert.throws(fn, (e) => e instanceof ReportRefusal && pattern.test(e.message));

// ---------- scrub ----------

test('scrub: the project root, with any path below it, becomes <project-path>', () => {
  assert.equal(scrub('failed in /home/alice/work/acme-secret/src/billing.ts today', ctx), 'failed in <project-path> today');
  assert.equal(scrub('cwd=/home/alice/work/acme-secret', ctx), 'cwd=<project-path>');
  assert.equal(scrub('in /home/alice/work/acme-secret-other/x', ctx), 'in <project-path>', 'a sibling dir sharing the prefix is not read as the root');
  const wsl = { ...ctx, projectRoot: '/mnt/c/Users/alice/acme' };
  assert.equal(scrub('saw C:\\Users\\alice\\acme\\a.ts and c:/Users/alice/acme', wsl), 'saw <project-path> and <project-path>');
});

test('scrub: the home dir becomes <project-path>', () => {
  assert.equal(scrub('see /home/alice/.config/thing for it', ctx), 'see <project-path> for it');
});

test('scrub: a root with a space in it is replaced whole, not split into tokens', () => {
  const spaced = { ...ctx, projectRoot: '/mnt/c/Users/Jo Doe/My App' };
  assert.equal(scrub('read /mnt/c/Users/Jo Doe/My App/src/x.ts failed', spaced), 'read <project-path> failed');
});

test('scrub: an absolute POSIX path becomes <project-path>', () => {
  assert.equal(scrub('ENOENT: /var/lib/acme/db.sqlite (open)', ctx), 'ENOENT: <project-path> (open)');
});

test('scrub: a Windows path becomes <project-path>', () => {
  assert.equal(scrub('at C:\\Users\\alice\\acme\\index.js:4', ctx), 'at <project-path>');
  assert.equal(scrub('share \\\\server\\acme\\x', ctx), 'share <project-path>');
});

test('scrub: a non-Sterling relative path token becomes <project-path>', () => {
  assert.equal(scrub('touched src/billing/invoice.ts and lib/x', ctx), 'touched <project-path> and <project-path>');
  assert.equal(scrub('a URL https://acme.example/repo/x leaks too', ctx), 'a URL <project-path> leaks too');
});

test('scrub: a Sterling repo-relative path is kept; one under a Sterling prefix that Sterling does not ship is not', () => {
  assert.equal(scrub('see scripts/lib/work-pr.mjs:99 and .sterling/config.json', ctx), 'see scripts/lib/work-pr.mjs:99 and .sterling/config.json');
  assert.equal(scrub('see scripts/deploy-acme-prod.sh:3', ctx), 'see <project-path>');
  assert.equal(scrub('see scripts/../../etc/passwd', ctx), 'see <project-path>');
});

test('scrub: only the fixed set of Sterling-owned .sterling/ names is kept; any other .sterling/ path becomes <project-path>', () => {
  assert.equal(scrub('see .sterling/domains/acme-client-secret/notes.md', ctx), 'see <project-path>');
  assert.equal(scrub('wrote .sterling/acme-billing-export.json', ctx), 'wrote <project-path>');
  assert.equal(scrub('in .sterling/transient/acme-secret.json', ctx), 'in <project-path>');
  assert.equal(
    scrub('read .sterling/sterling.db, .sterling/pending-issue-reports.jsonl:3 and .sterling/plan-lock.json', ctx),
    'read .sterling/sterling.db, .sterling/pending-issue-reports.jsonl:3 and .sterling/plan-lock.json'
  );
  assert.equal(scrub('under .sterling/transient/ only', ctx), 'under .sterling/transient/ only');
});

test('scrub: a path with spaces outside the project root and home is NOT fully scrubbed (documented limit: the words between its spaces stay)', () => {
  assert.equal(scrub('read /mnt/d/Acme Client Billing/src/x.ts failed', ctx), 'read <project-path> Client <project-path> failed');
});

test('scrub: a UUID becomes <id>', () => {
  assert.equal(scrub('record 630e54e6-8c61-4b73-beee-de569a5ec852 missing', ctx), 'record <id> missing');
});

// ---------- validate (refusals) ----------

test('validate: a well-formed report passes and comes back scrubbed', () => {
  const r = validateReport({ ...good(), observed: 'It failed at /home/alice/work/acme-secret/a.ts' }, ctx);
  assert.equal(r.observed, 'It failed at <project-path>');
  assert.deepEqual(r.evidence, ['scripts/lib/work-pr.mjs:99', '"bundle freshness: stale"']);
  assert.equal(r.severity, 'FRICTION');
});

for (const field of ['title', 'component', 'severity', 'observed', 'expected']) {
  test(`validate: a missing --${field} is refused naming the flag`, () => {
    refusal(() => validateReport({ ...good(), [field]: undefined }, ctx), new RegExp(`--${field}`));
    refusal(() => validateReport({ ...good(), [field]: '   ' }, ctx), new RegExp(`--${field}`));
  });
}

test('validate: no evidence line is refused', () => {
  refusal(() => validateReport({ ...good(), evidence: [] }, ctx), /--evidence/);
});

test('validate: a severity outside the three bands is refused naming them', () => {
  refusal(() => validateReport({ ...good(), severity: 'CRITICAL' }, ctx), /BLOCKED\|WORKAROUND\|FRICTION/);
});

for (const [field, cap] of [['title', CAPS.title], ['component', CAPS.component], ['observed', CAPS.observed], ['expected', CAPS.expected]]) {
  test(`validate: --${field} over ${cap} chars is refused`, () => {
    validateReport({ ...good(), [field]: 'a'.repeat(cap) }, ctx);
    refusal(() => validateReport({ ...good(), [field]: 'a'.repeat(cap + 1) }, ctx), new RegExp(`--${field}.*${cap}`));
  });
}

test('validate: an evidence line over the cap, and more lines than the cap, are refused', () => {
  refusal(() => validateReport({ ...good(), evidence: [`"${'x'.repeat(CAPS.evidenceLine)}"`] }, ctx), new RegExp(`${CAPS.evidenceLine}`));
  const many = Array.from({ length: CAPS.evidenceLines + 1 }, () => 'scripts/lib/work-pr.mjs:1');
  refusal(() => validateReport({ ...good(), evidence: many }, ctx), new RegExp(`${CAPS.evidenceLines}`));
});

test('validate: a bad evidence line is refused and named', () => {
  for (const bad of ['src/billing.ts:12', '/home/alice/work/acme-secret/x.ts:3', 'the hook crashed', 'scripts/lib/work-pr.mjs', 'scripts/not-shipped.mjs:4', 'scripts/../x.mjs:1']) {
    refusal(() => validateReport({ ...good(), evidence: [bad] }, ctx), new RegExp(`evidence line 1.*${bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  }
  validateReport({ ...good(), evidence: ['scripts/lib/work-pr.mjs:99-109'] }, ctx);
});

test('validate: a quoted evidence message is scrubbed', () => {
  const r = validateReport({ ...good(), evidence: ['"cannot read /home/alice/work/acme-secret/.env"'] }, ctx);
  assert.deepEqual(r.evidence, ['"cannot read <project-path>"']);
});

// ---------- fingerprint ----------

test('fingerprint: 12 hex, stable across digits, hex ids, UUIDs and paths in the title', () => {
  const fp = fingerprint('H19', 'cap drops 3 articles for 630e54e6-8c61-4b73-beee-de569a5ec852 in scripts/a.mjs');
  assert.match(fp, /^[0-9a-f]{12}$/);
  assert.equal(fingerprint('H19', 'cap drops 17 articles for 0be50399-9e99-4236-80ed-0dfc68215ce4 in <project-path>'), fp);
  assert.equal(fingerprint(' h19 ', 'Cap  drops 5 articles for <id> in scripts/b/c.mjs'), fp);
  assert.equal(normalizeTitle('build 0a4665c failed at line 12'), normalizeTitle('build a0a3212 failed at line 400'));
  assert.notEqual(fingerprint('H10', 'cap drops 3 articles for <id> in <project-path>'), fp);
  assert.notEqual(fingerprint('H19', 'cap keeps 3 articles for <id> in <project-path>'), fp);
});

// ---------- render, host, labels ----------

test('render: stamps, fenced free text, and the visible fingerprint line', () => {
  const r = validateReport({ ...good(), observed: 'ping @someone ```x```' }, ctx);
  const body = renderBody(r, { version: '0.18.54', head: 'cc0d9c3', host: 'claude-code', project: 'acme' });
  assert.match(body, /Sterling version: 0\.18\.54 \(HEAD cc0d9c3\)/);
  assert.match(body, /Host: claude-code/);
  assert.match(body, /Project: acme/);
  assert.match(body, /\n````text\nping @someone ```x```\n````\n/, 'free text is fenced longer than any backtick run inside it');
  assert.match(body, new RegExp(`\\nFingerprint: sterling-fp-${fingerprint(r.component, r.title)}$`));
  const installed = renderBody(r, { version: '0.18.54', head: null, host: 'opencode', project: 'acme' });
  assert.match(installed, /Sterling version: 0\.18\.54\n/);
  assert.match(renderBody(r, { version: '1', head: null, host: 'claude-code', project: 'a' }, { recursAfter: 41 }), /^Recurs after #41\./);
});

test('render: the Component line is inline code, so an @mention or markdown in it renders inert', () => {
  const stamp = { version: '1', head: null, host: 'claude-code', project: 'a' };
  const body = renderBody(validateReport({ ...good(), component: 'H19 @someone [x](https://e.x)' }, ctx), stamp);
  assert.match(body, /^Component: `H19 @someone \[x\]\(<project-path>\)`$/m);
  assert.match(renderBody(validateReport({ ...good(), component: 'a `b` c' }, ctx), stamp), /^Component: ``a `b` c``$/m, 'the delimiter outruns any backtick run inside');
  assert.match(renderBody(validateReport({ ...good(), component: '`edge`' }, ctx), stamp), /^Component: `` `edge` ``$/m, 'a leading or trailing backtick is padded');
  assert.match(renderBody(validateReport({ ...good(), component: 'two\nlines' }, ctx), stamp), /^Component: `two lines`$/m, 'whitespace runs collapse so the span stays on one line');
});

test('detectHost: OPENCODE env decides, as rotation-note does', () => {
  assert.equal(detectHost({}), 'claude-code');
  assert.equal(detectHost({ OPENCODE: '1' }), 'opencode');
  assert.equal(detectHost({ OPENCODE: '1', OPENCODE_SESSION_ID: 'ses_1', CLAUDE_CODE_SESSION_ID: 'abc' }), 'opencode');
  assert.equal(detectHost({ OPENCODE_SESSION_ID: 'ses_1', CLAUDE_CODE_SESSION_ID: 'abc' }), 'claude-code');
});

test('labels: sterling-report, severity band and a sanitized project name', () => {
  assert.deepEqual(labelsFor('BLOCKED', 'Acme Secret/App'), ['sterling-report', 'severity:blocked', 'project:acme-secret-app']);
  assert.equal(STERLING_ISSUE_REPO, 'Chulf58/sterling');
});

// ---------- CLI ----------

// The fake gh. State dir files:
//   log.jsonl   one JSON argv array per invocation
//   issues.json [{number, state, title, body, labels, comments: [body]}]
//   auth_fail   present => `gh auth status` exits 1
//   api_fail    present => every `gh api` call exits 1
//   fail_create_after  N => issue creates after the Nth exit 1
//   append_on_create   one JSON line, appended to $FAKE_GH_QUEUE after the next create (then deleted):
//                      a concurrent report landing while a flush is mid-send
//   kill_on_search     N => the Nth search SIGKILLs report-issue (the gh's parent): a flush killed mid-run
//   labels_refused     N => a create that carries labels[] exits 1 with 'gh: ... (HTTP N)'; one without labels succeeds
//   create_refused     N => every create exits 1 with 'gh: ... (HTTP N)'
//   drop_labels        present => a create succeeds but GitHub drops the labels (the issue and the response carry none)
//   labels.json        [name] the labels that exist in the repo
//   label_write_refused N => creating a label or setting labels on an issue exits 1 with 'gh: ... (HTTP N)'
const FAKE_GH_IMPL = `
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const state = process.env.FAKE_GH_STATE;
const argv = process.argv.slice(2);
appendFileSync(join(state, 'log.jsonl'), JSON.stringify(argv) + '\\n');
const file = join(state, 'issues.json');
const issues = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const fields = {};
argv.forEach((x, i) => { if (x === '-f' || x === '-F') { const kv = argv[i + 1]; const k = kv.indexOf('='); (fields[kv.slice(0, k)] ??= []).push(kv.slice(k + 1)); } });
const one = (k) => (fields[k] ?? [])[0];
const [a, b] = argv;
if (a === '--version') { console.log('gh version 9.9.9 (fake)'); process.exit(0); }
if (a === 'auth' && b === 'status') {
  if (existsSync(join(state, 'auth_fail'))) { console.error('You are not logged into any GitHub hosts.'); process.exit(1); }
  console.error('Logged in to github.com as fake'); process.exit(0);
}
if (a !== 'api' || flag('--hostname') !== 'github.com') { console.error('fake gh: unhandled ' + JSON.stringify(argv)); process.exit(3); }
if (existsSync(join(state, 'api_fail'))) { console.error('error connecting to api.github.com'); process.exit(1); }
const method = flag('--method') ?? 'GET';
const path = argv.find((x) => /^(repos|search)\\//.test(x));
const url = (n) => 'https://github.com/Chulf58/sterling/issues/' + n;
const bump = (name) => { const f = join(state, name); const n = (existsSync(f) ? Number(readFileSync(f, 'utf8')) : 0) + 1; writeFileSync(f, String(n)); return n; };
if (method === 'GET' && path === 'search/issues') {
  const searches = bump('search_count');
  if (existsSync(join(state, 'kill_on_search')) && searches === Number(readFileSync(join(state, 'kill_on_search'), 'utf8'))) { process.kill(process.ppid, 'SIGKILL'); process.exit(1); }
  const q = one('q');
  if (!/repo:Chulf58\\/sterling/.test(q)) { console.error('fake gh: bad search ' + q); process.exit(3); }
  const fp = (q.match(/sterling-fp-[0-9a-f]{12}/) ?? [])[0];
  if (!fp && !q.includes('"sterling-fp-"')) { console.error('fake gh: bad search ' + q); process.exit(3); }
  const items = issues
    .filter((i) => i.body.includes(fp ?? 'sterling-fp-') && (!/\\bis:open\\b/.test(q) || i.state === 'open'))
    .map((i) => ({ number: i.number, state: i.state, title: i.title, html_url: url(i.number), body: i.body, labels: i.labels.map((name) => ({ name })) }));
  console.log(JSON.stringify({ total_count: items.length, items })); process.exit(0);
}
if (method === 'GET' && path === 'repos/Chulf58/sterling/issues') {
  const hits = issues.filter((i) => i.state === one('state') && i.labels.includes(one('labels')));
  console.log(JSON.stringify(hits.map((i) => ({ number: i.number, title: i.title, html_url: url(i.number), labels: i.labels.map((name) => ({ name })) })))); process.exit(0);
}
const refuse = (status) => { console.log(JSON.stringify({ message: 'refused', status: String(status) })); console.error('gh: refused (HTTP ' + status + ')'); process.exit(1); };
const labelsFile = join(state, 'labels.json');
const known = () => (existsSync(labelsFile) ? JSON.parse(readFileSync(labelsFile, 'utf8')) : []);
if (method === 'POST' && path === 'repos/Chulf58/sterling/issues') {
  if (existsSync(join(state, 'fail_create_after')) && issues.length >= Number(readFileSync(join(state, 'fail_create_after'), 'utf8'))) { console.error('HTTP 502: Bad Gateway'); process.exit(1); }
  if (existsSync(join(state, 'create_refused'))) refuse(readFileSync(join(state, 'create_refused'), 'utf8'));
  if (existsSync(join(state, 'labels_refused')) && fields['labels[]']) refuse(readFileSync(join(state, 'labels_refused'), 'utf8'));
  const number = 100 + issues.length;
  const labels = existsSync(join(state, 'drop_labels')) ? [] : fields['labels[]'] ?? [];
  issues.push({ number, state: 'open', title: one('title'), body: one('body'), labels, comments: [] });
  writeFileSync(file, JSON.stringify(issues));
  const append = join(state, 'append_on_create');
  if (existsSync(append)) { appendFileSync(process.env.FAKE_GH_QUEUE, readFileSync(append, 'utf8')); rmSync(append); }
  console.log(JSON.stringify({ number, html_url: url(number), labels: labels.map((name) => ({ name })) })); process.exit(0);
}
const lab = (path ?? '').match(/^repos\\/Chulf58\\/sterling\\/labels\\/(.+)$/);
if (method === 'GET' && lab) {
  const name = decodeURIComponent(lab[1]);
  if (!known().includes(name)) { console.log(JSON.stringify({ message: 'Not Found', status: '404' })); console.error('gh: Not Found (HTTP 404)'); process.exit(1); }
  console.log(JSON.stringify({ name })); process.exit(0);
}
if (method === 'POST' && path === 'repos/Chulf58/sterling/labels') {
  if (existsSync(join(state, 'label_write_refused'))) refuse(readFileSync(join(state, 'label_write_refused'), 'utf8'));
  writeFileSync(labelsFile, JSON.stringify([...known(), one('name')]));
  console.log(JSON.stringify({ name: one('name') })); process.exit(0);
}
const setl = method === 'POST' && (path ?? '').match(/^repos\\/Chulf58\\/sterling\\/issues\\/(\\d+)\\/labels$/);
if (setl) {
  if (existsSync(join(state, 'label_write_refused'))) refuse(readFileSync(join(state, 'label_write_refused'), 'utf8'));
  const issue = issues.find((i) => i.number === Number(setl[1]));
  for (const l of fields['labels[]'] ?? []) if (!known().includes(l)) { console.log(JSON.stringify({ message: 'Validation Failed', status: '422' })); console.error('gh: Validation Failed (HTTP 422)'); process.exit(1); }
  issue.labels = [...new Set([...issue.labels, ...(fields['labels[]'] ?? [])])];
  writeFileSync(file, JSON.stringify(issues));
  console.log(JSON.stringify(issue.labels.map((name) => ({ name })))); process.exit(0);
}
const m = method === 'POST' && (path ?? '').match(/^repos\\/Chulf58\\/sterling\\/issues\\/(\\d+)\\/comments$/);
if (m) {
  const issue = issues.find((i) => i.number === Number(m[1]));
  issue.comments.push(one('body'));
  writeFileSync(file, JSON.stringify(issues));
  console.log(JSON.stringify({ id: 1, html_url: url(issue.number) + '#issuecomment-1' })); process.exit(0);
}
console.error('fake gh: unhandled api ' + JSON.stringify(argv)); process.exit(3);
`;

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'sterling-report-issue-'));
  const home = join(base, 'home');
  const project = join(home, 'acme-secret');
  mkdirSync(join(project, '.sterling'), { recursive: true });
  writeFileSync(join(project, '.sterling', 'config.json'), JSON.stringify({ project_name: 'acme' }));
  const bin = join(base, 'fakebin');
  const state = join(base, 'ghstate');
  mkdirSync(bin);
  mkdirSync(state);
  const impl = join(base, 'fake-gh.mjs');
  writeFileSync(impl, FAKE_GH_IMPL);
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nexec "${process.execPath}" "${impl}" "$@"\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const queue = join(project, '.sterling', 'pending-issue-reports.jsonl');
  return { base, home, project, bin, state, queue, lock: `${queue}.lock` };
}

function run(p, args, { path } = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: p.project,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, HOME: p.home, PATH: path ?? `${p.bin}${delimiter}${process.env.PATH}`, FAKE_GH_STATE: p.state, FAKE_GH_QUEUE: p.queue, OPENCODE: '', OPENCODE_SESSION_ID: '' },
  });
}

const reportArgs = (over = {}) => {
  const r = { ...good(), ...over };
  return ['--title', r.title, '--component', r.component, '--severity', r.severity, '--observed', r.observed, '--expected', r.expected, ...r.evidence.flatMap((e) => ['--evidence', e])];
};

const ghLog = (p) => (existsSync(join(p.state, 'log.jsonl')) ? readFileSync(join(p.state, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const issues = (p) => (existsSync(join(p.state, 'issues.json')) ? JSON.parse(readFileSync(join(p.state, 'issues.json'), 'utf8')) : []);
const queued = (p) => (existsSync(p.queue) ? readFileSync(p.queue, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const seed = (p, list) => writeFileSync(join(p.state, 'issues.json'), JSON.stringify(list));

function withSetup(fn) {
  const p = setup();
  try {
    fn(p);
  } finally {
    rmSync(p.base, { recursive: true, force: true });
  }
}

test('cli --dry-run: prints the scrubbed body and the plan, calls no gh, queues nothing', () =>
  withSetup((p) => {
    const r = run(p, ['--dry-run', ...reportArgs({ observed: `failed reading ${p.project}/src/a.ts` })]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /failed reading <project-path>/);
    assert.ok(!r.stdout.includes(p.project) && !r.stdout.includes(p.home));
    assert.match(r.stdout, /Fingerprint: sterling-fp-[0-9a-f]{12}/);
    assert.match(r.stdout, /Project: acme/);
    assert.match(r.stdout, /project:acme/);
    assert.deepEqual(ghLog(p), []);
    assert.ok(!existsSync(p.queue));
  }));

test('cli refusal: a missing field exits 2 with the remedy, calls no gh, queues nothing', () =>
  withSetup((p) => {
    const r = run(p, reportArgs({ severity: 'URGENT' }));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /BLOCKED\|WORKAROUND\|FRICTION/);
    const bad = run(p, reportArgs({ evidence: ['src/a.ts:1'] }));
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /evidence line 1/);
    assert.deepEqual(ghLog(p), []);
    assert.ok(!existsSync(p.queue));
  }));

test('cli: outside a Sterling project it refuses with exit 2', () =>
  withSetup((p) => {
    rmSync(join(p.project, '.sterling'), { recursive: true });
    const r = run(p, reportArgs());
    assert.equal(r.status, 2);
    assert.match(r.stderr, /not a Sterling project/);
  }));

test('cli no match: creates a new issue with the labels through gh api, printing the body before and after', () =>
  withSetup((p) => {
    const r = run(p, reportArgs());
    assert.equal(r.status, 0, r.stderr);
    const [issue] = issues(p);
    assert.equal(issue.title, good().title);
    assert.deepEqual(issue.labels, ['sterling-report', 'severity:friction', 'project:acme']);
    assert.match(issue.body, /Fingerprint: sterling-fp-[0-9a-f]{12}$/);
    assert.equal(r.stdout.split(issue.body).length - 1, 2, 'the final body is printed before and after sending');
    assert.match(r.stdout, /issues\/100/);
    for (const call of ghLog(p).filter((c) => c[0] === 'api')) assert.ok(call.includes('--hostname'), 'every api call names the host');
    assert.ok(!ghLog(p).some((c) => c[0] === 'issue'), 'gh issue create is never used');
  }));

test('cli open match: comments on the open issue instead of opening a duplicate', () =>
  withSetup((p) => {
    const fp = fingerprint(good().component, good().title);
    seed(p, [{ number: 7, state: 'open', title: 'x', body: `old\n\nFingerprint: sterling-fp-${fp}`, labels: ['sterling-report'], comments: [] }]);
    const r = run(p, reportArgs());
    assert.equal(r.status, 0, r.stderr);
    const list = issues(p);
    assert.equal(list.length, 1, 'no new issue');
    assert.equal(list[0].comments.length, 1);
    assert.match(list[0].comments[0], new RegExp(`sterling-fp-${fp}`));
    assert.match(r.stdout, /#7/);
  }));

test('cli closed match: opens a new issue saying it recurs after #N', () =>
  withSetup((p) => {
    const fp = fingerprint(good().component, good().title);
    seed(p, [
      { number: 5, state: 'closed', title: 'x', body: `Fingerprint: sterling-fp-${fp}`, labels: [], comments: [] },
      { number: 9, state: 'closed', title: 'x', body: `Fingerprint: sterling-fp-${fp}`, labels: [], comments: [] },
      { number: 11, state: 'open', title: 'y', body: 'mentions sterling-fp-000000000000 only', labels: [], comments: [] },
    ]);
    const r = run(p, reportArgs());
    assert.equal(r.status, 0, r.stderr);
    const created = issues(p).at(-1);
    assert.equal(created.number, 103);
    assert.match(created.body, /^Recurs after #9\./);
  }));

test('cli: gh not logged in queues the report, prints one loud line naming the gh path, exits 1', () =>
  withSetup((p) => {
    writeFileSync(join(p.state, 'auth_fail'), '');
    const r = run(p, reportArgs());
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`report-issue: QUEUED.*${join(p.bin, 'gh').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    const q = queued(p);
    assert.equal(q.length, 1);
    assert.match(q[0].body, /Fingerprint: sterling-fp-/);
    assert.ok(!readFileSync(p.queue, 'utf8').includes(p.project), 'the queue holds the scrubbed report');
  }));

test('cli: gh absent from PATH queues the report and exits 1', () =>
  withSetup((p) => {
    const r = run(p, reportArgs(), { path: p.base });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /report-issue: QUEUED.*gh not found on PATH/);
    assert.equal(queued(p).length, 1);
  }));

test('cli: a failing gh api call after preflight queues the report and exits 1', () =>
  withSetup((p) => {
    writeFileSync(join(p.state, 'api_fail'), '');
    const r = run(p, reportArgs());
    assert.equal(r.status, 1);
    assert.match(r.stderr, /report-issue: QUEUED/);
    assert.equal(queued(p).length, 1);
  }));

test('cli --flush: sends the queued reports and removes the queue file', () =>
  withSetup((p) => {
    writeFileSync(join(p.state, 'auth_fail'), '');
    assert.equal(run(p, reportArgs()).status, 1);
    assert.equal(run(p, reportArgs({ title: 'Another defect', component: 'H10' })).status, 1);
    assert.equal(queued(p).length, 2);
    rmSync(join(p.state, 'auth_fail'));
    const r = run(p, ['--flush']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(issues(p).map((i) => i.title), [good().title, 'Another defect']);
    assert.ok(!existsSync(p.queue));
  }));

test('cli: the queue is flushed before every new report', () =>
  withSetup((p) => {
    writeFileSync(join(p.state, 'auth_fail'), '');
    assert.equal(run(p, reportArgs({ title: 'Queued first' })).status, 1);
    rmSync(join(p.state, 'auth_fail'));
    const r = run(p, reportArgs());
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(issues(p).map((i) => i.title), ['Queued first', good().title]);
    assert.ok(!existsSync(p.queue));
  }));

test('cli --flush: a malformed queue line refuses with exit 2 and leaves the file alone', () =>
  withSetup((p) => {
    writeFileSync(p.queue, '{not json\n');
    const r = run(p, ['--flush']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /pending-issue-reports\.jsonl line 1/);
    assert.equal(readFileSync(p.queue, 'utf8'), '{not json\n');
  }));

test('cli --list: prints the open sterling-report issues', () =>
  withSetup((p) => {
    seed(p, [
      { number: 3, state: 'open', title: 'Open one', body: 'Fingerprint: sterling-fp-0123456789ab', labels: ['sterling-report', 'severity:blocked'], comments: [] },
      { number: 4, state: 'closed', title: 'Closed one', body: 'Fingerprint: sterling-fp-0123456789ac', labels: ['sterling-report'], comments: [] },
    ]);
    const r = run(p, ['--list']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /#3 .*Open one/);
    assert.ok(!r.stdout.includes('Closed one'));
  }));

// ---------- labels the filer cannot set ----------

const LABELS = 'Labels: sterling-report, severity:friction, project:acme';
const creates = (p) => ghLog(p).filter((c) => c[0] === 'api' && c.includes('POST') && c.includes('repos/Chulf58/sterling/issues'));
const hasLabelField = (call) => call.some((x) => x.startsWith('labels[]='));
const NOT_ACCEPTED =
  'report-issue: filed without labels: GitHub did not accept the labels (sterling-report, severity:friction, project:acme); they are in the issue body as the Labels line. A maintainer can apply them with report-issue --apply-labels.';

test('render: a visible Labels line sits just above the fingerprint line, so the classification survives a refused label', () => {
  const r = validateReport(good(), ctx);
  const body = renderBody(r, { version: '1', head: null, host: 'claude-code', project: 'acme' });
  assert.ok(body.endsWith(`\n${LABELS}\nFingerprint: sterling-fp-${fingerprint(r.component, r.title)}`), body);
});

test('labels line: parseLabelsLine keeps only Sterling-shaped labels, withLabelsLine adds a missing line without touching the fingerprint', () => {
  assert.deepEqual(parseLabelsLine(`x\n${LABELS}\nFingerprint: sterling-fp-0123456789ab`), ['sterling-report', 'severity:friction', 'project:acme']);
  assert.deepEqual(parseLabelsLine('Labels: sterling-report, bug, severity:urgent, project:a b, project:ok.1'), ['sterling-report', 'project:ok.1'], 'a label outside the three shapes is dropped');
  assert.equal(parseLabelsLine('no line here'), null);
  const fp = 'Fingerprint: sterling-fp-0123456789ab';
  const labels = ['sterling-report', 'severity:blocked'];
  assert.equal(withLabelsLine(`Body\n\n${fp}`, labels, '0123456789ab'), `Body\n\nLabels: sterling-report, severity:blocked\n${fp}`);
  const has = `Body\n${LABELS}\n${fp}`;
  assert.equal(withLabelsLine(has, labels, '0123456789ab'), has, 'an existing Labels line is left alone');
  assert.equal(withLabelsLine('plain', labels, '0123456789ab'), 'plain\n\nLabels: sterling-report, severity:blocked', 'no fingerprint line: the Labels line is appended');
});

test('cli --dry-run: the printed body carries the Labels line', () =>
  withSetup((p) => {
    const r = run(p, ['--dry-run', ...reportArgs()]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(`${LABELS}\nFingerprint: sterling-fp-`), r.stdout);
  }));

test('cli: a project named like a UUID cannot put the UUID in the Labels or Project line', () =>
  withSetup((p) => {
    writeFileSync(join(p.project, '.sterling', 'config.json'), JSON.stringify({ project_name: '630e54e6-8c61-4b73-beee-de569a5ec852' }));
    const r = run(p, ['--dry-run', ...reportArgs()]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes('630e54e6-8c61'), r.stdout);
  }));

test('cli: a labelled create that GitHub accepts is one create with the Labels line in the body and no note', () =>
  withSetup((p) => {
    const r = run(p, reportArgs());
    assert.equal(r.status, 0, r.stderr);
    assert.equal(creates(p).length, 1);
    assert.ok(hasLabelField(creates(p)[0]));
    assert.ok(issues(p)[0].body.includes(`${LABELS}\nFingerprint:`));
    assert.ok(!r.stdout.includes('filed without labels'));
  }));

for (const status of [403, 404, 422]) {
  test(`cli: HTTP ${status} on the labelled create is retried once without labels and reported as filed`, () =>
    withSetup((p) => {
      writeFileSync(join(p.state, 'labels_refused'), String(status));
      const r = run(p, reportArgs());
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const calls = creates(p);
      assert.equal(calls.length, 2, 'one labelled try, one unlabelled retry');
      assert.ok(hasLabelField(calls[0]) && !hasLabelField(calls[1]));
      const [issue] = issues(p);
      assert.deepEqual(issue.labels, []);
      assert.ok(issue.body.includes(`${LABELS}\nFingerprint:`), 'the classification is in the body');
      assert.match(r.stdout, /issues\/100/);
      assert.deepEqual(r.stdout.split('\n').filter((l) => l.includes('filed without labels')), [NOT_ACCEPTED]);
      assert.ok(!existsSync(p.queue));
    }));
}

test('cli: a labelled create that succeeds with its labels dropped is not followed by a second create; one note is printed', () =>
  withSetup((p) => {
    writeFileSync(join(p.state, 'drop_labels'), '');
    const r = run(p, reportArgs());
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(creates(p).length, 1, 'never post twice');
    assert.equal(issues(p).length, 1);
    assert.deepEqual(r.stdout.split('\n').filter((l) => l.includes('filed without labels')), [NOT_ACCEPTED]);
    assert.ok(!existsSync(p.queue));
  }));

test('cli: HTTP 401 on the create is an auth failure, not retried unlabelled; the report is queued', () =>
  withSetup((p) => {
    writeFileSync(join(p.state, 'create_refused'), '401');
    const r = run(p, reportArgs());
    assert.equal(r.status, 1);
    assert.equal(creates(p).length, 1);
    assert.match(r.stderr, /report-issue: QUEUED.*401/);
    assert.equal(queued(p).length, 1);
    assert.deepEqual(queued(p)[0].labels, ['sterling-report', 'severity:friction', 'project:acme']);
  }));

test('cli: a 5xx on the labelled create is not retried unlabelled; the report is queued', () =>
  withSetup((p) => {
    writeFileSync(join(p.state, 'labels_refused'), '503');
    const r = run(p, reportArgs());
    assert.equal(r.status, 1);
    assert.equal(creates(p).length, 1);
    assert.match(r.stderr, /report-issue: QUEUED.*503/);
    assert.equal(queued(p).length, 1);
  }));

test('cli: when the unlabelled retry is refused too, the report is queued and exits 1', () =>
  withSetup((p) => {
    writeFileSync(join(p.state, 'create_refused'), '422');
    const r = run(p, reportArgs());
    assert.equal(r.status, 1);
    assert.equal(creates(p).length, 2);
    assert.match(r.stderr, /report-issue: QUEUED.*422/);
    assert.equal(queued(p).length, 1);
    assert.deepEqual(issues(p), []);
  }));

test('cli: a network failure on the create is not retried unlabelled', () =>
  withSetup((p) => {
    writeFileSync(join(p.state, 'fail_create_after'), '0');
    const r = run(p, reportArgs());
    assert.equal(r.status, 1);
    assert.equal(creates(p).length, 1);
    assert.equal(queued(p).length, 1);
  }));

test('cli queue compatibility: a queued entry with no Labels line is sent with one added above its fingerprint, fingerprint unchanged', () =>
  withSetup((p) => {
    const fp = fingerprint('H19', 'Old queued report');
    const old = { v: 1, queued_at: '2026-10-01T00:00:00.000Z', fingerprint: fp, title: 'Old queued report', labels: ['sterling-report', 'severity:blocked', 'project:old'], body: `Component: \`H19\`\n\nFingerprint: sterling-fp-${fp}` };
    writeFileSync(p.queue, `${JSON.stringify(old)}\n`);
    const r = run(p, ['--flush']);
    assert.equal(r.status, 0, r.stderr);
    const [issue] = issues(p);
    assert.equal(issue.body, `Component: \`H19\`\n\nLabels: sterling-report, severity:blocked, project:old\nFingerprint: sterling-fp-${fp}`);
    assert.deepEqual(issue.labels, old.labels);
    assert.ok(!existsSync(p.queue));
  }));

test('cli queue compatibility: a queued entry that already has a Labels line is not given a second one', () =>
  withSetup((p) => {
    const fp = '0123456789ab';
    const entry = { v: 1, fingerprint: fp, title: 'New queued', labels: ['sterling-report'], body: `x\nLabels: sterling-report\nFingerprint: sterling-fp-${fp}` };
    writeFileSync(p.queue, `${JSON.stringify(entry)}\n`);
    assert.equal(run(p, ['--flush']).status, 0);
    assert.equal(issues(p)[0].body.match(/^Labels: /gm).length, 1);
  }));

test('cli dedup: an open report that GitHub stored without labels is still found by its fingerprint and commented on', () =>
  withSetup((p) => {
    const fp = fingerprint(good().component, good().title);
    seed(p, [{ number: 1, state: 'open', title: 'x', body: `old\n${LABELS}\nFingerprint: sterling-fp-${fp}`, labels: [], comments: [] }]);
    const r = run(p, reportArgs());
    assert.equal(r.status, 0, r.stderr);
    assert.equal(issues(p).length, 1, 'no duplicate');
    assert.equal(issues(p)[0].comments.length, 1);
    assert.deepEqual(creates(p), []);
    const search = ghLog(p).find((c) => c.includes('search/issues'));
    assert.ok(search.includes(`q=repo:Chulf58/sterling is:issue "sterling-fp-${fp}" in:body`), JSON.stringify(search));
  }));

test('cli --list: finds reports by the fingerprint marker, labelled or not, and shows the body labels for an unlabelled one', () =>
  withSetup((p) => {
    seed(p, [
      { number: 1, state: 'open', title: 'Unlabelled', body: `x\n${LABELS}\nFingerprint: sterling-fp-0123456789ab`, labels: [], comments: [] },
      { number: 2, state: 'open', title: 'Labelled', body: 'x\nFingerprint: sterling-fp-0123456789ac', labels: ['sterling-report', 'severity:blocked'], comments: [] },
      { number: 3, state: 'open', title: 'Only mentions it', body: 'see sterling-fp-0123456789ab in passing', labels: [], comments: [] },
      { number: 4, state: 'closed', title: 'Closed one', body: 'Fingerprint: sterling-fp-0123456789ad', labels: [], comments: [] },
    ]);
    const r = run(p, ['--list']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /2 open sterling-report issue\(s\)/);
    assert.match(r.stdout, /#1 \[labels in body, not applied: sterling-report, severity:friction, project:acme\] Unlabelled/);
    assert.match(r.stdout, /#2 \[sterling-report, severity:blocked\] Labelled/);
    assert.ok(!r.stdout.includes('Only mentions it') && !r.stdout.includes('Closed one'));
    const search = ghLog(p).find((c) => c.includes('search/issues'));
    assert.ok(search.includes('q=repo:Chulf58/sterling is:issue is:open "sterling-fp-" in:body'), JSON.stringify(search));
    assert.ok(!search.some((x) => x.includes('labels')), 'the list does not filter by label');
  }));

// ---------- --apply-labels (maintainer mode) ----------

const unlabelled = (n, labelsLine = LABELS) => ({ number: n, state: 'open', title: `Report ${n}`, body: `x\n${labelsLine}\nFingerprint: sterling-fp-01234567890${n}`, labels: [], comments: [] });

test('cli --apply-labels: creates the missing labels, sets them on each unlabelled report, never edits a body', () =>
  withSetup((p) => {
    writeFileSync(join(p.state, 'labels.json'), JSON.stringify(['bug', 'sterling-report']));
    const done = { ...unlabelled(2), labels: ['sterling-report', 'severity:friction', 'project:acme'] };
    seed(p, [unlabelled(1), done, unlabelled(3, 'Labels: sterling-report, bug, severity:blocked')]);
    const before = issues(p).map((i) => i.body);
    const r = run(p, ['--apply-labels']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const after = issues(p);
    assert.deepEqual(after[0].labels, ['sterling-report', 'severity:friction', 'project:acme']);
    assert.deepEqual(after[1].labels, done.labels, 'an already-labelled report is skipped');
    assert.deepEqual(after[2].labels, ['sterling-report', 'severity:blocked'], 'a label outside the three shapes is not applied');
    assert.deepEqual(after.map((i) => i.body), before, 'the body is never edited');
    assert.deepEqual(JSON.parse(readFileSync(join(p.state, 'labels.json'), 'utf8')).sort(), ['bug', 'project:acme', 'severity:blocked', 'severity:friction', 'sterling-report']);
    assert.ok(!ghLog(p).some((c) => c.includes('PATCH')));
    assert.match(r.stdout, /#1/);
    assert.match(r.stdout, /#3/);
  }));

for (const status of [403, 404]) {
  test(`cli --apply-labels: HTTP ${status} refuses loudly, names the status and says a maintainer must run it`, () =>
    withSetup((p) => {
      seed(p, [unlabelled(1)]);
      writeFileSync(join(p.state, 'label_write_refused'), String(status));
      const r = run(p, ['--apply-labels']);
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stderr, new RegExp(`report-issue: --apply-labels refused: GitHub answered HTTP ${status} .*account cannot change labels on Chulf58/sterling\\. A maintainer of the repo must run report-issue --apply-labels\\.`));
      assert.deepEqual(issues(p)[0].labels, []);
    }));
}

test('cli --apply-labels: takes no report fields and does not combine with another mode', () =>
  withSetup((p) => {
    assert.equal(run(p, ['--apply-labels', '--title', 'x']).status, 2);
    assert.equal(run(p, ['--apply-labels', '--list']).status, 2);
    assert.deepEqual(ghLog(p), []);
  }));

// ---------- queue lock ----------

/** Queue `titles` through the not-logged-in path, then log gh back in. */
function queueReports(p, titles) {
  writeFileSync(join(p.state, 'auth_fail'), '');
  for (const title of titles) assert.equal(run(p, reportArgs({ title })).status, 1);
  rmSync(join(p.state, 'auth_fail'));
  assert.deepEqual(queued(p).map((e) => e.title), titles);
}

test('cli --flush: a report appended to the queue while a send is in flight survives the rewrite', () =>
  withSetup((p) => {
    queueReports(p, ['First queued']);
    const appended = { v: 1, fingerprint: '0123456789ab', title: 'Appended meanwhile', body: 'b', labels: ['sterling-report'] };
    writeFileSync(join(p.state, 'append_on_create'), `${JSON.stringify(appended)}\n`);
    const r = run(p, ['--flush']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(issues(p).map((i) => i.title), ['First queued']);
    assert.deepEqual(queued(p), [appended], 'only the sent entry is removed');
    assert.ok(!existsSync(p.lock), 'the lock is released');
  }));

test('cli --flush: after a failed send only the unsent entries remain, and the lock is released', () =>
  withSetup((p) => {
    queueReports(p, ['One', 'Two', 'Three']);
    writeFileSync(join(p.state, 'fail_create_after'), '1');
    const r = run(p, ['--flush']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /NOT FLUSHED.*502.*2 report\(s\) stay/);
    assert.deepEqual(issues(p).map((i) => i.title), ['One']);
    assert.deepEqual(queued(p).map((e) => e.title), ['Two', 'Three']);
    assert.ok(!existsSync(p.lock));
  }));

test('cli --flush: a flush killed mid-run keeps only the unsent entries; the next run clears the stale lock and sends no duplicate', () =>
  withSetup((p) => {
    queueReports(p, ['One', 'Two', 'Three']);
    writeFileSync(join(p.state, 'kill_on_search'), '2');
    const killed = run(p, ['--flush']);
    assert.equal(killed.signal, 'SIGKILL', killed.stderr);
    assert.deepEqual(issues(p).map((i) => i.title), ['One']);
    assert.deepEqual(queued(p).map((e) => e.title), ['Two', 'Three'], 'the entry sent before the kill is already gone');
    assert.ok(existsSync(p.lock), 'the killed run left its lock');
    rmSync(join(p.state, 'kill_on_search'));
    const r = run(p, ['--flush']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /removed a stale lock/);
    assert.deepEqual(issues(p).map((i) => i.title), ['One', 'Two', 'Three']);
    assert.ok(!existsSync(p.queue) && !existsSync(p.lock));
  }));

test('cli: a lock held by a running process refuses loudly with exit 2 and touches neither the queue nor gh', () =>
  withSetup((p) => {
    queueReports(p, ['Queued']);
    const lockBody = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
    writeFileSync(p.lock, lockBody);
    const calls = ghLog(p).length;
    for (const args of [['--flush'], reportArgs()]) {
      const r = run(p, args);
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stderr, new RegExp(`pending-issue-reports\\.jsonl\\.lock is held by pid ${process.pid}`));
    }
    assert.equal(ghLog(p).length, calls, 'no gh call');
    assert.deepEqual(queued(p).map((e) => e.title), ['Queued']);
    assert.equal(readFileSync(p.lock, 'utf8'), lockBody, 'the holder keeps its lock');
  }));
