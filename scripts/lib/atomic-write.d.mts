// Type declarations for the part of atomic-write.mjs that TypeScript packages
// import statically (packages/tui/src/config-writeback.ts, replaceConfigFile).
export interface AtomicWriteFs {
  /** Called with (tmp, content), or with (tmp, content, { mode, flag: 'wx' }) when `mode` is set. */
  writeFile?: (tmp: string, content: string, options?: { mode: number; flag: string }) => void;
  rename?: (tmp: string, path: string) => void;
  /** Creates the temp file exclusively with this mode, so a private file is never written wider. */
  mode?: number;
}
export function writeFileAtomic(path: string, content: string, fs?: AtomicWriteFs): void;
