// BLIND LANE — `STERLING-DELIVERY: off` in a dispatch brief stops every Claude
// Code hook that delivers store knowledge into that subagent, and fails toward
// suppression when the lane's policy cannot be established (GitHub #88;
// decision blind-lane-sterling-delivery-off-brief-line, knowledge_get
// 73cc21d1-6911-42fb-a366-504b11dd0f89).
//
// Layers pinned here: the shared parser and stripper
// (scripts/hooks/lib/dispatch-prompt.mjs), the policy captured into the
// dispatch-state record and the read-only accessor
// (scripts/lib/dispatch-register.mjs readDeliveryPolicy), and the four
// delivering hooks run from source through their real stdin shapes:
// h19-dispatch-staging (SubagentStart), h19-knowledge-delivery (Read),
// h19-bash-delivery and h23-output-axis (Bash).

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { HOOK_NODE_FLAGS } from './lib/node-quiet.mjs';
import {
  parseSterlingDelivery,
  stripSterlingDeliveryLine,
  DELIVERY_OFF_NOTICE,
  DELIVERY_HELD_BACK_NOTICE,
} from '../hooks/lib/dispatch-prompt.mjs';
import { outgoingProposalText } from '../hooks/lib/delivery.mjs';
import {
  recordDispatchPre,
  recordDispatchPost,
  readDeliveryPolicy,
  resolveDispatchStart,
  sessionBoundarySweep,
  dispatchStateDir,
} from '../lib/dispatch-register.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-10-13T12:00:00.000Z';
const OFF = 'STERLING-DELIVERY: off';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

test('parser: the exact line reads off; no marker reads on', () => {
  assert.deepEqual(parseSterlingDelivery(`Do the thing.\n${OFF}\nThanks.`), { present: true, valid: true, policy: 'off' });
  assert.deepEqual(parseSterlingDelivery('Do the thing.\nNo directive here.'), { present: false, policy: 'on' });
  assert.deepEqual(parseSterlingDelivery(undefined), { present: false, policy: 'on' });
  assert.equal(parseSterlingDelivery(`  ${OFF}\r\n`).policy, 'off', 'leading indent and CRLF still match');
});

test('parser: a malformed value or a duplicate marker still reads off, flagged invalid', () => {
  for (const text of ['STERLING-DELIVERY: on', 'STERLING-DELIVERY: exclude [abc]', 'STERLING-DELIVERY:', 'STERLING-DELIVERY: OFF']) {
    const r = parseSterlingDelivery(text);
    assert.equal(r.policy, 'off', text);
    assert.equal(r.valid, false, text);
    assert.match(r.reason, /only 'off' is accepted/);
  }
  const dup = parseSterlingDelivery(`${OFF}\nbody\n${OFF}`);
  assert.equal(dup.policy, 'off');
  assert.equal(dup.valid, false);
  assert.match(dup.reason, /2 lines/);
});

test('parser: a mention inside a sentence or a backticked quote is not a directive', () => {
  assert.equal(parseSterlingDelivery(`The brief line \`${OFF}\` turns delivery off.`).present, false);
  assert.equal(parseSterlingDelivery(`- \`${OFF}\` is the line`).present, false);
});

test('notice: the held-back wording is the ruled text and never asserts that a sibling asked for off', () => {
  assert.equal(
    DELIVERY_HELD_BACK_NOTICE,
    "STERLING DELIVERY HELD BACK: this lane's delivery policy could not be established (it could not be told apart from a same-type lane that asked for STERLING-DELIVERY: off, or the dispatch state was unreadable), so no store records are delivered."
  );
  assert.doesNotMatch(DELIVERY_HELD_BACK_NOTICE, /while a same-type lane/);
});

test('parser: a line after 20,000 characters is still found', () => {
  const brief = `${'x'.repeat(25_000)}\n${OFF}\n`;
  assert.equal(parseSterlingDelivery(brief).policy, 'off');
});

