// Three-way host fences (Antigravity CLI slice 2): the agy-only kind, renderAgyText and the
// generalized no-counterpart marker, plus a golden check that the three existing renders are
// byte-identical to the base module frozen in fixtures/agent-fences-base.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fences from '../lib/agent-fences.mjs';
import { lintAgentFences } from '../lib/checks.mjs';
import * as base from './fixtures/agent-fences-base.mjs';

const { validateFences, renderClaudeText, renderOpenCodeFullText, renderPortableText, renderAgyText, noCounterpartHosts } = fences;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// The base module predates agy: it reads an agy-only block as prose and the general marker as a
// comment. Feed it what it understands: no agy-only blocks, and a general marker naming opencode
// back as the legacy marker it replaced.
const forBase = (text) => text
  .replace(/<!-- agy-only -->\n[\s\S]*?<!-- \/agy-only -->\n/g, '')
  .split('\n')
  .flatMap((l) => {
    const hosts = noCounterpartHosts(l);
    if (!hosts || l === '<!-- no-opencode-counterpart -->') return [l];
    return hosts.includes('opencode') ? ['<!-- no-opencode-counterpart -->'] : [];
  })
  .join('\n');
const kinds = (text) => validateFences(text, 't').map((v) => v.kind);
const ALL = { allHosts: true };
const kindsAll = (text) => validateFences(text, 't', ALL).map((v) => v.kind);

test('golden: existing renders of every template equal the base module output', () => {
  const files = readdirSync(join(repoRoot, 'agent-templates')).filter((f) => f.endsWith('.md')).map((f) => `agent-templates/${f}`);
  files.push('templates/target-claude-md.md');
  assert.ok(files.length > 1);
  for (const rel of files) {
    const text = readFileSync(join(repoRoot, rel), 'utf8');
    const old = forBase(text);
    assert.equal(renderClaudeText(text, rel), base.renderClaudeText(old, rel), `${rel} claude`);
    assert.equal(renderOpenCodeFullText(text, rel), base.renderOpenCodeFullText(old, rel), `${rel} opencode-full`);
    assert.equal(renderPortableText(text, rel), base.renderPortableText(old, rel), `${rel} portable`);
  }
});

test('agy-only: reaches only the agy render', () => {
  const text = 'a\n<!-- agy-only -->\n<!-- no-counterpart: claude, opencode -->\nagy\n<!-- /agy-only -->\n<!-- sterling-only -->\nst\n<!-- /sterling-only -->\nz\n';
  assert.deepEqual(validateFences(text, 't'), []);
  assert.equal(renderAgyText(text, 't'), 'a\nagy\nst\nz\n');
  assert.equal(renderClaudeText(text, 't'), 'a\nst\nz\n');
  assert.equal(renderOpenCodeFullText(text, 't'), 'a\nst\nz\n');
  assert.equal(renderPortableText(text, 't'), 'a\nz\n');
});

test('agy render drops claude-only, opencode-only and portable-only blocks', () => {
  const text = '<!-- claude-only -->\nc\n<!-- /claude-only -->\n<!-- opencode-only -->\n<!-- no-counterpart: agy -->\no\n<!-- /opencode-only -->\n<!-- portable-only -->\np\n<!-- /portable-only -->\nz';
  assert.equal(renderAgyText(text, 't'), 'z');
});

test('agy-only: structural errors are refused', () => {
  assert.deepEqual(kinds('<!-- agy-only -->\nx'), ['fence_unclosed']);
  assert.deepEqual(kinds('x\n<!-- /agy-only -->'), ['fence_unopened']);
  assert.deepEqual(kinds('<!-- agy-only -->\nx\n<!-- /opencode-only -->'), ['fence_mismatched', 'fence_unclosed']);
  assert.deepEqual(kinds('<!-- agy-only -->\n<!-- sterling-only -->\n'), ['fence_nested', 'fence_unclosed']);
  assert.deepEqual(kinds('<!-- agy-only -->\n\n<!-- /agy-only -->'), ['fence_empty_block']);
  assert.deepEqual(kinds('<!-- AGY-only -->\nx\n<!-- /agy-only -->'), ['fence_malformed', 'fence_unopened']);
  assert.throws(() => renderAgyText('<!-- agy-only -->\nx', 't'), /fence_unclosed/);
});

