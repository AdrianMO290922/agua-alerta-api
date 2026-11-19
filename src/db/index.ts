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

// PENDIENTE (bloquea Workers): el pooler de Supabase presenta un certificado de
// su CA privada (Supabase Intermediate 2021 CA). Bun cifra sin validar la cadena
// (ssl: "require"), pero el runtime de Workers siempre valida contra CAs públicas y
// rechaza el handshake. Solución propuesta: Hyperdrive. Ver CLAUDE.md.

/**
 * Abre una conexión, ejecuta `fn` y la cierra.
 * En Workers no se comparten conexiones entre requests: cada request usa la suya.
 */
export async function withDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL no configurada");

  const client = postgres(url, {
    ssl: "require", // sin esto postgres-js conecta en texto plano
    prepare: false, // el transaction pooler de Supabase (6543) no soporta prepared statements
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
