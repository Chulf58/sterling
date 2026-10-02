// Read-only subagent lanes receive anti-pattern hazards as ONE-LINE POINTERS,
// not whole TRIGGER/RIGHT WAY blocks (user ruling 2026-09-28, "Revisit for
// read-only lanes", amending decision delivery-total-cap-and-axis-generic-floor
// and the "each whole" clause of knowledge-delivery-target-design-no-delayed-
// delivery). Design map: finding hazard-delivery-call-sites-lane-identity-and-
// substance-only-freshness-trap-september-2026.
//
// Pinned here:
//   1. hazardLaneMode's FAIL-WHOLE matrix: 'pointer' only for a subagent lane
//      (agent_id) whose resolved agent type is a plain name with an installed
//      .claude/agents/<type>.md carrying exactly one unambiguous `tools:` line
//      whose every tool is on the read-only ALLOWLIST; everything else — any
//      other tool, any misparse-prone line, any thrown error — is 'whole'.
//   2. The H22 register fallback when agent_type is missing on stdin.
//   3. Pointer rendering: one line per hazard, no TRIGGER/RIGHT WAY, a
//      pointer-only header, credited as discovery (never substance).
//   4. No starvation: a pointer-mode lane's second touch surfaces the 4th and
//      5th hazards, not the first three again (freshness via isKnownDelivered).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOKS = join(root, 'scripts', 'hooks');
const NOW = '2026-09-28T12:00:00.000Z';

// The REAL roster files. `.claude/agents/` is untracked (install-agents renders
// it per machine), so the fixture copies the tracked templates, whose `tools:`
// line install renders verbatim when no extra_tools grant applies.
const TEMPLATES = join(root, 'agent-templates');
const RESEARCHER_TOOLS = /^tools: (.*)$/m.exec(readFileSync(join(TEMPLATES, 'researcher.md'), 'utf8'))[1];

let SterlingStore;
let hazardLaneMode;
let hazardParts;
let assembleDelivery;
before(async () => {
  ({ SterlingStore } = await import(pathToFileURL(join(root, 'packages', 'store', 'dist', 'index.js')).href));
  ({ hazardLaneMode } = await import(pathToFileURL(join(HOOKS, 'lib', 'hazard-lane-mode.mjs')).href));
  ({ hazardParts, assembleDelivery } = await import(pathToFileURL(join(HOOKS, 'lib', 'delivery.mjs')).href));
});

function runHook(script, input, cwd) {
  const r = spawnSync(process.execPath, [join(HOOKS, script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function antiPattern(n, paths, extra = {}) {
  return {
    id: randomUUID(),
    type: 'anti_pattern',
    created_at: NOW,
    updated_at: NOW,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: [],
    title: `hazard number ${n}`,
    slug: `hazard-number-${n}`,
    trigger: `hazard ${n} TRIGGER_BODY text`,
    guidance: `hazard ${n} guidance`,
    wrong_way: `hazard ${n} wrong way`,
    right_way: `hazard ${n} RIGHTWAY_BODY text`,
    source_evidence: `hazard ${n} evidence`,
    basis: 'codebase',
    file_keys: paths,
    ...extra,
  };
}

function agentFile(dir, name, frontmatterLines) {
  mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'agents', `${name}.md`), ['---', `name: ${name}`, ...frontmatterLines, '---', `# ${name}`, ''].join('\n'));
}

function makeDir() {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-h19-rolane-'));
  mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
  for (const name of ['researcher', 'scout', 'librarian', 'implementor']) {
    copyFileSync(join(TEMPLATES, `${name}.md`), join(dir, '.claude', 'agents', `${name}.md`));
  }
  agentFile(dir, 'editing-researcher', [`tools: ${RESEARCHER_TOOLS}, Edit`]);
  return dir;
}

function makeProject() {
  const dir = makeDir();
  mkdirSync(join(dir, '.sterling'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ delivery: { injection_rung: 'read' } }));
  const store = new SterlingStore(join(dir, '.sterling', 'sterling.db'));
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, cleanup };
}

