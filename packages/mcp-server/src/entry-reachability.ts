/**
 * Is a feature article's entry file reached? (decision
 * feature-article-states-follow-the-spec-meaning; board a11fea72.)
 *
 * An article marks its entry with files[].entry; the read-time state_review arm
 * in tools.ts asks this module whether a registry reaches that file. "Reached"
 * is a string membership test against one registry per entry kind, never an
 * import graph (measured on finding
 * feature-article-state-accuracy-and-wiring-check-machinery-october-2026: an
 * import graph gave 15 false positives from dynamic adapters and spawned
 * scripts):
 *
 *  - hook     scripts/hooks/<h>.mjs or hooks/<h>.mjs: a hooks/hooks.json command
 *             runs hooks/<h>.mjs (the source maps to its bundle by basename, as
 *             buildHooks in scripts/lib/bundled-artifacts.mjs emits it).
 *  - command  commands/<x>.md: the file exists (the platform auto-discovers it).
 *  - skill    skills/<name>/SKILL.md: the file exists (auto-discovered).
 *  - tool     packages/mcp-server/src/server.ts or tools.ts: the files[] ROLE
 *             names at least one tool that server.ts registers with
 *             registerTool. That is how an article names its tool: mark
 *             server.ts or tools.ts as the entry and name the tool in its role.
 *  - script   scripts/<x>.mjs (top level) or bin/<name>.mjs: BIN_ENTRIES in
 *             scripts/lib/bundled-artifacts.mjs lists it AND a command, skill,
 *             agent template, template, hooks.json or script other than the
 *             entry itself names bin/<name>.mjs or '<name>.mjs'; or the root
 *             package.json "scripts" run it; or shipped code spawns it by a path
 *             built from segments (a scripts/ source file, test files excluded,
 *             whose code, comments removed, passes 'scripts' then '<x>.mjs' as
 *             adjacent string literals to join() or resolve(), such as
 *             join(pluginRoot, 'scripts', 'maintenance-worker-run.mjs')). A script
 *             nothing references, such as an operator CLI, is still not reached.
 *  - agent    agent-templates/<x>.md: agent-templates/registry.json lists it.
 *
 * Any other path (a library file under packages/ or scripts/lib/) is not
 * judged: judge() returns null.
 *
 * ONLY A STERLING CLONE IS JUDGED. These registries are Sterling's own, so in
 * any other tree (a consumer project, which has its own scripts/, hooks/ or
 * agent-templates/ that mean something else) every entry is not judged and
 * judge() returns null. A tree counts as a Sterling clone by the predicate
 * isSterlingClone in scripts/lib/handoff-projection.mjs uses:
 * .claude-plugin/plugin.json names "sterling" and
 * scripts/architecture-projection.mjs exists. It is restated here because the
 * MCP server imports nothing from scripts/. A plugin.json that does not parse
 * reads as not a clone, since its name cannot be read.
 *
 * WHAT THIS DOES NOT CATCH:
 *  - library entries: a module that is only imported is never judged, so an
 *    article whose only entry is a library passes whatever its state.
 *  - dynamic wiring: a script spawned by a computed name, an adapter loaded by
 *    path at runtime, a bin referenced only from packages/ sources (for
 *    example the no-capture fallback named in a tools.ts refusal) reads as not
 *    referenced, and a reference in a comment counts the same as a call (except
 *    on the segmented-join route, which ignores comments and test files).
 *  - runtime failures: a registered hook that crashes, a tool that throws, a
 *    command whose script was renamed after the reference was written all read
 *    as reached. Reached means listed, not working.
 *  - a tool role that names a registered tool in passing counts as reached.
 *
 * Every registry is read lazily, once per instance; the caller keeps one
 * instance per knowledge_query call and tree root. Inside a Sterling clone, a
 * missing or unparseable registry is reported in the verdict's detail as not
 * reached, so the state check says what it could not read instead of passing
 * silently.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type EntryKind = 'hook' | 'command' | 'skill' | 'tool' | 'script' | 'agent';

export interface EntryVerdict {
  path: string;
  kind: EntryKind;
  reached: boolean;
  /** why: which registry reached it, or what was missing */
  detail: string;
}

