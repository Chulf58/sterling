// The one list of file extensions Sterling treats as SOURCE CODE (as opposed to
// documentation or data). Consumed by the undeclared-source disclosure
// (scripts/hooks/lib/undeclared-source.mjs) and by the state_review "planned
// over written code" check in packages/mcp-server/src/tools.ts, so "source"
// means one thing everywhere.

/** Lowercase extensions, no leading dot. */
export const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  'ts', 'js', 'mjs', 'cjs', 'tsx', 'jsx', 'py', 'go', 'rs', 'java', 'rb', 'cs', 'sh', 'gd', 'lua',
]);

/**
 * The basename's extension, lowercased, or null for a no-extension name or a
 * dotfile whose whole name would be the "extension" (never participates, v1: no
 * shebang sniff).
 */
export function sourceExtensionOf(path: string): string | null {
  const base = String(path).split('/').pop() ?? '';
  const idx = base.lastIndexOf('.');
  if (idx <= 0) return null;
  return base.slice(idx + 1).toLowerCase();
}

/** True when the path's extension is in SOURCE_EXTENSIONS. */
export function isSourcePath(path: string): boolean {
  const ext = sourceExtensionOf(path);
  return ext !== null && SOURCE_EXTENSIONS.has(ext);
}
