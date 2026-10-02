// The Sterling layer as one source with host blocks (decision
// sterling-layer-is-one-source-with-host-blocks): templates/target-claude-md.md carries
// claude-only / opencode-only blocks. Its Claude render is what init writes to CLAUDE.md and
// what stamp-contract propagates, byte-identical to the template before the blocks. The
// OpenCode server plugin renders the project's own CLAUDE.md for OpenCode, swapping each
// template claude-only block for its opencode-only partner and saying out loud what it
// could not map.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderClaudeText, validateFences, FENCE_KINDS } from '../lib/agent-fences.mjs';
import { readTemplateBullets, extractTemplateBlock, TARGET_LEADS } from '../lib/contract-bullets.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEMPLATE = join(repo, 'templates', 'target-claude-md.md');
// sha256 of templates/target-claude-md.md before the host blocks (a2f5c31). The Claude render
// must stay byte-identical to it until a deliberate wording change moves this pin.
const PRE_BLOCKS_CLAUDE_RENDER_SHA = '3b6c6d1eb57939c924702aa4181e838e79546b78b6db357fccbe11ebf55db9b8';
// What the OpenCode model can never act on. An unmapped /sterling:<name> is checked separately.
const CLAUDE_ONLY = ['${CLAUDE_PLUGIN_ROOT}', 'READY TO CLEAR', '/clear', 'AskUserQuestion'];
const MARKERS = Object.values(FENCE_KINDS).flatMap((f) => [f.open, f.close]);

let layer;
before(async () => {
  layer = await import(pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'layer.mjs')).href);
});

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const template = () => readFileSync(TEMPLATE, 'utf8');

