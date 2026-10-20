import { Pool } from "pg";
import type { PoolClient, PoolConfig } from "pg";
import { env } from "../config/env.js";

/**
 * A pool that reports connection failures instead of crashing on them.
 *
 * pg-pool removes its own `error` listener while a client is checked out, so a
 * socket reset — Neon suspending an idle project, a proxy recycling a
 * connection — would otherwise be an unhandled 'error' event and end the
 * process. Idle clients are re-emitted on the pool; checked-out ones only on
 * the client, so both need a listener.
 */
export function createPool(label: string, options: PoolConfig = {}): Pool {
  const pool = new Pool({ connectionString: env.DATABASE_URL, ...options });
  const watched = new WeakSet<PoolClient>();

  pool.on("error", (error) => {
    console.error(`${label}: connection error`, error);
  });

  pool.on("acquire", (client) => {
    // The listener outlives the checkout, so attach it once per client.
    if (watched.has(client)) {
      return;
    }
    watched.add(client);
    client.on("error", (error) => {
      console.error(`${label}: client connection error`, error);
    });
  });

  return pool;
}

export const pool = createPool("database");