test('no-counterpart marker: legacy form keeps its meaning and is dropped from every render', () => {
  assert.deepEqual(noCounterpartHosts('<!-- no-opencode-counterpart -->'), ['opencode']);
  const text = 'a\n<!-- claude-only -->\n<!-- no-opencode-counterpart -->\nc\n<!-- /claude-only -->\n<!-- agy-only -->\ny\n<!-- /agy-only -->\nz';
  assert.deepEqual(validateFences(text, 't'), []);
  assert.equal(renderClaudeText(text, 't'), 'a\nc\nz');
  assert.equal(renderOpenCodeFullText(text, 't'), 'a\nz');
  assert.equal(renderAgyText(text, 't'), 'a\ny\nz');
});

test('no-counterpart marker: general form names hosts, including agy', () => {
  assert.deepEqual(noCounterpartHosts('<!-- no-counterpart: opencode, agy -->'), ['opencode', 'agy']);
  const text = 'a\n<!-- claude-only -->\n<!-- no-counterpart: opencode, agy -->\nc\n<!-- /claude-only -->\nz';
  assert.deepEqual(validateFences(text, 't'), []);
  assert.equal(renderClaudeText(text, 't'), 'a\nc\nz');
  assert.equal(renderAgyText(text, 't'), 'a\nz');
  // an agy-only block needs no pairing, and may declare the others have no counterpart
  const agy = '<!-- agy-only -->\n<!-- no-counterpart: claude, opencode -->\nx\n<!-- /agy-only -->';
  assert.deepEqual(validateFences(agy, 't'), []);
  assert.equal(renderAgyText(agy, 't'), 'x');
});

test('no-counterpart marker: general form that names opencode satisfies the claude-only pairing rule; one that omits it does not', () => {
  assert.deepEqual(kinds('<!-- claude-only -->\n<!-- no-counterpart: agy -->\nc\n<!-- /claude-only -->'), ['fence_claude_only_unpaired']);
});

test('no-counterpart marker: validation errors', () => {
  assert.deepEqual(kinds('<!-- claude-only -->\n<!-- no-counterpart: vim, opencode -->\nc\n<!-- /claude-only -->'), ['fence_counterpart_host']);
  assert.deepEqual(kinds('<!-- claude-only -->\n<!-- no-counterpart: agy, agy, opencode -->\nc\n<!-- /claude-only -->'), ['fence_counterpart_host']);
  assert.deepEqual(kinds('<!-- claude-only -->\n<!-- no-counterpart:agy -->\nc\n<!-- /claude-only -->'), ['fence_counterpart_malformed', 'fence_claude_only_unpaired']);
  assert.deepEqual(kinds('<!-- no-opencode-counterpart --> trailing'), ['fence_counterpart_malformed']);
  assert.deepEqual(kinds('<!-- agy-only -->\nx\n<!-- no-counterpart: claude -->\n<!-- /agy-only -->'), ['fence_counterpart_misplaced']);
  assert.deepEqual(kinds('<!-- agy-only -->\n<!-- no-counterpart: agy -->\nx\n<!-- /agy-only -->'), ['fence_counterpart_self']);
  assert.throws(() => renderAgyText('<!-- agy-only -->\n<!-- no-counterpart: agy -->\nx\n<!-- /agy-only -->', 't'), /fence_counterpart_self/);
});

test('host accounting: every run of host blocks covers claude, opencode and agy', () => {
  const C = '<!-- claude-only -->\nc\n<!-- /claude-only -->';
  const O = '<!-- opencode-only -->\no\n<!-- /opencode-only -->';
  const A = '<!-- agy-only -->\ny\n<!-- /agy-only -->';
  assert.deepEqual(validateFences(`${C}\n${O}\n\n${A}`, 't', ALL), []);
  assert.deepEqual(validateFences(`${A}\n${C}\n${O}`, 't', ALL), []);
  // a pair with no agy text is refused, and the message names the missing host and both remedies
  const pair = validateFences(`${C}\n${O}\nz`, 'f.md', ALL);
  assert.deepEqual(pair.map((v) => v.kind), ['fence_host_unaccounted']);
  assert.match(pair[0].detail, /f\.md:1:.*no counterpart for agy.*agy-only.*no-counterpart: agy/);
  // off by default (a consumer's CLAUDE.md and the commands and skills are not held to it), on in the agent lint
  assert.deepEqual(validateFences(`${C}\n${O}\nz`, 'f.md'), []);
  assert.deepEqual(lintAgentFences(`${C}\n${O}\nz`, 'x.md').map((v) => v.kind), ['fence_host_unaccounted']);
  assert.deepEqual(kindsAll(`${C}\nz`), ['fence_claude_only_unpaired', 'fence_host_unaccounted']);
  assert.match(validateFences(`${A}`, 't', ALL)[0].detail, /claude, opencode/);
});

