'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface Meta {
  name: string;
  /** The public demo: one-click personas, fictional data, nightly reset. */
  demo: boolean;
}

/**
 * Public facts about this deployment. Also the first request a visitor makes, so on free
 * hosting it is what wakes a sleeping API: keep retrying for about a minute and a half.
 */
export const useMeta = () =>
  useQuery({
    queryKey: ['meta'],
    queryFn: () => api<Meta>('/meta'),
    staleTime: Infinity,
    retry: (count) => count < 30,
    retryDelay: 3000,
  });
