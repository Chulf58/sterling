// H22 library: the Post that binds a lane fills that lane's UNATTRIBUTABLE
// register row (fillUnattributableRowLocked), on every path where the row and
// the binding can miss each other.
//
// RULING: decision h22-dispatch-files-from-review-territory-and-resume-
// inherits-prior-round (e841facd), option A: files come from the bound brief's
// REVIEW-TERRITORY. INCIDENT: research_finding h10-article-demand-misses-live-
// lanes-same-type-fanout-and-out-of-territory-files-october-2026 (79e20118).
// The hook-level incident replay is h22-unattributable-row-filled-at-post;
// these cases drive scripts/lib/dispatch-register.mjs directly:
//   - the Start's unattributable fallback is written in a later lock hold
//     than the one that decided it; a Post in between must not be lost;
//   - a Post after SubagentStop's sidecar fallback made the state record
//     terminal still fills the (ended) row, and a resume inherits it;
//   - the rows the fill refuses, each disclosed, and the calls that never fill.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as DS from '../lib/dispatch-register.mjs';

const TYPE = 'implementor-graphic';

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-dispatch-post-fill-'));
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({}));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const brief = (lane, territory) => [`Lane ${lane}: graphics pass.`, ...(territory ? [`REVIEW-TERRITORY: ${JSON.stringify(territory)}`] : [])].join('\n');
const PRE = (tool_use_id, prompt, subagent_type = TYPE) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Agent',
  tool_use_id,
  session_id: 's1',
  prompt_id: 'pr-1',
  tool_input: { subagent_type, prompt, description: 'a lane' },
});
const POST = (tool_use_id, agentId, prompt, subagent_type = TYPE) => ({
  ...PRE(tool_use_id, prompt, subagent_type),
  hook_event_name: 'PostToolUse',
  tool_response: { agentId, prompt, description: 'a lane' },
});

// A stand-in for H22's postTerritory: the REVIEW-TERRITORY line's JSON array.
function territoryFor(prompt) {
  const m = /^REVIEW-TERRITORY: (.*)$/m.exec(prompt ?? '');
  if (!m) return { ok: false, reason: 'the bound brief declares no REVIEW-TERRITORY' };
  return { ok: true, files: JSON.parse(m[1]), file_entries: [] };
}

// A stand-in for H22's entryBuilder, reduced to the files decision.
function entryBuilder(res, agent_id) {
  const proven = res.source === 'post' || res.source === 'derived-type-unique';
  const t = proven ? territoryFor(res.prompt) : { ok: false };
  let files = [];
  let files_source = 'unattributable';
  if (t.ok) {
    files = t.files;
    files_source = 'review-territory';
  } else if (res.source === 'resume' && Array.isArray(res.inherited_files)) {
    files = res.inherited_files;
    files_source = 'resume-inherited';
  }
  return {
    agent_id,
    agent_type: TYPE,
    session_id: 's1',
    files,
    file_entries: [],
    files_source,
    attribution_case: res.case,
    tool_use_id: typeof res.tool_use_id === 'string' ? res.tool_use_id : null,
    at: new Date().toISOString(),
  };
}

// The row an unattributable Start writes.
const emptyRow = (agent_id, extra = {}) => ({
  agent_id,
  agent_type: TYPE,
  session_id: 's1',
  files: [],
  file_entries: [],
  files_source: 'unattributable',
  attribution_case: 'same-type-siblings-in-flight',
  tool_use_id: null,
  at: new Date().toISOString(),
  ...extra,
});

const registerFile = (dir) => join(dir, '.sterling', 'transient', 'dispatch-register.json');
const rowsFor = (dir, agentId) => JSON.parse(readFileSync(registerFile(dir), 'utf8')).filter((e) => e.agent_id === agentId);
const unattributableLines = (r) => r.disclosures.filter((d) => d.includes('[dispatch_unattributable]'));

// Hold the kernel register lock from a second connection, the way another
// hook process holding it looks to this one.
function holdLock(dir) {
  const db = new DatabaseSync(DS.registerLockPath(dir));
  db.exec('BEGIN IMMEDIATE');
  return () => {
    db.exec('ROLLBACK');
    db.close();
  };
}

