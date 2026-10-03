// BUNDLED-ARTIFACT GRAPH (invariant 3 — registries first, instantiated on the
// SET; board 16783088, research_finding foreign_890705ed). Every GENERATED artifact
// that ships tracked in this repo's tree is declared here as an EXECUTABLE
// descriptor — the build function itself plus the shipped location — and
// check-bundles-fresh.mjs iterates THIS list, never a family-specific glob.
// The measured failure this closes: the TUI bundle was the second member of
// the "bundled artifacts" set, there was no registry for it to be absent from,
// and it shipped two days stale with a completed feature missing while every
// net stayed green.
//
// WHY EXECUTABLE FUNCTIONS AND NOT A {builder, shipped} STRING TABLE: a
// metadata table beside the producer is a SECOND COPY of the producer, and
// this repo already holds measured drift of exactly that shape — the old
// check-bundles-fresh hand-mirrored build-hooks.mjs's esbuild options behind a
// keep-in-sync comment, and scripts/lib/update.mjs:GENERATED_TRACKED diverged
// from scripts/direct-merge.mjs:GENERATED_ONLY (outside-family review,
// 2026-08-29). Here the esbuild options exist ONCE, in the build functions
// below; scripts/build-hooks.mjs and scripts/build-tui.mjs are thin CLI
// callers, and the checker calls the same functions into a temp target. A
// build function returns the MANIFEST of files it emitted, so the checker
// compares what was actually built, never a parallel list.
//
// The build functions NEVER default to a shipped path — every caller passes
// an explicit output target. Building a shipped artifact in place is
// anti_pattern foreign_37b3cb0a (severity BLOCK): on this self-hosted clone the hook
// bundles are the LIVE enforcement surface, so an in-place build is an act of
// deployment. The thin CLIs own their shipped-path defaults and their strict
// flag parsing; this module owns only the build itself.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { contractHistoryJson } from './contract-bullets.mjs';
import { launcherHistorySnapshot } from './launcher-history.mjs';

// Banner for bundles that inline CommonJS dependencies: esbuild's ESM output
// has no `require`, so a bundled CJS module's require() of a node builtin
// needs one supplied from import.meta.url.
const CREATE_REQUIRE_BANNER = 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);';

// SOURCE-LOCATION IDENTITY for a bundle that ships at <root>/<shippedDir>/.
// Bundling collapses every module into one file, so each module's
// import.meta.url would become the BUNDLE's URL, and any path a module derives
// from its own location lands in the wrong place: scripts/lib/checks.mjs reads
// ../../agent-templates, scripts/adapters/resolve.mjs reads its own
// registry.json, packages/tui/dist/main.js reads ../../../.claude-plugin. This
// plugin rewrites import.meta.url in every repo-local module (never in
// node_modules) to the URL of that module's SOURCE file in the shipped tree,
// expressed RELATIVE to the bundle (e.g. "../scripts/lib/checks.mjs"), so every
// derived path resolves exactly as it does when the source runs, in any copy
// of the plugin tree, and the output never embeds a machine path. The rewrite
// depends only on shippedDir, never on the build's output target, so the
// checker's temp build stays byte-identical to the shipped one. What it does
// NOT do: make a module that the bundle loads at RUN time from the source tree
// (a spawn, or a computed dynamic import) standalone — that module still needs
// its own dependencies.
function sourceIdentityPlugin({ root, shippedDir }) {
  const up = shippedDir.split('/').map(() => '..').join('/');
  return {
    name: 'sterling-source-identity',
    setup(b) {
      b.onLoad({ filter: /\.m?js$/ }, (args) => {
        const rel = relative(root, args.path).split(sep).join('/');
        if (rel.startsWith('../') || rel.split('/').includes('node_modules')) return undefined;
        const src = readFileSync(args.path, 'utf8');
        if (!src.includes('import.meta.url')) return undefined;
        const url = `(new URL(${JSON.stringify(`${up}/${rel}`)}, import.meta.url).href)`;
        return { contents: src.replace(/\bimport\.meta\.url\b/g, url), loader: 'js', resolveDir: dirname(args.path) };
      });
    },
  };
}

