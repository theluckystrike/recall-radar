// Type declarations for the Cloudflare Workers runtime module "cloudflare:workers".
// The runtime provides the real implementation. The full @cloudflare/workers-types package declares
// globals that conflict with the DOM and node types this project uses, so only the RPC base class is declared here.

interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
}

interface DurableObjectState {
  storage: DurableObjectStorage;
}

declare module "cloudflare:workers" {
  export abstract class DurableObject<Env = unknown> {
    protected readonly ctx: DurableObjectState;
    protected readonly env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }
}
