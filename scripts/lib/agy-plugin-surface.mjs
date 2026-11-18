// The Antigravity CLI (agy) plugin surface checks (board 792619d3): the root
// hooks.json shape agy's loader accepts, and one version across the three
// manifests. Measured contract: research_finding
// how-does-an-antigravity-cli-agy-plugin-load-manifest-hooks-j (agy 1.5.11).
// Builtins only; npm run check runs these through scripts/check-agent-registry.mjs.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The manifests whose `version` must agree, repo-relative. The agy manifest is checked when present. */
export const VERSION_MANIFESTS = ['package.json', '.claude-plugin/plugin.json', '.antigravity-plugin/plugin.json'];

// agy's loader takes a FLAT handler list on these events; wrapping one in
// {hooks:[...]} makes it skip the whole file (measured).
const FLAT_EVENTS = new Set(['SessionStart', 'PreInvocation', 'PostInvocation', 'Stop']);
const MATCHER_EVENTS = new Set(['PreToolUse', 'PostToolUse']);

function handlerViolations(where, h) {
  const out = [];
  if (h === null || typeof h !== 'object' || Array.isArray(h)) return [`${where}: a handler must be an object`];
  if ('hooks' in h || 'matcher' in h) out.push(`${where}: a ${'hooks' in h ? '{hooks:[...]}' : 'matcher'} wrapper on a non-tool event makes agy skip the whole file — list {type,command} handlers directly`);
  if (h.type !== undefined && h.type !== 'command') out.push(`${where}: type must be "command"`);
  if (typeof h.command !== 'string' || h.command.trim() === '') out.push(`${where}: command must be a non-empty string`);
  else if (h.command.includes('\\')) out.push(`${where}: backslash in command '${h.command}' (spec §6 emission rule)`);
  if (h.timeout !== undefined && (!Number.isInteger(h.timeout) || h.timeout <= 0)) out.push(`${where}: timeout must be a positive integer (seconds)`);
  return out;
}

/** The bundle file each `./hooks/<name>.mjs` command runs, or null when the command names none. */
export function commandBundle(command) {
  const m = /(?:^|\s)\.\/hooks\/([\w.-]+\.mjs)(?:\s|$)/.exec(command);
  return m ? m[1] : null;
}

/**
 * Violations of the root hooks.json shape: `{ "<group>": { "<event>": [...] } }`,
 * flat handlers on SessionStart/PreInvocation/PostInvocation/Stop, `{matcher,
 * hooks:[...]}` on PreToolUse/PostToolUse, and every command running a bundle
 * `bundleExists` confirms. Empty means the shape holds.
 */
export function agyHooksShapeViolations(doc, { bundleExists = () => true } = {}) {
  const out = [];
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return ['hooks.json: the top level must be an object of named hook groups'];
  const groups = Object.entries(doc);
  if (groups.length === 0) out.push('hooks.json: no hook group');
  for (const [group, events] of groups) {
    if (events === null || typeof events !== 'object' || Array.isArray(events)) {
      out.push(`hooks.json ${group}: a group must be an object of events`);
      continue;
    }
    for (const [event, list] of Object.entries(events)) {
      if (event === 'enabled') continue;
      const where = `hooks.json ${group}.${event}`;
      if (!FLAT_EVENTS.has(event) && !MATCHER_EVENTS.has(event)) {
        out.push(`${where}: agy has no such event`);
        continue;
      }
      if (!Array.isArray(list)) {
        out.push(`${where}: must be an array`);
        continue;
      }
      const handlers = [];
      list.forEach((entry, i) => {
        if (FLAT_EVENTS.has(event)) {
          out.push(...handlerViolations(`${where}[${i}]`, entry));
          handlers.push(entry);
          return;
        }
        if (entry === null || typeof entry !== 'object' || typeof entry.matcher !== 'string' || !Array.isArray(entry.hooks)) {
          out.push(`${where}[${i}]: a tool event entry must be {matcher: string, hooks: [...]}`);
          return;
        }
        entry.hooks.forEach((h, j) => {
          out.push(...handlerViolations(`${where}[${i}].hooks[${j}]`, h));
          handlers.push(h);
        });
      });
      for (const h of handlers) {
        if (typeof h?.command !== 'string') continue;
        const bundle = commandBundle(h.command);
        if (bundle === null) out.push(`${where}: command '${h.command}' runs no ./hooks/<bundle>.mjs`);
        else if (!bundleExists(bundle)) out.push(`${where}: command runs hooks/${bundle}, which does not exist`);
      }
    }
  }
  return out;
}

/** Violations of version parity across VERSION_MANIFESTS under `root` (an absent agy manifest is not checked). */
export function versionParityViolations(root) {
  const out = [];
  const seen = [];
  for (const rel of VERSION_MANIFESTS) {
    const p = join(root, rel);
    if (!existsSync(p)) {
      if (rel !== '.antigravity-plugin/plugin.json') out.push(`${rel}: missing`);
      continue;
    }
    let version;
    try {
      version = JSON.parse(readFileSync(p, 'utf8')).version;
    } catch (e) {
      out.push(`${rel}: not valid JSON (${(e && e.message) || e})`);
      continue;
    }
    if (typeof version !== 'string' || version === '') out.push(`${rel}: no version`);
    else seen.push([rel, version]);
  }
  if (new Set(seen.map(([, v]) => v)).size > 1) {
    out.push(`version fields DIVERGED: ${seen.map(([rel, v]) => `${rel} ${v}`).join(', ')} — they move together in one commit`);
  }
  return out;
}
