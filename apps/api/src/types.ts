import type { Config } from './config.js';
import type { Sql, TxSql } from './db.js';
import type { LimiterStore } from './lib/rate-limit.js';
import type { DataSources } from './services/data-sources/sync.js';
import type { Notifier } from './services/notify.js';
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
  /** Rate-limit counters (memory or Redis). */
  limiter: LimiterStore;
  /** Imports from and copies to outside data sources. */
  dataSources?: DataSources;
  /** In-app notifications and the email outbox. */
  notifier: Notifier;
}

export interface AppEnv {
  Variables: {
    user: SessionUser | undefined;
    sessionId: string | undefined;
    /** The request's transaction, running as the restricted app role (see middleware/db.ts). */
    db: TxSql | undefined;
  };
}