// Bundle every scripts/hooks/h*.mjs (from srcDir) into standalone single-file
// bundles under outDir (invariant 4: dependency-light, esbuild-bundled, no
// workspace imports at runtime). Returns the emitted absolute paths.
// `only` (optional, an array of entry basenames) restricts the build to those
// entries — the test seam harness (scripts/tests/lib/seam-hook.mjs) builds ONE
// hook into a temp dir per suite. An `only` naming an entry that is not in
// srcDir is refused, never silently built as nothing.
export async function buildHooks({ root, srcDir, outDir, only }) {
  const all = readdirSync(srcDir).filter((f) => f.startsWith('h') && f.endsWith('.mjs'));
  let entries = all;
  if (only !== undefined) {
    if (!Array.isArray(only) || only.length === 0) throw new Error('buildHooks: `only` must be a non-empty array of hook entry basenames');
    const missing = only.filter((e) => !all.includes(e));
    if (missing.length) throw new Error(`buildHooks: \`only\` names entries not present in ${srcDir}: ${missing.join(', ')}`);
    entries = all.filter((e) => only.includes(e));
  }
  const emitted = [];
  for (const entry of entries) {
    await build({
      entryPoints: [join(srcDir, entry)],
      outfile: join(outDir, entry),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      // The workspace packages (@sterling/schemas, @sterling/store) always
      // resolve from THIS repo's node_modules, whatever srcDir points at. A
      // relocated source tree in the OS tmpdir (the mutation clean room) has
      // no node_modules above it, so ordinary resolution would fail; nodePaths
      // is the NODE_PATH-equivalent fallback and is consulted only after
      // normal resolution, so the default build is unchanged. Deliberate: the
      // clean room mutates HOOK SOURCES, never the workspace packages, so the
      // packages must come from the real tree — unlike the worktree shape
      // anti_pattern foreign_e2a1fee8 rejects, where a symlinked node_modules silently
      // swapped the SOURCE tree under the build.
      nodePaths: [join(root, 'node_modules')],
      // esbuild writes each module's path into the bundle as a comment,
      // RELATIVE to absWorkingDir (default: process.cwd()). Pinned to the repo
      // root, as for every other family, so the bytes — and therefore the
      // freshness check — do not depend on the directory the build ran from.
      absWorkingDir: root,
      banner: { js: '// GENERATED by scripts/build-hooks.mjs — do not edit; edit scripts/hooks/ and rebuild.' },
    });
    emitted.push(join(outDir, entry));
  }
  return emitted;
}

// Bundle the TUI (spec §11) into ONE standalone file at outFile (shipped,
// committed, at tui/sterling-tui.mjs so a /plugin install can launch it): zero runtime
// node_modules resolution — the standalone launch path has no SessionStart
// hook to heal the environment, so there must be nothing to repair. Builds
// from packages/tui/dist (tsc output), so a stale dist produces a faithfully
// stale bundle — the checker's dist guards exist for exactly that. Returns the
// emitted absolute path as a one-element manifest.
export async function buildTui({ root, outFile }) {
  await build({
    entryPoints: [join(root, 'packages', 'tui', 'dist', 'main.js')],
    outfile: outFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    // terminal-kit's lazy requires are bundler-hostile; it ships a static entry
    // (termkit-no-lazy-require.js) for exactly this case. The alias covers the
    // package import; the onLoad rewrite makes INTERNAL require('./termkit.js')
    // calls delegate to the same static entry (its own runtime check cannot work
    // inside a bundle). The README stub keeps the termconfig glob bundleable.
    alias: { 'terminal-kit': 'terminal-kit/lib/termkit-no-lazy-require.js' },
    absWorkingDir: root,
    plugins: [
      sourceIdentityPlugin({ root, shippedDir: 'tui' }),
      {
        name: 'terminal-kit-static',
        setup(b) {
          b.onLoad({ filter: /terminal-kit[\\/]lib[\\/]termkit\.js$/ }, () => ({
            contents: "module.exports = require('./termkit-no-lazy-require.js');",
            loader: 'js',
            resolveDir: join(root, 'node_modules', 'terminal-kit', 'lib'),
          }));
          b.onLoad({ filter: /termconfig[\\/]README$/ }, () => ({ contents: 'module.exports = {};', loader: 'js' }));
        },
      },
    ],
    // deps resolve at build time and are inlined; node: builtins stay external
    banner: {
      js: [
        '// GENERATED by scripts/build-tui.mjs — single-file Sterling TUI; do not edit.',
        CREATE_REQUIRE_BANNER,
        'import { fileURLToPath as __f2p } from "node:url"; import { dirname as __dn } from "node:path";',
        'const __filename = __f2p(import.meta.url); const __dirname = __dn(__filename);',
      ].join('\n'),
    },
  });
  return [outFile];
}

