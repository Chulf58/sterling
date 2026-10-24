export { normalizeRepoPath, repoPath, toRepoRelative, matchesGlob, samePath, isAbsolutePathAnyHost, sameLocationAnyHost, isUnderLocationAnyHost, classifyLocation, repoPathOfLocation, normalizeLocation, isCollapsedUrlLocation } from './paths.js';
export type { LocationKind } from './paths.js';
export {
  retiredTermSchema,
  retiredTermRegex,
  protectedSpans,
  findTermOccurrences,
  replaceRetiredTerms,
  retiredTermScanFields,
  collectRetiredTerms,
  retiredTermUses,
  retiredTermsInText,
  retiredTermWarning,
  RETIRED_TERM_SKIPPED_FIELDS,
  RETIRED_TERM_REWRITE_FIELDS,
} from './retired-terms.js';
export type { RetiredTermEntry, RetiredTerm, TermOccurrence, RetiredTermUse } from './retired-terms.js';
export { SOURCE_EXTENSIONS, sourceExtensionOf, isSourcePath } from './source-extensions.js';
export {
  LINK_RELS,
  WRITE_REFUSED_LINK_RELS,
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
  openQuestionSchema,
  attestationSchema,
  featureArticleSchema,
  todoSchema,
  todoHandoffSchema,
  todoHandoffReadSchema,
  todoWaitFieldsReadSchema,
  todoBoardItemReadSchema,
  needsReasonAllowed,
  needsReasonRequired,
  type TodoHandoff,
  HANDOFFS_DIR_REL,
  handoffClosureSchema,
  handoffClosureReadSchema,
  handoffEvidenceSchema,
  type HandoffEvidence,
  handoffEvidenceFileSchema,
  handoffEvidenceFileReadSchema,
  type HandoffEvidenceFile,
  HANDOFF_MILESTONE_MAX,
  type HandoffClosure,
  briefSchema,
  SYSTEM_REASONS,
  DRAIN_VERBS,
  RECORD_TYPES,
  validateRecord,
  objectShapeFor,
  knownFieldsFor,
  unknownFieldsIn,
  schemaFor,
  describeZod,
  exampleFor,
  digestRecord,
  headlineRecord,
  recordSizes,
  DIGEST_CLIP,
  HEADLINE_CLIP,
  NAME_CLIP,
  clipName,
  displayHandle,
  boardDisplayLabel,
  BOARD_NEEDS,
  AGENT_MODEL_KEY,
  REVIEWER_ROLES,
  ARTICLE_KINDS,
  NOT_APPLICABLE_EXEMPT_KINDS,
  ARTICLE_STATE_REQUIRES,
  OPEN_QUESTION_CLOSED,
  OPEN_QUESTION_TERMINUS_FIELD,
  TODO_SYSTEM_SOURCE,
  TODO_SYSTEM_REQUIRES,
  TODO_USER_ONLY_FIELDS,
  todoBlocksItself,
  undeclaredPhaseInterfaces,
  REPO_PATH_FORMAT,
  REPO_PATH_REFUSALS,
  fieldShapeAt,
  addFieldCondition,
  exampleRecordFor,
} from './records.js';
export type { RecordType, RecordTypeEntry, DurableRecord, FieldShape, BoardNeeds } from './records.js';
export { sessionEventSchema, NO_CAPTURE_LANES, noCaptureLaneSchema, WORKER_POLICY_LANES, workerPolicyItemSchema, workerPolicySchema } from './transient.js';
export type { SessionEvent, NoCaptureLane, WorkerPolicyLane, WorkerPolicyItem, WorkerPolicy } from './transient.js';
export { knowledgeWriteSchema, KNOWLEDGE_WRITES_REL, KNOWLEDGE_WRITES_DIR_REL, KNOWLEDGE_WRITES_PROCESS_FILE, KNOWLEDGE_WRITES_RETENTION_MS, KNOWLEDGE_WRITES_COMPACT_LINES, KNOWLEDGE_WRITES_KEEP_IDS, KNOWLEDGE_WRITES_TEMP_FILE, knowledgeWritesProcessFile, knowledgeWritesOwnerPid, knowledgeWritesTempFile, knowledgeWritesTempOwnerPid } from './transient.js';
export type { KnowledgeWrite } from './transient.js';
export { configSchema, parseConfig, normalizeRawConfig, migrateRetiredModelKeys, addModelDefaults, MODEL_DEFAULTS_MIGRATION_ID, moveImplementorHardTask, IMPLEMENTOR_HARD_MIGRATION_ID, resetOverpassDefaults, OVERPASS_DEFAULTS_MIGRATION_ID, AGENT_TOOL_NAME_RE, OPENCODE_MODEL_REF_RE, CLAUDE_MODEL_ID_RE, DEFAULT_UNDECLARED_SOURCE_EXCLUDE_GLOBS, unreadConfigKeys, describeUnreadConfigKeys, resolveOverpass, OverpassUnknownRoleError, DEFAULT_OVERPASS_PROVIDER, OVERPASS_PROVIDER_RE, OVERPASS_ROLES, MAINTENANCE_WORKER_ROLE, MAINTENANCE_WORKER_CLAUDE_MODEL, MAINTENANCE_WORKER_CLAUDE_EFFORT, OVERPASS_EFFORTS, OVERPASS_TIER_RE, OVERPASS_TIERS, DEFAULT_OVERPASS_TIER, DEFAULT_OVERPASS_ROLE_TIERS, DEFAULT_OVERPASS_ROLE_EFFORTS } from './config.js';
export type { SterlingConfig, UnreadConfigKey, OverpassResolution } from './config.js';
export { projectRegistrationSchema } from './registry.js';
export type { ProjectRegistration } from './registry.js';
export { BUILD_ID_FILE, runtimeMarkerSchema, buildIdPath, runtimeMarkerPath, stalenessVerdict } from './staleness.js';
export type { RuntimeMarker, StalenessVerdict } from './staleness.js';
export { PROJECT_MODES, ProjectModeError, ProjectIdentityError, PROJECT_IDENTITY_REL, readProjectMode, judgeProjectMode, readProjectIdentity, isProjectId } from './project.js';
export type { ProjectMode } from './project.js';
export {
  BROKER_PROTOCOL,
  BROKER_MAX_REQUEST_BYTES,
  BROKER_MAX_RESPONSE_BYTES,
  BROKER_DISCOVERY_MAX_ENTRIES,
  BROKER_REGISTRY_MAX_BYTES,
  BROKER_BOUNDS,
  BROKER_OPERATIONS,
  BROKER_MAX_ARGS,
  brokerIdentitySchema,
  brokerRegistrationSchema,
  brokerHelloSchema,
  brokerErrorSchema,
  brokerWelcomeSchema,
  brokerCallSchema,
  brokerResultSchema,
  isBrokerOperation,
} from './broker.js';
export type { BrokerTarget, BrokerIdentity, BrokerRegistration, BrokerHello, BrokerError, BrokerWelcome, BrokerCall, BrokerResult } from './broker.js';
export { STORE_FENCE_KEY, moveFenceSchema, renameFenceSchema, parseStoreFence } from './store-fence.js';
export type { StoreFence, RenameFence, MoveFenceValue } from './store-fence.js';
