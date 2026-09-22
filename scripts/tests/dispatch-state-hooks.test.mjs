// DISPATCH STATE MACHINE — HOOK-LEVEL PINS (h22-dispatch-register.mjs +
// h19-dispatch-staging.mjs, driven through their real stdin shapes).
//
// CONTRACT SOURCE (opened, not paraphrased): decision
// `dispatch-state-machine-pre-slot-post-binding-locked-start-resolution-replaces-transcript-attribution`
// (knowledge_get 7c515e52-19a8-41cf-8c2d-6da61f1c8425) §2, §3, §5, §6, §7(d),
// §8; board 5445066b; stdin shapes and the MEASURED interleaving from
// research_finding foreign_2bad782a (Pre×6 strictly serialized, Post and the child's
// SubagentStart within 0.1-9.3 ms in EITHER order — Start first 1 of 6).
//
// H4 READ WALL HONORED: no implementation file was opened by this file's
// author. The harness (temp project + .sterling/config.json + SterlingStore,
// runHook via spawnSync with JSON stdin, register/ledger readers) is adapted
// from scripts/tests/h22-attribution.test.mjs and
// scripts/tests/h19-dispatch-staging.test.mjs — both TESTS, reused without
// modifying them.
//
// TWO DELIBERATE CONSTRUCTIONS, stated rather than assumed:
//   (1) Every SubagentStart stdin below points transcript_path at a file that
//       DOES NOT EXIST. Under the decision the parent transcript is never read
//       at Start, so this must not weaken anything — and it makes any surviving
//       transcript reader fail LOUDLY here (it would find no dispatch block and
//       every own-territory assertion would go red) instead of passing by
//       accident.
//   (2) The state directory is read by RAW FILE (the §1 path is part of the
//       contract) rather than through the owner's own reader, so a pin here
//       cannot be satisfied by a reader bug that agrees with the writer.
//
// NEW FILE — nothing is RETIRED here.
//
// EXPECTED FAILURE SHAPE TODAY: the Pre/Post/Failure branches, the state
// directory and the resolver do not exist, so (a) no state record is ever
// written (readStateRecords() returns [] and every state assertion fails on
// its own assertion), (b) a Start still reads the parent transcript, which is
// deliberately ABSENT here, so h22 writes files:[] with no attribution field
// and h19 stages nothing and emits no disclosure line — the own-territory,
// attribution, and disclosure-line assertions all fail as assertions. The
// hooks.json and no-lastDispatch* grep pins fail on their own assertions too.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const H22_PATH = join(HOOKS, 'h22-dispatch-register.mjs');
const H19_PATH = join(HOOKS, 'h19-dispatch-staging.mjs');
const DISPATCH_PROMPT_LIB = join(HOOKS, 'lib', 'dispatch-prompt.mjs');
const HOOKS_JSON = join(root, 'hooks', 'hooks.json');
const BUNDLE_DIR = join(root, 'hooks');
const NOW = '2026-09-08T12:00:00.000Z';

let SterlingStore;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const CONFIG = {
  toolchains: [{ adapter: 'node', path_globs: ['**/*.mjs'], test_globs: ['tests/**', '**/*.test.mjs'], run_commands: { test: 'node --test' } }],
  caps: { dispatch_per_agent_type: 25, inner_loop_n: 3, outer_loop_m: 2, research_resume_per_phase: 2, phase_death_cap: 1 },
  context_watch: { windows: { default: 200_000, 'claude-fable-5': 200_000 } },
};

function envelope(type) {
  return {
    id: randomUUID(), type, created_at: NOW, updated_at: NOW, author: 'conductor',
    status: 'active', superseded_by: null, links: [], scope: 'project', stack_tags: [],
  };
}
function article(slug, paths) {
  return {
    ...envelope('feature_article'),
    slug, title: slug,
    what_it_does: `${slug} does the ${slug} thing`,
    intended_behavior: `${slug} intends`,
    files: paths.map((p) => ({ path: p, role: 'owner' })),
    current_ac: [{ ac_id: 'AC1', text: `${slug} works`, verifiable_at: 'final' }],
    dependencies: { relies_on: [], relied_by: [] },
    state: 'active', version: 1, history: [], live_test_refs: [],
  };
}

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-dispatch-state-hooks-'));
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify(CONFIG));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  return { dir, store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function runHook(scriptPath, input, cwd) {
  const r = spawnSync(process.execPath, [scriptPath], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1' },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const h22 = (input, dir) => runHook(H22_PATH, input, dir);
const h19 = (input, dir) => runHook(H19_PATH, input, dir);

// --- stdin shapes (research_finding foreign_2bad782a) ------------------------------

const preInput = (dir, { tool_use_id, subagent_type, prompt, description = 'a lane', session_id = 's1', tool_name = 'Task' }) => ({
  hook_event_name: 'PreToolUse',
  tool_name,
  tool_use_id,
  tool_input: { subagent_type, prompt, description },
  session_id,
  cwd: dir,
  transcript_path: join(dir, 't', 'parent.jsonl'),
  prompt_id: 'pr-1',
});

const postInput = (dir, { tool_use_id, subagent_type, prompt, agentId, description = 'a lane', session_id = 's1', tool_name = 'Task' }) => ({
  hook_event_name: 'PostToolUse',
  tool_name,
  tool_use_id,
  tool_input: { subagent_type, prompt, description },
  tool_response: {
    isAsync: true, status: 'async_launched', agentId, description,
    resolvedModel: 'claude-x', prompt, outputFile: join(dir, 'out.txt'), canReadOutputFile: true,
  },
  session_id,
  cwd: dir,
  transcript_path: join(dir, 't', 'parent.jsonl'),
  prompt_id: 'pr-1',
});

const failInput = (dir, { tool_use_id, subagent_type, prompt, session_id = 's1' }) => ({
  hook_event_name: 'PostToolUseFailure',
  tool_name: 'Task',
  tool_use_id,
  tool_input: { subagent_type, prompt, description: 'a lane' },
  error: 'launch failed',
  session_id,
  cwd: dir,
});

// CONSTRUCTION (1): transcript_path names a file that never exists.
const startInput = (dir, { agent_id, agent_type, session_id = 's1' }) => ({
  hook_event_name: 'SubagentStart',
  session_id,
  transcript_path: join(dir, 't', 'no-such-parent-transcript.jsonl'),
  cwd: dir,
  prompt_id: 'pr-1',
  agent_id,
  agent_type,
});

const stopInput = (dir, { agent_id, agent_type, session_id = 's1' }) => ({
  hook_event_name: 'SubagentStop',
  session_id,
  transcript_path: join(dir, 't', 'no-such-parent-transcript.jsonl'),
  cwd: dir,
  agent_id,
  agent_type,
  last_assistant_message: 'done',
});

// --- readers ---------------------------------------------------------------

function registerPath(dir) {
  return join(dir, '.sterling', 'transient', 'dispatch-register.json');
}
function readRegister(dir) {
  return existsSync(registerPath(dir)) ? JSON.parse(readFileSync(registerPath(dir), 'utf8')) : [];
}
function writeRegisterRaw(dir, entries) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(registerPath(dir), JSON.stringify(entries));
}
function entryFor(dir, agentId) {
  return readRegister(dir).filter((e) => e.agent_id === agentId).at(-1);
}

// CONSTRUCTION (2): raw read of the §1 path.
function stateDir(dir) {
  return join(dir, '.sterling', 'transient', 'dispatch-state');
}
function readStateRecords(dir) {
  const d = stateDir(dir);
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return { file: f, record: JSON.parse(readFileSync(join(d, f), 'utf8')) };
      } catch {
        return { file: f, record: null };
      }
    });
}
function stateFor(dir, toolUseId) {
  return readStateRecords(dir).find((x) => x.record?.tool_use_id === toolUseId)?.record ?? null;
}
function derivedState(rec) {
  if (!rec) return 'absent';
  if (rec.terminal) return 'terminal';
  if (rec.started) return 'started';
  if (rec.post_binding || rec.derived_binding) return 'bound';
  return 'pending';
}

