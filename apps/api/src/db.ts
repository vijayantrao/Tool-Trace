import postgres from 'postgres';

export type Sql = postgres.Sql;
export type TxSql = postgres.TransactionSql;

/**
 * Creates the connection pool. postgres.js always sends values as bound
 * parameters, so tagged-template queries are not vulnerable to SQL injection.
 */
export function createDb(url: string, options: { max?: number } = {}): Sql {
  return postgres(url, {
    max: options.max ?? 10,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
    transform: postgres.camel,
  });
}
