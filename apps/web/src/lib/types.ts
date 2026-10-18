export type Role = 'admin' | 'storekeeper' | 'technician' | 'auditor';
export type ToolStatus = 'available' | 'checked_out' | 'quarantined' | 'retired';
export type CalibrationState = 'not_required' | 'ok' | 'due_soon' | 'expired';
export type ReturnCondition = 'ok' | 'damaged' | 'needs_calibration';

export interface Me {
  id: string;
  email: string;
  displayName: string;
  role: Role;
}

export interface Tool {
  id: string;
  assetTag: string;
  name: string;
  category: string;
  status: ToolStatus;
  homeLocationId: string;
  homeLocationName: string;
  requiresCalibration: boolean;
  calibrationIntervalDays: number | null;
  lastCalibratedOn: string | null;
  calibrationDueOn: string | null;
  calibrationState: CalibrationState;
  holderId: string | null;
  holderName: string | null;
  dueBackAt: string | null;
  overdue: boolean;
  rfidUid: string | null;
}

export interface ToolDetail extends Tool {
  openCheckout: {
    id: string;
    holderId: string;
    holderName: string;
    checkedOutAt: string;
    dueBackAt: string;
    overdue: boolean;
  } | null;
  calibrations: {
    id: string;
    calibratedOn: string;
    dueOn: string;
    certificateRef: string | null;
    performedBy: string;
  }[];
}

export interface Checkout {
  id: string;
  toolId: string;
  assetTag: string;
  toolName: string;
  holderId: string;
  holderName: string;
  checkedOutAt: string;
  dueBackAt: string;
  returnedAt: string | null;
  conditionOnReturn: ReturnCondition | null;
  notes: string | null;
  overdue: boolean;
}

export interface Location {
  id: string;
  name: string;
  kind: 'crib' | 'bay' | 'line' | 'external';
}

export interface Dashboard {
  counts: {
    total: number;
    available: number;
    checkedOut: number;
    quarantined: number;
    calibrationExpired: number;
    calibrationDueSoon: number;
    overdue: number;
  };
  myCheckouts: {
    id: string;
    toolId: string;
    assetTag: string;
    toolName: string;
    checkedOutAt: string;
    dueBackAt: string;
    overdue: boolean;
  }[];
  dueSoonDays: number;
  /** Staff and auditors only. */
  insights: { likelyLate: number; lossRisk: number; openAnomalies: number } | null;
}

export interface UserRow {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  isActive: boolean;
  createdAt: string;
  badgeUid: string | null;
}

export interface Holder {
  id: string;
  displayName: string;
  role: Role;
}

export interface Invite {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  createdAt?: string;
  inviteUrl?: string;
}

export interface Station {
  id: string;
  name: string;
  locationId: string;
  locationName: string;
  isActive: boolean;
  keyVersion: number;
  lastSeenAt: string | null;
  online: boolean;
}

export interface Provisioning {
  stationId: string;
  keyVersion: number;
  stationKey: string;
  eventsTopic: string;
  repliesTopic: string;
  firmwareConfig: string;
}

export interface StationEvent {
  id: string;
  stationId: string;
  stationName: string;
  receivedAt: string;
  kind: 'hello' | 'tap';
  uid: string | null;
  outcome: 'accepted' | 'rejected';
  code: string;
  userId: string | null;
  userName: string | null;
  toolId: string | null;
  assetTag: string | null;
}

export interface FloorEvent {
  kind: 'checked_out' | 'returned' | 'tool_changed' | 'checkout_updated' | 'station_event';
  toolId?: string;
  assetTag?: string;
  stationId?: string;
  actorId?: string;
  message?: string;
  at: string;
}

export interface AuditEntry {
  id: number;
  at: string;
  action: string;
  entityType: string;
  entityId: string | null;
  entityName: string | null;
  details: Record<string, unknown>;
  actorIp: string | null;
  actorUserId: string | null;
  actorName: string | null;
  actorStationId: string | null;
  stationName: string | null;
  toolAssetTag: string | null;
  hash: string;
}

export interface AuditVerification {
  ok: boolean;
  checked: number;
  head: { id: number; hash: string } | null;
  firstProblem: { id: number; reason: 'missing_entries' | 'broken_link' | 'content_changed' } | null;
  anchorMatches: boolean | null;
}

export interface RiskFactor {
  key: string;
  text: string;
  impact: number;
}

