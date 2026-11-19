// Type declarations for host-copies.mjs, imported by packages/tui/src/controller.ts.
export function renderHostCopies(opts: {
  projectDir: string;
  pluginRoot: string;
  /** test seam: the agy project setup */
  agySetup?: (args: { projectDir: string; pluginRoot: string }) => { skipped?: string; rows?: Array<{ item?: string; status?: string; detail?: string; refused?: boolean }> };
}): { notes: string[]; refused: string[] };
