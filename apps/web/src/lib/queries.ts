'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiForm } from './api';
import type {
  AuditEntry,
  AuditVerification,
  Insights,
  Checkout,
  ConnectionInput,
  DataSourcesInfo,
  DateOrder,
  Dashboard,
  ImportResult,
  Mapping,
  RunOutcome,
  Schedule,
  Holder,
  Invite,
  Location,
  Provisioning,
  ReturnCondition,
  Station,
  StationEvent,
  Role,
  Tool,
  ToolDetail,
  UserRow,
  AckRow,
  CalibrationRegisterRow,
  EmailDelivery,
  ExportDataset,
  KitDetail,
  KitSummary,
  LabJobRow,
  MyStockIssue,
  NotificationsInfo,
  ReportSummary,
  RequestEvent,
  RequestKind,
  RequestReason,
  RequestRow,
  StockItem,
  StockKind,
  StockMovement,
} from './types';

export const keys = {
  dashboard: ['dashboard'] as const,
  tools: (q: Record<string, string> = {}) => ['tools', q] as const,
  tool: (id: string) => ['tool', id] as const,
  checkouts: (q: Record<string, string> = {}) => ['checkouts', q] as const,
  locations: ['locations'] as const,
  holders: ['holders'] as const,
  users: ['users'] as const,
  invites: ['invites'] as const,
  stations: ['stations'] as const,
  stationEvents: ['station-events'] as const,
  audit: (action: string) => ['audit', action] as const,
  insights: ['insights'] as const,
  dataSources: ['data-sources'] as const,
  notifications: ['notifications'] as const,
  delivery: ['email-delivery'] as const,
  acks: (scope: string) => ['acknowledgements', scope] as const,
  labJobs: (open: string) => ['lab-jobs', open] as const,
  stock: (q: Record<string, string> = {}) => ['stock', q] as const,
  stockItem: (id: string) => ['stock-item', id] as const,
  myStock: ['my-stock'] as const,
  requests: (scope: string) => ['requests', scope] as const,
  request: (id: string) => ['request', id] as const,
  kits: ['kits'] as const,
  kit: (id: string) => ['kit', id] as const,
  reports: ['reports'] as const,
  register: ['calibration-register'] as const,
};

const qs = (q: Record<string, string>) => {
  const p = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== ''));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const useDashboard = () =>
  useQuery({ queryKey: keys.dashboard, queryFn: () => api<Dashboard>('/dashboard'), refetchInterval: 30_000 });

export const useTools = (q: Record<string, string> = {}) =>
  useQuery({
    queryKey: keys.tools(q),
    queryFn: async () => (await api<{ tools: Tool[] }>(`/tools${qs(q)}`)).tools,
    refetchInterval: 30_000,
  });

export const useTool = (id: string) =>
  useQuery({ queryKey: keys.tool(id), queryFn: async () => (await api<{ tool: ToolDetail }>(`/tools/${id}`)).tool });

export const useCheckouts = (q: Record<string, string> = {}) =>
  useQuery({
    queryKey: keys.checkouts(q),
    queryFn: async () => (await api<{ checkouts: Checkout[] }>(`/checkouts${qs(q)}`)).checkouts,
  });

export const useLocations = () =>
  useQuery({
    queryKey: keys.locations,
    queryFn: async () => (await api<{ locations: Location[] }>('/locations')).locations,
    staleTime: 5 * 60_000,
  });

export const useHolders = (enabled: boolean) =>
  useQuery({
    queryKey: keys.holders,
    queryFn: async () => (await api<{ holders: Holder[] }>('/holders')).holders,
    enabled,
  });

export const useUsers = (enabled: boolean) =>
  useQuery({ queryKey: keys.users, queryFn: async () => (await api<{ users: UserRow[] }>('/users')).users, enabled });

export const useInvites = (enabled: boolean) =>
  useQuery({
    queryKey: keys.invites,
    queryFn: async () => (await api<{ invites: Invite[] }>('/invites')).invites,
    enabled,
  });

/** After any change to tools or checkouts, everything that shows them is refreshed. */
function useInvalidateFloor() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['tools'] }),
      qc.invalidateQueries({ queryKey: ['tool'] }),
      qc.invalidateQueries({ queryKey: ['checkouts'] }),
      qc.invalidateQueries({ queryKey: keys.dashboard }),
    ]);
}

export function useCheckOut() {
  const invalidate = useInvalidateFloor();
  return useMutation({
    mutationFn: (body: { toolId: string; holderId?: string; dueBackAt: string }) =>
      api<{ checkout: Checkout }>('/checkouts', { body }),
    onSuccess: invalidate,
  });
}

