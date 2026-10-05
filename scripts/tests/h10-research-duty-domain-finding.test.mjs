// H10 research duty and domain-scoped records (GitHub issue #12).
//
// A record with scope `domain:<name>` is written to that domain's own store
// (~/.sterling/domains/<name>/sterling.db, or config.domain_paths[<name>]),
// never to the project store. H10 read only the project store, so a
// research_finding the conductor filed under a domain could not discharge the
// research duty, and the Stop hook kept printing
//   H10 ▸ 1 duty(ies) unchanged since HH:MM: research→research_finding | no_capture --lane research
//
// The same miss is what made a capture_pending declaration look ignored while
// subagents were live: the capture_pending hold is reached only when the
// research duty is satisfied (decision
// capture-pending-grace-per-declaration-held-while-any-dispatch-live defers the
// CAPTURE duty only), so an unseen domain finding kept the Stop on the nag
// path instead of the hold.
//
//   DF-a — a domain-scoped research_finding created after the research event
//          discharges the research duty.
//   DF-b — a domain-scoped finding written BEFORE the research event does not.
//   DF-c — a mounted domain with no store on disk is skipped: the duty stays
//          armed and the hook does not create the store.
//   DF-f — a mounted domain store that cannot be opened is announced in the
//          nag and pays nothing.
//   DF-d — capture_pending + a live dispatch + a research duty paid by a
//          domain-scoped finding: the declaration is held, nothing is nagged.
//   DF-e — capture_pending + a live dispatch + an UNPAID research duty: the
//          research demand still fires (the declaration covers capture only).
//   DF-h — a domain record with no ledger line (another project wrote it, or
//          it predates the ledger) pays neither duty.
//   DF-i — the ledger line must be inside the window as well as name the id:
//          this project's OLD line does not let another project's later
//          update of the same record pay.
//   DF-j — a ledger that cannot be read is announced and pays nothing.
//   DF-g — the capture duty reads the domain stores too: a domain-scoped
//          decision written after the edit discharges it; one written before
//          the edit does not.
//
// The concept duty is not covered here on purpose: a feature_article is always
// project-scoped (packages/store/src/mounted.ts, §3.3), so no concept article
// can live in a domain store.
//
// Harness and fixtures follow scripts/tests/h10-capture-pending-grace.test.mjs
// and scripts/tests/h10-research-no-capture-and-concept-prewrite.test.mjs.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const DOMAIN = 'fixturedomain';
const R_EVENT_AT = '2026-06-10T11:00:00.000Z';
const BEFORE_EVENT = '2026-06-10T10:00:00.000Z';
const AFTER_EVENT = '2026-06-10T11:30:00.000Z';
const PENDING_AT = '2026-06-10T11:40:00.000Z';
const TOUCH_AT = '2026-06-10T11:45:00.000Z';
const AFTER_TOUCH = '2026-06-10T11:50:00.000Z';
const WORKFILE = 'src/feature/work.mjs';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

function runHook(script, input, cwd, env = {}) {
  const r = spawnSync(process.execPath, [join(HOOKS, script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1', ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function envelope(type, at, scope = 'project') {
  return {
    id: randomUUID(),
    type,
    created_at: at,
    updated_at: at,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope,
    stack_tags: [],
  };
}

const domainDbPath = (dir) => join(dir, 'domains', DOMAIN, 'sterling.db').replace(/\\/g, '/');

// stack_tags is the domain mount manifest; domain_paths keeps the fixture's
// domain store inside the temp dir instead of the real ~/.sterling/domains.
function makeProject({ createDomain = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h10-domain-'));
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  writeFileSync(
    join(dir, '.sterling', 'config.json'),
    JSON.stringify({
      toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
      caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
      context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
      stack_tags: [DOMAIN],
      domain_paths: { [DOMAIN]: domainDbPath(dir) },
    })
  );
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  let domain = null;
  if (createDomain) {
    mkdirSync(dirname(domainDbPath(dir)), { recursive: true });
    domain = new SterlingStore(domainDbPath(dir));
  }
  const cleanup = () => {
    store.close();
    domain?.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, domain, cleanup };
}

const hookInput = (dir, over = {}) => ({
  session_id: 's1',
  transcript_path: join(dir, 't', 's1.jsonl'),
  cwd: dir,
  permission_mode: 'default',
  ...over,
});
const stopOnce = (dir) => runHook('h10-direct-capture.mjs', hookInput(dir, { hook_event_name: 'Stop' }), dir);

const touchesPath = (dir) => join(dir, '.sterling', 'transient', 'touches.json');
const eventsPath = (dir) => join(dir, '.sterling', 'transient', 'session-events.json');
const registerPath = (dir) => join(dir, '.sterling', 'transient', 'dispatch-register.json');

function writeSessionEvents(dir, events) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(eventsPath(dir), JSON.stringify(events));
}
const readEvents = (dir) => (existsSync(eventsPath(dir)) ? JSON.parse(readFileSync(eventsPath(dir), 'utf8')) : []);

function touchRegister(dir, paths, at) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  for (const p of paths) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), '// touched\n');
  }
  writeFileSync(touchesPath(dir), JSON.stringify(paths.map((path) => ({ path, at }))));
}