test('FINDING 1: a Post that binds the lane before the Start writes its unattributable fallback still gives the row its territory', async () => {
  const { dir, cleanup } = project();
  try {
    await DS.recordDispatchPre(dir, PRE('toolu_a', brief('A', ['game/a'])));
    await DS.recordDispatchPre(dir, PRE('toolu_b', brief('B', ['game/b'])));
    const post = await DS.recordDispatchPost(dir, POST('toolu_a', 'aaaa1111', brief('A', ['game/a'])), { territoryFor });
    assert.equal(post.action, 'post-bound');
    assert.deepEqual(post.disclosures, [], 'no row exists yet: the ordinary order, silent');

    // The Start's determining hold cannot get the lock, so it gives up as
    // unattributable('lock-held') and writes the row in a second hold.
    const release = holdLock(dir);
    const t0 = Date.now();
    const started = DS.resolveAndRegisterStart(dir, { session_id: 's1', agent_id: 'aaaa1111', agent_type: TYPE }, (res) => entryBuilder(res, 'aaaa1111'));
    setTimeout(release, 1300);
    const { entry } = await started;
    assert.ok(Date.now() - t0 >= 1000, 'the determining hold timed out, so the fallback path ran');

    const rows = rowsFor(dir, 'aaaa1111');
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].files, ['game/a'], 'the row registered from the binding, not as files []');
    assert.equal(rows[0].files_source, 'review-territory');
    assert.equal(rows[0].tool_use_id, 'toolu_a');
    assert.equal(entry.tool_use_id, 'toolu_a');
  } finally {
    cleanup();
  }
});

test('FINDING 1 (control): with no binding by the second hold, the fallback row is still the unattributable one', async () => {
  const { dir, cleanup } = project();
  try {
    await DS.recordDispatchPre(dir, PRE('toolu_a', brief('A', ['game/a'])));
    await DS.recordDispatchPre(dir, PRE('toolu_b', brief('B', ['game/b'])));
    const release = holdLock(dir);
    const started = DS.resolveAndRegisterStart(dir, { session_id: 's1', agent_id: 'aaaa1111', agent_type: TYPE }, (res) => entryBuilder(res, 'aaaa1111'));
    setTimeout(release, 1300);
    await started;
    const [row] = rowsFor(dir, 'aaaa1111');
    assert.deepEqual(row.files, []);
    assert.equal(row.files_source, 'unattributable');
    assert.equal(row.attribution_case, 'lock-held', 'the fallback keeps the reason it gave up');
  } finally {
    cleanup();
  }
});

test('FINDING 2: a foreground Post after the Stop sidecar fallback made the record terminal fills the ended row, and a resume inherits the files', async () => {
  const { dir, cleanup } = project();
  try {
    await DS.recordDispatchPre(dir, PRE('toolu_a', brief('A', ['game/a', 'game/a/hud.gd'])));
    await DS.recordDispatchPre(dir, PRE('toolu_b', brief('B', ['game/b'])));
    await DS.registerStart(dir, emptyRow('aaaa1111'));
    const fin = await DS.finishDispatchAndRegisterEnd(dir, { session_id: 's1', agent_id: 'aaaa1111', sidecarToolUseId: 'toolu_a', event: 'subagent-stop' });
    assert.equal(fin.record?.terminal?.reason, 'stop', 'the sidecar fallback terminalized the unbound record');

    const post = await DS.recordDispatchPost(dir, POST('toolu_a', 'aaaa1111', brief('A', ['game/a', 'game/a/hud.gd'])), { territoryFor });
    assert.equal(post.action, 'late-post-noop');
    assert.deepEqual(unattributableLines(post), [], 'an unambiguous fill is not a degraded path');

    const [row] = rowsFor(dir, 'aaaa1111');
    assert.deepEqual(row.files, ['game/a', 'game/a/hud.gd']);
    assert.equal(row.files_source, 'review-territory');
    assert.equal(row.tool_use_id, 'toolu_a');
    assert.ok(row.ended, 'the fill leaves the round ended');

    const resumed = await DS.resolveDispatchStart(dir, { session_id: 's1', agent_id: 'aaaa1111', agent_type: TYPE }, { consumer: 'h22' });
    assert.equal(resumed.source, 'resume');
    assert.deepEqual(resumed.inherited_files, ['game/a', 'game/a/hud.gd']);
  } finally {
    cleanup();
  }
});

test('FINDING 3: a row that is not an empty unattributable one is left as it is and disclosed', async () => {
  const { dir, cleanup } = project();
  try {
    await DS.registerStart(dir, emptyRow('aaaa1111', { files: ['game/x'], files_source: 'free-prose-fallback' }));
    const before = readFileSync(registerFile(dir), 'utf8');
    const post = await DS.recordDispatchPost(dir, POST('toolu_a', 'aaaa1111', brief('A', ['game/a'])), { territoryFor });
    const [line] = unattributableLines(post);
    assert.match(line, /row-not-unattributable|not an empty unattributable one/);
    assert.equal(readFileSync(registerFile(dir), 'utf8'), before);
  } finally {
    cleanup();
  }
});

