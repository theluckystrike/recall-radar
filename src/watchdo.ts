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
 * single-threaded and strongly consistent, so each call sees the list as it stands when that call runs. A check
 * re-reads the list after its slow lookups and merges the seen recall ids by item id, so an add or a remove
 * made while the check was waiting is kept. It extends the runtime RPC base class and delegates the storage
 * logic to WatchStore, which carries no runtime imports and is what the unit tests exercise.
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