function writeRegisterRaw(dir, content) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(registerPath(dir), JSON.stringify(content));
}

const liveEntry = (agentId, files) => ({
  agent_id: agentId,
  agent_type: 'coder',
  session_id: 's1',
  files,
  at: new Date().toISOString(),
});

const rEvent = (detail, at = R_EVENT_AT) => ({ kind: 'research_tool', detail, at });
const cpEvent = (detail, at = PENDING_AT) => ({ kind: 'capture_pending', detail, at });

function domainFinding(domain, at) {
  return domain.create({
    ...envelope('research_finding', at, `domain:${DOMAIN}`),
    question: 'genesys webhook signature scope?',
    answer: 'per-org secret, validated at the edge',
    source_urls: ['https://developer.genesys.cloud/x'],
    source_date: '2026-06-10',
    capture_date: '2026-06-10',
  });
}

function domainDecision(domain, at) {
  return domain.create({
    ...envelope('decision', at, `domain:${DOMAIN}`),
    title: 'webhook secrets are per-org',
    statement: 's',
    alternatives_rejected: [],
    rationale: 'r',
  });
}

// The domain-write ledger (decision
// domain-record-duty-credit-comes-from-a-per-project-write-ledger): the line
// this project's MCP server writes after a domain-scoped write. A domain record
// pays a duty only when the ledger under this project root has a line for it
// inside the window; a fixture that only creates the record models a write by
// ANOTHER project into the shared store.
const ledgerPath = (dir) => join(dir, '.sterling', 'transient', 'knowledge-writes.jsonl');
function logWrite(dir, record, at) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  appendFileSync(ledgerPath(dir), `${JSON.stringify({ id: record.id, type: record.type, at })}\n`);
}

const owed = (store, reason) => store.query({ types: ['todo'], cap: 100 }).filter((t) => t.system_reason === reason);

test('DF-a (RED before the fix): a research_finding with scope domain:<name>, created after the research event, discharges the research duty', () => {
  const { dir, store, domain, cleanup } = makeProject();
  try {
    writeSessionEvents(dir, [rEvent('genesys webhook signature validation')]);
    logWrite(dir, domainFinding(domain, AFTER_EVENT), AFTER_EVENT);
    const ledgerBefore = readFileSync(ledgerPath(dir), 'utf8');

    const r = stopOnce(dir);
    assert.equal(r.code, 0, 'DOMAIN-FINDING-UNSEEN SHAPE if this is 2: the finding lives in the mounted domain store and must pay the research duty');
    assert.doesNotMatch(r.stderr, /research/i, 'no research demand once a domain-scoped finding has landed');
    assert.equal(existsSync(eventsPath(dir)), false, 'the paid duty clears the session-events register');
    assert.equal(owed(store, 'research_owed').length, 0, 'nothing owed');
    assert.equal(readFileSync(ledgerPath(dir), 'utf8'), ledgerBefore, 'the Stop that clears the registers leaves the write ledger byte-identical');
  } finally {
    cleanup();
  }
});

test('DF-b: a domain-scoped finding written BEFORE the research event does not discharge it', () => {
  const { dir, domain, cleanup } = makeProject();
  try {
    writeSessionEvents(dir, [rEvent('genesys webhook signature validation')]);
    domainFinding(domain, BEFORE_EVENT);

    const r = stopOnce(dir);
    assert.equal(r.code, 2, 'the window opens at the research event; older domain knowledge never pays it');
    assert.match(r.stderr, /genesys webhook signature validation/);
  } finally {
    cleanup();
  }
});

test('DF-c: a mounted domain with no store on disk is skipped — the duty stays armed and the store is not created', () => {
  const { dir, cleanup } = makeProject({ createDomain: false });
  try {
    writeSessionEvents(dir, [rEvent('genesys webhook signature validation')]);

    const r = stopOnce(dir);
    assert.equal(r.code, 2, 'nothing paid the duty');
    assert.match(r.stderr, /genesys webhook signature validation/);
    assert.equal(existsSync(domainDbPath(dir)), false, 'a missing domain store is never created by the hook');
  } finally {
    cleanup();
  }
});

