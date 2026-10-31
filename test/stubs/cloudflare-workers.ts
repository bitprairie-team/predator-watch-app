// Minimal stand-in for the `cloudflare:workers` module so Worker code that
// imports it (the OAuth provider) can load under Node in vitest.
export class WorkerEntrypoint<Env = unknown> {
  constructor(
    public ctx: unknown,
    public env: Env,
  ) {}
}
export class DurableObject<Env = unknown> {
  constructor(
    public ctx: unknown,
    public env: Env,
  ) {}
}
export const env = {};
