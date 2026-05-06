declare module "pg" {
  export class Pool {
    constructor(config?: unknown);
    query<T = unknown>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
    end(): Promise<void>;
  }
}