test('DF-f: a mounted domain store that cannot be opened is announced in the nag and pays nothing', () => {
  const { dir, cleanup } = makeProject({ createDomain: false });
  try {
    mkdirSync(dirname(domainDbPath(dir)), { recursive: true });
    writeFileSync(domainDbPath(dir), 'this is not a sqlite database, only a file at the mounted path\n'.repeat(40));
    writeSessionEvents(dir, [rEvent('genesys webhook signature validation')]);

    const r = stopOnce(dir);
    assert.equal(r.code, 2, 'an unreadable domain store never discharges the duty');
    assert.match(r.stderr, /genesys webhook signature validation/);
    assert.match(r.stderr, new RegExp(`domain store '${DOMAIN}' could not be read for the session-end duties`), 'the degraded read is stated, not silent');
  } finally {
    cleanup();
  }
});

test('DF-d (RED before the fix): with the research duty paid by a domain-scoped finding, a capture_pending declaration is held while a dispatch is live', () => {
  const { dir, store, domain, cleanup } = makeProject();
  try {
    touchRegister(dir, [WORKFILE], TOUCH_AT);
    writeSessionEvents(dir, [rEvent('genesys webhook signature validation'), cpEvent('commit-7f3a9c — rides the pending commit')]);
    logWrite(dir, domainFinding(domain, AFTER_EVENT), AFTER_EVENT); // after the research event, BEFORE the touch: pays research, not capture
    // The live entry owns a file that was not touched, so only the declaration
    // can be what defers WORKFILE.
    writeRegisterRaw(dir, [liveEntry('sub-anon-42', ['src/elsewhere/lane.mjs'])]);

    for (let i = 1; i <= 2; i += 1) {
      const r = stopOnce(dir);
      assert.equal(r.code, 0, `Stop ${i}: HOLD-UNREACHED SHAPE if this is 2 — the unseen domain finding left the research duty open, which keeps the Stop off the hold path`);
      assert.doesNotMatch(r.stderr, /research/i, `Stop ${i}: no research demand`);
      assert.equal(owed(store, 'capture_owed').length, 0, `Stop ${i}: a held declaration is not converted to debt`);
      assert.equal(readEvents(dir).some((e) => e.kind === 'capture_pending'), true, `Stop ${i}: the held declaration survives`);
      assert.equal(existsSync(touchesPath(dir)), true, `Stop ${i}: the hold is non-terminal`);
    }
  } finally {
    cleanup();
  }
});

test('DF-e: capture_pending with a live dispatch does not hold an UNPAID research duty — the declaration covers the capture duty only', () => {
  const { dir, cleanup } = makeProject();
  try {
    touchRegister(dir, [WORKFILE], TOUCH_AT);
    writeSessionEvents(dir, [rEvent('genesys webhook signature validation'), cpEvent('commit-7f3a9c — rides the pending commit')]);
    writeRegisterRaw(dir, [liveEntry('sub-anon-42', ['src/elsewhere/lane.mjs'])]);

    const r = stopOnce(dir);
    assert.equal(r.code, 2, 'the research demand still blocks');
    assert.match(r.stderr, /genesys webhook signature validation/);
  } finally {
    cleanup();
  }
});

test('DF-g (RED before the fix): a domain-scoped decision written after the edit discharges the capture duty; one written before the edit does not', () => {
  const early = makeProject();
  try {
    touchRegister(early.dir, [WORKFILE], TOUCH_AT);
    logWrite(early.dir, domainDecision(early.domain, AFTER_EVENT), AFTER_EVENT); // before the touch
    const r = stopOnce(early.dir);
    assert.equal(r.code, 2, 'a domain record older than the edit pays nothing');
    assert.match(r.stderr, /nothing was captured/);
  } finally {
    early.cleanup();
  }

  const late = makeProject();
  try {
    touchRegister(late.dir, [WORKFILE], TOUCH_AT);
    logWrite(late.dir, domainDecision(late.domain, AFTER_TOUCH), AFTER_TOUCH);
    const r = stopOnce(late.dir);
    assert.doesNotMatch(r.stderr, /nothing was captured/, 'DOMAIN-CAPTURE-UNSEEN SHAPE if this matches: the decision lives in the mounted domain store and must pay the capture duty');
    assert.equal(r.code, 0);
    assert.equal(owed(late.store, 'capture_owed').length, 0, 'nothing owed');
  } finally {
    late.cleanup();
  }
});