export function useReturn() {
  const invalidate = useInvalidateFloor();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; condition: ReturnCondition; notes?: string }) =>
      api(`/checkouts/${id}/return`, { body }),
    onSuccess: invalidate,
  });
}

export function useRecordCalibration() {
  const invalidate = useInvalidateFloor();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; calibratedOn: string; performedBy: string; certificateRef?: string }) =>
      api<{ tool: ToolDetail }>(`/tools/${id}/calibrations`, { body }),
    onSuccess: invalidate,
  });
}

export function useCreateTool() {
  const invalidate = useInvalidateFloor();
  return useMutation({
    mutationFn: (body: {
      assetTag: string;
      name: string;
      category: string;
      homeLocationId: string;
      requiresCalibration: boolean;
      calibrationIntervalDays?: number;
      lastCalibratedOn?: string;
      unitPrice?: number;
      make?: string;
      model?: string;
    }) => api<{ tool: ToolDetail }>('/tools', { body }),
    onSuccess: invalidate,
  });
}

export function useUpdateTool() {
  const invalidate = useInvalidateFloor();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; name?: string; category?: string; homeLocationId?: string; unitPrice?: number | null; make?: string | null; model?: string | null }) =>
      api<{ tool: ToolDetail }>(`/tools/${id}`, { method: 'PATCH', body }),
    onSuccess: invalidate,
  });
}

export function useUpdateToolStatus() {
  const invalidate = useInvalidateFloor();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'available' | 'quarantined' | 'retired' }) =>
      api<{ tool: ToolDetail }>(`/tools/${id}`, { method: 'PATCH', body: { status } }),
    onSuccess: invalidate,
  });
}

export function useSetToolTag() {
  const invalidate = useInvalidateFloor();
  return useMutation({
    mutationFn: ({ id, rfidUid }: { id: string; rfidUid: string | null }) =>
      api<{ tool: ToolDetail }>(`/tools/${id}`, { method: 'PATCH', body: { rfidUid } }),
    onSuccess: invalidate,
  });
}

export const useStations = (enabled: boolean) =>
  useQuery({
    queryKey: keys.stations,
    queryFn: () => api<{ stations: Station[]; enabled: boolean }>('/stations'),
    enabled,
    refetchInterval: 30_000,
  });

export const useStationEvents = (enabled: boolean) =>
  useQuery({
    queryKey: keys.stationEvents,
    queryFn: async () => (await api<{ events: StationEvent[] }>('/station-events?limit=50')).events,
    enabled,
  });

function useStationMutation<T>(fn: (v: T) => Promise<{ provisioning?: Provisioning }>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: keys.stations }) });
}

export const useCreateStation = () =>
  useStationMutation((body: { name: string; locationId: string }) =>
    api<{ station: Station; provisioning: Provisioning }>('/stations', { body }),
  );

export const useRotateStationKey = () =>
  useStationMutation((id: string) =>
    api<{ station: Station; provisioning: Provisioning }>(`/stations/${id}/rotate-key`, { method: 'POST', body: {} }),
  );

export const useUpdateStation = () =>
  useStationMutation(({ id, ...body }: { id: string; isActive?: boolean; name?: string }) =>
    api<{ provisioning?: Provisioning }>(`/stations/${id}`, { method: 'PATCH', body }),
  );

export function useCreateInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; role: Role }) =>
      api<{ invite: Invite & { inviteUrl: string } }>('/invites', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.invites }),
  });
}

export function useRevokeInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/invites/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.invites }),
  });
}

export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; role?: Role; isActive?: boolean; badgeUid?: string | null }) =>
      api<{ user: UserRow }>(`/users/${id}`, { method: 'PATCH', body }),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: keys.users }), qc.invalidateQueries({ queryKey: keys.holders })]),
  });
}

const AUDIT_PAGE = 50;

/** The audit trail, newest first, paged by id (stable even while new entries arrive). */
export const useAudit = (action: string, enabled: boolean) =>
  useInfiniteQuery({
    queryKey: keys.audit(action),
    initialPageParam: 0,
    queryFn: async ({ pageParam }) =>
      (
        await api<{ entries: AuditEntry[] }>(
          `/audit${qs({ action, limit: String(AUDIT_PAGE), before: pageParam ? String(pageParam) : '' })}`,
        )
      ).entries,
    getNextPageParam: (last) => (last.length === AUDIT_PAGE ? last[last.length - 1]!.id : undefined),
    enabled,
  });