function project(claudeMd) {
  const dir = mkdtempSync(join(tmpdir(), 'sterling-layer-blocks-'));
  mkdirSync(join(dir, '.sterling'));
  writeFileSync(join(dir, '.sterling', 'config.json'), JSON.stringify({ project_name: 'blocks-proj' }));
  if (claudeMd !== undefined) writeFileSync(join(dir, 'CLAUDE.md'), claudeMd);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const initRender = (name = 'blocks-proj') => renderClaudeText(template(), 'target-claude-md.md').replaceAll('{{PROJECT_NAME}}', name);
const bodyOf = (rendered) => rendered.slice(0, rendered.indexOf('\n## OpenCode host'));

test('the Claude render of the template is byte-identical to the template before the host blocks', () => {
  assert.equal(sha(renderClaudeText(template(), 'target-claude-md.md')), PRE_BLOCKS_CLAUDE_RENDER_SHA);
});

test('the template fences are valid and every claude-only block is paired, except the @AGENTS.md import', () => {
  assert.deepEqual(validateFences(template(), 'target-claude-md.md'), []);
  const pairs = layer.hostBlockPairs(template());
  assert.equal(pairs.length, 14, 'the import plus the 13 lines the old phrase map rewrote');
  const unpaired = pairs.filter((p) => p.opencode.length === 0).map((p) => p.claude.join('\n'));
  assert.deepEqual(unpaired, ['@AGENTS.md'], 'only the import has no OpenCode text: OpenCode reads AGENTS.md natively');
});

test('the OpenCode render of an init-written CLAUDE.md carries no Claude-only phrase, no fence marker and no claude-only block text', () => {
  const p = project(initRender());
  try {
    const root = layer.sterlingRoot();
    const out = layer.renderSterlingLayer(p.dir, root);
    for (const t of CLAUDE_ONLY) assert.ok(!out.includes(t), `OpenCode render carries ${t}`);
    for (const m of MARKERS) assert.ok(!out.includes(m), `OpenCode render carries the marker ${m}`);
    assert.ok(!out.includes('{{'), 'no placeholder survives');
    assert.doesNotMatch(out, /^@AGENTS\.md$/m, 'the import line is dropped: OpenCode reads AGENTS.md natively');
    assert.doesNotMatch(out, /STERLING LAYER HOST CHECK/, 'a pristine CLAUDE.md maps cleanly, so nothing is flagged');
    for (const pair of layer.hostBlockPairs(template())) {
      for (const line of pair.claude) assert.ok(!out.includes(line), `claude-only line reached OpenCode: ${line.slice(0, 80)}`);
    }
    for (const m of out.matchAll(/\/sterling:([a-z][a-z-]*)/g)) {
      assert.ok(out.slice(m.index, m.index + 200).includes(`${root}/commands/${m[1]}.md`), `/sterling:${m[1]} is mapped to its command file`);
    }
  } finally {
    p.cleanup();
  }
});

test('every mapping the old phrase map carried has its OpenCode text in the render', () => {
  const p = project(initRender());
  try {
    const root = layer.sterlingRoot();
    const out = layer.renderSterlingLayer(p.dir, root);
    const expected = {
      'conductor-install': '.opencode/agents/sterling/conductor.md',
      'delivery-h19': 'on OpenCode the Sterling plugin appends it to read, edit and write tool results',
      'concept-designed-h10': `node "${root}/bin/concept-designed.mjs" --family <slug>`,
      'wired-h7-h10': 'On OpenCode the Sterling plugin settles each finished turn',
      'ask-question-tool': "through OpenCode's `question` tool.**",
      'ask-question-form': 'goes through the `question` tool form',
      'de-ai-skill': `Run the de-ai-writing skill (\`${root}/skills/de-ai-writing/SKILL.md\`)`,
      'de-ai-scanner': `node "${root}/skills/de-ai-writing/scripts/check-ai-signs.mjs" <file>`,
      'review-territory-h22': 'OpenCode has no H22; the line is still required',
      'store-guard-h15': 'on OpenCode by the edit deny on `.sterling/sterling.db*`',
      'platform-mechanics': "OpenCode's plugin hooks, agent files and config move between versions",
      'codex-availability': 'only when a `codex` MCP server is configured for it',
      'codex-background': 'How OpenCode handles a long Codex call is unmeasured',
      'ready-for-new-session': '- **Say `READY FOR NEW SESSION` plainly when it is time.**',
      'version-banner': `read it from \`${root}/.claude-plugin/plugin.json\``,
      'agent-currency': 'on OpenCode say that no agent-currency check ran',
      'strict-mcp-config': '- **On Claude Code, a user-scope MCP server entry can be silently dropped under `--strict-mcp-config`.**',
    };
    for (const [id, text] of Object.entries(expected)) assert.ok(out.includes(text), `${id}: OpenCode text missing: ${text}`);
    assert.match(out, /`node "[^"]+\/bin\/rotation-note\.mjs"`.*\/new/s, 'the new-session line names rotation-note by root and /new');
  } finally {
    p.cleanup();
  }
});

test("a project's own Sterling bullet reaches the OpenCode render, and a project without CLAUDE.md gets the template", () => {
  const own = '- **Deploys go through the blue lane.** PROJECT-BULLET-QUARTZ: never push to prod by hand.';
  const p = project(initRender().replace('## Plugin mechanics', `${own}\n\n## Plugin mechanics`));
  const bare = project();
  try {
    const root = layer.sterlingRoot();
    const out = layer.renderSterlingLayer(p.dir, root);
    assert.ok(out.includes(own), 'the project bullet is injected verbatim');
    assert.doesNotMatch(out, /STERLING LAYER HOST CHECK/);
    assert.equal(bodyOf(layer.renderSterlingLayer(bare.dir, root)), bodyOf(out).replace(`${own}\n\n`, ''), 'no CLAUDE.md renders the template as init would have written it');
  } finally {
    p.cleanup();
    bare.cleanup();
  }
});

test('a CRLF CLAUDE.md maps the same as its LF form', () => {
  const lf = project(initRender());
  const crlf = project(initRender().replace(/\n/g, '\r\n'));
  try {
    const root = layer.sterlingRoot();
    assert.equal(layer.renderSterlingLayer(crlf.dir, root), layer.renderSterlingLayer(lf.dir, root));
  } finally {
    lf.cleanup();
    crlf.cleanup();
  }
});

test('what cannot be mapped is loud: a Claude-only phrase in a project bullet, an unknown /sterling: command, and a template block the project changed', () => {
  const tuned = initRender().replace('plainly when it is time.** At a clean boundary', 'plainly when it is time.** At any clean boundary');
  const p = project(`${tuned}\n- ask through AskUserQuestion, then run /clear and \`/sterling:nosuch\`\n`);
  try {
    const root = layer.sterlingRoot();
    const out = layer.renderSterlingLayer(p.dir, root);
    const check = out.slice(out.indexOf('STERLING LAYER HOST CHECK'));
    assert.ok(out.startsWith('STERLING LAYER HOST CHECK'), 'the warning leads the layer, before the rules it qualifies');
    for (const t of ['READY TO CLEAR', 'AskUserQuestion', '/clear']) assert.match(check, new RegExp(`Claude-only phrase.*${t.replace('/', '\\/')}`, 's'), `${t} is named`);
    assert.match(check, /\/sterling:nosuch.*commands\/nosuch\.md/s, 'the unknown command is named with the file that is missing');
    assert.match(check, /not found verbatim.*Say `READY TO CLEAR` plainly/s, 'the template block the project changed is named by its first line');
  } finally {
    p.cleanup();
  }
});

test("a template bullet the project wrapped in its own host blocks is not flagged, and a bullet the project deleted is not flagged", () => {
  const lead = '- **Say `READY TO CLEAR` plainly when it is time.**';
  const tunedLine = `${lead} At any clean boundary, print it.`;
  const fenced = ['<!-- claude-only -->', tunedLine, '<!-- /claude-only -->', '<!-- opencode-only -->', '- **On OpenCode, say `READY FOR NEW SESSION` plainly when it is time.** OWN-OPENCODE-WORDING.', '<!-- /opencode-only -->'].join('\n');
  const base = initRender();
  const line = base.split('\n').find((l) => l.startsWith(lead));
  const wrapped = project(base.replace(line, fenced));
  const deleted = project(base.replace(`${line}\n`, ''));
  try {
    const root = layer.sterlingRoot();
    const out = layer.renderSterlingLayer(wrapped.dir, root);
    assert.ok(out.includes('OWN-OPENCODE-WORDING') && !out.includes('READY TO CLEAR'));
    assert.doesNotMatch(out, /STERLING LAYER HOST CHECK/);
    assert.doesNotMatch(layer.renderSterlingLayer(deleted.dir, root), /STERLING LAYER HOST CHECK/);
  } finally {
    wrapped.cleanup();
    deleted.cleanup();
  }
});

test("a project's own host blocks in CLAUDE.md are rendered for OpenCode", () => {
  const own = (oc) => ['<!-- claude-only -->', '- Run CLAUDE-OWN-ONLY via Claude.', '<!-- /claude-only -->', '<!-- opencode-only -->', oc, '<!-- /opencode-only -->'].join('\n');
  const p = project(`${initRender()}\n${own('- On OpenCode, run OPENCODE-OWN-ONLY.')}\n`);
  // Claude Code reads CLAUDE.md raw, so a project's opencode-only block must say it is for OpenCode.
  const unmarked = project(`${initRender()}\n${own('- Run OPENCODE-OWN-ONLY.')}\n`);
  try {
    const root = layer.sterlingRoot();
    const out = layer.renderSterlingLayer(p.dir, root);
    assert.ok(out.includes('OPENCODE-OWN-ONLY') && !out.includes('CLAUDE-OWN-ONLY'));
    for (const m of MARKERS) assert.ok(!out.includes(m));
    assert.doesNotMatch(out, /STERLING LAYER HOST CHECK/);
    assert.match(layer.renderSterlingLayer(unmarked.dir, root), /^STERLING LAYER HOST CHECK.*opencode-only block at CLAUDE\.md:\d+ does not open with "On OpenCode,"/s);
  } finally {
    p.cleanup();
    unmarked.cleanup();
  }
});

test('stamp-contract reads the Claude render: no tracked bullet carries a fence marker or OpenCode text', () => {
  const { current } = readTemplateBullets(repo);
  const claude = renderClaudeText(template(), 'target-claude-md.md');
  for (const lead of TARGET_LEADS) {
    const block = current.get(lead);
    for (const m of MARKERS) assert.ok(!block.includes(m), `${lead}: carries ${m}`);
    if (claude.includes(lead)) assert.ok(claude.includes(block), `${lead}: the propagated block is the Claude render's`);
  }
  assert.equal(extractTemplateBlock(template(), '- **Say `READY TO CLEAR` plainly when it is time.**').block.includes('READY FOR NEW SESSION'), false);
});

test('swapBlocks refuses a pair with no claude lines instead of looping on it', () => {
  // [].every() is true at every index, so an unguarded swap of an empty claude block splices
  // forever. Run it in a child with a timeout: a hang fails the test instead of the suite.
  const layerUrl = pathToFileURL(join(repo, 'packages', 'opencode-plugin', 'src', 'layer.mjs')).href;
  const script = `const { swapBlocks } = await import(${JSON.stringify(layerUrl)});
try { swapBlocks(['a', 'b'], [{ claude: [], opencode: ['x'] }]); console.log('RETURNED'); }
catch (err) { console.log('THREW ' + err.message); }`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10000 });
  assert.equal(r.signal, null, `swapBlocks did not finish within the timeout (killed by ${r.signal})`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^THREW .*no claude lines/m);
});

test('swapBlocks still swaps every occurrence of a non-empty block', () => {
  const lines = ['a', 'c1', 'c2', 'b', 'c1', 'c2'];
  assert.deepEqual(layer.swapBlocks(lines, [{ claude: ['c1', 'c2'], opencode: ['o'] }, { claude: ['missing'], opencode: [] }]), ['missing']);
  assert.deepEqual(lines, ['a', 'o', 'b', 'o']);
});
