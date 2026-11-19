// Esquemas de entrada/salida de la API. Validan los requests y generan la
// documentación de Scalar (/docs). La API habla en snake_case y fechas ISO 8601.
import { t } from "elysia";
import type { SchemaOptions } from "@sinclair/typebox";
import type { InferSelectViewModel } from "drizzle-orm";
import type { leaksRanked } from "../db";
import type { CrewLoad } from "../services/crews";

const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * Enum de strings. Usar SIEMPRE este y no t.UnionEnum directo: el de Elysia trae
 * `default: values[0]` y rellena los campos opcionales que no vienen (un PATCH de
 * solo `crew_id` llegaba con status "pendiente" y severity "goteo").
 * Solo conserva un default si se pasa explícito en `options`.
 */
export function oneOf<const T extends readonly [string, ...string[]]>(values: T, options: SchemaOptions = {}) {
  const schema = t.UnionEnum(values, options);
  if (!("default" in options)) delete (schema as { default?: unknown }).default;
  return schema;
}

// --- Comunes ------------------------------------------------------------
export const ErrorRes = t.Object({ error: t.String() }, { description: "Error con mensaje para mostrar" });

export const Severity = oneOf(["goteo", "chorro", "inundacion"], { description: "Nivel de desperdicio" });
export const LeakStatus = oneOf(["pendiente", "en_atencion", "resuelta", "descartada"]);
export const UrgencyLevel = oneOf(["critica", "alta", "media", "baja"], {
  description: "critica ≥60 · alta ≥40 · media ≥20 · baja <20",
});
export const LocationSource = oneOf(["gps", "manual"], {
  description: "gps: ubicación del teléfono (por defecto) · manual: pin arrastrado a mano",
});
export const Uuid = t.String({ format: "uuid" });
const DateTime = t.String({ format: "date-time" });

// Rango aproximado de México (mismo check que la tabla reports)
export const Lat = t.Number({ minimum: 14, maximum: 33, description: "Latitud (México)" });
export const Lng = t.Number({ minimum: -119, maximum: -86, description: "Longitud (México)" });

// --- Fugas ----------------------------------------------------------------
type RankedRow = InferSelectViewModel<typeof leaksRanked>;

export const LeakPin = t.Object({
  id: Uuid,
  lat: t.Number(),
  lng: t.Number(),
  status: LeakStatus,
  max_severity: Severity,
  report_count: t.Integer({ description: "Reportes de dispositivos distintos" }),
  urgency_score: t.Integer({ minimum: 0, maximum: 100 }),
  urgency_level: UrgencyLevel,
  liters_wasted: t.Integer({ description: "Litros estimados perdidos desde el primer reporte" }),
  liters_per_day: t.Integer(),
  photo_url: t.Nullable(t.String({ description: "Foto más reciente" })),
  first_reported_at: DateTime,
});

export const toPin = (r: RankedRow) => ({
  id: r.id,
  lat: r.lat,
  lng: r.lng,
  status: r.status,
  max_severity: r.maxSeverity,
  report_count: r.reportCount,
  urgency_score: r.urgencyScore,
  urgency_level: r.urgencyLevel,
  liters_wasted: r.litersWasted,
  liters_per_day: r.litersPerDay,
  photo_url: r.photoUrl,
  first_reported_at: iso(r.firstReportedAt),
});

export const AdminLeak = t.Composite([
  LeakPin,
  t.Object({
    confirmation_count: t.Integer(),
    is_recurrent: t.Boolean({ description: "Reapareció donde ya se había reparado una fuga" }),
    crew_id: t.Nullable(t.Integer()),
    crew_name: t.Nullable(t.String()),
    zone_id: t.Nullable(t.Integer({ description: "Cambia en cada consulta: no usar como id" })),
    zone_size: t.Integer({ description: "Fugas activas en su zona (≥3 = posible falla en red primaria)" }),
    attended_at: t.Nullable(DateTime),
    resolved_at: t.Nullable(DateTime),
    sector_id: t.Nullable(t.Integer({ description: "Zona de servicio (GET /admin/sectors); null = fuera de cobertura" })),
    sector_name: t.Nullable(t.String()),
    sector_color: t.Nullable(t.String()),
    suggested_crew_id: t.Nullable(
      t.Integer({ description: "Cuadrilla de su zona con menos carga; null si no hay zona o la zona no tiene cuadrillas" }),
    ),
    suggested_crew_name: t.Nullable(t.String()),
  }),
]);