export const useVerifyAudit = () =>
  useMutation({
    mutationFn: (anchor?: { id: number; hash: string }) =>
      api<AuditVerification>(`/audit/verify${anchor ? qs({ anchorId: String(anchor.id), anchorHash: anchor.hash }) : ''}`),
  });

export const useInsights = (enabled: boolean) =>
  useQuery({ queryKey: keys.insights, queryFn: () => api<Insights>('/insights'), enabled, refetchInterval: 60_000 });

export function useReviewAnomaly() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; status: 'confirmed' | 'dismissed'; note?: string }) =>
      api(`/anomalies/${id}/review`, { body }),
    onSuccess: () =>
      Promise.all([qc.invalidateQueries({ queryKey: keys.insights }), qc.invalidateQueries({ queryKey: keys.dashboard })]),
  });
}

// ---- Data sources --------------------------------------------------------
export const useDataSources = (enabled: boolean) =>
  useQuery({ queryKey: keys.dataSources, queryFn: () => api<DataSourcesInfo>('/data-sources'), enabled });

/** Anything that may have changed tools also refreshes the board and the tool lists. */
function useDataMutation<V, R>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.dataSources });
      void qc.invalidateQueries({ queryKey: ['tools'] });
      void qc.invalidateQueries({ queryKey: keys.dashboard });
      void qc.invalidateQueries({ queryKey: keys.locations });
    },
  });
}

export interface FileImportBody {
  fileName: string;
  fileKind: 'excel' | 'csv';
  dateOrder: DateOrder;
  dryRun: boolean;
  rows: { row: number; values: Record<string, string | number | boolean | null> }[];
}

export const useFileImport = () =>
  useDataMutation((body: FileImportBody) => api<{ result: ImportResult }>('/data-sources/files/import', { body }));

export const browseDatabase = (connection: ConnectionInput) =>
  api<{ tables: string[] }>('/data-sources/browse', { body: { connection } });

export const browseTable = (connection: ConnectionInput, table: string) =>
  api<{ columns: { name: string; type: string }[]; preview: Record<string, unknown>[]; suggested: Mapping }>(
    '/data-sources/browse/table',
    { body: { connection, table } },
  );

export const previewDatabaseImport = (body: { connection: ConnectionInput; table: string; mapping: Mapping; dateOrder: DateOrder }) =>
  api<{ result: ImportResult }>('/data-sources/preview', { body });

export const useCreateDataSource = () =>
  useDataMutation(
    (body: {
      name: string;
      mode: 'import' | 'mirror';
      connection: ConnectionInput;
      table: string;
      mapping?: Mapping;
      dateOrder: DateOrder;
      schedule: Schedule;
    }) => api<{ id: string; run: RunOutcome }>('/data-sources', { body }),
  );

export const useSyncDataSource = () =>
  useDataMutation((id: string) => api<{ run: RunOutcome }>(`/data-sources/${id}/sync`, { method: 'POST', body: {} }));

export const useUpdateDataSource = () =>
  useDataMutation(({ id, ...body }: { id: string; name?: string; schedule?: Schedule; password?: string }) =>
    api<{ ok: true }>(`/data-sources/${id}`, { method: 'PATCH', body }),
  );

export const useRemoveDataSource = () =>
  useDataMutation((id: string) => api<{ ok: true }>(`/data-sources/${id}`, { method: 'DELETE' }));

// ---- Notifications -------------------------------------------------------
export const useNotifications = (enabled = true) =>
  useQuery({ queryKey: keys.notifications, queryFn: () => api<NotificationsInfo>('/notifications'), enabled, refetchInterval: 120_000 });

export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { ids: string[] } | { all: true }) => api<{ marked: number }>('/notifications/read', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.notifications }),
  });
}

export function useEmailPreference() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (email: boolean) => api<{ email: boolean }>('/notifications/preferences', { method: 'PUT', body: { email } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.notifications }),
  });
}

export const useEmailDelivery = (enabled: boolean) =>
  useQuery({ queryKey: keys.delivery, queryFn: () => api<EmailDelivery>('/notifications/delivery'), enabled });

// ---- Acknowledgements ----------------------------------------------------
export const useAcknowledgements = (scope: 'mine' | 'all', enabled = true) =>
  useQuery({
    queryKey: keys.acks(scope),
    queryFn: async () => (await api<{ acknowledgements: AckRow[] }>(`/acknowledgements?scope=${scope}`)).acknowledgements,
    enabled,
  });