function ctxOf(r) {
  if (!r.stdout || !r.stdout.trim()) return '';
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    assert.fail(`stdout was not valid JSON: ${JSON.stringify(r.stdout)}`);
  }
  return parsed?.hookSpecificOutput?.additionalContext ?? '';
}
const outputOf = (r) => `${r.stdout}\n${r.stderr}`;
const ANY_CODE = /\[[a-z][a-z0-9_]*\]/;

// §6, VERBATIM. Asserted as a PREFIX up to and including the case token, per
// the contract sheet — the tail ("no territory was staged; ...") is wording.
const STAGING_DISCLOSURE = (kase) =>
  `STERLING DISPATCH STAGING (H19): this spawn's dispatch could not be attributed at Start [${kase}]`;

// ===========================================================================
// PIN H1 — THE MEASURED INTERLEAVING (the board's done-when condition)
// ===========================================================================

test('DSH-1: six different-type dispatches in ONE message, Pre×6 then Post/Start interleaved BOTH ways — each Start gets exactly its OWN territory in h22 and its OWN article in h19', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    const lanes = ['coder', 'reviewer-correctness', 'explorer', 'librarian', 'debugger', 'test-writer'].map((type, i) => ({
      type,
      i,
      tool_use_id: `toolu_lane_${i}`,
      agent_id: `agent-lane-${i}`,
      file: `src/f${i}.mjs`,
      slug: `own-${i}`,
    }));
    for (const lane of lanes) store.create(article(lane.slug, [lane.file]));

    // Pre×6 first, strictly serialized — exactly as measured.
    for (const lane of lanes) {
      const r = h22(
        preInput(dir, {
          tool_use_id: lane.tool_use_id,
          subagent_type: lane.type,
          prompt: `Lane ${lane.i}: work on ${lane.file}.\nREVIEW-TERRITORY: ["${lane.file}"]\nReport back.`,
        }),
        dir
      );
      assert.equal(r.code, 0, `Pre must never deny: ${r.stderr}`);
    }
    assert.equal(readStateRecords(dir).length, 6, 'six dispatches -> six state records, one per tool_use_id');

    // Per dispatch: EVEN lanes get Post-then-Start, ODD lanes Start-then-Post
    // (measured: Start fired before Post in 1 of 6).
    const h19Ctx = new Map();
    for (const lane of lanes) {
      const post = () =>
        h22(
          postInput(dir, {
            tool_use_id: lane.tool_use_id,
            subagent_type: lane.type,
            prompt: `Lane ${lane.i}: work on ${lane.file}.\nREVIEW-TERRITORY: ["${lane.file}"]\nReport back.`,
            agentId: lane.agent_id,
          }),
          dir
        );
      const starts = () => {
        const a = h19(startInput(dir, { agent_id: lane.agent_id, agent_type: lane.type }), dir);
        assert.equal(a.code, 0, `h19 Start must never deny: ${a.stderr}`);
        h19Ctx.set(lane.agent_id, ctxOf(a));
        const b = h22(startInput(dir, { agent_id: lane.agent_id, agent_type: lane.type }), dir);
        assert.equal(b.code, 0, `h22 Start must never deny: ${b.stderr}`);
      };
      if (lane.i % 2 === 0) {
        assert.equal(post().code, 0);
        starts();
      } else {
        starts();
        assert.equal(post().code, 0);
      }
    }

    for (const lane of lanes) {
      const entry = entryFor(dir, lane.agent_id);
      assert.ok(entry, `lane ${lane.i} has a register entry`);
      assert.deepEqual(entry.files, [lane.file], `lane ${lane.i} (${lane.type}) is attributed EXACTLY its own declared file`);
      assert.equal(entry.attribution, 'block', 'an attributed Start is precise — H26 only ever compares exact "block" entries');
      assert.ok(
        entry.attribution_case === 'post' || entry.attribution_case === 'derived-type-unique',
        `the entry records HOW it was attributed, got ${JSON.stringify(entry.attribution_case)}`
      );

      const ctx = h19Ctx.get(lane.agent_id);
      assert.match(ctx, new RegExp(`${lane.slug} does the ${lane.slug} thing`), `h19 staged lane ${lane.i}'s OWN owning article`);
      for (const other of lanes) {
        if (other.i === lane.i) continue;
        assert.doesNotMatch(ctx, new RegExp(`${other.slug} does the ${other.slug} thing`), `lane ${lane.i} never receives lane ${other.i}'s territory (the 4-of-6 measured defect)`);
      }
      assert.doesNotMatch(ctx, /could not be attributed at Start/, `lane ${lane.i} was attributable — no disclosure line`);
    }
  } finally {
    cleanup();
  }
});
// SABOTAGE: resolve the Start from the parent transcript's last dispatching
// message (the DELETED lastDispatchBlocks path) instead of the state record —
// with transcript_path deliberately absent, every files/article assertion goes
// red at once. Narrower sabotage: drop the subagent_type filter from
// derivation — the ODD lanes (Start before Post) start matching each other's
// slots and their per-lane file assertions go red while the EVEN lanes, bound
// by Post, stay green. That split is why both orders are exercised.