const MCP_TOOL_FILES = new Set(['packages/mcp-server/src/server.ts', 'packages/mcp-server/src/tools.ts']);
const TOOL_NAME_TOKEN = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

/** Directories whose files may reference a bin (non-recursive), plus single files. */
const BIN_REFERENCE_DIRS = ['commands', 'agent-templates', 'templates', 'scripts', 'scripts/lib', 'scripts/hooks', 'scripts/hooks/lib'];
const BIN_REFERENCE_FILES = ['hooks/hooks.json'];
const BIN_REGISTRY_FILE = 'scripts/lib/bundled-artifacts.mjs';

const SOURCE_FILE = /\.(?:mjs|cjs|js)$/;
const TEST_FILE = /(?:\.test\.[cm]?js$|\/tests?\/)/;

/**
 * The source with its // and block comments blanked, string and template
 * literals kept (a comment marker inside a literal is not a comment). A regex
 * literal holding a quote can derail the scan; the effect is a missed
 * reference, never an invented one.
 */
function stripComments(src: string): string {
  let out = '';
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      out += ' ';
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

type Loaded<T> = { ok: true; value: T } | { ok: false; why: string };

export class EntryReachability {
  private hookCommands?: Loaded<string[]>;
  private toolNames?: Loaded<Set<string>>;
  private binEntries?: Loaded<Map<string, string>>;
  private agentFiles?: Loaded<Set<string>>;
  private npmScripts?: Loaded<string[]>;
  private referenceCorpus?: Map<string, string>;
  private sterlingClone?: boolean;

  constructor(private readonly root: string) {}

  /**
   * The verdict for one entry file, or null when no registry covers its kind
   * or the tree is not a Sterling clone.
   */
  judge(path: string, role: string): EntryVerdict | null {
    if (!(this.sterlingClone ??= this.isSterlingClone())) return null;
    let m: RegExpExecArray | null;
    if ((m = /^(?:scripts\/)?hooks\/([^/]+\.mjs)$/.exec(path))) return this.judgeHook(path, m[1]);
    if (/^commands\/[^/]+\.md$/.test(path)) return this.judgePresent(path, 'command');
    if (/^skills\/[^/]+\/SKILL\.md$/.test(path)) return this.judgePresent(path, 'skill');
    if (MCP_TOOL_FILES.has(path)) return this.judgeTool(path, role);
    if ((m = /^agent-templates\/([^/]+\.md)$/.exec(path))) return this.judgeAgent(path, m[1]);
    if (/^scripts\/[^/]+\.mjs$/.test(path) || /^bin\/[^/]+\.mjs$/.test(path)) return this.judgeScript(path);
    return null;
  }

  /**
   * Why judge() returns null for this entry, or null when it is judged. The
   * write receipt of a state_review close uses it to say the entry was not
   * reach-checked (board 12e97ef5).
   */
  unjudgedReason(path: string, role: string): string | null {
    if (!(this.sterlingClone ??= this.isSterlingClone())) {
      return 'this tree is not a Sterling clone, whose registries the check reads, so reachability was not checked';
    }
    return this.judge(path, role) === null
      ? 'no registry (hooks, commands, skills, tools, bin entries, agents) covers its kind, so reachability was not checked'
      : null;
  }

  private judgeHook(path: string, bundle: string): EntryVerdict {
    const commands = (this.hookCommands ??= this.load('hooks/hooks.json', (text) => {
      const out: string[] = [];
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) node.forEach(walk);
        else if (node && typeof node === 'object') {
          for (const [k, v] of Object.entries(node)) {
            if (k === 'command' && typeof v === 'string') out.push(v);
            else walk(v);
          }
        }
      };
      walk(JSON.parse(text));
      return out;
    }));
    if (!commands.ok) return { path, kind: 'hook', reached: false, detail: commands.why };
    const target = `hooks/${bundle}`;
    const hit = commands.value.some((c) => c === target || c.includes(`/${target}`) || c.includes(` ${target}`));
    return hit
      ? { path, kind: 'hook', reached: true, detail: `hooks/hooks.json runs ${target}` }
      : { path, kind: 'hook', reached: false, detail: `no hooks/hooks.json command runs ${target}` };
  }

  private judgePresent(path: string, kind: 'command' | 'skill'): EntryVerdict {
    return existsSync(join(this.root, path))
      ? { path, kind, reached: true, detail: `${kind} file present` }
      : { path, kind, reached: false, detail: `${path} does not exist, so nothing discovers it` };
  }

  private judgeTool(path: string, role: string): EntryVerdict {
    const names = (this.toolNames ??= this.load('packages/mcp-server/src/server.ts', (text) => {
      const out = new Set<string>();
      for (const hit of text.matchAll(/registerTool\(\s*['"]([a-z][a-z0-9_]*)['"]/g)) out.add(hit[1]);
      return out;
    }));
    if (!names.ok) return { path, kind: 'tool', reached: false, detail: names.why };
    const named = [...new Set(role.match(TOOL_NAME_TOKEN) ?? [])];
    const registered = named.filter((n) => names.value.has(n));
    if (registered.length) return { path, kind: 'tool', reached: true, detail: `server.ts registers ${registered.join(', ')}` };
    return {
      path,
      kind: 'tool',
      reached: false,
      detail: named.length
        ? `its role names ${named.join(', ')}, and server.ts registers none of them`
        : `its role names no tool; a tool entry names its registerTool name in the files[] role`,
    };
  }

  private judgeAgent(path: string, file: string): EntryVerdict {
    const files = (this.agentFiles ??= this.load('agent-templates/registry.json', (text) => {
      const parsed = JSON.parse(text) as { agents?: { file?: unknown }[] };
      return new Set((parsed.agents ?? []).map((a) => a.file).filter((f): f is string => typeof f === 'string'));
    }));
    if (!files.ok) return { path, kind: 'agent', reached: false, detail: files.why };
    return files.value.has(file)
      ? { path, kind: 'agent', reached: true, detail: `agent-templates/registry.json lists ${file}` }
      : { path, kind: 'agent', reached: false, detail: `agent-templates/registry.json does not list ${file}` };
  }

  private judgeScript(path: string): EntryVerdict {
    const npm = (this.npmScripts ??= this.readNpmScripts());
    if (path.startsWith('scripts/') && npm.ok && npm.value.some((s) => s.includes(path))) {
      return { path, kind: 'script', reached: true, detail: 'a package.json script runs it' };
    }
    const spawner = path.startsWith('scripts/') ? this.findSegmentedJoin(path) : undefined;
    if (spawner) return { path, kind: 'script', reached: true, detail: `${spawner} builds its path from segments with join()` };
    const bins = (this.binEntries ??= this.load(BIN_REGISTRY_FILE, (text) => {
      const block = /export const BIN_ENTRIES\s*=\s*\{([\s\S]*?)\n\};/.exec(text);
      if (!block) throw new Error('no BIN_ENTRIES object found');
      const out = new Map<string, string>();
      for (const hit of block[1].matchAll(/^\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:\s*['"]([^'"]+)['"]/gm)) {
        out.set(hit[1] ?? hit[2] ?? hit[3], hit[4]);
      }
      return out;
    }));
    if (!bins.ok) return { path, kind: 'script', reached: false, detail: bins.why };
    let name: string | undefined;
    let source: string | undefined;
    const binPath = /^bin\/([^/]+)\.mjs$/.exec(path);
    if (binPath) {
      name = bins.value.has(binPath[1]) ? binPath[1] : undefined;
      source = name ? bins.value.get(name) : undefined;
    } else {
      for (const [n, src] of bins.value) if (src === path) [name, source] = [n, src];
    }
    if (!name) {
      const npmNote = npm.ok ? 'no package.json script runs it' : npm.why;
      return { path, kind: 'script', reached: false, detail: `${BIN_REGISTRY_FILE} BIN_ENTRIES does not list it and ${npmNote}` };
    }
    const tokens = [`bin/${name}.mjs`, `'${name}.mjs'`, `"${name}.mjs"`];
    for (const [file, text] of this.corpus()) {
      if (file === source || file === path) continue;
      if (tokens.some((t) => text.includes(t))) return { path, kind: 'script', reached: true, detail: `BIN_ENTRIES lists ${name} and ${file} references it` };
    }
    return { path, kind: 'script', reached: false, detail: `BIN_ENTRIES lists ${name} but no command, skill or script references bin/${name}.mjs` };
  }

  /**
   * The shipped scripts/ source that passes 'scripts' and '<x>.mjs' as adjacent
   * string literals to a join() or resolve() call, or undefined. Test files, the
   * entry itself and anything inside a comment are ignored; calls nested two deep
   * are allowed before the literals, as in
   * join(dirname(fileURLToPath(import.meta.url)), 'scripts', 'y.mjs').
   */
  private findSegmentedJoin(path: string): string | undefined {
    const base = path.slice('scripts/'.length).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nest1 = String.raw`(?:[^()]|\([^()]*\))*`;
    const nest2 = String.raw`(?:[^()]|\(${nest1}\))*?`;
    const call = new RegExp(
      String.raw`(?<![\w$])(?:[\w$]+\.)?(?:join|resolve)\s*\(${nest2}(['"\`])scripts\1\s*,\s*(['"\`])${base}\2\s*[,)]`,
    );
    for (const [file, text] of this.corpus()) {
      if (file === path || !file.startsWith('scripts/') || !SOURCE_FILE.test(file) || TEST_FILE.test(file)) continue;
      if (call.test(stripComments(text))) return file;
    }
    return undefined;
  }

  private corpus(): Map<string, string> {
    if (this.referenceCorpus) return this.referenceCorpus;
    const out = new Map<string, string>();
    const add = (rel: string) => {
      try {
        out.set(rel, readFileSync(join(this.root, rel), 'utf8'));
      } catch (err) {
        // a listed name that is a directory, or a skill folder without SKILL.md
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'EISDIR') throw err;
      }
    };
    const list = (dir: string): string[] => {
      try {
        return readdirSync(join(this.root, dir));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
      }
    };
    for (const dir of BIN_REFERENCE_DIRS) {
      for (const name of list(dir)) {
        const rel = `${dir}/${name}`;
        if (rel !== BIN_REGISTRY_FILE) add(rel);
      }
    }
    for (const skill of list('skills')) add(`skills/${skill}/SKILL.md`);
    for (const file of BIN_REFERENCE_FILES) add(file);
    this.referenceCorpus = out;
    return out;
  }

  /** Same predicate as isSterlingClone in scripts/lib/handoff-projection.mjs (see the header). */
  private isSterlingClone(): boolean {
    if (!existsSync(join(this.root, 'scripts/architecture-projection.mjs'))) return false;
    const manifest = this.load('.claude-plugin/plugin.json', (text) => (JSON.parse(text) as { name?: unknown }).name);
    return manifest.ok && manifest.value === 'sterling';
  }

  private readNpmScripts(): Loaded<string[]> {
    if (!existsSync(join(this.root, 'package.json'))) return { ok: true, value: [] };
    return this.load('package.json', (text) => {
      const scripts = (JSON.parse(text) as { scripts?: Record<string, unknown> }).scripts ?? {};
      return Object.values(scripts).filter((v): v is string => typeof v === 'string');
    });
  }

  private load<T>(rel: string, parse: (text: string) => T): Loaded<T> {
    const abs = join(this.root, rel);
    if (!existsSync(abs)) return { ok: false, why: `${rel} is missing` };
    try {
      return { ok: true, value: parse(readFileSync(abs, 'utf8')) };
    } catch (err) {
      return { ok: false, why: `${rel} could not be parsed (${(err as Error).message})` };
    }
  }
}