export function useAnswerAck() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; answer: 'received' | 'not_received'; note?: string }) =>
      api<{ status: string }>(`/acknowledgements/${id}/answer`, { body }),
    onSuccess: () =>
      Promise.all(
        [keys.dashboard, ['acknowledgements'], ['tool'], ['checkouts'], keys.myStock, ['kit']].map((queryKey) => qc.invalidateQueries({ queryKey })),
      ),
  });
}

// ---- Calibration lab -------------------------------------------------------
export const useLabJobs = (open: 'true' | 'false' | '', enabled: boolean) =>
  useQuery({
    queryKey: keys.labJobs(open),
    queryFn: async () => (await api<{ jobs: LabJobRow[] }>(`/calibration-jobs${qs({ open })}`)).jobs,
    enabled,
  });

function useLabMutation<V, R>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  const invalidate = useInvalidateFloor();
  return useMutation({
    mutationFn: fn,
    onSuccess: async () => {
      await invalidate();
      await qc.invalidateQueries({ queryKey: ['lab-jobs'] });
    },
  });
}

export const useSendToLab = () =>
  useLabMutation(({ toolId, ...body }: { toolId: string; labName: string; labEmail?: string; expectedBackOn: string; notes?: string }) =>
    api<{ job: { id: string }; labLink: string; emailed: boolean }>(`/tools/${toolId}/calibration-jobs`, { body }),
  );

export const useReissueLabLink = () =>
  useLabMutation((jobId: string) => api<{ labLink: string; emailed: boolean }>(`/calibration-jobs/${jobId}/link`, { body: {} }));

export const useLabResults = () =>
  useLabMutation(({ jobId, form }: { jobId: string; form: FormData }) =>
    apiForm<{ recordId: string; dueOn: string }>(`/calibration-jobs/${jobId}/results`, form),
  );

export const useReceiveFromLab = () =>
  useLabMutation(({ jobId, outcome }: { jobId: string; outcome: 'passed' | 'failed' }) =>
    api<{ toolStatus: string }>(`/calibration-jobs/${jobId}/receive`, { body: { outcome } }),
  );

export const useCancelLab = () =>
  useLabMutation((jobId: string) => api<{ toolStatus: string }>(`/calibration-jobs/${jobId}/cancel`, { body: {} }));

export const useUploadCertificate = () =>
  useLabMutation(({ recordId, form }: { recordId: string; form: FormData }) =>
    apiForm<{ fileName: string }>(`/calibration-records/${recordId}/certificate`, form),
  );

// ---- Stock -----------------------------------------------------------------
export const useStock = (q: Record<string, string> = {}) =>
  useQuery({ queryKey: keys.stock(q), queryFn: async () => (await api<{ items: StockItem[] }>(`/stock${qs(q)}`)).items });

export const useStockItem = (id: string | null) =>
  useQuery({
    queryKey: keys.stockItem(id ?? ''),
    queryFn: () => api<{ item: StockItem; movements: StockMovement[] }>(`/stock/${id}`),
    enabled: Boolean(id),
  });

export const useMyStock = (enabled = true) =>
  useQuery({ queryKey: keys.myStock, queryFn: async () => (await api<{ issues: MyStockIssue[] }>('/stock/mine')).issues, enabled });

function useStockMutation<V, R>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () =>
      Promise.all([['stock'], ['stock-item'], keys.myStock, keys.reports].map((queryKey) => qc.invalidateQueries({ queryKey }))),
  });
}

export const useCreateStockItem = () =>
  useStockMutation(
    (body: { code: string; name: string; kind: StockKind; category: string; unit: string; locationId: string; reorderLevel: number; unitPrice?: number; openingQuantity: number }) =>
      api<{ item: StockItem }>('/stock', { body }),
  );

export const useUpdateStockItem = () =>
  useStockMutation(({ id, ...body }: { id: string; name?: string; category?: string; unit?: string; locationId?: string; reorderLevel?: number; unitPrice?: number | null; isActive?: boolean }) =>
    api<{ item: StockItem }>(`/stock/${id}`, { method: 'PATCH', body }),
  );

export type MovementBody =
  | { kind: 'receive'; quantity: number; note?: string }
  | { kind: 'issue' | 'return'; quantity: number; issuedTo: string; note?: string }
  | { kind: 'adjust'; countedQuantity: number; note: string };