test('host accounting: a marker inside any block of the run accounts for the hosts it names', () => {
  const O = (marker) => `<!-- opencode-only -->\n${marker}o\n<!-- /opencode-only -->`;
  const C = '<!-- claude-only -->\nc\n<!-- /claude-only -->';
  assert.deepEqual(validateFences(`${C}\n${O('<!-- no-counterpart: agy -->\n')}`, 't', ALL), []);
  assert.deepEqual(validateFences(O('<!-- no-counterpart: claude, agy -->\n'), 't', ALL), []);
  assert.deepEqual(kindsAll(O('<!-- no-counterpart: claude -->\n')), ['fence_host_unaccounted']);
  assert.deepEqual(kindsAll(`${C}\n${O('')}`), ['fence_host_unaccounted']);
});

test('host accounting: blocks separated by text are separate runs, each needing all three hosts', () => {
  const C = '<!-- claude-only -->\nc\n<!-- /claude-only -->';
  const O = '<!-- opencode-only -->\n<!-- no-counterpart: agy -->\no\n<!-- /opencode-only -->';
  const A = '<!-- agy-only -->\ny\n<!-- /agy-only -->';
  assert.deepEqual(validateFences(`${C}\n${O}\nprose\n${C}\n${O}`, 't', ALL), []);
  const split = validateFences(`${C}\n${O}\nprose\n${A}`, 't', ALL);
  assert.deepEqual(split.map((v) => v.kind), ['fence_host_unaccounted']);
  assert.match(split[0].detail, /t:9:.*claude, opencode/);
});

test('every shipped template accounts for all three hosts', () => {
  const files = readdirSync(join(repoRoot, 'agent-templates')).filter((f) => f.endsWith('.md')).map((f) => `agent-templates/${f}`);
  files.push('templates/target-claude-md.md');
  for (const rel of files) {
    assert.deepEqual(validateFences(readFileSync(join(repoRoot, rel), 'utf8'), rel, ALL), [], rel);
  }
});

test('GEMINI.md: the agy render of the target template fits agy\'s 24,000-byte cap and does not import AGENTS.md', () => {
  const rel = 'templates/target-claude-md.md';
  const out = renderAgyText(readFileSync(join(repoRoot, rel), 'utf8'), rel, ALL);
  assert.ok(Buffer.byteLength(out) < 24000, `GEMINI.md render is ${Buffer.byteLength(out)} bytes`);
  assert.ok(!out.includes('@AGENTS.md'), 'agy loads AGENTS.md itself; GEMINI.md must not import it');
  assert.ok(out.includes('written as `GEMINI.md`'), 'the agy form says what the shared heading means');
  assert.ok(out.includes('`sterling-ro` server, started with `--read-only`'), 'GEMINI.md names the read-only server');
  assert.ok(!out.includes('not in place yet'), 'GEMINI.md no longer says the read-only guard is missing');
});

test('agy render of the conductor names the agy tools and states the measured limits', () => {
  const rel = 'agent-templates/conductor.md';
  const out = renderAgyText(readFileSync(join(repoRoot, rel), 'utf8'), rel, ALL);
  for (const needle of ['agy --agent conductor', 'call_mcp_tool', 'invoke_subagent', 'send_message', 'ask_question', 'run_command', '`sterling-ro` server, started with `--read-only`', 'A Stop block fires once per turn']) {
    assert.ok(out.includes(needle), `conductor agy render lacks ${needle}`);
  }
  assert.ok(!out.includes('not in place yet'), 'the conductor no longer says the read-only guard is missing');
});

test('agy render of the conductor says H10 gives the 35%/50% pressure line on agy, keeps the unverified caveat and the no-window case; Claude and OpenCode renders do not', () => {
  const rel = 'agent-templates/conductor.md';
  const src = readFileSync(join(repoRoot, rel), 'utf8');
  const agy = renderAgyText(src, rel);
  for (const needle of ['H10 on agy notes pressure at 35% and warns at 50%', '`PLANNER_RESPONSE`', 'Gemini 4 Neon ids at 512000', 'measured against `windows.default`', '**Unverified:** the field names come from the issue report, not from a live agy run']) {
    assert.ok(agy.includes(needle), `agy render lacks ${needle}`);
  }
  assert.ok(!agy.includes('do not promise a context-pressure line'), 'the stale agy claim is gone');
  for (const render of [renderClaudeText, renderOpenCodeFullText]) {
    const other = render(src, rel);
    assert.ok(!other.includes('PLANNER_RESPONSE') && !other.includes('H10 on agy notes pressure'), 'only the agy render carries the agy pressure text');
  }
});
