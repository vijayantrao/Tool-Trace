'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import type {
  Checkout,
  Dashboard,
  Holder,
  Invite,
  Location,
  ReturnCondition,
  Role,
  Tool,
  ToolDetail,
  UserRow,
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
    }) => api<{ tool: ToolDetail }>('/tools', { body }),
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
    mutationFn: ({ id, ...body }: { id: string; role?: Role; isActive?: boolean }) =>
      api<{ user: UserRow }>(`/users/${id}`, { method: 'PATCH', body }),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: keys.users }), qc.invalidateQueries({ queryKey: keys.holders })]),
  });
}