// ===========================================================================
// PIN H2 — h19-first / h22-first / Post-between converge on ONE record
// ===========================================================================

function stageOne(dir, { tool_use_id = 'toolu_conv', type = 'coder', file = 'src/conv.mjs' } = {}) {
  const prompt = `Please work on ${file}.\nREVIEW-TERRITORY: ["${file}"]`;
  assert.equal(h22(preInput(dir, { tool_use_id, subagent_type: type, prompt }), dir).code, 0);
  return { tool_use_id, type, file, prompt };
}

test('DSH-2a: h19 Start FIRST then h22 Start — one state record, started.by carries BOTH consumers, both staged the same prompt', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('conv', ['src/conv.mjs']));
    const d = stageOne(dir);
    const a = h19(startInput(dir, { agent_id: 'agent-c1', agent_type: d.type }), dir);
    const b = h22(startInput(dir, { agent_id: 'agent-c1', agent_type: d.type }), dir);
    assert.equal(a.code, 0, a.stderr);
    assert.equal(b.code, 0, b.stderr);

    assert.equal(readStateRecords(dir).length, 1, 'two consumers, ONE record — never a second file per consumer');
    const rec = stateFor(dir, d.tool_use_id);
    assert.equal(derivedState(rec), 'started');
    assert.equal(rec.started.agent_id, 'agent-c1');
    assert.deepEqual([...rec.started.by].sort(), ['h19', 'h22'], 'each consumer appends itself exactly once');
    assert.match(ctxOf(a), /conv does the conv thing/, 'h19 staged the resolved prompt');
    assert.deepEqual(entryFor(dir, 'agent-c1').files, ['src/conv.mjs'], 'h22 registered the same resolution');
  } finally {
    cleanup();
  }
});

test('DSH-2b: h22 Start FIRST then h19 Start — the same single record and the same union of consumers (order-independent)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('conv', ['src/conv.mjs']));
    const d = stageOne(dir);
    const b = h22(startInput(dir, { agent_id: 'agent-c2', agent_type: d.type }), dir);
    const a = h19(startInput(dir, { agent_id: 'agent-c2', agent_type: d.type }), dir);
    assert.equal(b.code, 0, b.stderr);
    assert.equal(a.code, 0, a.stderr);

    assert.equal(readStateRecords(dir).length, 1);
    const rec = stateFor(dir, d.tool_use_id);
    assert.deepEqual([...rec.started.by].sort(), ['h19', 'h22']);
    assert.match(ctxOf(a), /conv does the conv thing/, 'the SECOND consumer still resolves — the first did not consume the record away');
    assert.deepEqual(entryFor(dir, 'agent-c2').files, ['src/conv.mjs']);
  } finally {
    cleanup();
  }
});
// SABOTAGE (2a/2b): read-and-DELETE the record at the first Start (the board's
// original candidate (a) wording) — whichever consumer runs second gets
// 'no-slot', so its article/files assertion goes red in exactly one of the two
// arms. Running BOTH orders is what makes that visible.

test('DSH-2c: a Post landing BETWEEN the two Starts converges on the same record — the derivation is CONFIRMED, never duplicated or overwritten', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('conv', ['src/conv.mjs']));
    const d = stageOne(dir);
    const a = h19(startInput(dir, { agent_id: 'agent-c3', agent_type: d.type }), dir);
    assert.equal(h22(postInput(dir, { ...d, agentId: 'agent-c3' }), dir).code, 0);
    const b = h22(startInput(dir, { agent_id: 'agent-c3', agent_type: d.type }), dir);
    assert.equal(a.code, 0, a.stderr);
    assert.equal(b.code, 0, b.stderr);

    assert.equal(readStateRecords(dir).length, 1, 'the Post binds the EXISTING record — it never creates a post-only twin');
    const rec = stateFor(dir, d.tool_use_id);
    assert.equal(rec.post_binding?.agent_id, 'agent-c3');
    assert.equal(rec.post_binding?.confirmed_derived, true, 'the Post confirms h19\'s derivation rather than contradicting it');
    assert.equal(rec.started.agent_id, 'agent-c3', 'started is immutable — the same agent either way');
    assert.equal(rec.derived_post_mismatch, undefined, 'agreeing evidence is not a mismatch');
    assert.deepEqual(entryFor(dir, 'agent-c3').files, ['src/conv.mjs']);
  } finally {
    cleanup();
  }
});
// SABOTAGE: have the Post path CREATE a record whenever it cannot find one by
// its own re-derived key (rather than by tool_use_id) — records.length becomes
// 2 and that assertion goes red. Second sabotage: let the Post overwrite
// started — the started.agent_id/mismatch assertions go red.

// ===========================================================================
// PIN H3 — the two UNATTRIBUTABLE shapes, in both consumers
// ===========================================================================

