import type { Config } from './config.js';
import type { Sql } from './db.js';

export const ROLES = ['admin', 'storekeeper', 'technician', 'auditor'] as const;
export type Role = (typeof ROLES)[number];

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
}

export interface Deps {
  sql: Sql;
  config: Config;
}

export interface AppEnv {
  Variables: {
    user: SessionUser | undefined;
    sessionId: string | undefined;
  };
}
