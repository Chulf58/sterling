// The write fence a store carries in its store_meta table under the key
// 'move_fence' (STORE_FENCE_KEY). Every SterlingStore.tx() refuses a write
// while the key exists, whatever its value, so binaries that predate this
// union still refuse writes to a store fenced by a newer one.
//
// Two kinds, one key (decision domain-rename-is-a-fenced-copy-verb-on-domain-doctor):
//   move    the side a store move left (packages/store/src/store-move.ts).
//           Written before the union existed, so it carries no `kind` field;
//           an explicit kind 'move' is accepted too.
//   rename  a domain store that `domain-doctor rename` copied under a new
//           domain name. The fenced file is kept as the backup; store-move
//           refuses it, and a session that mounts it is told the new name.
import { z } from 'zod';

/** store_meta key holding the write fence (both kinds). */
export const STORE_FENCE_KEY = 'move_fence';

/** The fence a store move writes on the side it left. */
export const moveFenceSchema = z
  .object({
    kind: z.literal('move').optional(),
    move_id: z.string(),
    /** The counterpart the store moved to: 'postgres:<schema>' or 'sqlite:<absolute path>'. */
    to: z.string(),
    fenced_at: z.string().optional(),
    /** The manifest digest of the content at fencing; null until the snapshot is taken. */
    manifest_digest: z.string().nullable().optional(),
  })
  .passthrough();

const DOMAIN_NAME_RE = /^[a-z0-9_-]+$/;

/** The fence domain-doctor rename writes on the old domain store. */
export const renameFenceSchema = z
  .object({
    kind: z.literal('rename'),
    /** The rename's operation id; the copy's receipt carries the same id. */
    operation_id: z.string().min(1),
    from_domain: z.string().regex(DOMAIN_NAME_RE),
    to_domain: z.string().regex(DOMAIN_NAME_RE),
    /** Absolute POSIX path of the store published under the new name. */
    to_path: z.string().min(1),
    fenced_at: z.string(),
  })
  .strict();

/** A parsed move fence. `kind` is set by parseStoreFence; the stored value
 *  usually has none. Other stored fields are kept as they were. */
export interface MoveFenceValue {
  kind: 'move';
  move_id: string;
  to: string;
  fenced_at?: string;
  manifest_digest?: string | null;
  [key: string]: unknown;
}
export type RenameFence = z.infer<typeof renameFenceSchema>;
export type StoreFence = MoveFenceValue | RenameFence;

/**
 * Parse a store_meta 'move_fence' value into the union. A value with no
 * `kind` is a move fence (the shape written before the union existed). An
 * unknown kind, invalid JSON or a member that fails its schema throws: a
 * fence nobody can read is never treated as absent or as the other kind.
 */
export function parseStoreFence(value: string): StoreFence {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new Error(`store_meta '${STORE_FENCE_KEY}' is not JSON (${value.slice(0, 80)})`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`store_meta '${STORE_FENCE_KEY}' is not an object (${value.slice(0, 80)})`);
  }
  const kind = (raw as { kind?: unknown }).kind;
  if (kind === 'rename') {
    const r = renameFenceSchema.safeParse(raw);
    if (!r.success) throw new Error(`store_meta '${STORE_FENCE_KEY}' is a malformed rename fence: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
    return r.data;
  }
  if (kind === undefined || kind === 'move') {
    const r = moveFenceSchema.safeParse(raw);
    if (!r.success) throw new Error(`store_meta '${STORE_FENCE_KEY}' is a malformed move fence: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
    const fence = { ...r.data, kind: 'move' } as MoveFenceValue;
    return fence;
  }
  throw new Error(`store_meta '${STORE_FENCE_KEY}' has an unknown fence kind ${JSON.stringify(kind)}`);
}
