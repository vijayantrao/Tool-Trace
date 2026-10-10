import type { Config } from './config.js';
import type { Sql } from './db.js';
import type { FloorEvents } from './stations/floor-events.js';
import type { StationGateway } from './stations/gateway.js';

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
  /** Signs/verifies station traffic and provisions station keys. */
  gateway: StationGateway;
  /** Live change feed for browsers (Server-Sent Events). */
  events?: FloorEvents;
}

export interface AppEnv {
  Variables: {
    user: SessionUser | undefined;
    sessionId: string | undefined;
  };
}
