// Config registration: the one place the plugin registers commands, skills and
// the sterling MCP entry with OpenCode. OpenCode 2.0.21's plugin context has no
// `config` hook; the registration surfaces are `ctx.command.transform(cb)`,
// `ctx.skill.transform(cb)` and `ctx.mcp.transform(cb)`, each returning a
// Registration. This is a no-op until a lane registers through them.

/** Returns `configure(ctx)`, called once from setup inside the `config` fence. */
export function createConfigHandler(deps = {}) {
  return async function configure(ctx) {};
}