test('FINDING 3: a row of another agent type is left as it is and disclosed', async () => {
  const { dir, cleanup } = project();
  try {
    await DS.registerStart(dir, emptyRow('aaaa1111', { agent_type: 'researcher' }));
    const before = readFileSync(registerFile(dir), 'utf8');
    const post = await DS.recordDispatchPost(dir, POST('toolu_a', 'aaaa1111', brief('A', ['game/a'])), { territoryFor });
    const [line] = unattributableLines(post);
    assert.match(line, /agent type 'researcher' differs from the dispatched 'implementor-graphic'/);
    assert.equal(readFileSync(registerFile(dir), 'utf8'), before);
  } finally {
    cleanup();
  }
});

test('FINDING 3: a corrupt register is left as it is and disclosed', async () => {
  const { dir, cleanup } = project();
  try {
    writeFileSync(registerFile(dir), '{not json');
    const post = await DS.recordDispatchPost(dir, POST('toolu_a', 'aaaa1111', brief('A', ['game/a'])), { territoryFor });
    assert.equal(post.action, 'created-post-only');
    const [line] = unattributableLines(post);
    assert.match(line, /is unreadable/);
    assert.equal(readFileSync(registerFile(dir), 'utf8'), '{not json');
  } finally {
    cleanup();
  }
});

test('FINDING 3: a post-only Post (no Pre was recorded) fills the row', async () => {
  const { dir, cleanup } = project();
  try {
    await DS.registerStart(dir, emptyRow('aaaa1111'));
    const post = await DS.recordDispatchPost(dir, POST('toolu_a', 'aaaa1111', brief('A', ['game/a'])), { territoryFor });
    assert.equal(post.action, 'created-post-only');
    assert.deepEqual(unattributableLines(post), []);
    const [row] = rowsFor(dir, 'aaaa1111');
    assert.deepEqual(row.files, ['game/a']);
    assert.equal(row.files_source, 'review-territory');
    assert.equal(row.tool_use_id, 'toolu_a');
  } finally {
    cleanup();
  }
});

test('FINDING 3: the two-argument call (OpenCode registers at Post) never fills and never discloses', async () => {
  const { dir, cleanup } = project();
  try {
    await DS.recordDispatchPre(dir, PRE('toolu_a', brief('A', ['game/a'])));
    await DS.registerStart(dir, emptyRow('aaaa1111'));
    const before = readFileSync(registerFile(dir), 'utf8');
    const post = await DS.recordDispatchPost(dir, POST('toolu_a', 'aaaa1111', brief('A', ['game/a'])));
    assert.equal(post.action, 'post-bound');
    assert.deepEqual(post.disclosures, []);
    assert.equal(readFileSync(registerFile(dir), 'utf8'), before);
  } finally {
    cleanup();
  }
});

test('FINDING 4: the refusal names what an empty row costs: deferral while the round is live, inheritance once it has ended', async () => {
  const { dir, cleanup } = project();
  try {
    await DS.recordDispatchPre(dir, PRE('toolu_a', brief('A')));
    await DS.registerStart(dir, emptyRow('aaaa1111'));
    const live = await DS.recordDispatchPost(dir, POST('toolu_a', 'aaaa1111', brief('A')), { territoryFor });
    const [liveLine] = unattributableLines(live);
    assert.match(liveLine, /H10 will not defer this lane's files/);
    assert.doesNotMatch(liveLine, /resume/);

    await DS.recordDispatchPre(dir, PRE('toolu_b', brief('B')));
    await DS.registerStart(dir, emptyRow('bbbb2222'));
    await DS.finishDispatchAndRegisterEnd(dir, { session_id: 's1', agent_id: 'bbbb2222', sidecarToolUseId: 'toolu_b', event: 'subagent-stop' });
    const ended = await DS.recordDispatchPost(dir, POST('toolu_b', 'bbbb2222', brief('B')), { territoryFor });
    const [endedLine] = unattributableLines(ended);
    assert.match(endedLine, /a resume will inherit no files/);
    assert.doesNotMatch(endedLine, /H10 will not defer/);
  } finally {
    cleanup();
  }
});
