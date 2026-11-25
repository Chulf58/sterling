// The Sterling layer for OpenCode (decision sterling-layer-is-one-source-with-host-blocks):
// the template's opencode-only blocks, rendered, plus the OpenCode host tail. The shared Sterling
// rules are a generated section of the project's AGENTS.md, which OpenCode reads itself
// (decision project-rules-live-in-agents-md-claude-and-gemini-md-hold-only-the-sterling-layer),
// so only what is specific to OpenCode is injected here.
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadConfig } from '../../../scripts/hooks/lib/common.mjs';
import { sterlingRootFrom } from '../../../scripts/lib/opencode-install.mjs';
import { FENCE_KINDS, NO_COUNTERPART_MARKER, validateFences } from '../../../scripts/lib/agent-fences.mjs';

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
    "This session runs on OpenCode, not Claude Code. The OpenCode rules above are Sterling's OpenCode text; the shared Sterling layer is in AGENTS.md. The other differences:",
    '',
    install,
    '- **/plugin, --plugin-dir and the marketplace** do not apply. OpenCode loads Sterling through the plugin shim in its config dir. Sterling\'s commands are registered as OpenCode slash commands under the same names (`/sterling:<name>`), except `sterling:dashboard`, which does not exist here: open the dashboard with `/sterling` or <leader>k. Each command this layer names also points at its file under the commands directory. .claude/agents and .claude/settings.json are Claude Code surfaces and are absent here.',
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

// The template's opencode-only text names the Sterling root by this token; the render replaces it with the resolved root.
const ROOT_TOKEN = '{{STERLING_ROOT}}';
// Left in the layer after rendering, any of these gives the OpenCode model a Claude Code
// instruction it cannot carry out.
const CLAUDE_ONLY_RESIDUE = ['READY TO CLEAR', '/clear', 'AskUserQuestion'];
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

const OPENCODE_OPEN = FENCE_KINDS['opencode-only'].open;

// The lines of every opencode-only block, in template order.
function opencodeLines(templateText) {
  const out = [];
  let inside = false;
  for (const line of templateText.replace(/\r\n/g, '\n').split('\n')) {
    if (line === OPENCODE_OPEN) inside = true;
    else if (line === OPENCODE_CLOSE) inside = false;
    else if (inside) out.push(line);
  }
  return out;
}

/**
 * The layer for OpenCode: the template's opencode-only blocks with the Sterling root filled in and
 * each /sterling:<name> pointed at its command file, then the OpenCode host tail. Whatever is left
 * that only Claude Code can act on is listed in a STERLING LAYER HOST CHECK block at the top.
 */
export function renderSterlingLayer(projectDir, pluginRoot = sterlingRoot(), templatePath = join(pluginRoot, 'templates', 'target-claude-md.md')) {
  const projectName = loadConfig(projectDir)?.project_name ?? basename(projectDir);
  const templateText = readFileSync(templatePath, 'utf8');
  hostBlockPairs(templateText);
  const missingCommands = [];
  const rules = opencodeLines(templateText).join('\n')
    .replaceAll('{{PROJECT_NAME}}', () => projectName)
    .replaceAll(ROOT_TOKEN, () => pluginRoot)
    .replaceAll('${CLAUDE_PLUGIN_ROOT}', () => pluginRoot)
    .replace(/`?\/sterling:([a-z][a-z-]*)`?/g, (whole, name) => {
      const file = join(pluginRoot, 'commands', `${name}.md`);
      if (existsSync(file)) return `${whole} (on OpenCode: follow \`${file}\`)`;
      missingCommands.push(`\`/sterling:${name}\` names a command with no file at ${file}.`);
      return whole;
    });
  const residue = CLAUDE_ONLY_RESIDUE.filter((t) => rules.includes(t));
  const problems = [
    ...(residue.length ? [`Claude-only phrase(s) left in the text: ${residue.join(', ')}.`] : []),
    ...missingCommands,
  ];
  const body = `## Sterling layer on OpenCode\n\nThe shared Sterling rules are in the "Sterling layer (generated)" section of AGENTS.md. These rules are OpenCode's own.\n\n${rules.trim()}\n\n${opencodeHostTail(pluginRoot)}`;
  if (!problems.length) return body;
  return `STERLING LAYER HOST CHECK: parts of the OpenCode text could not be rendered and are injected unchanged. Read them as Claude Code instructions, apply the OpenCode host section at the end, and tell the user.\n${problems.map((p) => `- ${p}`).join('\n')}\n\n${body}`;
}