test('DSH-3: two SAME-TYPE pending slots and a Post that never comes — h22 writes files:[] / "unattributable" / attribution "none", h19 emits the [same-type-siblings-in-flight] line', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('twinA', ['src/twin-a.mjs']));
    store.create(article('twinB', ['src/twin-b.mjs']));
    for (const [id, file] of [['toolu_twin_a', 'src/twin-a.mjs'], ['toolu_twin_b', 'src/twin-b.mjs']]) {
      assert.equal(
        h22(preInput(dir, { tool_use_id: id, subagent_type: 'coder', prompt: `work on ${file}\nREVIEW-TERRITORY: ["${file}"]` }), dir).code,
        0
      );
    }

    const a = h19(startInput(dir, { agent_id: 'agent-twin', agent_type: 'coder' }), dir);
    const b = h22(startInput(dir, { agent_id: 'agent-twin', agent_type: 'coder' }), dir);
    assert.equal(a.code, 0, a.stderr);
    assert.equal(b.code, 0, b.stderr);

    const entry = entryFor(dir, 'agent-twin');
    assert.ok(entry, 'an unattributable Start STILL appends its round — the entry exists, it just declares nothing');
    assert.deepEqual(entry.files, [], 'no territory is guessed from an ambiguous pair');
    assert.equal(entry.files_source, 'unattributable');
    assert.equal(entry.attribution, 'none', 'H26 skips anything but exact "block" — "none" is the fail-closed value, not a missing field');

    const ctx = ctxOf(a);
    assert.ok(ctx.includes(STAGING_DISCLOSURE('same-type-siblings-in-flight')), `h19 must disclose the exact case; got: ${ctx}`);
    assert.doesNotMatch(ctx, /twinA does the twinA thing/, 'nothing is staged for an unattributable Start');
    assert.doesNotMatch(ctx, /twinB does the twinB thing/, 'and certainly not the union of the two candidates');

    for (const id of ['toolu_twin_a', 'toolu_twin_b']) {
      assert.equal(derivedState(stateFor(dir, id)), 'pending', `${id} is untouched — an ambiguous Start consumes no slot`);
    }
  } finally {
    cleanup();
  }
});
// SABOTAGE: fall back to the union of the same-type candidates (the retired
// attribution:'union' behaviour) — files/attribution and both doesNotMatch
// assertions go red at once. Second sabotage: swallow the h19 line when
// nothing was staged — the disclosure assertion goes red and the child is
// silently starved with no way to know it.

test('DSH-4: a Start with NO state at all (a stale session that never loaded the Pre registration) is an honest [no-slot] — never a confident wrong answer', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('lonely', ['src/lonely.mjs']));
    const a = h19(startInput(dir, { agent_id: 'agent-nostate', agent_type: 'coder' }), dir);
    const b = h22(startInput(dir, { agent_id: 'agent-nostate', agent_type: 'coder' }), dir);
    assert.equal(a.code, 0, a.stderr);
    assert.equal(b.code, 0, b.stderr);

    const ctx = ctxOf(a);
    assert.ok(ctx.includes(STAGING_DISCLOSURE('no-slot')), `expected the no-slot disclosure; got: ${ctx}`);
    assert.doesNotMatch(ctx, /lonely does the lonely thing/, 'no transcript fallback, no guess');
    assert.match(ctx, /STERLING DEFAULT RETURN CONTRACT/, 'the unconditional contract injection still fires (decision 04982f45) — the disclosure rides BESIDE it'); // not-a-citation: fixture id

    const entry = entryFor(dir, 'agent-nostate');
    assert.ok(entry, 'the round is still appended');
    assert.deepEqual(entry.files, []);
    assert.equal(entry.attribution, 'none');
    assert.equal(entry.files_source, 'unattributable');
  } finally {
    cleanup();
  }
});
// SABOTAGE: keep lastDispatchPrompts as a fallback "when no slot exists" (the
// explicitly rejected alternative) — the doesNotMatch and files:[] assertions
// go red. Second sabotage: emit the disclosure INSTEAD of the return contract
// — the CONTRACT match goes red (shared-fate regression).

// ===========================================================================
// PIN H5 — RESUME
// ===========================================================================

test('DSH-5: a RESUME (an already-ended round for this agent_id + a fresh same-type pending slot) stages nothing, says nothing, consumes no slot — and still appends a round', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('freshlane', ['src/fresh.mjs']));
    writeRegisterRaw(dir, [
      {
        agent_id: 'agent-resumed', agent_type: 'coder', session_id: 's1',
        files: ['src/round1.mjs'], files_source: 'review-territory', attribution: 'block',
        at: '2026-09-08T11:00:00.000Z', round: 1,
        ended: { at: '2026-09-08T11:30:00.000Z', event: 'subagent-stop' },
      },
    ]);
    // Somebody ELSE's fresh dispatch of the same type is pending.
    assert.equal(
      h22(preInput(dir, { tool_use_id: 'toolu_someone_else', subagent_type: 'coder', prompt: 'work on src/fresh.mjs\nREVIEW-TERRITORY: ["src/fresh.mjs"]' }), dir).code,
      0
    );

    const a = h19(startInput(dir, { agent_id: 'agent-resumed', agent_type: 'coder' }), dir);
    const b = h22(startInput(dir, { agent_id: 'agent-resumed', agent_type: 'coder' }), dir);
    assert.equal(a.code, 0, a.stderr);
    assert.equal(b.code, 0, b.stderr);

    const ctx = ctxOf(a);
    assert.doesNotMatch(ctx, /freshlane does the freshlane thing/, "a resumed agent must never be handed a stranger's territory");
    assert.doesNotMatch(ctx, /could not be attributed at Start/, '§6: on "resume" h19 emits nothing extra — a resume is not a failure');

    assert.equal(derivedState(stateFor(dir, 'toolu_someone_else')), 'pending', 'the fresh slot is still there for its real owner');

    const rounds = readRegister(dir).filter((e) => e.agent_id === 'agent-resumed');
    assert.equal(rounds.length, 2, 'each Start is its own round (decision 24dc4c63) — a resume appends round 2'); // not-a-citation: fixture id
    const unended = rounds.filter((e) => !e.ended);
    assert.equal(unended.length, 1);
    assert.deepEqual(unended[0].files, []);
    assert.equal(unended[0].attribution, 'none');
  } finally {
    cleanup();
  }
});
// SABOTAGE: drop the register-round half of the resume guard (§5(ii)) — the
// resumed Start derives the stranger's slot, so the freshlane doesNotMatch,
// the still-pending assertion and the attribution:'none' assertion all go red.
// Second sabotage: skip the register append for a resume — rounds.length goes
// red and the resumed round's reviewer receipt can never be minted.

// ===========================================================================
// PIN H6 — STOP
// ===========================================================================

