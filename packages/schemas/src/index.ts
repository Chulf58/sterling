export { normalizeRepoPath, repoPath, toRepoRelative, matchesGlob } from './paths.js';
export {
  LINK_RELS,
  linkSchema,
  AUTHOR_RE,
  SCOPE_RE,
  envelopeFields,
  refineSupersession,
  // schema v2 identity pair [stable-identity-design-v2]
  LIFECYCLE_VALUES,
  FRESHNESS_VALUES,
} from './envelope.js';
export type { Lifecycle, Freshness } from './envelope.js';
export {
  verifiableAt,
  modelsCatalogSchema,
  decisionSchema,
  antiPatternSchema,
  researchFindingSchema,
  referenceMaterialSchema,
  disconfirmedHypothesisSchema,
  attestationSchema,
  featureArticleSchema,
  todoSchema,
  briefSchema,
  SYSTEM_REASONS,
  DRAIN_VERBS,
  RECORD_TYPES,
  validateRecord,
  knownFieldsFor,
  unknownFieldsIn,
  schemaFor,
  digestRecord,
  recordSizes,
  DIGEST_CLIP,
  AGENT_MODEL_KEY,
  REVIEWER_ROLES,
  AGENT_CLASS,
  PIPELINE_AGENT_TYPES,
} from './records.js';
export type { RecordType, RecordTypeEntry, DurableRecord, FieldShape } from './records.js';
export {
  SIGNALS,
  signalSchema,
  SIGNAL_PAYLOADS,
  SPINE_SIGNALS,
  spineSignal,
  handoffSchema,
  MACHINE_STATES,
  machineState,
  runRecordSchema,
  sessionEventSchema,
} from './transient.js';
export type { Signal, SpineSignal, Handoff, MachineState, RunRecord, SessionEvent } from './transient.js';
export { configSchema, parseConfig } from './config.js';
export type { SterlingConfig } from './config.js';
export { projectRegistrationSchema } from './registry.js';
export type { ProjectRegistration } from './registry.js';
export { BUILD_ID_FILE, runtimeMarkerSchema, buildIdPath, runtimeMarkerPath, stalenessVerdict } from './staleness.js';
export type { RuntimeMarker, StalenessVerdict } from './staleness.js';