// Bundle the MCP server into outDir/sterling-mcp.mjs (shipped, committed, at
// mcp/sterling-mcp.mjs so a /plugin install runs it with no node_modules;
// decision sterling-ships-as-a-marketplace-plugin-authoring-machine-keeps-its-clone).
// Builds from packages/mcp-server/dist (tsc output); node:sqlite and every other
// node: builtin stay external. The server's own import.meta.url is left as the
// bundle's: recordRuntimeMarker reads the build-id BESIDE the running entry, so
// outDir/.build-id is written here — a content hash of the bundle bytes, the
// same 16-hex shape as scripts/build-stamp.mjs's dist stamp, so a no-op rebuild
// yields the same id. Returns [bundle, .build-id].
export async function buildMcp({ root, outDir }) {
  const outFile = join(outDir, 'sterling-mcp.mjs');
  await build({
    entryPoints: [join(root, 'packages', 'mcp-server', 'dist', 'main.js')],
    outfile: outFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    absWorkingDir: root,
    banner: {
      js: ['// GENERATED by scripts/build-mcp.mjs — single-file Sterling MCP server; do not edit.', CREATE_REQUIRE_BANNER].join('\n'),
    },
  });
  const buildIdFile = join(outDir, '.build-id');
  writeFileSync(buildIdFile, createHash('sha256').update(readFileSync(outFile)).digest('hex').slice(0, 16));
  return [outFile, buildIdFile];
}

// The scripts a command (commands/*.md), a skill, a generated project artifact or H1
// invokes through ${CLAUDE_PLUGIN_ROOT}, each bundled to bin/<name>.mjs so it runs from a
// /plugin install with no node_modules and no packages/*/dist. name → source
// entry. init bundles init-impl.mjs, not init.mjs: init.mjs is a builtins-only
// bootstrap whose whole job is to precheck node_modules and packages/*/dist
// before importing init-impl.mjs, and a bundle has neither to check.
// The OpenCode 2 server plugin (decision
// sterling-on-opencode-2-is-the-knowledge-loop-in-one-small-plugin): one ESM
// file OpenCode's Bun runtime loads. node: built-ins stay external
// (platform node); the workspace packages and hook libraries are inlined.
// import.meta.url is left as the bundle's own URL, so the template and the
// maintenance worker's plugin root resolve by walking up from opencode/.
export async function buildOpencode({ root, outFile }) {
  await build({
    entryPoints: [join(root, 'packages', 'opencode-plugin', 'src', 'server.mjs')],
    outfile: outFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    absWorkingDir: root,
    banner: {
      js: ['// GENERATED by scripts/build-opencode.mjs — Sterling OpenCode 2 server plugin; do not edit.', CREATE_REQUIRE_BANNER].join('\n'),
    },
  });
  return [outFile];
}

// The OpenCode 2 dashboard plugin (opencode/sterling-tui/tui.tsx) as one file
// beside its source, named by that directory's package.json exports['./tui'].
// A marketplace install has no node_modules and no packages/*/dist, so the
// workspace packages and scripts/lib are inlined. solid-js and @opentui/solid
// stay external: OpenCode supplies them to TUI plugins. JSX is preserved and the
// file keeps the .tsx extension and the @jsxImportSource pragma on line 1, so
// OpenCode compiles it exactly as it compiles the source.
export async function buildOpencodeTui({ root, outFile }) {
  await build({
    entryPoints: [join(root, 'opencode', 'sterling-tui', 'tui.tsx')],
    outfile: outFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    jsx: 'preserve',
    external: ['solid-js', 'solid-js/*', '@opentui/solid', '@opentui/solid/*'],
    absWorkingDir: root,
    // preserve mode ignores the source's @jsxImportSource on purpose; the banner restates it
    logOverride: { 'unsupported-jsx-comment': 'silent' },
    plugins: [sourceIdentityPlugin({ root, shippedDir: 'opencode/sterling-tui' })],
    banner: {
      js: ['/** @jsxImportSource @opentui/solid */', '// GENERATED by scripts/build-opencode-tui.mjs — Sterling OpenCode 2 dashboard plugin; do not edit.', CREATE_REQUIRE_BANNER].join('\n'),
    },
  });
  return [outFile];
}

