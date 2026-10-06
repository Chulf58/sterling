// The hook store broker's wire shapes (decision
// hook-store-broker-whole-method-rpc-over-local-socket). On Postgres storage
// the MCP server serves whole store operations to hooks over a local Unix
// socket, so a hook skips its own TLS login. Defined once here and imported by
// the server (packages/mcp-server/src/broker.ts) and the hook client
// (scripts/hooks/lib/broker-client.mjs).
//
// Framing: a 4-byte big-endian length, then that many bytes of UTF-8 JSON.
// A frame longer than its bound is refused and the connection closed.
import { z } from 'zod';

/** Bumped on any change to the shapes or the operation registry below. */
export const BROKER_PROTOCOL = 1;

/** Largest request frame the server reads (hooks send method arguments, never bulk data). */
export const BROKER_MAX_REQUEST_BYTES = 1024 * 1024;
/** Largest response frame the client reads. */
export const BROKER_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
/** Most registry files discovery reads for one project. */
export const BROKER_DISCOVERY_MAX_ENTRIES = 32;
/** Largest registry file discovery reads. */
export const BROKER_REGISTRY_MAX_BYTES = 16 * 1024;

/** Each phase has its own bound (ms). */
export const BROKER_BOUNDS = {
  /** Connecting to the socket. */
  connectMs: 500,
  /** Hello to welcome. */
  handshakeMs: 1000,
  /** How long a call may wait in the server before it starts; past this it is refused unexecuted. */
  queueMs: 2000,
  /** How long the client waits for a started call's result; past this the outcome is unknown. */
  executeMs: 20_000,
} as const;

/**
 * The operation registry: the only store methods a hook may call through the
 * broker. `project` is the project SterlingStore; `mounted` is the server's
 * MountedStores. Each is one complete operation inside the server: none takes a
 * callback and none leaves a transaction open between frames.
 */
export const BROKER_OPERATIONS = {
  project: [
    'get',
    'query',
    'count',
    'articlesBySlug',
    'inboundSupersedes',
    'boardReadiness',
    'getMeta',
    'create',
    'enqueueSystemTodo',
    'updateTodo',
    'remove',
    'recordCheckSkipped',
  ],
  mounted: ['domainNames', 'bySource', 'querySource', 'inboundSupersedes', 'domainDescription'],
} as const;
export type BrokerTarget = keyof typeof BROKER_OPERATIONS;

/** Most arguments any registered operation takes. */
export const BROKER_MAX_ARGS = 6;

/** What the server says about itself; the client checks every field it can derive on its own. */
export const brokerIdentitySchema = z.object({
  instance_id: z.string().regex(/^[0-9a-f]{32}$/),
  protocol: z.number().int(),
  build_id: z.string(),
  project_id: z.string(),
  root: z.string(),
  storage: z.object({ backend: z.literal('postgres'), database: z.string(), meta_schema: z.string(), project_schema: z.string() }),
  pid: z.number().int(),
});
export type BrokerIdentity = z.infer<typeof brokerIdentitySchema>;

/** The registry file a ready server publishes: its identity plus the socket to reach it. */
export const brokerRegistrationSchema = brokerIdentitySchema.extend({ socket: z.string() });
export type BrokerRegistration = z.infer<typeof brokerRegistrationSchema>;

export const brokerHelloSchema = z.object({
  type: z.literal('hello'),
  protocol: z.number().int(),
  instance_id: z.string(),
  project_id: z.string(),
  root: z.string(),
});
export type BrokerHello = z.infer<typeof brokerHelloSchema>;

export const brokerErrorSchema = z.object({
  name: z.string(),
  message: z.string(),
  /** Enumerable string or number fields of the original error (domain, location, schema, code). */
  fields: z.record(z.union([z.string(), z.number()])).default({}),
});
export type BrokerError = z.infer<typeof brokerErrorSchema>;

export const brokerWelcomeSchema = z.union([
  z.object({ type: z.literal('welcome'), identity: brokerIdentitySchema }),
  z.object({ type: z.literal('refused'), error: brokerErrorSchema }),
]);
export type BrokerWelcome = z.infer<typeof brokerWelcomeSchema>;

export const brokerCallSchema = z.object({
  type: z.literal('call'),
  id: z.number().int().nonnegative(),
  target: z.enum(['project', 'mounted']),
  op: z.string(),
  args: z.array(z.unknown()).max(BROKER_MAX_ARGS),
  /** Client clock (ms since epoch) when the call was sent; client and server share the machine clock. */
  sent_at: z.number(),
});
export type BrokerCall = z.infer<typeof brokerCallSchema>;

export const brokerResultSchema = z.union([
  z.object({ type: z.literal('result'), id: z.number().int(), ok: z.literal(true), result: z.unknown().optional() }),
  /** `executed` false means the server did not start the operation, so the caller may fall back; true or absent means it may have run. */
  z.object({ type: z.literal('result'), id: z.number().int(), ok: z.literal(false), executed: z.boolean(), error: brokerErrorSchema }),
]);
export type BrokerResult = z.infer<typeof brokerResultSchema>;

/** True when `op` is registered for `target`. */
export function isBrokerOperation(target: string, op: string): target is BrokerTarget {
  const ops = (BROKER_OPERATIONS as Record<string, readonly string[]>)[target];
  return Array.isArray(ops) && ops.includes(op);
}