export const useStockMovement = () =>
  useStockMutation(({ id, ...body }: { id: string } & MovementBody) =>
    api<{ movement: { id: string; quantity: number; balanceAfter: number } }>(`/stock/${id}/movements`, { body }),
  );

// ---- Requests --------------------------------------------------------------
export const useRequests = (scope: 'mine' | 'review' | 'approve' | 'all') =>
  useQuery({
    queryKey: keys.requests(scope),
    queryFn: () => api<{ requests: RequestRow[]; counts: { toReview: number; toApprove: number; toFulfil: number } }>(`/requests?scope=${scope}`),
  });

export const useRequest = (id: string | null) =>
  useQuery({
    queryKey: keys.request(id ?? ''),
    queryFn: () => api<{ request: RequestRow; events: RequestEvent[] }>(`/requests/${id}`),
    enabled: Boolean(id),
  });

function useRequestMutation<V, R>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => Promise.all([['requests'], ['request'], keys.notifications].map((queryKey) => qc.invalidateQueries({ queryKey }))),
  });
}

export const useCreateRequest = () =>
  useRequestMutation(
    (body: { kind: RequestKind; reason: RequestReason; title: string; details?: string; quantity: number; estimatedCost?: number; toolId?: string; stockItemId?: string }) =>
      api<{ request: { id: string; number: number } }>('/requests', { body }),
  );

export const useRequestAction = () =>
  useRequestMutation(
    ({ id, step, ...body }: { id: string; step: 'review' | 'decide' | 'fulfil' | 'cancel'; action?: string; note?: string }) =>
      api<{ status: string }>(`/requests/${id}/${step}`, { body }),
  );

// ---- Kits ------------------------------------------------------------------
export const useKits = () => useQuery({ queryKey: keys.kits, queryFn: async () => (await api<{ kits: KitSummary[] }>('/kits')).kits });

export const useKit = (id: string) =>
  useQuery({ queryKey: keys.kit(id), queryFn: async () => (await api<{ kit: KitDetail }>(`/kits/${id}`)).kit });

function useKitMutation<V, R extends { kit: KitDetail } = { kit: KitDetail }>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  const invalidate = useInvalidateFloor();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (data) => {
      qc.setQueryData(keys.kit(data.kit.id), data.kit);
      await Promise.all([invalidate(), qc.invalidateQueries({ queryKey: keys.kits })]);
    },
  });
}

export const useCreateKit = () =>
  useKitMutation((body: { assetTag: string; name: string; homeLocationId: string; toolTags: string[] }) => api<{ kit: KitDetail }>('/kits', { body }));
export const useAddKitTool = () =>
  useKitMutation(({ id, assetTag }: { id: string; assetTag: string }) => api<{ kit: KitDetail }>(`/kits/${id}/tools`, { body: { assetTag } }));
export const useRemoveKitTool = () =>
  useKitMutation(({ id, toolId }: { id: string; toolId: string }) => api<{ kit: KitDetail }>(`/kits/${id}/tools/${toolId}`, { method: 'DELETE' }));
export const useUpdateKit = () =>
  useKitMutation(({ id, ...body }: { id: string; name?: string; isActive?: boolean }) => api<{ kit: KitDetail }>(`/kits/${id}`, { method: 'PATCH', body }));
export const useKitCheckout = () =>
  useKitMutation(({ id, ...body }: { id: string; holderId?: string; dueBackAt: string }) => api<{ kit: KitDetail }>(`/kits/${id}/checkout`, { body }));
export const useKitReturn = () =>
  useKitMutation(
    ({ id, ...body }: { id: string; tools: { toolId: string; condition: 'ok' | 'damaged' | 'needs_calibration' | 'missing' }[]; notes?: string }) =>
      api<{ kit: KitDetail; returned: number; missing: string[] }>(`/kits/${id}/return`, { body }),
  );

// ---- Reports ---------------------------------------------------------------
export const useReportSummary = () => useQuery({ queryKey: keys.reports, queryFn: () => api<ReportSummary>('/reports/summary') });

export const fetchExport = (dataset: ExportDataset, range: { from?: string; to?: string }) =>
  api<{ title: string; rows: Record<string, unknown>[]; truncated: boolean; timeZone: string }>(
    `/reports/export/${dataset}${qs({ from: range.from ?? '', to: range.to ?? '' })}`,
  );

export const useCalibrationRegister = () =>
  useQuery({
    queryKey: keys.register,
    queryFn: () => api<{ tools: CalibrationRegisterRow[]; today: string; timeZone: string }>('/reports/calibration-register'),
  });
