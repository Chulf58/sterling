// The Sterling layer for OpenCode (decision sterling-layer-is-one-source-with-host-blocks):
// the project's CLAUDE.md rendered for OpenCode, plus the OpenCode host tail.
// templates/target-claude-md.md is one source with claude-only / opencode-only blocks
// (scripts/lib/agent-fences.mjs). Init writes its Claude render to CLAUDE.md, so a project's
// CLAUDE.md holds the claude-only lines and none of the OpenCode text; this module swaps each
// template claude-only block found in CLAUDE.md for its opencode-only partner. The project's
// own bullets pass through, and what cannot be mapped is named at the top of the layer.
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadConfig } from '../../../scripts/hooks/lib/common.mjs';
import { sterlingRootFrom } from '../../../scripts/lib/opencode-install.mjs';
import { FENCE_KINDS, NO_COUNTERPART_MARKER, renderClaudeText, renderOpenCodeFullText, validateFences } from '../../../scripts/lib/agent-fences.mjs';

/**
 * The OpenCode host section appended after the rendered layer. `pluginRoot`
 * is the resolved Sterling root, or null when it could not be resolved.
 */
export function opencodeHostTail(pluginRoot) {
  const install = pluginRoot
    ? `- **Sterling is installed at \`${pluginRoot}\`.** Its scripts are \`${pluginRoot}/bin/*.mjs\` (run one with \`node "${pluginRoot}/bin/<name>.mjs"\`), its commands are \`${pluginRoot}/commands/*.md\`, its skills are \`${pluginRoot}/skills/*/SKILL.md\` and its agent templates are under \`${pluginRoot}/agent-templates/\`. Those files are written for Claude Code: where one says CLAUDE_PLUGIN_ROOT, use \`${pluginRoot}\`, and read the rest with the substitutions this layer makes.`
    : "- **Sterling's install root could not be resolved** (the error is above), so its scripts, commands and skills are unreachable this session. Tell the user before relying on any of them.";
  return [
    '## OpenCode host',
    '',
    "This session runs on OpenCode, not Claude Code. The layer above is this project's CLAUDE.md rendered for OpenCode: each Claude-only rule Sterling ships is replaced by its OpenCode text. The other differences:",
    '',
    install,
    '- **/plugin, --plugin-dir and the marketplace** do not apply. OpenCode loads Sterling through the plugin shim in its config dir. Slash commands, .claude/agents and .claude/settings.json are Claude Code surfaces and are absent here; to run a Sterling command this layer names, read its file under the commands directory and follow it.',
    '- **There is no stop block.** When a turn ends, Sterling settles the files it changed. Capture and reconcile duties it finds arrive as a STERLING NOTICE in the next turn; act on them before new work.',
    `- **The conductor role** (${pluginRoot ? `\`${pluginRoot}/agent-templates/conductor.md\`` : 'agent-templates/conductor.md'}) is yours in the main session. Dispatch subagents with the \`subagent\` tool.`,
  ].join('\n');
}

/**
 * The Sterling plugin root above this module. The source
 * (packages/opencode-plugin/src) and the committed bundle (opencode/) both sit
 * under it, so this is the root of whichever Sterling the shim loaded. It
 * delegates to the installer's sterlingRootFrom, the one root resolver the
 * OpenCode side and the dashboard share; the default URL is this module's own.
 */
export function sterlingRoot(moduleUrl = import.meta.url) {
  return sterlingRootFrom(moduleUrl);
}

export function defaultTemplatePath(moduleUrl = import.meta.url) {
  return join(sterlingRoot(moduleUrl), 'templates', 'target-claude-md.md');
}

// The template's opencode-only text names the Sterling root by this token; the render
// replaces it with the resolved root. CLAUDE.md never holds it: the Claude render drops
// those blocks.
const ROOT_TOKEN = '{{STERLING_ROOT}}';
// Left in the layer after rendering, any of these gives the OpenCode model a Claude Code
// instruction it cannot carry out.
const CLAUDE_ONLY_RESIDUE = ['${CLAUDE_PLUGIN_ROOT}', 'READY TO CLEAR', '/clear', 'AskUserQuestion'];
const CLAUDE_OPEN = FENCE_KINDS['claude-only'].open;
const CLAUDE_CLOSE = FENCE_KINDS['claude-only'].close;
const OPENCODE_CLOSE = FENCE_KINDS['opencode-only'].close;

/**
 * Every claude-only block of the template with the opencode-only block paired after it, as
 * line arrays. A block marked no-opencode-counterpart pairs with no lines. Throws on invalid
 * fences, naming each violation.
 */
export function hostBlockPairs(templateText, label = 'templates/target-claude-md.md') {
  const violations = validateFences(templateText, label);
  if (violations.length) throw new Error(`Sterling layer: host blocks invalid in ${label}:\n  ${violations.map((v) => `[${v.kind}] ${v.detail}`).join('\n  ')}`);
  const lines = templateText.replace(/\r\n/g, '\n').split('\n');
  const pairs = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== CLAUDE_OPEN) continue;
    const close = lines.indexOf(CLAUDE_CLOSE, i + 1);
    const noCounterpart = lines[i + 1] === NO_COUNTERPART_MARKER;
    const claude = lines.slice(noCounterpart ? i + 2 : i + 1, close);
    i = close;
    let opencode = [];
    if (!noCounterpart) {
      // validateFences guarantees the next non-blank line opens the opencode-only block.
      const open = lines.findIndex((l, k) => k > close && l.trim() !== '');
      const end = lines.indexOf(OPENCODE_CLOSE, open + 1);
      opencode = lines.slice(open + 1, end);
      i = end;
    }
    pairs.push({ claude, opencode });
  }
  return pairs;
}