export interface AtRiskCheckout {
  checkoutId: string;
  toolId: string;
  assetTag: string;
  toolName: string;
  category: string;
  holderId: string;
  holderName: string;
  checkedOutAt: string;
  dueBackAt: string;
  offlineQueuedAt: string | null;
  overdue: boolean;
  lateProbability: number | null;
  lossProbability: number | null;
  factors: RiskFactor[];
  scoredAt: string | null;
}

export interface Anomaly {
  id: string;
  checkoutId: string;
  score: number;
  reasons: { key: string; text: string; z: number }[];
  detectedAt: string;
  status: 'open' | 'confirmed' | 'dismissed';
  reviewNote: string | null;
  reviewedAt: string | null;
  reviewedByName: string | null;
  toolId: string;
  assetTag: string;
  toolName: string;
  holderName: string;
  checkedOutAt: string;
  dueBackAt: string;
  returnedAt: string | null;
}

export interface ModelMetrics {
  model: string;
  labelled?: number;
  reason?: string;
  validationRocAuc?: Record<string, number | null>;
  test?: {
    n: number;
    positives?: number;
    baseRate: number | null;
    rocAuc: number | null;
    prAuc: number | null;
    brier: number | null;
  };
  testReliable?: boolean;
  selection?: string;
  baselineTestRocAuc?: number | null;
}

export interface MlRun {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'succeeded' | 'failed';
  modelVersion: string;
  trainedOn: number | null;
  error: string | null;
  metrics: {
    late?: ModelMetrics;
    loss?: ModelMetrics;
    anomaly?: { trainedOn: number; flagFraction: number; scoredRecent: number; flaggedNew: number };
    scored?: { open: number };
    data?: { checkouts: number; from: string | null; to: string | null };
  };
}

export interface Insights {
  latestRun: MlRun | null;
  lastSuccessfulRun: MlRun | null;
  thresholds: { likelyLate: number; lossRisk: number };
  atRisk: AtRiskCheckout[];
  anomalies: Anomaly[];
}

// ---- Data sources --------------------------------------------------------
export type DbKind = 'mysql' | 'postgres' | 'mssql';
export type SourceKind = 'excel' | 'csv' | DbKind;
export type TlsMode = 'verify' | 'require' | 'off';
export type Schedule = 'manual' | 'hourly' | 'daily';
export type DateOrder = 'dmy' | 'mdy';
export type FieldKey = 'assetTag' | 'name' | 'category' | 'location' | 'calibrationIntervalDays' | 'lastCalibratedOn' | 'rfidUid';
export type Mapping = Partial<Record<FieldKey, string>>;

export interface ToolField {
  key: FieldKey;
  label: string;
  required: boolean;
  hint: string;
  synonyms: string[];
}

export interface DataSource {
  id: string;
  name: string;
  kind: DbKind;
  mode: 'import' | 'mirror';
  host: string;
  port: number;
  databaseName: string;
  username: string;
  tls: TlsMode;
  tableName: string | null;
  mapping: { fields?: Mapping; dateOrder?: DateOrder };
  schedule: Schedule;
  nextSyncAt: string | null;
  lastSyncAt: string | null;
  lastSyncOk: boolean | null;
  lastSyncMessage: string | null;
  createdAt: string;
}

export interface SyncRun {
  id: string;
  sourceId: string | null;
  sourceLabel: string;
  kind: SourceKind;
  direction: 'import' | 'mirror';
  trigger: 'manual' | 'schedule';
  ok: boolean;
  summary: {
    message?: string;
    rows?: number;
    created?: number;
    updated?: number;
    unchanged?: number;
    skipped?: number;
    calibrationsRecorded?: number;
    locationsCreated?: number;
    problems?: number;
    copied?: number;
  };
  at: string;
  runByName: string;
}

export interface DataSourcesInfo {
  sources: DataSource[];
  runs: SyncRun[];
  fields: ToolField[];
  capabilities: {
    databases: { enabled: boolean; reason?: string };
    maxFileRows: number;
    defaultPorts: Record<DbKind, number>;
  };
}

export interface ImportProblem {
  row: number;
  assetTag: string | null;
  level: 'error' | 'warning';
  message: string;
}

export interface ImportResult {
  rows: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  calibrationsRecorded: number;
  locationsCreated: string[];
  problems: ImportProblem[];
  changes: { row: number; assetTag: string; action: 'create' | 'update'; fields: string[] }[];
}

export interface RunOutcome {
  ok: boolean;
  message: string;
  import?: ImportResult;
  copied?: number;
}

export interface ConnectionInput {
  kind: DbKind;
  host: string;
  port?: number;
  database: string;
  username: string;
  password: string;
  tls: TlsMode;
}
