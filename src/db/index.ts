import postgres from "postgres";
import { sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import {
  drizzle,
  type PostgresJsDatabase,
  type PostgresJsQueryResultHKT,
} from "drizzle-orm/postgres-js";
import * as schema from "./schema";
import type { LeakStatus, Severity } from "./schema";

export * from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;
/** `db` o la `tx` de `db.transaction(...)`. */
export type Executor = PgDatabase<PostgresJsQueryResultHKT, typeof schema>;

/** Falta configuración (no es un fallo de red). /health muestra el mensaje tal cual. */
export class DbConfigError extends Error {}

const IN_WORKERS = typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";

/**
 * De dónde sale la conexión:
 * - Worker: binding HYPERDRIVE (vía documentada por Cloudflare). El tramo
 *   Worker → Hyperdrive va por la red interna de Cloudflare y Hyperdrive →
 *   Supabase va cifrado (sslmode=require). Conectar directo con TLS no sirve: el
 *   pooler usa un certificado de la CA privada de Supabase y Workers solo acepta
 *   CAs públicas.
 * - Bun (scripts y pruebas): DATABASE_URL con TLS (cifra sin validar esa CA).
 */
async function connection(): Promise<{ url: string; ssl?: "require" }> {
  if (IN_WORKERS) {
    // Import dinámico: el módulo solo existe en Workers y este archivo también lo usa Bun.
    const { env } = await import("cloudflare:workers");
    if (!env.HYPERDRIVE) throw new DbConfigError("Falta el binding HYPERDRIVE (wrangler.jsonc)");
    return { url: env.HYPERDRIVE.connectionString };
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new DbConfigError("DATABASE_URL no configurada");
  return { url, ssl: "require" };
}

/**
 * Abre una conexión, ejecuta `fn` y la cierra.
 * En Workers no se comparten conexiones entre requests: cada request usa la suya
 * (con Hyperdrive abrirla es barato; él mantiene el pool hacia Supabase).
 */
export async function withDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const { url, ssl } = await connection();
  const client = postgres(url, {
    ...(ssl && { ssl }),
    prepare: false, // el transaction pooler de Supabase (6543) que usa Bun no los soporta
    max: 1,
    connect_timeout: 5,
    fetch_types: false, // ahorra un viaje a la BD por request; Drizzle parsea los arrays
  });
  try {
    return await fn(drizzle(client, { schema }));
  } finally {
    await client.end({ timeout: 1 });
  }
}

export type NearbyLeak = {
  id: string;
  distance_m: number;
  status: LeakStatus;
  max_severity: Severity;
  report_count: number;
  photo_url: string | null;
  /** ISO 8601 en UTC. En db.execute() el driver no convierte fechas a Date. */
  resolved_at: string | null;
};

/**
 * Fugas no descartadas dentro de `radiusM`, de la más cercana a la más lejana.
 * La usan el pre-check (GET /leaks/nearby) y el agrupamiento de POST /reports.
 */
export async function findNearbyLeaks(
  db: Executor,
  lat: number,
  lng: number,
  radiusM: number,
): Promise<NearbyLeak[]> {
  return db.execute<NearbyLeak>(sql`
    select id, distance_m, status, max_severity, report_count, photo_url,
           to_char(resolved_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as resolved_at
    from find_nearby_leaks(${lat}, ${lng}, ${radiusM})`);
}
