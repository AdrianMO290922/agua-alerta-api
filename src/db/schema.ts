// Espejo en TypeScript del esquema SQL de supabase/migrations/.
// La fuente de verdad es el SQL: no se usa drizzle-kit para migrar.
// Si cambias una tabla o vista allá, actualiza este archivo.
import { sql, type SQL } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  doublePrecision,
  integer,
  numeric,
  pgEnum,
  pgTable,
  pgView,
  serial,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

// --- Tipos ------------------------------------------------------------
export const severityLevel = pgEnum("severity_level", ["goteo", "chorro", "inundacion"]);
export const leakStatus = pgEnum("leak_status", ["pendiente", "en_atencion", "resuelta", "descartada"]);
export const reportKind = pgEnum("report_kind", ["initial", "confirmation"]);
export const locationSrc = pgEnum("location_src", ["gps", "manual"]);

export const userRole = pgEnum("user_role", ["admin", "operador"]);

export type Severity = (typeof severityLevel.enumValues)[number];
export type LeakStatus = (typeof leakStatus.enumValues)[number];
export type UserRole = (typeof userRole.enumValues)[number];
export type UrgencyLevel = "critica" | "alta" | "media" | "baja";

/** Estatus en los que una fuga sigue abierta (se agrupa, acumula antigüedad, sale en el mapa). */
export const ACTIVE_STATUSES = ["pendiente", "en_atencion"] as const satisfies readonly LeakStatus[];

// geography(Point, 4326) de PostGIS. La app no la lee (para eso están lat/lng);
// se escribe siempre con geoPoint() para que lat/lng y geom no se desincronicen.
const geography = customType<{ data: string }>({
  dataType: () => "extensions.geography(Point, 4326)",
});

/** Punto PostGIS para columnas `geom`. Ojo: st_makepoint recibe (lng, lat). */
export const geoPoint = (lat: number, lng: number): SQL =>
  sql`extensions.st_setsrid(extensions.st_makepoint(${lng}, ${lat}), 4326)::extensions.geography`;

// geometry(MultiPolygon, 4326): polígono de una zona de servicio. La app no lo lee
// crudo: lo pide como GeoJSON con extensions.st_asgeojson().
const multiPolygon = customType<{ data: string }>({
  dataType: () => "extensions.geometry(MultiPolygon, 4326)",
});

const tstz = (name: string) => timestamp(name, { withTimezone: true });

// --- Tablas -----------------------------------------------------------
/** Parámetros ajustables en vivo (radios de agrupamiento, rate limit...). */
export const appConfig = pgTable("app_config", {
  key: text("key").primaryKey(),
  value: numeric("value", { mode: "number" }).notNull(),
});

/**
 * Zona de servicio fija (Norte, Centro, Sur...). Cada fuga cae en la que contiene
 * su punto (lo calcula leaks_ranked.sector_id). No confundir con zone_id (DBSCAN).
 */
export const sectors = pgTable("sectors", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  color: text("color").notNull(), // check: #rrggbb
  neighborhoods: text("neighborhoods").array().notNull().default(sql`'{}'`),
  managerName: text("manager_name"),
  managerPhone: text("manager_phone"),
  /** Se suman al índice de urgencia de sus fugas (0–15). */
  priorityPoints: integer("priority_points").notNull().default(0),
  priorityReason: text("priority_reason"),
  geom: multiPolygon("geom").notNull(),
  createdAt: tstz("created_at").notNull().defaultNow(),
});

export const crews = pgTable("crews", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: tstz("created_at").notNull().defaultNow(),
  /** null = cuadrilla sin zona (comodín). */
  sectorId: integer("sector_id").references(() => sectors.id, { onDelete: "set null" }),
  /** Fugas activas que puede llevar a la vez; más que eso = saturada. */
  maxActiveLeaks: integer("max_active_leaks").notNull().default(5),
});