export const BIN_ENTRIES = {
  'check-agents-visible': 'scripts/check-agents-visible.mjs',
  // the two checks templates/check-consumer.mjs (the sterling-check.mjs launcher) spawns
  'check-record-citations': 'scripts/check-record-citations.mjs',
  'check-stale-claims': 'scripts/check-stale-claims.mjs',
  'cleanup-plan': 'scripts/cleanup-plan.mjs',
  // the concept_designed no-server fallback templates/target-claude-md.md names
  'concept-designed': 'scripts/concept-designed.mjs',
  'debug-scope': 'scripts/debug-scope.mjs',
  'direct-merge': 'scripts/direct-merge.mjs',
  'fs-remove': 'scripts/fs-remove.mjs',
  'handoff-projection': 'scripts/handoff-projection.mjs',
  init: 'scripts/init-impl.mjs',
  'install-agents': 'scripts/install-agents.mjs',
  'list-projects': 'scripts/list-projects.mjs',
  'migrate-stores': 'scripts/migrate-stores.mjs',
  // the no_capture no-server fallback the MCP server's session-event refusal names
  'no-capture': 'scripts/no-capture.mjs',
  'plan-lock': 'scripts/plan-lock.mjs',
  'pr-review-wait': 'scripts/pr-review-wait.mjs',
  // files a scrubbed Sterling defect report as a GitHub issue from a consumer project
  'report-issue': 'scripts/report-issue.mjs',
  'rotation-note': 'scripts/rotation-note.mjs',
  'stamp-contract': 'scripts/stamp-contract.mjs',
  'sync-agents': 'scripts/sync-agents.mjs',
  update: 'scripts/update.mjs',
};

// Bundle every BIN_ENTRIES script into outDir/<name>.mjs. Source-location
// identity (above) keeps each module's derived paths pointing into the shipped
// tree: bin/ sits one level below the root exactly as scripts/ does, and nested
// modules (scripts/lib/*, scripts/adapters/*) keep their own locations.
// It also writes outDir/contract-history.json, the stamp-contract bullet history an installed
// copy (no git) reads in place of the templates' git log (scripts/lib/contract-history.mjs);
// it leaves out the current template blocks, so a template commit does not make bin/ stale.
// outDir/launcher-history.json is the same for the launcher templates: the earlier versions
// init matches an existing launcher against (scripts/lib/launcher-history.mjs).
// Returns the emitted absolute paths.
export async function buildBins({ root, outDir }) {
  const emitted = [];
  for (const [name, entry] of Object.entries(BIN_ENTRIES)) {
    const outFile = join(outDir, `${name}.mjs`);
    await build({
      entryPoints: [join(root, entry)],
      outfile: outFile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      absWorkingDir: root,
      plugins: [sourceIdentityPlugin({ root, shippedDir: 'bin' })],
      banner: {
        js: [`// GENERATED by scripts/build-bin.mjs from ${entry} — do not edit; edit the source and rebuild.`, CREATE_REQUIRE_BANNER].join('\n'),
      },
    });
    emitted.push(outFile);
  }
  const historyFile = join(outDir, 'contract-history.json');
  writeFileSync(historyFile, contractHistoryJson(root));
  emitted.push(historyFile);
  const launcherHistoryFile = join(outDir, 'launcher-history.json');
  writeFileSync(launcherHistoryFile, launcherHistorySnapshot({ repoRoot: root }));
  emitted.push(launcherHistoryFile);
  return emitted;
}

