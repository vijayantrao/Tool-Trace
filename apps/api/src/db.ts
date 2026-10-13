import postgres from 'postgres';

export type Sql = postgres.Sql;
export type TxSql = postgres.TransactionSql;

/**
 * Accepts connection strings exactly as hosting consoles hand them out.
 *
 * - `channel_binding` is a libpq option that postgres.js doesn't know; it would be sent to the
 *   server as an unknown setting and the connection refused. It is dropped (SCRAM still applies).
 * - For Neon, whose certificates are publicly trusted, `sslmode=require` (encrypt, but don't check
 *   who answers) is upgraded to `verify-full`, so the server's certificate and name are verified.
 */
export function normalizeDatabaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw; // not a URL (e.g. a socket path): leave it to postgres.js
  }
  url.searchParams.delete('channel_binding');
  if (url.hostname.endsWith('.neon.tech') && ['require', 'prefer', null].includes(url.searchParams.get('sslmode'))) {
    url.searchParams.set('sslmode', 'verify-full');
  }
  return url.toString();
}

/**
 * Creates the connection pool. postgres.js always sends values as bound
 * parameters, so tagged-template queries are not vulnerable to SQL injection.
 */
export function createDb(url: string, options: { max?: number } = {}): Sql {
  return postgres(normalizeDatabaseUrl(url), {
    max: options.max ?? 10,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
    transform: postgres.camel,
  });
}
