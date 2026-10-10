'use client';

import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from './api';
import type { Me, Role } from './types';

export const meKey = ['me'] as const;

export function useMe() {
  return useQuery({
    queryKey: meKey,
    queryFn: async () => {
      try {
        return (await api<{ user: Me }>('/auth/me')).user;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
  });
}

export const can = {
  manageTools: (r?: Role) => r === 'admin' || r === 'storekeeper',
  issueToOthers: (r?: Role) => r === 'admin' || r === 'storekeeper',
  checkOut: (r?: Role) => r === 'admin' || r === 'storekeeper' || r === 'technician',
  receiveReturns: (r?: Role) => r === 'admin' || r === 'storekeeper',
  seePeople: (r?: Role) => r === 'admin' || r === 'auditor',
  managePeople: (r?: Role) => r === 'admin',
  seeStations: (r?: Role) => r === 'admin' || r === 'storekeeper' || r === 'auditor',
  manageStations: (r?: Role) => r === 'admin',
};