// THE REGISTRY. Each descriptor:
//   name          short label for check output
//   builderScript repo-relative path of the thin CLI (diagnostic + the
//                 totality scan's join key — the CLI is a caller of the build
//                 function above, never a second copy of the options)
//   build         ({root, outTarget}) → emitted absolute paths. outTarget is a
//                 DIRECTORY for kind 'dir', a FILE path for kind 'file'.
//   kind          'dir' | 'file' — how outTarget and shipped are interpreted
//   shipped       repo-relative POSIX path of the shipped output
//   rebuild       remediation command a staleness failure prints
//   distGuards    workspace packages whose compiled dist the build vendors
//                 (verified by grep 2026-08-29: hooks import @sterling/schemas
//                 + @sterling/store; the TUI additionally builds FROM its own
//                 dist). The checker refuses when a guard's src is newer than
//                 its dist: with a stale dist BOTH sides of the byte-compare
//                 vendor the same stale code and the check passes on exactly
//                 the staleness it exists to catch (decision foreign_83bb625c's class,
//                 held at the checker itself because direct-merge invokes it
//                 standalone).
export const BUNDLED_ARTIFACTS = [
  {
    name: 'hooks',
    builderScript: 'scripts/build-hooks.mjs',
    kind: 'dir',
    shipped: 'hooks',
    rebuild: 'npm run build:hooks',
    distGuards: ['packages/schemas', 'packages/store'],
    build: ({ root, outTarget }) => buildHooks({ root, srcDir: join(root, 'scripts', 'hooks'), outDir: outTarget }),
  },
  {
    name: 'tui',
    builderScript: 'scripts/build-tui.mjs',
    kind: 'file',
    shipped: 'tui/sterling-tui.mjs',
    rebuild: 'npm run build:tui',
    distGuards: ['packages/schemas', 'packages/store', 'packages/tui'],
    build: ({ root, outTarget }) => buildTui({ root, outFile: outTarget }),
  },
  {
    name: 'mcp',
    builderScript: 'scripts/build-mcp.mjs',
    kind: 'dir',
    shipped: 'mcp',
    rebuild: 'npm run build:mcp',
    distGuards: ['packages/schemas', 'packages/store', 'packages/mcp-server'],
    build: ({ root, outTarget }) => buildMcp({ root, outDir: outTarget }),
  },
  {
    name: 'bin',
    builderScript: 'scripts/build-bin.mjs',
    kind: 'dir',
    shipped: 'bin',
    rebuild: 'npm run build:bin',
    distGuards: ['packages/schemas', 'packages/store'],
    build: ({ root, outTarget }) => buildBins({ root, outDir: outTarget }),
  },
  {
    name: 'opencode',
    builderScript: 'scripts/build-opencode.mjs',
    kind: 'file',
    shipped: 'opencode/sterling-server.mjs',
    rebuild: 'npm run build:opencode',
    distGuards: ['packages/schemas', 'packages/store'],
    build: ({ root, outTarget }) => buildOpencode({ root, outFile: outTarget }),
  },
  {
    name: 'opencode-tui',
    builderScript: 'scripts/build-opencode-tui.mjs',
    kind: 'file',
    shipped: 'opencode/sterling-tui/sterling-tui.bundle.tsx',
    rebuild: 'npm run build:opencode-tui',
    distGuards: ['packages/schemas', 'packages/store', 'packages/tui'],
    build: ({ root, outTarget }) => buildOpencodeTui({ root, outFile: outTarget }),
  },
];

// FAIL-CLOSED TOTALITY (the consistency check invariant 3 demands): the
// checker scans every scripts/build-*.mjs AND every package.json script named
// build/build:* — each must resolve to a registered builderScript above or
// appear here WITH ITS REASON. Adding a third bundled artifact therefore fails
// `npm run check` (and the merge gate, which runs the same checker) until it
// is registered — the gate the TUI bundle never had. Only build steps that
// ship NO tracked artifact belong in these lists.
export const NON_SHIPPING_BUILD_SCRIPTS = {
  'build-stamp.mjs':
    'writes packages/mcp-server/dist/.build-id — dist/ is gitignored, nothing tracked ships from it',
};
export const NON_SHIPPING_PACKAGE_BUILD_SCRIPTS = {
  build:
    'tsc into gitignored packages/*/dist plus build-stamp — compile inputs to the bundles, not a shipped artifact itself',
  'build:bundles':
    'runs every registered builder CLI in turn — each output is gated through its own descriptor in BUNDLED_ARTIFACTS',
};
// NOTE on `prepare` (npm ci time): it runs `npm run build` ONLY — the
// gitignored packages/*/dist — and rebuilds NO registered bundle in place. Every
// family above (hooks, tui, mcp, bin) is committed, and rebuilding a tracked
// bundle at dependency-install time on a consumer clone would dirty tracked
// files from whatever dist happens to hold (decision
// fresh-clone-bootstrap-prepare-plus-preflight, foreign_8a8ae518 — first
// reasoned for the hooks, the live enforcement surface; the TUI joined the rule
// when its bundle became committed, decision
// sterling-ships-as-a-marketplace-plugin-authoring-machine-keeps-its-clone).
// Freshness of the committed bundles is the checker's job, not prepare's.
