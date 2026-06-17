// Shared project registry shape (decision 8f9e6db2). Defined here per the
// schema-defined-once invariant, but NOT a RECORD_TYPES member: a registry row
// is mutable metadata (last_seen_at updates every session), not an immutable
// durable knowledge record. The ProjectRegistry store (packages/store) is the
// one writer; this is the shape it validates on read.
import { z } from 'zod';

export const projectRegistrationSchema = z.object({
  // identity: the project root, absolute POSIX (machine-global, like backup_path —
  // NOT a repo-relative file_key, so it does not go through the path invariant).
  repo_path: z.string(),
  name: z.string(),
  // the project's stack_tags = the §3.3 domain mount manifest: which shared
  // domains this project joins (the real cross-project signal).
  stack_tags: z.array(z.string()).default([]),
  // toolchain adapter names (e.g. ["node"], ["pester"]) — quick stack context.
  toolchains: z.array(z.string()).default([]),
  // plugin version at last init — spot version skew across projects.
  sterling_version: z.string().nullable().default(null),
  first_init_at: z.string(),
  last_init_at: z.string(),
  // touched by the H1 SessionStart hook for an existing row — activity, not just
  // init recency. null until the first session start after registration.
  last_seen_at: z.string().nullable().default(null),
});

export type ProjectRegistration = z.infer<typeof projectRegistrationSchema>;
