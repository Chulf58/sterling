// Seed a record straight through a store's create, past the tool layer's
// write policy. Used where a pin needs a row knowledge_create now refuses:
// a domain-scoped feature_article that owns files (Domains D2, decision
// projects-mount-domains-and-sibling-projects: repo paths never enter a domain
// store through the tool surface). Such rows can still exist in a store
// written before that rule, so the downstream refusals stay pinned on them.
// The envelope matches the one knowledgeCreate assembles.
import { randomUUID } from 'node:crypto';
import type { DurableRecord } from '@sterling/schemas';

export function seedRecordRaw(
  store: { create(input: unknown): DurableRecord },
  type: string,
  fields: Record<string, unknown>,
  now: string
): DurableRecord {
  return store.create({
    id: randomUUID(),
    type,
    created_at: now,
    updated_at: now,
    author: 'conductor',
    status: 'active',
    superseded_by: null,
    links: [],
    scope: 'project',
    stack_tags: [],
    ...fields,
  });
}