test('DSH-6: SubagentStop ends the round and tombstones the record with prompt:null (reason "stop")', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('stopper', ['src/stop.mjs']));
    const d = stageOne(dir, { tool_use_id: 'toolu_stop', file: 'src/stop.mjs' });
    assert.equal(h22(postInput(dir, { ...d, agentId: 'agent-stop' }), dir).code, 0);
    assert.equal(h22(startInput(dir, { agent_id: 'agent-stop', agent_type: d.type }), dir).code, 0);

    const r = h22(stopInput(dir, { agent_id: 'agent-stop', agent_type: d.type }), dir);
    assert.equal(r.code, 0, r.stderr);

    const entry = entryFor(dir, 'agent-stop');
    assert.equal(entry.ended?.event, 'subagent-stop', 'Stop MARKS the round ended (A1) — it never deletes it');
    const rec = stateFor(dir, 'toolu_stop');
    assert.equal(derivedState(rec), 'terminal');
    assert.equal(rec.terminal.reason, 'stop');
    assert.equal(rec.prompt, null, 'the brief is dropped at Stop; the identity/forensics survive');
    assert.equal(rec.started?.agent_id, 'agent-stop');
  } finally {
    cleanup();
  }
});
// SABOTAGE: leave the state record 'started' at Stop (no tombstone) — the
// terminal/prompt assertions go red and the record lingers with a readable
// brief until the session boundary. Second sabotage: delete the state FILE at
// Stop instead of tombstoning — stateFor() returns null and derivedState reads
// 'absent', so the same assertions go red; the tombstone is the resume
// evidence §5(ii) needs.

// ===========================================================================
// PIN H7 — reviewer-class Start: derived is attributable, ambiguous is not
// ===========================================================================

