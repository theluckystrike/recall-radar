import { DurableObject } from "cloudflare:workers";

import { searchWatchItem } from "./server.js";
import {
  WatchStore,
  type AddWatchOutcome,
  type RemoveWatchOutcome,
  type WatchCheck,
  type WatchEnv,
  type WatchInput,
  type WatchItem,
  type WatchStorage,
} from "./watchstore.js";

/**
 * One Durable Object per user id holds the watch list. Reads and writes go through the object, which is
 * single-threaded and strongly consistent, so an add, a remove or a check cannot lose a concurrent write the
 * way an eventually consistent Workers KV key can. It extends the runtime RPC base class and delegates the
 * storage logic to WatchStore, which carries no runtime imports and is what the unit tests exercise.
 */
export class WatchListDO extends DurableObject<WatchEnv> {
  private readonly watch: WatchStore;

  constructor(ctx: DurableObjectState, env: WatchEnv) {
    super(ctx, env);
    this.watch = new WatchStore({ storage: ctx.storage as unknown as WatchStorage });
  }

  async add(input: WatchInput): Promise<AddWatchOutcome> {
    return this.watch.add(input);
  }

  async remove(text: string): Promise<RemoveWatchOutcome> {
    return this.watch.remove(text);
  }

  async list(): Promise<WatchItem[]> {
    return this.watch.list();
  }

  async check(): Promise<WatchCheck> {
    return this.watch.check(searchWatchItem);
  }
}
