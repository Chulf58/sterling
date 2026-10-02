// OpenCode names the installed Sterling agents sterling/<role> (.opencode/agents/sterling/);
// Claude Code names them <role>. Every agent-type comparison on the OpenCode side
// goes through agentRole, so the shared name sets (stage-brief.mjs, dispatch-overlap.mjs,
// research_agents) match on both hosts (anti-pattern comparing-bare-agent-type-names-on-opencode).

/** The role an OpenCode agent name stands for: 'sterling/implementor' -> 'implementor'; any other value as given. */
export function agentRole(name) {
  return typeof name === 'string' ? name.replace(/^sterling\//, '') : name;
}
