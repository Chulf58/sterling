// Re-render one project's agent copies on every installed host from its config.models: the
// System tab's model change realizes at once instead of waiting for the next /sterling:update
// (decision settings-redesign-build-shape-one-legacy-to-canonical-config). It runs the same
// renderers sync-agents runs: installAgents for the Claude copies (a modified copy is refused
// and reported, never overwritten), refreshFullAgentModels for OpenCode's Sterling-full set and
// setupAgy for agy. Host fit is the renderers' own: a host that cannot run an agent's model
// gets no copy and loses the unedited one Sterling generated.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig } from '@sterling/schemas';
import { installAgents } from './agent-distribution.mjs';
import { refreshFullAgentModels } from './opencode-install.mjs';
import { setupAgy } from './agy-setup.mjs';
import { storeRootFor } from './worktree-root.mjs';

/**
 * Returns { notes, refused }: one line per host saying what happened, and the lines that
 * need the user (a refused or failed render). A host failure is reported, never thrown, so
 * one host's failure does not hide the others; config.json itself is never touched here.
 * `agySetup` is a test seam.
 */
export function renderHostCopies({ projectDir, pluginRoot, agySetup = setupAgy }) {
  const notes = [];
  const refused = [];
  let config;
  try {
    config = parseConfig(JSON.parse(readFileSync(join(storeRootFor(projectDir), '.sterling', 'config.json'), 'utf8')));
  } catch (err) {
    return { notes, refused: [`the agent copies were not re-rendered: config.json does not validate (${err.message.replace(/\s+/g, ' ')})`] };
  }
  const agentsDir = join(projectDir, '.claude', 'agents');
  if (existsSync(agentsDir)) {
    try {
      const pluginVersion = JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8')).version;
      const { report } = installAgents({
        templatesDir: join(pluginRoot, 'agent-templates'),
        registryPath: join(pluginRoot, 'agent-templates', 'registry.json'),
        targetAgentsDir: agentsDir,
        pluginVersion,
        now: new Date().toISOString(),
        config,
      });
      const changed = report.filter((r) => ['installed', 'header_repaired', 'unsupported_removed'].includes(r.status)).length;
      notes.push(`Claude Code: ${changed} agent file(s) written or removed`);
      for (const r of report) if (r.refused) refused.push(`Claude Code agent ${r.name}: ${r.status}${r.detail ? ` (${r.detail})` : ''}`);
    } catch (err) {
      refused.push(`Claude Code agent files were not re-rendered: ${err.message}`);
    }
  }
  try {
    const oc = refreshFullAgentModels({ projectDir, pluginRoot });
    if (oc.refused) refused.push(`OpenCode agent files: ${oc.refused.detail}`);
    else if (oc.rows) {
      notes.push(`OpenCode: ${oc.rows.filter((r) => ['created', 'refreshed', 'removed'].includes(r.status)).length} agent file(s) written or removed`);
      for (const r of oc.rows) if (r.refused) refused.push(`OpenCode agent ${r.item}: ${r.detail ?? r.status}`);
    }
  } catch (err) {
    refused.push(`OpenCode agent files were not re-rendered: ${err.message}`);
  }
  try {
    const agy = agySetup({ projectDir, pluginRoot });
    if (agy.rows) {
      notes.push(`agy: ${agy.rows.filter((r) => ['created', 'refreshed', 'removed'].includes(r.status)).length} agent file(s) written or removed`);
      for (const r of agy.rows) if (r.refused) refused.push(`agy ${r.item}: ${r.detail ?? r.status}`);
    }
  } catch (err) {
    refused.push(`agy agent files were not re-rendered: ${err.message}`);
  }
  return { notes, refused };
}
