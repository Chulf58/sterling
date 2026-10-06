// The slice of node-postgres (pg 8.23.1) that pg-worker.ts uses. pg ships no
// types and @types/pg is not a dependency, so this file declares only what
// the worker calls.
declare module 'pg' {
  export interface QueryResult {
    rows: Record<string, unknown>[];
    rowCount: number | null;
  }
  class Client {
    constructor(config: Record<string, unknown>);
    connect(): Promise<void>;
    query(text: string, values?: unknown[]): Promise<QueryResult | QueryResult[]>;
    end(): Promise<void>;
    on(event: 'error' | 'end', listener: (err?: Error) => void): this;
  }
  const types: {
    setTypeParser(oid: number, parser: (value: string) => unknown): void;
  };
  const pg: { Client: typeof Client; types: typeof types };
  export default pg;
}
