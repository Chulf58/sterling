// Config registration: the one place the plugin registers commands, skills and
// the sterling MCP entry with OpenCode. The plugin context has no single `config`
// hook; it has one surface per kind. The ones used here are `ctx.command.transform(cb)`,
// `ctx.skill.transform(cb)` and `ctx.mcp.transform(cb)`, each returning a
// Registration. 2.0.22 also has `ctx.agent.transform(cb)` and `ctx.permission.hook(name, fn)`
// (with tool, shell and others). Sterling does not use the agent transform: a plugin's
// transform runs BEFORE the built-in one that loads agent files, so it cannot see or
// guard a project agent, and awaiting ctx.agent.list() in setup hangs (both measured
// live). The store guard uses permission.hook('evaluate') instead (store-guard.mjs).
// Measured on 2.0.21:
//   - a command name may contain ':' (and '/'), so commands/<name>.md registers as
//     sterling:<name>, the name Claude Code uses. execute receives
//     { sessionID, prompt: { text: <the arguments> }, delivery } and puts the body
//     into the session with ctx.session.prompt, as OpenCode's own /init does;
//   - a skill is Skill.Info { id, name, description, path, content }: content is the
//     body without frontmatter, and the directory of `path` is the base that the
//     skill's relative paths (scripts/, references/) resolve against;
//   - every transform callback runs again on each reload against a fresh base, so
//     the callbacks add from what setup rendered once;
//   - the mcp callback sees the `sterling` entry of the project's
//     .opencode/opencode.json, and set() replaces it.
// Bodies come from the one source (commands/*.md, skills/*/SKILL.md), rendered for
// OpenCode: host fences, the resolved root for ${CLAUDE_PLUGIN_ROOT}, and the
// Claude-only phrases mapped. One that still holds a Claude-only phrase is not
// registered: it gets a log line and a notice, and the others still register.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderOpenCodeFullText } from '../../../scripts/lib/agent-fences.mjs';
import { projectRoot } from '../../../scripts/hooks/lib/common.mjs';
import { sterlingRoot as defaultSterlingRoot } from './layer.mjs';
import { LOG_REL, errText, logLine } from './log.mjs';
import { addNotice } from './notices.mjs';

export const COMMAND_PREFIX = 'sterling:';
export const SKILL_PREFIX = 'sterling:';

// Commands/<name>.md files that are not registered on OpenCode. A registered command only
// puts its body into the session as a prompt (execute above); it cannot open a TUI view,
// and the plugin API this file uses has no call that does. The dashboard is the TUI
// plugin's own `/sterling` command (<leader>k), so a prompt command named
// sterling:dashboard would only talk about it (GitHub issue 51).
export const OPENCODE_UNREGISTERED_COMMANDS = ['dashboard'];

