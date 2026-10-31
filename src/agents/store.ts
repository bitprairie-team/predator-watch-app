// Key-value storage behind the private features. Production uses Workers KV;
// tests use the in-memory version. Keys are always built by the data access
// layer from the caller's AuthContext, never from request input.

export interface PrivateStore {
  get<T>(key: string): Promise<T | null>;
  put(key: string, value: unknown, opts?: { expirationTtl?: number }): Promise<void>;
  list(prefix: string, limit?: number): Promise<string[]>;
}

export class MemoryStore implements PrivateStore {
  readonly map = new Map<string, string>();
  async get<T>(key: string): Promise<T | null> {
    const v = this.map.get(key);
    return v === undefined ? null : (JSON.parse(v) as T);
  }
  async put(key: string, value: unknown): Promise<void> {
    this.map.set(key, JSON.stringify(value));
  }
  async list(prefix: string, limit = 1000): Promise<string[]> {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit);
  }
}

export class KvStore implements PrivateStore {
  constructor(private readonly kv: KVNamespace) {}
  get<T>(key: string): Promise<T | null> {
    return this.kv.get<T>(key, "json");
  }
  async put(key: string, value: unknown, opts?: { expirationTtl?: number }): Promise<void> {
    await this.kv.put(key, JSON.stringify(value), opts);
  }
  async list(prefix: string, limit = 1000): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.kv.list({ prefix, cursor, limit: Math.min(1000, limit - keys.length) });
      keys.push(...page.keys.map((k) => k.name));
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor && keys.length < limit);
    return keys;
  }
}