export type AdminLeakExtra = {
  crewName: string | null;
  sectorName: string | null;
  sectorColor: string | null;
  suggested: { id: number; name: string } | null;
};

export const toAdminLeak = (r: RankedRow, x: AdminLeakExtra) => ({
  ...toPin(r),
  confirmation_count: r.confirmationCount,
  is_recurrent: r.isRecurrent,
  crew_id: r.crewId,
  crew_name: x.crewName,
  zone_id: r.zoneId,
  zone_size: r.zoneSize,
  attended_at: isoOrNull(r.attendedAt),
  resolved_at: isoOrNull(r.resolvedAt),
  sector_id: r.sectorId,
  sector_name: x.sectorName,
  sector_color: x.sectorColor,
  suggested_crew_id: x.suggested?.id ?? null,
  suggested_crew_name: x.suggested?.name ?? null,
});

export const NearbyLeak = t.Object({
  id: Uuid,
  distance_m: t.Number(),
  status: LeakStatus,
  max_severity: Severity,
  report_count: t.Integer(),
  photo_url: t.Nullable(t.String()),
});

export const Zone = t.Object({
  zone_id: t.Integer({ description: "Cambia en cada consulta: para asignar usa leak_ids" }),
  leak_count: t.Integer(),
  liters_per_day: t.Integer(),
  max_urgency: t.Integer(),
  center_lat: t.Number(),
  center_lng: t.Number(),
  leak_ids: t.Array(Uuid),
  sector_id: t.Nullable(t.Integer({ description: "Zona de servicio donde cae la mayoría de sus fugas" })),
  sector_name: t.Nullable(t.String({ description: "Para el panel: \"Zona Centro · 3 fugas\"" })),
});

// --- Admin ----------------------------------------------------------------
export const UserRole = oneOf(["admin", "operador"]);
export const SessionUser = t.Object({ id: Uuid, email: t.String(), name: t.String(), role: UserRole });

export const Crew = t.Object({
  id: t.Integer(),
  name: t.String(),
  sector_id: t.Nullable(t.Integer({ description: "Zona a la que pertenece; null = sin zona (comodín)" })),
  sector_name: t.Nullable(t.String()),
  active_leaks: t.Integer({ description: "Fugas pendientes o en atención asignadas" }),
  max_active_leaks: t.Integer({ description: "Capacidad: fugas activas que puede llevar a la vez" }),
  saturated: t.Boolean({ description: "active_leaks ≥ max_active_leaks" }),
});

export const toCrew = (c: CrewLoad) => ({
  id: c.id,
  name: c.name,
  sector_id: c.sectorId,
  sector_name: c.sectorName,
  active_leaks: c.activeLeaks,
  max_active_leaks: c.maxActiveLeaks,
  saturated: c.saturated,
});

export const GeoMultiPolygon = t.Object(
  {
    type: t.Literal("MultiPolygon"),
    coordinates: t.Array(t.Array(t.Array(t.Array(t.Number())))),
  },
  { description: "GeoJSON en [lng, lat], listo para dibujar en Leaflet/MapLibre" },
);
export type GeoMultiPolygon = { type: "MultiPolygon"; coordinates: number[][][][] };

export const HexColor = t.String({ pattern: "^#[0-9a-fA-F]{6}$", description: "#rrggbb para el mapa" });

export const Sector = t.Object({
  id: t.Integer(),
  name: t.String(),
  color: HexColor,
  neighborhoods: t.Array(t.String(), { description: "Colonias que cubre" }),
  manager_name: t.Nullable(t.String({ description: "Responsable de la zona" })),
  manager_phone: t.Nullable(t.String()),
  priority_points: t.Integer({ minimum: 0, maximum: 15, description: "Se suman al índice de urgencia de sus fugas" }),
  priority_reason: t.Nullable(t.String()),
  crews: t.Array(Crew, { description: "Cuadrillas de la zona con su carga" }),
  suggested_crew_id: t.Nullable(t.Integer({ description: "La no saturada con menos carga" })),
  geometry: GeoMultiPolygon,
});

export const AssignWarning = t.Object({
  code: oneOf(["crew_other_sector", "crew_saturated"], {
    description: "crew_other_sector: la cuadrilla es de otra zona · crew_saturated: rebasó su capacidad",
  }),
  message: t.String({ description: "Texto listo para mostrar al admin" }),
});