// Claude Code phrase -> OpenCode phrase, applied in order after ${CLAUDE_PLUGIN_ROOT}.
// Each AskUserQuestion phrasing the sources use has its own rule, so the result reads.
const HOST_MAP = [
  [/(?:the )?`?AskUserQuestion`? tool\b/g, "OpenCode's `question` tool"],
  [/\b(an?|the) `?AskUserQuestion`? (form|call)\b/g, (_, art, noun) => `${art === 'the' ? 'the' : 'a'} \`question\` tool ${noun}`],
  [/`?AskUserQuestion`? (form|call)\b/g, (_, noun) => `\`question\` tool ${noun}`],
  [/\*\*AskUserQuestion\*\*/g, 'the **`question`** tool'],
  [/\(AskUserQuestion\)/g, '(the `question` tool)'],
  [/`AskUserQuestion`/g, 'the `question` tool'],
  [/READY TO CLEAR/g, 'READY FOR NEW SESSION'],
  // Sterling installs the roster under .opencode/agents/sterling/ on OpenCode (STERLING_AGENTS_SUBDIR).
  [/\.claude\/agents\//g, '.opencode/agents/sterling/'],
];

// Left in a body after mapping, any of these is a Claude Code instruction the
// OpenCode model cannot carry out.
const CLAUDE_ONLY_RESIDUE = [
  ['CLAUDE_PLUGIN_ROOT', /CLAUDE_PLUGIN_ROOT/],
  ['AskUserQuestion', /AskUserQuestion/],
  ['READY TO CLEAR', /READY TO CLEAR/],
  ['/clear', /(^|[\s`(])\/clear\b/m],
];

/** Split `---` frontmatter (single-line `key: value` pairs) from the body. */
export function splitFrontmatter(text, label) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) throw new Error(`${label}: no frontmatter block`);
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: text.slice(m[0].length).replace(/^\n+/, '') };
}

/** Render one command or skill text for OpenCode; throws naming the residue. */
export function hostMapText(text, root, label) {
  let out = renderOpenCodeFullText(text, label).replaceAll('${CLAUDE_PLUGIN_ROOT}', () => root);
  for (const [from, to] of HOST_MAP) out = out.replace(from, to);
  const left = CLAUDE_ONLY_RESIDUE.filter(([, re]) => re.test(out)).map(([name]) => name);
  if (left.length) throw new Error(`${label} has unmapped Claude-only phrase(s) for OpenCode: ${left.join(', ')}`);
  return out;
}

function renderSource(path, root, label) {
  const { meta, body } = splitFrontmatter(readFileSync(path, 'utf8').replace(/\r\n/g, '\n'), label);
  if (!meta.description) throw new Error(`${label}: frontmatter has no description`);
  return { meta, description: hostMapText(meta.description, root, `${label} description`), body: hostMapText(body, root, label).trimEnd() };
}

/**
 * Every commands/*.md and skills/*\/SKILL.md under `root`, rendered for OpenCode.
 * An item that fails to render lands in `failures` with its label, never thrown.
 */
export function renderRegistrations(root) {
  const commands = [];
  const skills = [];
  const failures = [];
  const commandsDir = join(root, 'commands');
  const skillsDir = join(root, 'skills');
  if (!existsSync(commandsDir)) throw new Error(`no commands directory at ${commandsDir}`);
  if (!existsSync(skillsDir)) throw new Error(`no skills directory at ${skillsDir}`);
  for (const file of readdirSync(commandsDir).filter((f) => f.endsWith('.md') && !OPENCODE_UNREGISTERED_COMMANDS.includes(f.slice(0, -3))).sort()) {
    const name = `${COMMAND_PREFIX}${file.slice(0, -3)}`;
    try {
      const { description, body } = renderSource(join(commandsDir, file), root, `commands/${file}`);
      commands.push({ name, description, body });
    } catch (e) {
      failures.push({ kind: 'command', name, error: errText(e) });
    }
  }
  for (const dir of readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
    const path = join(skillsDir, dir, 'SKILL.md');
    if (!existsSync(path)) continue;
    const id = `${SKILL_PREFIX}${dir}`;
    try {
      const { description, body } = renderSource(path, root, `skills/${dir}/SKILL.md`);
      skills.push({ id, name: id, description, path, content: body });
    } catch (e) {
      failures.push({ kind: 'skill', name: id, error: errText(e) });
    }
  }
  return { commands, skills, failures };
}

/** The `sterling` local MCP entry for the Sterling copy at `root`, serving the project's stores (--project routes by config.storage). */
export function mcpEntry(root, project) {
  return {
    type: 'local',
    command: ['node', '--disable-warning=ExperimentalWarning', join(root, 'mcp', 'sterling-mcp.mjs'), '--project', project],
  };
}

/** The text a command puts into the session: its body, plus the arguments as Claude Code appends them. */
export function commandText(body, args) {
  const a = (args ?? '').trim();
  return a ? `${body}\n\nARGUMENTS: ${a}` : body;
}

/** Register `commands` (rendered { name, description, body }) through ctx.command.transform. */
function registerCommands(ctx, commands) {
  return ctx.command.transform((editor) => {
    for (const c of commands) {
      editor.add({
        name: c.name,
        description: c.description,
        execute: (inv) => ctx.session.prompt({ ...inv.prompt, sessionID: inv.sessionID, text: commandText(c.body, inv.prompt?.text), delivery: inv.delivery }).then(() => {}),
      });
    }
  });
}

// The commands that work before a project has a store: init creates it, and projects
// reads only the machine registry (~/.sterling/registry.db). Every other command, every
// skill and the sterling MCP entry need the project's store, so they wait for init.
export const BOOTSTRAP_COMMANDS = [`${COMMAND_PREFIX}init`, `${COMMAND_PREFIX}projects`];

/**
 * Returns `bootstrap(ctx)`, called once from setup OUTSIDE a Sterling project, so a
 * new user has /sterling:init. It writes nothing into the project: a command that
 * fails to render is skipped with one stderr line (a Sterling defect, not the project's).
 */
export function createBootstrapHandler(deps = {}) {
  const stderr = deps.stderr ?? ((s) => process.stderr.write(s));
  return async function bootstrap(ctx) {
    const root = deps.sterlingRoot ?? defaultSterlingRoot();
    const commands = [];
    for (const name of BOOTSTRAP_COMMANDS) {
      const file = `${name.slice(COMMAND_PREFIX.length)}.md`;
      try {
        const { description, body } = renderSource(join(root, 'commands', file), root, `commands/${file}`);
        commands.push({ name, description, body });
      } catch (e) {
        stderr(`[sterling] /${name} not registered on OpenCode: ${errText(e)}\n`);
      }
    }
    await registerCommands(ctx, commands);
  };
}

/** Returns `configure(ctx)`, called once from setup inside the `config` fence. */
export function createConfigHandler(deps = {}) {
  const now = deps.now ?? (() => new Date().toISOString());
  return async function configure(ctx) {
    const project = projectRoot(ctx?.location?.directory);
    if (!project) throw new Error('configure ran outside a Sterling project');
    const root = deps.sterlingRoot ?? defaultSterlingRoot();
    const { commands, skills, failures } = renderRegistrations(root);
    for (const f of failures) {
      logLine(project, `config: ${f.kind} ${f.name} not registered: ${f.error}`);
      addNotice(project, `Sterling plugin: the ${f.kind} ${f.kind === 'command' ? `/${f.name}` : f.name} is not registered on OpenCode (${f.error}). See ${LOG_REL}.`, now());
    }

    await registerCommands(ctx, commands);

    await ctx.skill.transform((editor) => {
      for (const s of skills) {
        if (editor.get(s.id)) editor.remove(s.id);
        editor.add({ ...s });
      }
    });

    // Precedence: this copy's entry replaces a `sterling` entry from the project
    // config (decision sterling-opencode-plugin-injects-its-own-mcp-entry: the entry
    // follows the code that is actually loaded). A replaced entry that differed is logged once.
    const want = mcpEntry(root, project);
    let replacedLogged = false;
    await ctx.mcp.transform((editor) => {
      const existing = editor.get('sterling');
      if (existing && !replacedLogged && JSON.stringify(existing.command) !== JSON.stringify(want.command)) {
        replacedLogged = true;
        logLine(project, `config: the sterling MCP entry from the project config (${JSON.stringify(existing)}) is replaced by this copy's (${JSON.stringify(want)})`);
      }
      editor.set('sterling', { ...want, command: [...want.command] });
    });
  };
}