test('DSH-7 CONTROL (placed FIRST): a reviewer-class Start attributed BY DERIVATION is a normal precise entry — never flagged unattributable', () => {
  const { dir, cleanup } = makeProject();
  try {
    assert.equal(
      h22(preInput(dir, {
        tool_use_id: 'toolu_rev_ok',
        subagent_type: 'reviewer-correctness',
        prompt: 'Please review the diff.\nREVIEW-TERRITORY: ["scripts/target-a.mjs"]',
      }), dir).code,
      0
    );
    const r = h22(startInput(dir, { agent_id: 'agent-rev-ok', agent_type: 'reviewer-correctness' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const entry = entryFor(dir, 'agent-rev-ok');
    assert.deepEqual(entry.files, ['scripts/target-a.mjs']);
    assert.equal(entry.attribution, 'block');
    assert.equal(entry.attribution_case, 'derived-type-unique', 'a type-unique pending slot IS exact by construction, reviewer class included');
    assert.notEqual(entry.files_source, 'unattributable', 'the reviewer class is no longer unattributable merely for being a reviewer — that residual (5d3747c1) is retired by the state machine');
  } finally {
    cleanup();
  }
});
// SABOTAGE: keep the pre-existing reviewer-class blanket override (flag every
// non-Post reviewer Start unattributable) — the attribution/files_source
// assertions go red. This control is what stops DSH-7 below from being
// satisfiable by "this class denies everything".

test('DSH-7: a reviewer-class Start with two same-type pending siblings IS flagged unattributable, and the case is disclosed by code', () => {
  const { dir, cleanup } = makeProject();
  try {
    for (const [id, file] of [['toolu_rev_1', 'scripts/r1.mjs'], ['toolu_rev_2', 'scripts/r2.mjs']]) {
      assert.equal(
        h22(preInput(dir, { tool_use_id: id, subagent_type: 'reviewer-correctness', prompt: `review it\nREVIEW-TERRITORY: ["${file}"]` }), dir).code,
        0
      );
    }
    const r = h22(startInput(dir, { agent_id: 'agent-rev-amb', agent_type: 'reviewer-correctness' }), dir);
    assert.equal(r.code, 0, r.stderr);
    const entry = entryFor(dir, 'agent-rev-amb');
    assert.deepEqual(entry.files, []);
    assert.equal(entry.files_source, 'unattributable');
    assert.equal(entry.attribution, 'none');
    assert.match(outputOf(r), ANY_CODE, 'the fail-closed Start is disclosed through the shared errors module, code first (A6) — never a silent downgrade');
  } finally {
    cleanup();
  }
});
// SABOTAGE: pick either sibling ("close enough" for an advisory) — files/
// files_source/attribution all go red. The CONTROL above must stay green under
// the same sabotage, which is how a real classification is told apart from a
// blanket one.

// ===========================================================================
// PIN H8 — §7(d) REGISTRATION + THE DELETED READERS
// ===========================================================================

function hooksJsonEventGroups(json, event) {
  const container = json?.hooks && typeof json.hooks === 'object' ? json.hooks : json;
  const groups = container?.[event];
  return Array.isArray(groups) ? groups : [];
}
function groupMentions(group, needle) {
  return JSON.stringify(group?.hooks ?? group ?? {}).includes(needle);
}

// CHANGED 2026-09-22 (decision `h22-observes-taskstop-to-end-a-killed-dispatch`,
// user-ruled): PostToolUse now carries a SECOND h22 group with matcher exactly
// "TaskStop", so the old "exactly one PostToolUse group" count could not hold.
// Every prior pin is kept: each event still has exactly one "Task|Agent" h22
// group, and the new group is pinned to the exact string "TaskStop".
test('DSH-8: hooks/hooks.json registers h22-dispatch-register on PreToolUse, PostToolUse AND PostToolUseFailure, each with matcher exactly "Task|Agent" — plus exactly one PostToolUse "TaskStop" group', () => {
  assert.equal(existsSync(HOOKS_JSON), true, `hooks/hooks.json must exist at ${HOOKS_JSON}`);
  const json = JSON.parse(readFileSync(HOOKS_JSON, 'utf8'));
  const expected = { PreToolUse: ['Task|Agent'], PostToolUse: ['Task|Agent', 'TaskStop'], PostToolUseFailure: ['Task|Agent'] };
  for (const [event, matchers] of Object.entries(expected)) {
    const groups = hooksJsonEventGroups(json, event);
    const mine = groups.filter((g) => groupMentions(g, 'h22-dispatch-register'));
    assert.deepEqual(
      mine.map((g) => g.matcher).sort(),
      [...matchers].sort(),
      `${event}'s h22 groups must have exactly the matchers ${JSON.stringify(matchers)} (decision f99d527a normalized "Task|Agent") — got ${JSON.stringify(mine.map((g) => g.matcher))}` // not-a-citation: fixture id
    );
  }
});
// SABOTAGE: register only PreToolUse and PostToolUse (skipping
// PostToolUseFailure, §2's tombstone seam) — that event's length assertion
// goes red and an aborted dispatch leaves a pending orphan that poisons
// same-type derivation for the session. Second sabotage: widen a matcher to
// '.*' or 'Task' — the matcher equality goes red.

test('DSH-9: the DELETED transcript-tail readers survive NOWHERE — not in scripts/hooks/*.mjs, not in scripts/hooks/lib/dispatch-prompt.mjs, not in the generated hooks/ bundles', () => {
  const dead = ['lastDispatchPrompts', 'lastDispatchBlocks', 'attributeBlocks'];
  const targets = [];
  for (const d of [HOOKS, join(HOOKS, 'lib'), BUNDLE_DIR]) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      if (f.endsWith('.mjs')) targets.push(join(d, f));
    }
  }
  assert.ok(targets.length > 5, `harness: expected to scan a real hook set, found ${targets.length} files`);
  const bundles = targets.filter((p) => p.startsWith(BUNDLE_DIR));
  assert.ok(bundles.length > 0, 'harness: the GENERATED bundles must be scanned too — a stale bundle is what actually runs');

  for (const file of targets) {
    const body = readFileSync(file, 'utf8');
    for (const name of dead) {
      assert.equal(body.includes(name), false, `${file} still contains '${name}' — the transcript tail is the MEASURED defect, not a fallback`);
    }
  }
});
// SABOTAGE: leave the readers in place "unused" (or delete them from source
// but not rebuild the bundles) — the includes assertion goes red for exactly
// the file that kept them. The bundle half is the load-bearing one: the
// bundles are what the platform executes.

test('DSH-10: extractPathCandidates SURVIVES in scripts/hooks/lib/dispatch-prompt.mjs; parseReviewTerritory is GONE (no non-test reader, H22 dispatch-register slim-down)', async () => {
  assert.equal(existsSync(DISPATCH_PROMPT_LIB), true, 'the prompt-parsing lib is kept, not deleted with the tail readers');
  const mod = await import(pathToFileURL(DISPATCH_PROMPT_LIB).href);
  assert.equal(typeof mod.extractPathCandidates, 'function', 'extractPathCandidates stays exported — the consumers parse the resolved prompt with it');
  // parseReviewTerritory (decision 8f137474) is DELETED // not-a-citation: fixture id
  // — research_finding h22-dispatch-register-consumer-map-which-parts-have-a-
  // reader-september-2026 found no non-test reader of the REVIEW-TERRITORY
  // declared-territory override — h22's SubagentStart now writes `files` from
  // free-prose extraction only.
  for (const name of ['lastDispatchPrompts', 'lastDispatchBlocks', 'attributeBlocks', 'parseReviewTerritory']) {
    assert.equal(mod[name], undefined, `${name} must not survive as an export — an importable reader is a live fallback, not dead code`);
  }
});
// SABOTAGE: delete the whole lib along with the tail readers (over-deletion)
// — the extractPathCandidates typeof assertion goes red, and the decision's
// "derive territory at Pre instead" alternative (explicitly rejected: it
// splits parser authority) would be the only way back.

// ===========================================================================
// PIN H11 — PostToolUseFailure through the hook
// ===========================================================================

test('DSH-11: a PostToolUseFailure on a pending dispatch tombstones it, so its type is derivable again by a LATER real dispatch', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('survivor', ['src/survivor.mjs']));
    assert.equal(h22(preInput(dir, { tool_use_id: 'toolu_doomed', subagent_type: 'coder', prompt: 'doomed lane on src/doomed.mjs' }), dir).code, 0);
    const f = h22(failInput(dir, { tool_use_id: 'toolu_doomed', subagent_type: 'coder', prompt: 'doomed lane on src/doomed.mjs' }), dir);
    assert.equal(f.code, 0, `the Failure branch must never deny: ${f.stderr}`);
    const doomed = stateFor(dir, 'toolu_doomed');
    assert.equal(derivedState(doomed), 'terminal');
    assert.equal(doomed.terminal.reason, 'tool-failure');

    // A real dispatch of the SAME type now resolves cleanly — the tombstone is
    // not a candidate, so there is exactly one.
    assert.equal(
      h22(preInput(dir, { tool_use_id: 'toolu_live', subagent_type: 'coder', prompt: 'work on src/survivor.mjs\nREVIEW-TERRITORY: ["src/survivor.mjs"]' }), dir).code,
      0
    );
    const a = h19(startInput(dir, { agent_id: 'agent-live', agent_type: 'coder' }), dir);
    const b = h22(startInput(dir, { agent_id: 'agent-live', agent_type: 'coder' }), dir);
    assert.equal(a.code, 0, a.stderr);
    assert.equal(b.code, 0, b.stderr);
    assert.match(ctxOf(a), /survivor does the survivor thing/, 'a tombstoned sibling does not make the survivor ambiguous');
    assert.deepEqual(entryFor(dir, 'agent-live').files, ['src/survivor.mjs']);
  } finally {
    cleanup();
  }
});
// SABOTAGE: treat a terminal record as a derivation candidate — two candidates
// appear, the Start goes unattributable, and the article/files assertions go
// red. Second sabotage: no Failure branch at all (§7(a)'s accepted orphan
// case) — same reddening, which is exactly the availability cost the decision
// says is PINNED AND INSTRUMENTED rather than assumed away.