// Replace every whole-line occurrence of each pair's claude lines with its opencode lines.
// Returns the first line of each pair that was found nowhere.
function swapBlocks(lines, pairs) {
  const unmatched = [];
  for (const { claude, opencode } of pairs) {
    let found = false;
    for (let i = 0; i + claude.length <= lines.length; i++) {
      if (!claude.every((l, k) => lines[i + k] === l)) continue;
      lines.splice(i, claude.length, ...opencode);
      i += opencode.length - 1;
      found = true;
    }
    if (!found) unmatched.push(claude[0]);
  }
  return unmatched;
}

const clip = (s) => (s.length > 90 ? `${s.slice(0, 90)}…` : s);
// A bullet is known by its bold lead; any other line by its first 40 characters.
const leadOf = (line) => /^- \*\*.*?\*\*/.exec(line)?.[0] ?? line.slice(0, 40);

// The project's lines outside every host block it wrote itself (fences validated by the
// OpenCode render before this runs). A template block whose lead shows up here was kept
// in the project's own wording, unfenced, so its Claude-only text reached OpenCode as is.
function unfencedText(source) {
  const markers = new Map(Object.values(FENCE_KINDS).flatMap((f) => [[f.open, true], [f.close, false]]));
  let inside = false;
  const out = [];
  for (const line of source.replace(/\r\n/g, '\n').split('\n')) {
    if (markers.has(line)) inside = markers.get(line);
    else if (!inside) out.push(line);
  }
  return out.join('\n');
}

// Claude Code reads CLAUDE.md raw, so an opencode-only block a project writes there reaches
// the Claude model too. Each one opens with an explicit "On OpenCode," (the same rule as
// commands and skills) so the Claude model cannot take it as its own instruction.
const ON_OPENCODE = /^(?:- )?(?:\*\*)?On OpenCode,/;
function unmarkedOpenCodeBlocks(source) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  lines.forEach((line, i) => {
    if (line !== FENCE_KINDS['opencode-only'].open) return;
    const first = lines.slice(i + 1).find((l) => l.trim() !== '') ?? '';
    if (!ON_OPENCODE.test(first)) out.push(`CLAUDE.md:${i + 1}`);
  });
  return out;
}

/**
 * The layer for OpenCode: the project's CLAUDE.md (or, without one, the template as init
 * would write it) with its own host blocks rendered, the template's claude-only blocks
 * swapped for their OpenCode text, the Sterling root filled in and each /sterling:<name>
 * pointed at its command file, then the OpenCode host tail. Whatever is left that only
 * Claude Code can act on is listed in a STERLING LAYER HOST CHECK block at the top.
 */
export function renderSterlingLayer(projectDir, pluginRoot = sterlingRoot(), templatePath = join(pluginRoot, 'templates', 'target-claude-md.md')) {
  const projectName = loadConfig(projectDir)?.project_name ?? basename(projectDir);
  const named = (s) => s.replaceAll('{{PROJECT_NAME}}', () => projectName);
  const templateText = readFileSync(templatePath, 'utf8');
  const pairs = hostBlockPairs(templateText).map((p) => ({ claude: p.claude.map(named), opencode: p.opencode.map(named) }));
  const claudeMdPath = join(projectDir, 'CLAUDE.md');
  const source = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, 'utf8') : named(renderClaudeText(templateText, templatePath));
  const lines = renderOpenCodeFullText(source, 'CLAUDE.md').split('\n');
  const plain = unfencedText(source);
  const unmatched = swapBlocks(lines, pairs).filter((first) => plain.includes(leadOf(first)));
  const missingCommands = [];
  const text = lines
    .join('\n')
    .replaceAll(ROOT_TOKEN, () => pluginRoot)
    .replaceAll('${CLAUDE_PLUGIN_ROOT}', () => pluginRoot)
    .replace(/`?\/sterling:([a-z][a-z-]*)`?/g, (whole, name) => {
      const file = join(pluginRoot, 'commands', `${name}.md`);
      if (existsSync(file)) return `${whole} (on OpenCode: follow \`${file}\`)`;
      missingCommands.push(`\`/sterling:${name}\` names a command with no file at ${file}.`);
      return whole;
    });
  const residue = CLAUDE_ONLY_RESIDUE.filter((t) => text.includes(t));
  const problems = [
    ...(residue.length ? [`Claude-only phrase(s) left in the text: ${residue.join(', ')}.`] : []),
    ...missingCommands,
    ...unmarkedOpenCodeBlocks(source).map((at) => `The opencode-only block at ${at} does not open with "On OpenCode,". Claude Code reads CLAUDE.md raw, so the Claude model could take it as its own instruction; start its first line with "On OpenCode,".`),
    ...(unmatched.length
      ? [`Claude-only template block(s) not found verbatim in CLAUDE.md: the project keeps its own wording of them, so their Claude Code text was not swapped for OpenCode's: ${unmatched.map((l) => `"${clip(l)}"`).join('; ')}. Restore the template wording, or wrap the project's version in claude-only / opencode-only blocks.`]
      : []),
  ];
  const body = `${text.trimEnd()}\n\n${opencodeHostTail(pluginRoot)}`;
  if (!problems.length) return body;
  return `STERLING LAYER HOST CHECK: parts of this project's CLAUDE.md could not be rendered for OpenCode and are injected unchanged. Read them as Claude Code instructions, apply the OpenCode host section at the end, and tell the user.\n${problems.map((p) => `- ${p}`).join('\n')}\n\n${body}`;
}