function writeRegister(dir, entries) {
  mkdirSync(join(dir, '.sterling', 'transient'), { recursive: true });
  writeFileSync(join(dir, '.sterling', 'transient', 'dispatch-register.json'), JSON.stringify(entries));
}

const ctxOf = (r) => {
  assert.equal(r.code, 0, `hook must not block: ${r.stderr}`);
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput?.additionalContext ?? '' : '';
};

// ---------------------------------------------------------------------------
// 1. The fail-whole matrix.
// ---------------------------------------------------------------------------

test('hazardLaneMode: fail-whole matrix — only a resolvable read-only plain-named lane gets pointers', () => {
  const dir = makeDir();
  try {
    const lane = (extra) => ({ session_id: 's1', agent_id: 'agent-x', ...extra });
    assert.equal(hazardLaneMode(lane({ agent_type: 'researcher' }), dir), 'pointer', 'researcher (no write tools) -> pointer');
    assert.equal(hazardLaneMode(lane({ agent_type: 'scout' }), dir), 'pointer', 'scout (no write tools) -> pointer');
    assert.equal(hazardLaneMode(lane({ agent_type: 'implementor' }), dir), 'whole', 'implementor (no tools: line, inherits all) -> whole');
    assert.equal(hazardLaneMode({ session_id: 's1', agent_type: 'conductor' }, dir), 'whole', 'main session (no agent_id) -> whole');
    assert.equal(hazardLaneMode({ session_id: 's1', agent_id: '', agent_type: 'researcher' }, dir), 'whole', 'empty agent_id -> whole');
    assert.equal(hazardLaneMode(lane({}), dir), 'whole', 'agent_type missing and no register entry -> whole');
    assert.equal(hazardLaneMode(lane({ agent_type: 'no-such-agent' }), dir), 'whole', 'unknown type (no .md) -> whole');
    assert.equal(hazardLaneMode(lane({ agent_type: 'plugin:x:researcher' }), dir), 'whole', 'plugin-scoped type -> whole');
    assert.equal(hazardLaneMode(lane({ agent_type: '../researcher' }), dir), 'whole', 'a type that is not a plain name -> whole');
    assert.equal(hazardLaneMode(lane({ agent_type: 'editing-researcher' }), dir), 'whole', 'a tools line granting Edit (extra_tools) -> whole');
    // A thrown read error: the .md path exists but is a directory (EISDIR).
    mkdirSync(join(dir, '.claude', 'agents', 'broken.md'));
    assert.equal(hazardLaneMode(lane({ agent_type: 'broken' }), dir), 'whole', 'a thrown read error -> whole');
    assert.equal(hazardLaneMode(null, dir), 'whole', 'no input at all -> whole');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hazardLaneMode: each file-write tool on the tools line flips the lane to whole', () => {
  const dir = makeDir();
  try {
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      agentFile(dir, `ro-${tool}`, [`tools: Read, Grep, ${tool}`]);
      assert.equal(hazardLaneMode({ agent_id: 'a', agent_type: `ro-${tool}` }, dir), 'whole', `${tool} -> whole`);
    }
    agentFile(dir, 'ro-empty', ['tools:', '  - Read']);
    assert.equal(hazardLaneMode({ agent_id: 'a', agent_type: 'ro-empty' }, dir), 'whole', 'a block-list tools: line (unparsed) -> whole');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hazardLaneMode: the real roster — researcher and scout pointer, librarian (store-write MCP) and implementor whole', () => {
  const dir = makeDir();
  try {
    const mode = (t) => hazardLaneMode({ agent_id: 'a', agent_type: t }, dir);
    assert.equal(mode('researcher'), 'pointer');
    assert.equal(mode('scout'), 'pointer');
    assert.equal(mode('librarian'), 'whole', 'the librarian writes records');
    assert.equal(mode('implementor'), 'whole');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hazardLaneMode: an ALLOWLIST — every misparse-prone or unknown tools line fails whole', () => {
  const dir = makeDir();
  try {
    const cases = {
      comment: ['tools: Read, Edit # comment'],
      continuation: ['tools: Read, Grep,', '  Edit'],
      lowercase: ['tools: Read, edit'],
      starQuoted: ['tools: "*"'],
      star: ['tools: Read, *'],
      twoKeys: ['tools: Read', 'tools: Read, Edit'],
      scoped: ['tools: Read, Edit(src/**)'],
      noComma: ['tools: Read Edit'],
      foreignMcpWrite: ['tools: Read, mcp__filesystem__write_file'],
      flowList: ['tools: [Read, Grep]'],
      unknownTool: ['tools: Read, Task'],
      sterlingWriteMcp: ['tools: Read, mcp__sterling__knowledge_update'],
      doubleQuotedSecondKey: ['tools: Read', '"tools": Read, Edit'],
      singleQuotedFirstKey: ["'tools': Read, Edit", 'tools: Read'],
      complexKey: ['tools: Read', '? tools', ': Read, Edit'],
      loneCarriageReturn: ['name: x\rtools: Read, Edit', 'tools: Read'],
    };
    for (const [name, lines] of Object.entries(cases)) {
      agentFile(dir, `case-${name}`, lines);
      assert.equal(hazardLaneMode({ agent_id: 'a', agent_type: `case-${name}` }, dir), 'whole', `${name}: ${lines.join(' / ')} -> whole`);
    }
    agentFile(dir, 'case-ok', ['tools: Read, Grep, Bash, mcp__plugin_sterling_sterling__knowledge_schema, mcp__sterling__knowledge_preflight']);
    assert.equal(hazardLaneMode({ agent_id: 'a', agent_type: 'case-ok' }, dir), 'pointer', 'CONTROL: an all-read-only line -> pointer');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. The register fallback.
// ---------------------------------------------------------------------------

test('hazardLaneMode: agent_type missing on stdin but present in the H22 register -> pointer', () => {
  const dir = makeDir();
  try {
    writeRegister(dir, [{ agent_id: 'agent-reg', session_id: 's1', files: [], at: NOW, agent_type: 'researcher' }]);
    assert.equal(hazardLaneMode({ session_id: 's1', agent_id: 'agent-reg' }, dir), 'pointer');
    assert.equal(hazardLaneMode({ session_id: 's1', agent_id: 'agent-other' }, dir), 'whole', 'CONTROL: another agent_id has no entry -> whole');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Pointer rendering (the one helper).
// ---------------------------------------------------------------------------

test('hazardParts pointer mode: one line per hazard, pointer-only header, credited discovery, +N more kept', () => {
  const hz = [1, 2, 3, 4].map((n) => antiPattern(n, ['src/a.mjs']));
  const parts = hazardParts(hz, { fileKeys: ['src/a.mjs'], mode: 'pointer' });
  const credited = parts.filter((p) => p.identity);
  assert.equal(credited.length, 3, 'HAZARD_CAP still applies');
  for (const p of credited) {
    assert.equal(p.contentClass, 'discovery', 'a pointer is never substance');
    assert.equal(p.text.split('\n').length, 1, 'exactly one line per hazard');
    assert.ok(!/TRIGGER|RIGHT WAY/.test(p.text), 'no TRIGGER or RIGHT WAY');
    assert.ok(p.text.includes(`knowledge_get ${p.identity}`), 'the line points at the full record');
  }
  const text = parts.map((p) => p.text).join('\n');
  assert.match(text, /HAZARDS \(pointer-only: read-only lane — knowledge_get each before acting on its subject\)/);
  assert.match(text, /1 more hazard\(s\) NOT shown \(cap 3\)/, 'the +N more disclosure survives');
  const assembled = assembleDelivery(parts, 3000);
  assert.equal(assembled.emittedSubstance.length, 0, 'no substance credit');
  assert.equal(assembled.emittedDiscovery.length, 3, 'discovery credit for exactly the shown three');
});

test('hazardParts whole mode (default) is unchanged: TRIGGER + RIGHT WAY, substance, no pointer-only header', () => {
  const hz = [antiPattern(1, ['src/a.mjs'])];
  const parts = hazardParts(hz, { fileKeys: ['src/a.mjs'] });
  assert.equal(parts.length, 1);
  assert.equal(parts[0].contentClass, 'substance');
  assert.match(parts[0].text, /TRIGGER: hazard 1 TRIGGER_BODY/);
  assert.ok(!parts[0].text.includes('pointer-only'));
});

// ---------------------------------------------------------------------------
// 4. Hook level: rendering and no starvation, per in-lane call site.
// ---------------------------------------------------------------------------

const postRead = (dir, file, extra) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Read',
  tool_input: { file_path: join(dir, file) },
  session_id: 's1',
  cwd: dir,
  ...extra,
});

const hazardLines = (ctx) => ctx.split('\n').filter((l) => l.startsWith('⚠ ANTI-PATTERN'));

test('H19 Read in a researcher lane: pointer rendering, then the 4th and 5th hazards on the second touch', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    writeFileSync(join(dir, 'src', 'a.mjs'), 'x\n');
    const hz = [1, 2, 3, 4, 5].map((n) => antiPattern(n, ['src/a.mjs']));
    for (const h of hz) store.create(h);
    const lane = { agent_id: 'agent-ro', agent_type: 'researcher' };
    const first = ctxOf(runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs', lane), dir));
    assert.match(first, /HAZARDS \(pointer-only: read-only lane/);
    assert.ok(!/TRIGGER|RIGHT WAY/.test(first), 'no hazard body in a read-only lane');
    const firstIds = hz.filter((h) => first.includes(h.id)).map((h) => h.id);
    assert.equal(firstIds.length, 3, 'three pointers on the first touch');
    assert.equal(hazardLines(first).length, 3);

    const second = ctxOf(runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs', lane), dir));
    const secondIds = hz.filter((h) => second.includes(h.id)).map((h) => h.id);
    assert.equal(secondIds.length, 2, 'the remaining two surface on the second touch');
    assert.ok(secondIds.every((id) => !firstIds.includes(id)), 'the first three do not repeat');
  } finally {
    cleanup();
  }
});

test('H19 Read in an implementor lane stays whole (CONTROL)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    writeFileSync(join(dir, 'src', 'a.mjs'), 'x\n');
    store.create(antiPattern(1, ['src/a.mjs']));
    const ctx = ctxOf(runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs', { agent_id: 'agent-w', agent_type: 'implementor' }), dir));
    assert.match(ctx, /TRIGGER: hazard 1 TRIGGER_BODY/);
    assert.match(ctx, /RIGHT WAY: hazard 1 RIGHTWAY_BODY/);
    assert.ok(!ctx.includes('pointer-only'));
  } finally {
    cleanup();
  }
});

test('H19 Bash in a scout-typed lane (register fallback): pointers, then the 4th and 5th on the next command', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    writeFileSync(join(dir, 'src', 'a.mjs'), 'x\n');
    const hz = [1, 2, 3, 4, 5].map((n) => antiPattern(n, ['src/a.mjs']));
    for (const h of hz) store.create(h);
    writeRegister(dir, [{ agent_id: 'agent-b', session_id: 's1', files: [], at: NOW, agent_type: 'scout' }]);
    const bash = { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'cat src/a.mjs' }, session_id: 's1', cwd: dir, agent_id: 'agent-b' };
    const first = ctxOf(runHook('h19-bash-delivery.mjs', bash, dir));
    assert.match(first, /HAZARDS \(pointer-only: read-only lane/);
    assert.ok(!/TRIGGER|RIGHT WAY/.test(first));
    const firstIds = hz.filter((h) => first.includes(h.id)).map((h) => h.id);
    assert.equal(firstIds.length, 3);
    const second = ctxOf(runHook('h19-bash-delivery.mjs', bash, dir));
    const secondIds = hz.filter((h) => second.includes(h.id)).map((h) => h.id);
    assert.equal(secondIds.length, 2, 'the remaining two surface');
    assert.ok(secondIds.every((id) => !firstIds.includes(id)), 'the first three do not repeat');
  } finally {
    cleanup();
  }
});

test('H19 SubagentStart staging of a researcher: path-channel hazards render as pointers', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    writeFileSync(join(dir, 'src', 'a.mjs'), 'x\n');
    const hz = [1, 2].map((n) => antiPattern(n, ['src/a.mjs']));
    for (const h of hz) store.create(h);
    const noTranscript = join(dir, 'no-such-parent-transcript.jsonl');
    const pre = runHook(
      'h22-dispatch-register.mjs',
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Task',
        tool_use_id: `toolu_${randomUUID().slice(0, 8)}`,
        tool_input: { subagent_type: 'researcher', prompt: 'Investigate src/a.mjs and report back.', description: 'a lane' },
        session_id: 's1',
        cwd: dir,
        transcript_path: noTranscript,
        prompt_id: 'p1',
      },
      dir
    );
    assert.notEqual(pre.code, 2);
    const ctx = ctxOf(
      runHook(
        'h19-dispatch-staging.mjs',
        { hook_event_name: 'SubagentStart', session_id: 's1', transcript_path: noTranscript, cwd: dir, prompt_id: 'p1', agent_id: 'agent-s', agent_type: 'researcher' },
        dir
      )
    );
    for (const h of hz) assert.ok(ctx.includes(`knowledge_get ${h.id}`), 'each hazard is pointed at');
    assert.match(ctx, /HAZARDS \(pointer-only: read-only lane/);
    assert.ok(!/TRIGGER_BODY|RIGHTWAY_BODY/.test(ctx), 'no hazard body staged into a read-only lane');
  } finally {
    cleanup();
  }
});

test('Guard isolation: a pointer delivered in a researcher lane never suppresses the whole hazard for another agent or the main session', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    writeFileSync(join(dir, 'src', 'a.mjs'), 'x\n');
    const h = antiPattern(1, ['src/a.mjs']);
    store.create(h);
    const a = ctxOf(runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs', { agent_id: 'agent-A', agent_type: 'researcher' }), dir));
    assert.ok(a.includes(`knowledge_get ${h.id}`) && !a.includes('TRIGGER_BODY'), 'CONTROL: agent A got the pointer');
    const b = ctxOf(runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs', { agent_id: 'agent-B', agent_type: 'implementor' }), dir));
    assert.match(b, /TRIGGER: hazard 1 TRIGGER_BODY/, 'agent B (implementor) gets the whole hazard');
    const main = ctxOf(runHook('h19-knowledge-delivery.mjs', postRead(dir, 'src/a.mjs', {}), dir));
    assert.match(main, /TRIGGER: hazard 1 TRIGGER_BODY/, 'the main session gets the whole hazard');
  } finally {
    cleanup();
  }
});

function stage(dir, subagentType, agentId, prompt) {
  const noTranscript = join(dir, 'no-such-parent-transcript.jsonl');
  const pre = runHook(
    'h22-dispatch-register.mjs',
    {
      hook_event_name: 'PreToolUse',
      tool_name: 'Task',
      tool_use_id: `toolu_${randomUUID().slice(0, 8)}`,
      tool_input: { subagent_type: subagentType, prompt, description: 'a lane' },
      session_id: 's1',
      cwd: dir,
      transcript_path: noTranscript,
      prompt_id: 'p1',
    },
    dir
  );
  assert.notEqual(pre.code, 2);
  return ctxOf(
    runHook(
      'h19-dispatch-staging.mjs',
      { hook_event_name: 'SubagentStart', session_id: 's1', transcript_path: noTranscript, cwd: dir, prompt_id: 'p1', agent_id: agentId, agent_type: subagentType },
      dir
    )
  );
}

test('H19 SubagentStart staging of an implementor stays whole (CONTROL)', () => {
  const { dir, store, cleanup } = makeProject();
  try {
    writeFileSync(join(dir, 'src', 'a.mjs'), 'x\n');
    const h = antiPattern(1, ['src/a.mjs']);
    store.create(h);
    const ctx = stage(dir, 'implementor', 'agent-i', 'Change src/a.mjs and report back.');
    assert.match(ctx, /TRIGGER: hazard 1 TRIGGER_BODY/);
    assert.match(ctx, /RIGHT WAY: hazard 1 RIGHTWAY_BODY/);
    assert.ok(!ctx.includes('pointer-only'));
  } finally {
    cleanup();
  }
});