// ===========================================================================
// PIN H12 — §4(b): H1's SessionStart does BOTH halves of the boundary.
// (Homed HERE rather than in scripts/tests/h22-dispatch-register.test.mjs
// because this is the hook-level suite for the state machine, and that file's
// three existing H1 arms pin only the register deletion — a reader looking for
// "what the boundary does to dispatch state" would not find it there.)
//
// WHAT THIS PIN COVERS, AND WHAT IT DOES NOT — stated rather than implied.
// §4(b) says H1 calls sessionBoundarySweep INSIDE the existing
// deleteRegisterUnderLock hold, i.e. the sweep happens BEFORE the register file
// is removed. THIS PIN DOES NOT VERIFY THAT ORDER. Observing the order needs a
// fixture that makes the register deletion fail after the sweep succeeded (a
// read-only register file, or a contended lock), and I hold no Bash to build
// or confirm such a fixture — a pin whose fixture I cannot verify is worse than
// an honest gap, because a green would look like proof. THE ORDER IS VERIFIED
// BY THE CODER'S REPORT, NOT BY THIS PIN. What IS pinned here is the
// observable both-effects property: after one SessionStart, the pending record
// is terminal 'session-boundary' with its prompt dropped AND the register file
// is gone. A build that does one and skips the other fails this.
// ===========================================================================

// Env mirrors scripts/tests/h22-dispatch-register.test.mjs's own h1() helper
// (NO_COLOR / STERLING_NO_BANNER / STERLING_PLUGIN_ROOT) so the banner cannot
// interfere; copied from that TEST, never from the hook.
function runH1(dir, source) {
  const r = spawnSync(process.execPath, [join(HOOKS, 'h1-session-start.mjs')], {
    input: JSON.stringify({
      hook_event_name: 'SessionStart',
      source,
      session_id: 's1',
      transcript_path: join(dir, 't', 's1.jsonl'),
      cwd: dir,
      permission_mode: 'default',
    }),
    encoding: 'utf8',
    cwd: dir,
    timeout: 60_000,
    env: { ...process.env, STERLING_CURRENCY_DISABLE: '1', NO_COLOR: '1', STERLING_NO_BANNER: '1', STERLING_PLUGIN_ROOT: root },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

test('DSH-12: one SessionStart produces BOTH boundary effects — the pending record becomes terminal "session-boundary" with prompt null, and the register file is removed', () => {
  const { dir, cleanup } = makeProject();
  try {
    const prompt = 'a brief that must not survive the session boundary';
    assert.equal(
      h22(preInput(dir, { tool_use_id: 'toolu_boundary', subagent_type: 'coder', prompt }), dir).code,
      0
    );
    writeRegisterRaw(dir, [
      { agent_id: 'agent-stale', agent_type: 'coder', session_id: 's1', files: ['src/x.mjs'], attribution: 'block', at: '2026-09-08T11:00:00.000Z' },
    ]);
    assert.equal(derivedState(stateFor(dir, 'toolu_boundary')), 'pending', 'sanity: there is a live pending slot to sweep');
    assert.equal(existsSync(registerPath(dir)), true, 'sanity: there is a register to remove');

    const r = runH1(dir, 'startup');
    assert.notEqual(r.code, 2, `SessionStart must never deny: ${r.stderr}`);

    const rec = stateFor(dir, 'toolu_boundary');
    assert.ok(rec, '§4(b): the tombstone SURVIVES the boundary on purpose — it is the resume evidence in §5(ii), so the directory is never rm -rf\'d');
    assert.equal(derivedState(rec), 'terminal', 'the pending set is EMPTIED, so nothing from a previous session is ever derivable');
    assert.equal(rec.terminal.reason, 'session-boundary');
    assert.equal(rec.prompt, null, 'and the brief is dropped at the boundary, not retained for 7 days');

    assert.equal(existsSync(registerPath(dir)), false, 'the register is still removed — the sweep is an ADDITION to that behaviour, never a replacement for it');
  } finally {
    cleanup();
  }
});
// SABOTAGE: wire sessionBoundarySweep into H1 but drop the register deletion
// (or vice versa) — exactly one of the two halves goes red, so the failure
// names which half was lost. Second sabotage: implement the sweep as an rm -rf
// of dispatch-state/ — the `assert.ok(rec)` line goes red first, which is the
// round-2 FATAL case (a resumed pre-/clear agent then matches a fresh
// same-type slot and consumes it).

// ===========================================================================
// TaskStop ends a killed dispatch (decision
// `h22-observes-taskstop-to-end-a-killed-dispatch`). TaskStop is a TOOL, not a
// hook event: h22 sees it on PostToolUse with matcher "TaskStop". The join key
// is tool_response.task_id — the RESOLVED task id, which for a task_type
// 'local_agent' is the agent's agentId (Claude Code 2.1.280: the task is
// registered with id = agentId; TaskStop's call returns {message, task_id,
// task_type, command}). tool_input.task_id may be a NAME, so it is never the
// join key.
// ===========================================================================

const taskStopInput = (dir, { task_id, input_task_id = task_id, task_type = 'local_agent', session_id = 's1' }) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'TaskStop',
  tool_use_id: 'toolu_taskstop',
  tool_input: { task_id: input_task_id },
  tool_response: { message: `Successfully stopped task: ${task_id} (a lane)`, task_id, task_type, command: 'a lane' },
  session_id,
  cwd: dir,
  transcript_path: join(dir, 't', 'parent.jsonl'),
});

test('DSH-13: a PostToolUse TaskStop of a local_agent ENDS its register round (event "task-stop") and tombstones its state record — joined on tool_response.task_id even when tool_input named the agent', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('killed', ['src/killed.mjs']));
    const d = stageOne(dir, { tool_use_id: 'toolu_killed', file: 'src/killed.mjs' });
    assert.equal(h22(postInput(dir, { ...d, agentId: 'agent-killed' }), dir).code, 0);
    assert.equal(h22(startInput(dir, { agent_id: 'agent-killed', agent_type: d.type }), dir).code, 0);
    assert.equal(entryFor(dir, 'agent-killed').ended, undefined, 'sanity: the round is open before the kill');

    const r = h22(taskStopInput(dir, { task_id: 'agent-killed', input_task_id: 'my-named-lane' }), dir);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /unexpected .*tool_name/, 'TaskStop is a handled tool on this hook, not a matcher mismatch');

    const entry = entryFor(dir, 'agent-killed');
    assert.equal(entry.ended?.event, 'task-stop', 'the killed round is MARKED ended (inactive-confirmed), never deleted');
    const rec = stateFor(dir, 'toolu_killed');
    assert.equal(derivedState(rec), 'terminal');
    assert.equal(rec.terminal.reason, 'task-stop');
    assert.equal(rec.prompt, null);
    assert.match(r.stderr, /\[dispatch_residue\]/, 'a killed dispatch gets the same kill-residue disclosure a message-less SubagentStop gets');
  } finally {
    cleanup();
  }
});

