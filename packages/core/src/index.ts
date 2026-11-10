export { Secret, generationOf, type Generation } from "./secret";
export {
  ENVIRONMENTS,
  type AccountCheck,
  type Destination,
  type DestinationCapabilities,
  type Environment,
  type Evidence,
  type Json,
  type KeyId,
  type KeyRef,
  type ProviderToken,
  type Receipt,
  type TokenPolicy,
  type TokenProvider,
  type VerifiedToken,
  type VaultBackend,
  type VaultCapabilities,
  type VaultItem,
  type VaultMetadata,
  type VaultScope,
} from "./contracts";
export {
  DESTINATION_KINDS,
  destinationId,
  parseMap,
  validateMap,
  type Consumer,
  type EnvEntry,
  type IssueSpec,
  type KeyEntry,
  type KeysMap,
  type MapResult,
  type PublishTarget,
} from "./map";
export { addDays, DUE_SOON_DAYS, isDay, periodDays } from "./rotation";
export { type Files } from "./files";
export { sameAccess } from "./tokens";
export { isRecord } from "./record";
export {
  emptyRegistry,
  loadRegistry,
  register,
  REGISTRY_VERSION,
  unregister,
  type Registry,
  type SharedKey,
} from "./registry";
export {
  emptyState,
  finishOperation,
  loadState,
  receiptsFor,
  recordReceipt,
  saveState,
  startOperation,
  STATE_VERSION,
  unfinishedOperations,
  type Operation,
  type State,
} from "./state";
export {
  approvalsFor,
  planPublish,
  sameRef,
  type Approval,
  type ApprovalReason,
  type PlanInput,
  type PlanStep,
  type PublishPlan,
  type RemovedDestination,
  type SkipReason,
  type WriteReason,
} from "./plan";
export {
  dropRotation,
  emptyRotations,
  loadRotations,
  putRotation,
  rotateCommand,
  saveRotations,
  unfinishedRotation,
  type Rotation,
  type Rotations,
  type RotationStage,
  type TokenRecord,
} from "./rotations";
export {
  buildStatus,
  type DestinationRow,
  type Problem,
  type ProblemKind,
  type Status,
  type StatusInput,
  type StatusRow,
} from "./status";
export const packageName = "@keypin/core";