/** Fuga agrupada: lo que ve la cuadrilla. */
export const leaks = pgTable("leaks", {
  id: uuid("id").primaryKey().defaultRandom(),
  lat: doublePrecision("lat").notNull(),
  lng: doublePrecision("lng").notNull(),
  geom: geography("geom").notNull(),
  maxSeverity: severityLevel("max_severity").notNull(),
  reportCount: integer("report_count").notNull().default(1),
  confirmationCount: integer("confirmation_count").notNull().default(1),
  status: leakStatus("status").notNull().default("pendiente"),
  isRecurrent: boolean("is_recurrent").notNull().default(false),
  crewId: integer("crew_id").references(() => crews.id),
  firstReportedAt: tstz("first_reported_at").notNull().defaultNow(),
  // Los llena el trigger trg_leak_status al cambiar de estatus.
  attendedAt: tstz("attended_at"),
  resolvedAt: tstz("resolved_at"),
});

/** Lo que manda cada ciudadano: reporte inicial o confirmación de una fuga. */
export const reports = pgTable(
  "reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leakId: uuid("leak_id")
      .notNull()
      .references(() => leaks.id, { onDelete: "cascade" }),
    kind: reportKind("kind").notNull().default("initial"),
    lat: doublePrecision("lat").notNull(),
    lng: doublePrecision("lng").notNull(),
    geom: geography("geom").notNull(),
    accuracyM: doublePrecision("accuracy_m"),
    locationSource: locationSrc("location_source").notNull().default("gps"),
    severity: severityLevel("severity").notNull(),
    photoUrl: text("photo_url"),
    note: text("note"), // check: <= 280 caracteres
    deviceId: text("device_id").notNull(),
    createdAt: tstz("created_at").notNull().defaultNow(),
  },
  // Violarla (código 23505) = "ya confirmaste esta fuga" → 409.
  (t) => [unique("reports_one_per_device").on(t.leakId, t.deviceId)],
);

/** Usuarios del panel admin. password_hash es bcrypt generado en Postgres (pgcrypto). */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique("users_email_key"), // check: siempre en minúsculas
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: userRole("role").notNull().default("operador"),
  active: boolean("active").notNull().default(true),
  createdAt: tstz("created_at").notNull().defaultNow(),
  lastLoginAt: tstz("last_login_at"),
});

// --- Vistas (solo lectura) --------------------------------------------
/** Fugas con índice de urgencia, litros y zona. Ya viene ordenada por urgencia. */
export const leaksRanked = pgView("leaks_ranked", {
  id: uuid("id").notNull(),
  lat: doublePrecision("lat").notNull(),
  lng: doublePrecision("lng").notNull(),
  status: leakStatus("status").notNull(),
  maxSeverity: severityLevel("max_severity").notNull(),
  reportCount: integer("report_count").notNull(),
  confirmationCount: integer("confirmation_count").notNull(),
  isRecurrent: boolean("is_recurrent").notNull(),
  crewId: integer("crew_id"),
  firstReportedAt: tstz("first_reported_at").notNull(),
  attendedAt: tstz("attended_at"),
  resolvedAt: tstz("resolved_at"),
  // Entero que DBSCAN reasigna en cada consulta: no usarlo como id estable.
  zoneId: integer("zone_id"),
  zoneSize: bigint("zone_size", { mode: "number" }).notNull(),
  litersWasted: bigint("liters_wasted", { mode: "number" }).notNull(),
  litersPerDay: bigint("liters_per_day", { mode: "number" }).notNull(),
  urgencyScore: integer("urgency_score").notNull(),
  urgencyLevel: text("urgency_level").$type<UrgencyLevel>().notNull(),
  photoUrl: text("photo_url"),
  /** Zona de servicio que contiene la fuga; null = fuera de cobertura. */
  sectorId: integer("sector_id"),
}).existing();

/** Clusters de ≥3 fugas activas en 250 m (posible falla en red primaria). */
export const zonesRanked = pgView("zones_ranked", {
  zoneId: integer("zone_id").notNull(),
  leakCount: bigint("leak_count", { mode: "number" }).notNull(),
  litersPerDay: numeric("liters_per_day", { mode: "number" }).notNull(),
  maxUrgency: integer("max_urgency").notNull(),
  centerLat: numeric("center_lat", { mode: "number" }).notNull(),
  centerLng: numeric("center_lng", { mode: "number" }).notNull(),
  leakIds: uuid("leak_ids").array().notNull(),
  /** Zona de servicio donde cae la mayoría de sus fugas. */
  sectorId: integer("sector_id"),
}).existing();
