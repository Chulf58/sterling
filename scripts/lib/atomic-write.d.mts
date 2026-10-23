// Type declarations for the part of atomic-write.mjs that TypeScript packages
// import statically (packages/tui/src/config-writeback.ts, replaceConfigFile).
export function writeFileAtomic(
  path: string,
  content: string,
  fs?: {
    writeFile?: (tmp: string, content: string) => void;
    rename?: (tmp: string, path: string) => void;
  },
): void;
