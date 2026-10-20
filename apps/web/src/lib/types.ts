export type Role = 'admin' | 'storekeeper' | 'technician' | 'auditor';
export type ToolStatus = 'available' | 'checked_out' | 'quarantined' | 'at_calibration' | 'retired';
export type AbcClass = 'A' | 'B' | 'C';
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
  unitPrice: number | null;
  make: string | null;
  model: string | null;
  abcClass: AbcClass | null;
}

export type AckStatus = 'pending' | 'acknowledged' | 'disputed';

export interface LabJob {
  id: string;
  labName: string;
  labEmail: string | null;
  notes: string | null;
  status: 'at_lab' | 'calibrated' | 'received' | 'cancelled';
  sentAt: string;
  expectedBackOn: string;
  late: boolean;
  sentByName: string;
  resultsVia: 'lab' | 'staff' | null;
  resultsAt: string | null;
  tokenExpiresAt: string | null;
  calibrationRecordId: string | null;
}

export interface ToolDetail extends Tool {
  openCheckout: {
    id: string;
    holderId: string;
    holderName: string;
    checkedOutAt: string;
    dueBackAt: string;
    overdue: boolean;
    kitIssueId: string | null;
    issuedBy: string;
    issuedByName: string;
    acknowledgement: { id: string; status: AckStatus; respondedAt: string | null; note: string | null; userId: string } | null;
  } | null;
  calibrations: {
    id: string;
    calibratedOn: string;
    dueOn: string;
    certificateRef: string | null;
    performedBy: string;
    certificateFile: string | null;
  }[];
  labJob: LabJob | null;
  kit: { id: string; assetTag: string; name: string } | null;
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
  ackStatus: AckStatus | null;
  kitIssueId: string | null;
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
    atCalibration: number;
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
  myAcknowledgements: PendingAck[];
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
  kind:
    | 'checked_out'
    | 'returned'
    | 'tool_changed'
    | 'checkout_updated'
    | 'station_event'
    | 'notification'
    | 'acknowledgement'
    | 'stock_changed';
  toolId?: string;
  itemId?: string;
  userId?: string;
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
export type FieldKey =
  | 'assetTag'
  | 'name'
  | 'category'
  | 'location'
  | 'calibrationIntervalDays'
  | 'lastCalibratedOn'
  | 'rfidUid'
  | 'unitPrice'
  | 'make'
  | 'model';
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

// ---- Notifications -------------------------------------------------------
export interface AppNotification {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationsInfo {
  notifications: AppNotification[];
  unread: number;
  email: { available: boolean; enabled: boolean; address: string };
}

export interface EmailDelivery {
  available: boolean;
  pending: number;
  sentLastWeek: number;
  failed: number;
  lastError: string | null;
}

// ---- Acknowledgements ----------------------------------------------------
export interface PendingAck {
  id: string;
  subjectType: 'checkout' | 'stock_issue' | 'kit_issue';
  summary: string;
  createdAt: string;
  requestedByName: string;
}

export interface AckRow extends PendingAck {
  subjectId: string;
  status: AckStatus;
  respondedAt: string | null;
  respondedVia: 'app' | 'email' | null;
  note: string | null;
  userId: string;
  userName: string;
}

// ---- Calibration lab -------------------------------------------------------
export interface LabJobRow {
  id: string;
  toolId: string;
  assetTag: string;
  toolName: string;
  labName: string;
  labEmail: string | null;
  notes: string | null;
  status: LabJob['status'];
  sentAt: string;
  expectedBackOn: string;
  late: boolean;
  sentByName: string;
  resultsVia: 'lab' | 'staff' | null;
  resultsAt: string | null;
  outcome: 'passed' | 'failed' | null;
  closedAt: string | null;
}

// ---- Stock -----------------------------------------------------------------
export type StockKind = 'consumable' | 'ppe';

export interface StockItem {
  id: string;
  code: string;
  name: string;
  kind: StockKind;
  category: string;
  unit: string;
  locationId: string;
  locationName: string;
  quantity: number;
  reorderLevel: number;
  unitPrice: number | null;
  abcClass: AbcClass | null;
  isActive: boolean;
  low: boolean;
  stockValue: number | null;
  updatedAt: string;
}

export interface StockMovement {
  id: string;
  kind: 'receive' | 'issue' | 'return' | 'adjust';
  quantity: number;
  balanceAfter: number;
  note: string | null;
  at: string;
  issuedTo: string | null;
  issuedToName: string | null;
  byName: string;
  ackStatus: AckStatus | null;
}

export interface MyStockIssue {
  id: string;
  itemId: string;
  code: string;
  name: string;
  unit: string;
  quantity: number;
  at: string;
  note: string | null;
  byName: string;
  ackStatus: AckStatus | null;
  ackId: string | null;
}

// ---- Requests --------------------------------------------------------------
export type RequestKind = 'new_tool' | 'replacement' | 'stock';
export type RequestReason = 'new_requirement' | 'damaged' | 'missing' | 'kaizen' | 'used_up' | 'other';
export type RequestStatus = 'submitted' | 'reviewed' | 'approved' | 'rejected' | 'fulfilled' | 'cancelled';

export interface RequestRow {
  id: string;
  number: number;
  kind: RequestKind;
  reason: RequestReason;
  title: string;
  details: string | null;
  quantity: number;
  estimatedCost: number | null;
  toolId: string | null;
  toolAssetTag: string | null;
  toolName: string | null;
  stockItemId: string | null;
  stockCode: string | null;
  stockName: string | null;
  status: RequestStatus;
  createdAt: string;
  updatedAt: string;
  requestedBy: string;
  requestedByName: string;
  reviewedBy: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  closedByName: string | null;
  closedAt: string | null;
}

export interface RequestEvent {
  id: number;
  action: 'submitted' | 'reviewed' | 'approved' | 'rejected' | 'fulfilled' | 'cancelled';
  note: string | null;
  at: string;
  byName: string;
}

// ---- Kits ------------------------------------------------------------------
export type KitState = 'in_crib' | 'out' | 'partial' | 'unavailable' | 'empty';

export interface KitSummary {
  id: string;
  assetTag: string;
  name: string;
  homeLocationName: string;
  isActive: boolean;
  toolCount: number;
  state: KitState;
  holderName: string | null;
  dueBackAt: string | null;
}

export interface KitTool {
  id: string;
  assetTag: string;
  name: string;
  category: string;
  status: ToolStatus;
  calibrationExpired: boolean;
  calibrationDueOn: string | null;
  checkoutId: string | null;
  holderId: string | null;
  holderName: string | null;
  kitIssueId: string | null;
  dueBackAt: string | null;
  overdue: boolean | null;
}

export interface KitDetail {
  id: string;
  assetTag: string;
  name: string;
  homeLocationId: string;
  homeLocationName: string;
  isActive: boolean;
  state: KitState;
  tools: KitTool[];
  openIssue: {
    id: string;
    holderId: string;
    holderName: string;
    issuedAt: string;
    dueBackAt: string;
    overdue: boolean;
    issuedByName: string;
    ackStatus: AckStatus | null;
  } | null;
}

// ---- Reports ---------------------------------------------------------------
export interface ReportSummary {
  currency: string;
  tools: {
    count: number;
    value: number;
    valueOut: number;
    valueOverdue: number;
    valueQuarantined: number;
    valueAtLab: number;
    unpriced: number;
    out: number;
    calibrated: number;
  };
  byCategory: { category: string; count: number; value: number }[];
  byClass: { class: AbcClass | 'none'; count: number; value: number }[];
  weekly: { week: string; checkouts: number; lateReturns: number }[];
  calibrationDue: { month: string; count: number }[];
  calibration: { expired: number; dueSoon: number; atLab: number };
  stock: { items: number; value: number; low: number };
  openRequests: number;
  approvedCost: number;
  pendingAcks: number;
  disputedAcks: number;
}

export type ExportDataset = 'tools' | 'checkouts' | 'calibrations' | 'stock' | 'movements' | 'requests' | 'audit';

export interface CalibrationRegisterRow {
  id: string;
  assetTag: string;
  name: string;
  category: string;
  make: string | null;
  model: string | null;
  location: string;
  status: ToolStatus;
  calibrationIntervalDays: number;
  lastCalibratedOn: string | null;
  calibrationDueOn: string;
  calibrationState: 'ok' | 'due_soon' | 'expired';
  performedBy: string | null;
  certificateRef: string | null;
  recordId: string | null;
  hasCertificate: boolean;
  atLab: string | null;
}
