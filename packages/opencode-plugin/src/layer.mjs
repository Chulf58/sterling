// The Sterling layer for OpenCode: templates/target-claude-md.md with its
// Claude-only phrases mapped to OpenCode, plus the OpenCode host tail.
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadConfig } from '../../../scripts/hooks/lib/common.mjs';
import { sterlingRootFrom } from '../../../scripts/lib/opencode-install.mjs';

/**
 * The OpenCode host section appended after the host-mapped layer. `pluginRoot`
 * is the resolved Sterling root, or null when it could not be resolved.
 */
export function opencodeHostTail(pluginRoot) {
  const install = pluginRoot
    ? `- **Sterling is installed at \`${pluginRoot}\`.** Its scripts are \`${pluginRoot}/bin/*.mjs\` (run one with \`node "${pluginRoot}/bin/<name>.mjs"\`), its commands are \`${pluginRoot}/commands/*.md\`, its skills are \`${pluginRoot}/skills/*/SKILL.md\` and its agent templates are under \`${pluginRoot}/agent-templates/\`. Those files are written for Claude Code: where one says CLAUDE_PLUGIN_ROOT, use \`${pluginRoot}\`, and read the rest with the substitutions this layer makes.`
    : "- **Sterling's install root could not be resolved** (the error is above), so its scripts, commands and skills are unreachable this session. Tell the user before relying on any of them.";
  return [
    '## OpenCode host',
    '',
    "This session runs on OpenCode, not Claude Code. The layer above is Sterling's Claude Code layer with its Claude-only phrases rewritten for OpenCode. The other differences:",
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

// The Claude-only phrases of templates/target-claude-md.md and their OpenCode
// equivalents. A `phrase` is a literal the template must contain; a `lead`
// replaces the whole bullet that starts with it. One that matches nothing means
// the template drifted, and the render throws. `r` is the resolved Sterling root.
const LAYER_HOST_MAP = [
  { id: 'agents-import', phrase: '@AGENTS.md\n', to: () => '' },
  {
    id: 'conductor-install',
    phrase: "installed to this project's `.claude/agents/conductor.md` by install-agents/sync-agents and activated as the main-session agent through `\"agent\": \"conductor\"` in `.claude/settings.json`",
    to: () => "installed on OpenCode to this project's `.opencode/agents/sterling/conductor.md` by Sterling's init and update and made the default agent through `default_agent: \"sterling/conductor\"` in `.opencode/opencode.json` (on Claude Code: `.claude/agents/conductor.md`, activated in `.claude/settings.json`)",
  },
  {
    id: 'delivery-h19',
    phrase: 'H19 delivery helps here but does not excuse you:',
    to: () => 'Knowledge delivery (H19 on Claude Code; on OpenCode the Sterling plugin appends it to read, edit and write tool results, not yet to shell or patch) helps here but does not excuse you:',
  },
  {
    id: 'concept-designed-h10',
    phrase: 'so H10 holds the demand at session end',
    to: () => 'so the demand is held at session end (H10 does this on Claude Code; OpenCode does not mint it yet, so write the concept article before the turn ends)',
  },
  {
    id: 'wired-h7-h10',
    lead: '- **Wired, not just asked:**',
    to: () =>
      '- **Wired, not just asked:** on Claude Code H7 and H10 do this. On OpenCode the Sterling plugin settles each finished turn: the owning article of a changed file gets a maintenance item (`reconcile_needed`) and a STERLING NOTICE in the next turn. The demand for an owning article of unowned territory (`article_missing`) and for the concept article of a registered `concept_designed` event (`concept_article_missing`) are not minted on OpenCode yet, so meet them yourself before the work is done.',
  },
  { id: 'ask-question-tool', phrase: 'through the AskUserQuestion tool.**', to: () => "through OpenCode's `question` tool (AskUserQuestion on Claude Code).**" },
  { id: 'ask-question-form', phrase: 'goes through the AskUserQuestion tool form', to: () => 'goes through the `question` tool form' },
  {
    id: 'de-ai-skill',
    phrase: 'Run `sterling:de-ai-writing` on prose deliverables before they ship.**',
    to: (r) => `Run the de-ai-writing skill (\`${r}/skills/de-ai-writing/SKILL.md\`) on prose deliverables before they ship.**`,
  },
  {
    id: 'de-ai-scanner',
    phrase: "(the skill's scanner plus a read)",
    to: (r) => `(its scanner, \`node "${r}/skills/de-ai-writing/scripts/check-ai-signs.mjs" <file>\`, plus a read)`,
  },
  {
    id: 'review-territory-h22',
    phrase: 'Without it H22 falls back to prose-scraping the brief; H22 warns on a reviewer dispatch missing the line.',
    to: () => 'On Claude Code H22 reads the line, falls back to prose-scraping the brief without it and warns on a reviewer dispatch that lacks it. OpenCode has no H22; the line is still required, so a brief reads the same on both hosts.',
  },
  {
    id: 'store-guard-h15',
    phrase: '(Enforced: H15 — one rule:',
    to: () => '(Enforced on Claude Code by H15, and on OpenCode by the edit deny on `.sterling/sterling.db*` in `.opencode/opencode.json`, which covers the edit and write tools but not the shell — one rule:',
  },
  {
    id: 'platform-mechanics',
    phrase: "Claude Code's hook, frontmatter and transcript mechanics move between versions.",
    to: () => "OpenCode's plugin hooks, agent files and config move between versions, as Claude Code's hooks, frontmatter and transcripts do.",
  },
  {
    id: 'codex-availability',
    phrase: 'uses the `codex` MCP tool, with the lane',
    to: () => 'uses the `codex` MCP tool (on OpenCode only when a `codex` MCP server is configured for it; if the tool is absent, say so and skip the Codex lane), with the lane',
  },
  {
    id: 'codex-background',
    phrase: 'A call still running after 120s backgrounds itself and returns its result as a notification — normal, not a hang.',
    to: () => 'On Claude Code a call still running after 120s moves to the background and reports back as a notification. How OpenCode handles a long Codex call is unmeasured, so a slow call is not by itself a hang.',
  },
  {
    id: 'ready-for-new-session',
    lead: '- **Say `READY TO CLEAR` plainly when it is time.**',
    to: (r) =>
      `- **Say \`READY FOR NEW SESSION\` plainly when it is time.** At a clean boundary (the slice is committed, the rotation note is written by \`node "${r}/bin/rotation-note.mjs"\`, and nothing is in flight: no running lane, no uncommitted change, no pending capture), end the reply with the literal line \`READY FOR NEW SESSION\` in capitals, on its own line; the user then starts a new session with /new. If the session changed plugin or MCP-server code, write \`EXIT AND RELAUNCH\` instead, so OpenCode restarts on the new code. Never use a soft variant such as "fine to start over whenever you like". If something is still in flight, name it and do not print the line. User-stated 2026-09-26 for this line's Claude Code form, and user-ruled for OpenCode as this new-session wording: a hedged phrase buried in a summary gets missed, and the user is the one who starts the new session. On /new the Sterling plugin restores and consumes it in the new session's first turn.`,
  },
  { id: 'version-banner', phrase: '(the same value the session-start banner prints)', to: (r) => `(on OpenCode, read it from \`${r}/.claude-plugin/plugin.json\`)` },
  {
    id: 'agent-currency',
    phrase: ', and whether the session-start banner reported an AGENT CURRENCY warning',
    to: () => ', and whether the session-start banner reported an AGENT CURRENCY warning (that banner is Claude Code only; on OpenCode say that no agent-currency check ran)',
  },
  {
    id: 'strict-mcp-config',
    phrase: '- **A user-scope MCP server entry can be silently dropped under `--strict-mcp-config`.**',
    to: () => "- **On Claude Code, a user-scope MCP server entry can be silently dropped under `--strict-mcp-config`.** (OpenCode reads its MCP servers from its own config and the project's `.opencode/opencode.json`.)",
  },
];

// Left in the layer after mapping, any of these would give the OpenCode model a
// Claude Code instruction it cannot carry out.
const CLAUDE_ONLY_RESIDUE = ['${CLAUDE_PLUGIN_ROOT}', 'READY TO CLEAR', '/clear'];

/** Rewrite the Claude-only phrases of the layer for OpenCode; throws on template drift or an unmapped phrase. */
export function hostMapLayer(text, pluginRoot) {
  let out = text;
  for (const m of LAYER_HOST_MAP) {
    if (m.lead) {
      const lines = out.split('\n');
      const i = lines.findIndex((l) => l.startsWith(m.lead));
      if (i < 0) throw new Error(`Sterling layer host mapping '${m.id}': the bullet "${m.lead}" was not found in the template`);
      lines[i] = m.to(pluginRoot);
      out = lines.join('\n');
    } else {
      if (!out.includes(m.phrase)) throw new Error(`Sterling layer host mapping '${m.id}': "${m.phrase}" was not found in the template`);
      out = out.replaceAll(m.phrase, () => m.to(pluginRoot));
    }
  }
  out = out.replaceAll('${CLAUDE_PLUGIN_ROOT}', () => pluginRoot);
  out = out.replace(/`?\/sterling:([a-z][a-z-]*)`?/g, (whole, name) => {
    const file = join(pluginRoot, 'commands', `${name}.md`);
    if (!existsSync(file)) throw new Error(`Sterling layer host mapping: the template names /sterling:${name}, but ${file} does not exist`);
    return `${whole} (on OpenCode: follow \`${file}\`)`;
  });
  const left = CLAUDE_ONLY_RESIDUE.filter((t) => out.includes(t));
  if (left.length) throw new Error(`Sterling layer has unmapped Claude-only phrase(s) for OpenCode: ${left.join(', ')}`);
  return out;
}

/** The Sterling layer as init renders it into CLAUDE.md, host-mapped for OpenCode, plus the OpenCode host tail. */
export function renderSterlingLayer(projectDir, pluginRoot = sterlingRoot(), templatePath = join(pluginRoot, 'templates', 'target-claude-md.md')) {
  const projectName = loadConfig(projectDir)?.project_name ?? basename(projectDir);
  const mapped = hostMapLayer(readFileSync(templatePath, 'utf8').replace(/\r\n/g, '\n'), pluginRoot);
  return `${mapped.replaceAll('{{PROJECT_NAME}}', () => projectName).trimEnd()}\n\n${opencodeHostTail(pluginRoot)}`;
}
