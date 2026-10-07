export const CONFIG_REL: string;
export const STORE_DB_REL: string;
export function isSterlingRoot(dir: unknown): boolean;
export function storeBackend(root: string): 'sqlite' | 'routed';
