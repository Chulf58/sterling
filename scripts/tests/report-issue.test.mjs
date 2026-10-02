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
const FAKE_GH_IMPL = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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
if (method === 'GET' && path === 'search/issues') {
  const fp = (one('q').match(/sterling-fp-[0-9a-f]{12}/) ?? [])[0];
  if (!fp || !/repo:Chulf58\\/sterling/.test(one('q'))) { console.error('fake gh: bad search ' + one('q')); process.exit(3); }
  const items = issues.filter((i) => i.body.includes(fp)).map((i) => ({ number: i.number, state: i.state, html_url: url(i.number), body: i.body }));
  console.log(JSON.stringify({ total_count: items.length, items })); process.exit(0);
}
if (method === 'GET' && path === 'repos/Chulf58/sterling/issues') {
  const hits = issues.filter((i) => i.state === one('state') && i.labels.includes(one('labels')));
  console.log(JSON.stringify(hits.map((i) => ({ number: i.number, title: i.title, html_url: url(i.number), labels: i.labels.map((name) => ({ name })) })))); process.exit(0);
}
if (method === 'POST' && path === 'repos/Chulf58/sterling/issues') {
  const number = 100 + issues.length;
  issues.push({ number, state: 'open', title: one('title'), body: one('body'), labels: fields['labels[]'] ?? [], comments: [] });
  writeFileSync(file, JSON.stringify(issues));
  console.log(JSON.stringify({ number, html_url: url(number) })); process.exit(0);
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
  return { base, home, project, bin, state, queue: join(project, '.sterling', 'pending-issue-reports.jsonl') };
}

function run(p, args, { path } = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: p.project,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, HOME: p.home, PATH: path ?? `${p.bin}${delimiter}${process.env.PATH}`, FAKE_GH_STATE: p.state, OPENCODE: '', OPENCODE_SESSION_ID: '' },
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
      { number: 3, state: 'open', title: 'Open one', body: '', labels: ['sterling-report', 'severity:blocked'], comments: [] },
      { number: 4, state: 'closed', title: 'Closed one', body: '', labels: ['sterling-report'], comments: [] },
    ]);
    const r = run(p, ['--list']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /#3 .*Open one/);
    assert.ok(!r.stdout.includes('Closed one'));
  }));