test('DSH-14 CONTROL: a TaskStop of a NON-agent task (a background shell) changes nothing and says nothing', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('shell', ['src/shell.mjs']));
    const d = stageOne(dir, { tool_use_id: 'toolu_shell', file: 'src/shell.mjs' });
    assert.equal(h22(postInput(dir, { ...d, agentId: 'agent-live' }), dir).code, 0);
    assert.equal(h22(startInput(dir, { agent_id: 'agent-live', agent_type: d.type }), dir).code, 0);
    const before = readFileSync(registerPath(dir), 'utf8');

    const r = h22(taskStopInput(dir, { task_id: 'agent-live', task_type: 'local_bash' }), dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readFileSync(registerPath(dir), 'utf8'), before, 'a shell kill is not a dispatch kill — even when its id collides with an agent id');
    assert.equal(r.stderr.trim(), '', `nothing to disclose: ${r.stderr}`);
  } finally {
    cleanup();
  }
});

test('DSH-15: a TaskStop whose tool_response carries no task_type is an UNKNOWN shape — disclosed, nothing ended', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('odd', ['src/odd.mjs']));
    const d = stageOne(dir, { tool_use_id: 'toolu_odd', file: 'src/odd.mjs' });
    assert.equal(h22(postInput(dir, { ...d, agentId: 'agent-odd' }), dir).code, 0);
    assert.equal(h22(startInput(dir, { agent_id: 'agent-odd', agent_type: d.type }), dir).code, 0);

    const input = taskStopInput(dir, { task_id: 'agent-odd' });
    input.tool_response = 'Successfully stopped task: agent-odd';
    const r = h22(input, dir);
    assert.notEqual(r.code, 2, `never blocks — the disclosure rides the hook's non-blocking warning channel: ${r.stderr}`);
    assert.match(r.stderr, /TaskStop/, `the unreadable shape is disclosed: ${r.stderr}`);
    assert.equal(entryFor(dir, 'agent-odd').ended, undefined, 'no guess: the round stays open');
  } finally {
    cleanup();
  }
});

test('DSH-16: a SubagentStop arriving AFTER a TaskStop already ended the round is a clean no-op — the "task-stop" mark stands', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('late', ['src/late.mjs']));
    const d = stageOne(dir, { tool_use_id: 'toolu_late', file: 'src/late.mjs' });
    assert.equal(h22(postInput(dir, { ...d, agentId: 'agent-late' }), dir).code, 0);
    assert.equal(h22(startInput(dir, { agent_id: 'agent-late', agent_type: d.type }), dir).code, 0);
    assert.equal(h22(taskStopInput(dir, { task_id: 'agent-late' }), dir).code, 0);

    const r = h22(stopInput(dir, { agent_id: 'agent-late', agent_type: d.type }), dir);
    assert.equal(r.code, 0, r.stderr);
    const rounds = readRegister(dir).filter((e) => e.agent_id === 'agent-late');
    assert.equal(rounds.length, 1, 'no second round appears');
    assert.equal(rounds[0].ended?.event, 'task-stop');
    assert.equal(stateFor(dir, 'toolu_late').terminal.reason, 'task-stop');
  } finally {
    cleanup();
  }
});

// TaskStop selects by the PAIR (session_id, agent_id) — in the register AND in
// the dispatch-state terminalization. An absent session_id would fall back to
// agent_id-only selection and could end another session's round, so it ends
// nothing and says so.
test('DSH-17: a TaskStop whose hook input carries NO session_id ends nothing — register byte-identical, state record still live, disclosed', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('nosess', ['src/nosess.mjs']));
    const d = stageOne(dir, { tool_use_id: 'toolu_nosess', file: 'src/nosess.mjs' });
    assert.equal(h22(postInput(dir, { ...d, agentId: 'agent-nosess' }), dir).code, 0);
    assert.equal(h22(startInput(dir, { agent_id: 'agent-nosess', agent_type: d.type }), dir).code, 0);
    const before = readFileSync(registerPath(dir), 'utf8');

    const input = taskStopInput(dir, { task_id: 'agent-nosess' });
    delete input.session_id;
    const r = h22(input, dir);
    assert.notEqual(r.code, 2, `never blocks: ${r.stderr}`);
    assert.match(r.stderr, /session_id/, `the missing session_id is disclosed: ${r.stderr}`);
    assert.equal(readFileSync(registerPath(dir), 'utf8'), before, 'no round was ended by agent_id alone');
    assert.equal(stateFor(dir, 'toolu_nosess').terminal, undefined, 'the state record is not terminalized either');
  } finally {
    cleanup();
  }
});

test("DSH-18: a TaskStop from ANOTHER session naming the same agent_id ends neither this session's round nor its state record", () => {
  const { dir, store, cleanup } = makeProject();
  try {
    store.create(article('cross', ['src/cross.mjs']));
    const d = stageOne(dir, { tool_use_id: 'toolu_cross', file: 'src/cross.mjs' });
    assert.equal(h22(postInput(dir, { ...d, agentId: 'agent-cross' }), dir).code, 0);
    assert.equal(h22(startInput(dir, { agent_id: 'agent-cross', agent_type: d.type }), dir).code, 0);

    const r = h22(taskStopInput(dir, { task_id: 'agent-cross', session_id: 's-other' }), dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(entryFor(dir, 'agent-cross').ended, undefined, "the s1 round stays open — s-other's kill is not its kill");
    assert.equal(stateFor(dir, 'toolu_cross').terminal, undefined, "the s1 state record is not terminalized by an agent_id match alone");

    // CONTROL: the same kill from the OWNING session ends both.
    assert.equal(h22(taskStopInput(dir, { task_id: 'agent-cross' }), dir).code, 0);
    assert.equal(entryFor(dir, 'agent-cross').ended?.event, 'task-stop');
    assert.equal(stateFor(dir, 'toolu_cross').terminal?.reason, 'task-stop');
  } finally {
    cleanup();
  }
});