test('stripper: removes the line, keeps the rest; H20 outgoing text never sees it', () => {
  const brief = `Edit src/a.mjs.\n${OFF}\nREVIEW-TERRITORY: ["src/a.mjs"]\nThen stop.`;
  const stripped = stripSterlingDeliveryLine(brief);
  assert.ok(!stripped.includes('STERLING-DELIVERY'));
  assert.ok(stripped.includes('Edit src/a.mjs.') && stripped.includes('Then stop.'));
  const outgoing = outgoingProposalText({ prompt: brief });
  assert.ok(!outgoing.includes('STERLING-DELIVERY') && !outgoing.includes('REVIEW-TERRITORY'));
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function envelope(type) {
  return { id: randomUUID(), type, created_at: NOW, updated_at: NOW, author: 'conductor', status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [] };
}
function article(slug, paths) {
  return {
    ...envelope('feature_article'),
    slug,
    title: slug,
    what_it_does: `${slug} does the ${slug} thing`,
    intended_behavior: `${slug} intends`,
    files: paths.map((p) => ({ path: p, role: 'owner' })),
    current_ac: [{ ac_id: 'AC1', text: `${slug} works`, verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active',
    version: 1,
    history: [],
    live_test_refs: [],
  };
}
// The H23 floor-clearing vocabulary idiom from scripts/tests/h23-output-axis.test.mjs.
const DOMAIN_TRIGGER =
  'breach countdown breach countdown widget flywheel widget flywheel ballast klaxon ballast klaxon ' +
  'recur constantly though this bug rarely touches a game field cell during setup work';
const CONTENT_SENTENCE =
  'The reactor log shows the breach alarm firing while the widget assembly and the flywheel governor both spike past nominal load.';
function hazard() {
  return {
    ...envelope('anti_pattern'),
    title: 'HZ breach countdown widget flywheel ballast klaxon failure',
    trigger: DOMAIN_TRIGGER,
    guidance: 'guidance',
    wrong_way: 'wrong way',
    right_way: 'right way text',
    source_evidence: 'evidence',
    basis: 'codebase',
    file_keys: [],
  };
}

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-blind-lane-'));
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({}));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const art = store.create(article('alpha-art', ['src/a.mjs']));
  const hz = store.create(hazard());
  return { dir, art, hz, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function runHook(name, input, cwd) {
  const r = spawnSync(process.execPath, [...HOOK_NODE_FLAGS, join(HOOKS, name)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const context = (r) => (r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : '');

const pre = (dir, { tool_use_id, subagent_type, prompt, session_id = 's1' }) => ({
  hook_event_name: 'PreToolUse', tool_name: 'Task', tool_use_id, tool_input: { subagent_type, prompt, description: 'lane' }, session_id, cwd: dir, prompt_id: 'p1',
});
const post = (dir, { tool_use_id, subagent_type, prompt, agentId, session_id = 's1' }) => ({
  hook_event_name: 'PostToolUse', tool_name: 'Task', tool_use_id, tool_input: { subagent_type, prompt, description: 'lane' },
  tool_response: { agentId, prompt, description: 'lane' }, session_id, cwd: dir, prompt_id: 'p1',
});
const start = (dir, { agent_id, agent_type, session_id = 's1' }) => ({
  hook_event_name: 'SubagentStart', session_id, cwd: dir, prompt_id: 'p1', agent_id, agent_type, transcript_path: join(dir, 'no-such.jsonl'),
});
const stop = (dir, { agent_id, agent_type, session_id = 's1' }) => ({
  hook_event_name: 'SubagentStop', session_id, cwd: dir, agent_id, agent_type, transcript_path: join(dir, 'no-such.jsonl'), last_assistant_message: 'done',
});
const readTouch = (dir, lane) => ({
  hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: join(dir, 'src', 'a.mjs') }, tool_response: 'export const a = 1;', session_id: 's1', cwd: dir, ...lane,
});
const bashTouch = (dir, lane, command = 'cat src/a.mjs', response = 'export const a = 1;') => ({
  hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: response, session_id: 's1', cwd: dir, ...lane,
});

const OFF_BRIEF = `Work on src/a.mjs and nothing else.\n${OFF}\n`;
const ON_BRIEF = 'Work on src/a.mjs and nothing else.\n';

// A bound lane: Pre + Post through the owner, as H22 records them.
async function boundLane(dir, { tool_use_id, agentId, subagent_type = 'general', prompt }) {
  await recordDispatchPre(dir, pre(dir, { tool_use_id, subagent_type, prompt }));
  await recordDispatchPost(dir, post(dir, { tool_use_id, subagent_type, prompt, agentId }));
}

function assertNoRecords(text, { art, hz }) {
  for (const needle of [art.id, art.id.slice(0, 8), 'alpha-art', hz.id, hz.title, 'knowledge_get']) {
    assert.ok(!text.includes(needle), `no record title or id may reach a blind lane (found ${needle})`);
  }
}

// ---------------------------------------------------------------------------
// Register capture and the accessor
// ---------------------------------------------------------------------------

test('register: Pre captures delivery off from the raw brief, even an oversize one whose prompt is nulled', async () => {
  const { dir, cleanup } = makeProject();
  try {
    await recordDispatchPre(dir, pre(dir, { tool_use_id: 'tu1', subagent_type: 'general', prompt: OFF_BRIEF }));
    const big = `${'y'.repeat(600 * 1024)}\n${OFF}`;
    await recordDispatchPre(dir, pre(dir, { tool_use_id: 'tu2', subagent_type: 'general', prompt: big }));
    await recordDispatchPre(dir, pre(dir, { tool_use_id: 'tu3', subagent_type: 'general', prompt: ON_BRIEF }));
    const recs = Object.fromEntries(
      readdirSync(dispatchStateDir(dir)).map((f) => {
        const r = JSON.parse(readFileSync(join(dispatchStateDir(dir), f), 'utf8'));
        return [r.tool_use_id, r];
      })
    );
    assert.equal(recs.tu1.delivery, 'off');
    assert.equal(recs.tu2.prompt, null);
    assert.equal(recs.tu2.oversize, true);
    assert.equal(recs.tu2.delivery, 'off', 'the line past the size cap is still captured');
    assert.equal(recs.tu3.delivery, undefined, 'an on brief stores no field');
  } finally {
    cleanup();
  }
});

test('accessor: off for the bound off lane, on for the bound on lane in the same session, on for the main thread', async () => {
  const { dir, cleanup } = makeProject();
  try {
    await boundLane(dir, { tool_use_id: 'tuA', agentId: 'agentA', prompt: OFF_BRIEF });
    await boundLane(dir, { tool_use_id: 'tuB', agentId: 'agentB', prompt: ON_BRIEF });
    assert.equal(readDeliveryPolicy(dir, { session_id: 's1', agent_id: 'agentA', agent_type: 'general' }), 'off');
    assert.equal(readDeliveryPolicy(dir, { session_id: 's1', agent_id: 'agentB', agent_type: 'general' }), 'on');
    assert.equal(readDeliveryPolicy(dir, { session_id: 's1' }), 'on', 'no agent_id is the main thread');
  } finally {
    cleanup();
  }
});

test('accessor: an unattributed agent beside a pending same-type off sibling is unknown; another type, or no off anywhere, is on', async () => {
  const { dir, cleanup } = makeProject();
  try {
    assert.equal(readDeliveryPolicy(dir, { session_id: 's1', agent_id: 'agentX', agent_type: 'general' }), 'on', 'absent state reads on');
    await recordDispatchPre(dir, pre(dir, { tool_use_id: 'tuOn', subagent_type: 'general', prompt: ON_BRIEF }));
    assert.equal(readDeliveryPolicy(dir, { session_id: 's1', agent_id: 'agentX', agent_type: 'general' }), 'on', 'a session with no off line is unchanged');
    await recordDispatchPre(dir, pre(dir, { tool_use_id: 'tuOff', subagent_type: 'general', prompt: OFF_BRIEF }));
    assert.equal(readDeliveryPolicy(dir, { session_id: 's1', agent_id: 'agentX', agent_type: 'general' }), 'unknown');
    assert.equal(readDeliveryPolicy(dir, { session_id: 's1', agent_id: 'agentX', agent_type: 'reviewer' }), 'on');
    assert.equal(readDeliveryPolicy(dir, { session_id: 's2', agent_id: 'agentX', agent_type: 'general' }), 'on', 'another session is not a sibling');
    assert.equal(readDeliveryPolicy(dir, { session_id: 's1', agent_id: 'agentX' }), 'unknown', 'no agent_type: any off record in the session holds it back');
  } finally {
    cleanup();
  }
});

test('accessor: a poisoned entry or a malformed delivery field holds an unattributed agent back; reading mutates nothing', async () => {
  const { dir, cleanup } = makeProject();
  try {
    await recordDispatchPre(dir, pre(dir, { tool_use_id: 'tuOn', subagent_type: 'general', prompt: ON_BRIEF }));
    const sd = dispatchStateDir(dir);
    const file = join(sd, readdirSync(sd)[0]);
    const rec = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...rec, delivery: 'maybe' }));
    const before = readdirSync(sd).map((f) => [f, readFileSync(join(sd, f), 'utf8')]);
    assert.equal(readDeliveryPolicy(dir, { session_id: 's1', agent_id: 'agentX', agent_type: 'general' }), 'unknown');
    assert.deepEqual(readdirSync(sd).map((f) => [f, readFileSync(join(sd, f), 'utf8')]), before, 'read-only');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// SubagentStart staging
// ---------------------------------------------------------------------------

test('staging: an off lane gets no records, only the off notice beside the return contract; an on lane in the same session is staged', async () => {
  const { dir, cleanup, ...recs } = makeProject();
  try {
    await boundLane(dir, { tool_use_id: 'tuA', agentId: 'agentA', prompt: OFF_BRIEF });
    await boundLane(dir, { tool_use_id: 'tuB', agentId: 'agentB', prompt: ON_BRIEF });
    const off = runHook('h19-dispatch-staging.mjs', start(dir, { agent_id: 'agentA', agent_type: 'general' }), dir);
    assert.equal(off.code, 0, off.stderr);
    const offText = context(off);
    assert.ok(offText.includes(DELIVERY_OFF_NOTICE));
    assert.ok(!offText.includes(DELIVERY_HELD_BACK_NOTICE));
    assert.match(offText, /STERLING DEFAULT RETURN CONTRACT/, 'the return contract is kept');
    assertNoRecords(offText, recs);

    const on = runHook('h19-dispatch-staging.mjs', start(dir, { agent_id: 'agentB', agent_type: 'general' }), dir);
    const onText = context(on);
    assert.ok(onText.includes('alpha-art'), 'the on lane is staged as before');
    assert.ok(!onText.includes('STERLING DELIVERY'));
  } finally {
    cleanup();
  }
});

test('staging: unattributable same-type parallel siblings where one is off are both held back and disclosed', async () => {
  const { dir, cleanup, ...recs } = makeProject();
  try {
    await recordDispatchPre(dir, pre(dir, { tool_use_id: 'tuOff', subagent_type: 'general', prompt: OFF_BRIEF }));
    await recordDispatchPre(dir, pre(dir, { tool_use_id: 'tuOn', subagent_type: 'general', prompt: ON_BRIEF }));
    for (const agent_id of ['agentP', 'agentQ']) {
      const r = runHook('h19-dispatch-staging.mjs', start(dir, { agent_id, agent_type: 'general' }), dir);
      assert.equal(r.code, 0, r.stderr);
      const text = context(r);
      assert.ok(text.includes(DELIVERY_HELD_BACK_NOTICE), agent_id);
      assert.ok(!text.includes('could not be attributed'), 'the query-the-store line is replaced for a held-back lane');
      assertNoRecords(text, recs);
    }
  } finally {
    cleanup();
  }
});

test('staging: a session with no off line is unchanged', async () => {
  const { dir, cleanup } = makeProject();
  try {
    await boundLane(dir, { tool_use_id: 'tuB', agentId: 'agentB', prompt: ON_BRIEF });
    const text = context(runHook('h19-dispatch-staging.mjs', start(dir, { agent_id: 'agentB', agent_type: 'general' }), dir));
    assert.ok(text.includes('alpha-art'));
    assert.ok(!text.includes('STERLING DELIVERY'));
  } finally {
    cleanup();
  }
});

test('resume: an off lane stays off after SubagentStop and after the session boundary', async () => {
  const { dir, cleanup, ...recs } = makeProject();
  try {
    const lane = { agent_id: 'agentA', agent_type: 'general' };
    await boundLane(dir, { tool_use_id: 'tuA', agentId: 'agentA', prompt: OFF_BRIEF });
    assert.equal(runHook('h22-dispatch-register.mjs', start(dir, lane), dir).code, 0);
    assert.equal(runHook('h22-dispatch-register.mjs', stop(dir, lane), dir).code, 0);
    const tomb = readdirSync(dispatchStateDir(dir)).find((f) => f.startsWith('done-'));
    assert.ok(tomb, 'Stop left a tombstone');
    const body = JSON.parse(readFileSync(join(dispatchStateDir(dir), tomb), 'utf8'));
    assert.equal(body.prompt, null);
    assert.equal(body.delivery, 'off', 'the policy survives Stop while the prompt does not');

    const resumed = runHook('h19-dispatch-staging.mjs', start(dir, lane), dir);
    const text = context(resumed);
    assert.ok(text.includes(DELIVERY_OFF_NOTICE), 'a resumed lane is told it is still off');
    assertNoRecords(text, recs);
    assertNoRecords(context(runHook('h19-knowledge-delivery.mjs', readTouch(dir, lane), dir)), recs);

    sessionBoundarySweep(dir);
    assert.equal(readDeliveryPolicy(dir, { session_id: 's2', ...lane }), 'off', 'a resume across the boundary stays off');
  } finally {
    cleanup();
  }
});

test('resolution: a derived binding is read as the lane policy too', async () => {
  const { dir, cleanup } = makeProject();
  try {
    await recordDispatchPre(dir, pre(dir, { tool_use_id: 'tuA', subagent_type: 'general', prompt: OFF_BRIEF }));
    const res = await resolveDispatchStart(dir, { session_id: 's1', agent_id: 'agentA', agent_type: 'general' }, { consumer: 'h19' });
    assert.equal(res.source, 'derived-type-unique');
    assert.equal(readDeliveryPolicy(dir, { session_id: 's1', agent_id: 'agentA', agent_type: 'general' }), 'off');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Tool-time hooks
// ---------------------------------------------------------------------------

test('H19 Read: the off lane gets only the notice; the on lane in the same session still gets the article', async () => {
  const { dir, cleanup, ...recs } = makeProject();
  try {
    await boundLane(dir, { tool_use_id: 'tuA', agentId: 'agentA', prompt: OFF_BRIEF });
    await boundLane(dir, { tool_use_id: 'tuB', agentId: 'agentB', prompt: ON_BRIEF });
    const off = runHook('h19-knowledge-delivery.mjs', readTouch(dir, { agent_id: 'agentA', agent_type: 'general' }), dir);
    assert.equal(off.code, 0, off.stderr);
    assert.equal(context(off), DELIVERY_OFF_NOTICE);
    const on = runHook('h19-knowledge-delivery.mjs', readTouch(dir, { agent_id: 'agentB', agent_type: 'general' }), dir);
    assert.ok(context(on).includes('alpha-art'));
    assertNoRecords(context(off), recs);
  } finally {
    cleanup();
  }
});

test('H19 Bash: the off lane gets only the notice; the on lane still gets the pointer', async () => {
  const { dir, cleanup, ...recs } = makeProject();
  try {
    await boundLane(dir, { tool_use_id: 'tuA', agentId: 'agentA', prompt: OFF_BRIEF });
    await boundLane(dir, { tool_use_id: 'tuB', agentId: 'agentB', prompt: ON_BRIEF });
    const off = runHook('h19-bash-delivery.mjs', bashTouch(dir, { agent_id: 'agentA', agent_type: 'general' }), dir);
    assert.equal(off.code, 0, off.stderr);
    assert.equal(context(off), DELIVERY_OFF_NOTICE);
    assertNoRecords(context(off), recs);
    const on = runHook('h19-bash-delivery.mjs', bashTouch(dir, { agent_id: 'agentB', agent_type: 'general' }), dir);
    assert.ok(context(on).includes('alpha-art'));
  } finally {
    cleanup();
  }
});

test('H23: the off lane gets only the notice; the on lane still gets the hazard pointer', async () => {
  const { dir, cleanup, ...recs } = makeProject();
  try {
    await boundLane(dir, { tool_use_id: 'tuA', agentId: 'agentA', prompt: OFF_BRIEF });
    await boundLane(dir, { tool_use_id: 'tuB', agentId: 'agentB', prompt: ON_BRIEF });
    const off = runHook('h23-output-axis.mjs', bashTouch(dir, { agent_id: 'agentA', agent_type: 'general' }, 'cat run.log', CONTENT_SENTENCE), dir);
    assert.equal(off.code, 0, off.stderr);
    assert.equal(context(off), DELIVERY_OFF_NOTICE);
    assert.ok(!off.stderr.includes('SECOND stdout payload'), 'the delivery body does not run after the notice');
    assertNoRecords(context(off), recs);
    const on = runHook('h23-output-axis.mjs', bashTouch(dir, { agent_id: 'agentB', agent_type: 'general' }, 'cat run.log', CONTENT_SENTENCE), dir);
    assert.ok(context(on).includes(recs.hz.id));
  } finally {
    cleanup();
  }
});

test('tool-time: an unattributed lane beside a pending same-type off sibling is held back on Read, Bash and H23', async () => {
  const { dir, cleanup, ...recs } = makeProject();
  try {
    await recordDispatchPre(dir, pre(dir, { tool_use_id: 'tuOff', subagent_type: 'general', prompt: OFF_BRIEF }));
    await recordDispatchPre(dir, pre(dir, { tool_use_id: 'tuOn', subagent_type: 'general', prompt: ON_BRIEF }));
    const lane = { agent_id: 'agentX', agent_type: 'general' };
    for (const [hook, input] of [
      ['h19-knowledge-delivery.mjs', readTouch(dir, lane)],
      ['h19-bash-delivery.mjs', bashTouch(dir, lane)],
      ['h23-output-axis.mjs', bashTouch(dir, lane, 'cat run.log', CONTENT_SENTENCE)],
    ]) {
      const r = runHook(hook, input, dir);
      assert.equal(r.code, 0, `${hook}: ${r.stderr}`);
      assert.equal(context(r), DELIVERY_HELD_BACK_NOTICE, hook);
      assertNoRecords(context(r), recs);
    }
  } finally {
    cleanup();
  }
});

test('tool-time: the main thread and lanes in a session with no off line are unchanged', async () => {
  const { dir, cleanup, ...recs } = makeProject();
  try {
    await boundLane(dir, { tool_use_id: 'tuB', agentId: 'agentB', prompt: ON_BRIEF });
    assert.ok(context(runHook('h19-knowledge-delivery.mjs', readTouch(dir, {}), dir)).includes('alpha-art'));
    assert.ok(context(runHook('h19-bash-delivery.mjs', bashTouch(dir, { agent_id: 'agentY', agent_type: 'general' }), dir)).includes('alpha-art'));
    assert.ok(context(runHook('h23-output-axis.mjs', bashTouch(dir, { agent_id: 'agentY', agent_type: 'general' }, 'cat run.log', CONTENT_SENTENCE), dir)).includes(recs.hz.id));
  } finally {
    cleanup();
  }
});