test('DF-h: a domain record with no ledger line under this root pays neither the research nor the capture duty', () => {
  const research = makeProject();
  try {
    writeSessionEvents(research.dir, [rEvent('genesys webhook signature validation')]);
    domainFinding(research.domain, AFTER_EVENT); // in the window, written by another project
    const r = stopOnce(research.dir);
    assert.equal(r.code, 2, 'FOREIGN-WRITE-PAYS SHAPE if this is 0: a record this project did not log must not pay its research duty');
    assert.match(r.stderr, /genesys webhook signature validation/);
  } finally {
    research.cleanup();
  }

  const capture = makeProject();
  try {
    touchRegister(capture.dir, [WORKFILE], TOUCH_AT);
    domainDecision(capture.domain, AFTER_TOUCH);
    const r = stopOnce(capture.dir);
    assert.equal(r.code, 2, 'FOREIGN-WRITE-PAYS SHAPE if this is 0: a record this project did not log must not pay its capture duty');
    assert.match(r.stderr, /nothing was captured/);
  } finally {
    capture.cleanup();
  }
});

test('DF-i: a ledger line older than the window does not let a later write by another project pay; a line inside the window does', () => {
  const { dir, store, domain, cleanup } = makeProject();
  try {
    const finding = domainFinding(domain, BEFORE_EVENT);
    logWrite(dir, finding, BEFORE_EVENT); // this project wrote it, before the research ran
    domain.updateRecord(finding.id, { ...finding, answer: 'changed by another project', updated_at: AFTER_EVENT });
    assert.equal(domain.get(finding.id).updated_at, AFTER_EVENT, 'fixture: the record itself is inside the window');
    writeSessionEvents(dir, [rEvent('genesys webhook signature validation')]);

    const stale = stopOnce(dir);
    assert.equal(stale.code, 2, 'ID-ALONE-PAYS SHAPE if this is 0: the id is logged, but not inside the window');
    assert.match(stale.stderr, /genesys webhook signature validation/);

    // The same record, now updated by THIS project inside the window (a record another project created).
    writeSessionEvents(dir, [rEvent('genesys webhook signature validation')]);
    logWrite(dir, finding, AFTER_EVENT);
    const paid = stopOnce(dir);
    assert.equal(paid.code, 0, 'an in-window line for the id pays, whoever created the record');
    assert.doesNotMatch(paid.stderr, /research/i);
    assert.equal(owed(store, 'research_owed').length, 0, 'paid, not queued as debt');
  } finally {
    cleanup();
  }
});

test('DF-j: a domain-write ledger that cannot be read is announced in the nag and no domain record pays', () => {
  const { dir, domain, cleanup } = makeProject();
  try {
    writeSessionEvents(dir, [rEvent('genesys webhook signature validation')]);
    logWrite(dir, domainFinding(domain, AFTER_EVENT), AFTER_EVENT);
    rmSync(ledgerPath(dir));
    mkdirSync(ledgerPath(dir)); // a directory where the file belongs: the read fails

    const r = stopOnce(dir);
    assert.equal(r.code, 2, 'an unreadable ledger never discharges the duty');
    assert.match(r.stderr, /genesys webhook signature validation/);
    assert.match(r.stderr, /the domain-write ledger \(\.sterling\/transient\/knowledge-writes\.jsonl\) could not be read/, 'the degraded read is stated, not silent');
    assert.match(r.stderr, /a domain-scoped record logged only in that file is not counted toward the session-end duties, and entries in this project's other ledger files still count/, 'the nag claims only the named file\'s entries are lost');
    assert.doesNotMatch(r.stderr, /no domain-scoped record is counted/, 'with one ledger file per server process an unreadable file no longer means no domain record counted');
  } finally {
    cleanup();
  }
});

test('DF-k: with one ledger file per server process, a corrupt file is named in the release and a write logged in another file still pays', () => {
  const { dir, store, domain, cleanup } = makeProject();
  try {
    writeSessionEvents(dir, [rEvent('genesys webhook signature validation')]);
    const finding = domainFinding(domain, AFTER_EVENT);
    const transient = join(dir, '.sterling', 'transient');
    mkdirSync(transient, { recursive: true });
    writeFileSync(join(transient, `knowledge-writes.4141-${randomUUID()}.jsonl`), `${JSON.stringify({ id: finding.id, type: finding.type, at: AFTER_EVENT })}\n`);
    const corrupt = `knowledge-writes.4242-${randomUUID()}.jsonl`;
    writeFileSync(join(transient, corrupt), 'not json at all\n');

    const r = stopOnce(dir);
    assert.equal(r.code, 0, 'CORRUPT-FILE-HIDES-VALID SHAPE if this is 2: the write logged in the readable per-process file pays the research duty');
    assert.equal(owed(store, 'research_owed').length, 0, 'nothing owed');
    const said = r.stdout + r.stderr;
    assert.ok(said.includes(`the domain-write ledger (.sterling/transient/${corrupt}) could not be read`), `the corrupt file is named: ${said}`);
    assert.match(said, /none of its 1 line\(s\) is a valid entry/);
    assert.match(said, /entries in this project's other ledger files still count/);
  } finally {
    cleanup();
  }
});
