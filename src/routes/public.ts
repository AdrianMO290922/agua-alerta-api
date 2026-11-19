// App ciudadana: acceso libre, sin login.
import { Elysia, t } from "elysia";
import { and, asc, between, desc, eq, inArray } from "drizzle-orm";
import { ACTIVE_STATUSES, findNearbyLeaks, leaksRanked, withDb, zonesRanked, type Db } from "../db";
import { loadConfig, radiiFor } from "../lib/config";
import {
  ErrorRes,
  Lat,
  LeakPin,
  Lng,
  LocationSource,
  NearbyLeak,
  oneOf,
  Severity,
  Uuid,
  Zone,
  toPin,
} from "../lib/schemas";
import { notifyLeakEvent } from "../lib/mqtt";
import { PHOTO_KEY_PATTERN, savePhoto } from "../lib/storage";
import { createReport } from "../services/reports";

const isActive = (s: string) => (ACTIVE_STATUSES as readonly string[]).includes(s);
const round1 = (n: number) => Math.round(n * 10) / 10;

async function rankedLeak(db: Db, id: string) {
  const [row] = await db.select().from(leaksRanked).where(eq(leaksRanked.id, id));
  return row;
}

export const publicRoutes = new Elysia({ tags: ["Ciudadano"] })
  .get(
    "/leaks",
    async ({ query, status }) => {
      let box: [number, number, number, number] | null = null;
      if (query.bbox) {
        box = query.bbox.split(",").map(Number) as [number, number, number, number];
        if (box[0] > box[2] || box[1] > box[3]) {
          return status(400, { error: "bbox debe ser minLng,minLat,maxLng,maxLat" });
        }
      }
      const rows = await withDb((db) =>
        db
          .select()
          .from(leaksRanked)
          .where(
            and(
              inArray(leaksRanked.status, [...ACTIVE_STATUSES]),
              box ? between(leaksRanked.lng, box[0], box[2]) : undefined,
              box ? between(leaksRanked.lat, box[1], box[3]) : undefined,
            ),
          )
          .orderBy(desc(leaksRanked.urgencyScore), asc(leaksRanked.firstReportedAt)),
      );
      return rows.map(toPin);
    },
    {
      query: t.Object({
        bbox: t.Optional(
          t.String({
            pattern: "^-?\\d+(\\.\\d+)?(,-?\\d+(\\.\\d+)?){3}$",
            description: "Área visible del mapa: minLng,minLat,maxLng,maxLat. Sin bbox devuelve todas.",
            examples: ["-101.21,19.69,-101.17,19.72"],
          }),
        ),
      }),
      response: { 200: t.Array(LeakPin), 400: ErrorRes },
      detail: {
        summary: "Pines del mapa",
        description: "Fugas activas (pendiente y en atención), de mayor a menor urgencia.",
      },
    },
  )
  .get(
    "/leaks/nearby",
    async ({ query }) => {
      const source = query.source ?? "gps";
      const { cfg, nearby } = await withDb(async (db) => {
        const cfg = await loadConfig(db);
        const { outer } = radiiFor(cfg, query.accuracy, source);
        return { cfg, nearby: await findNearbyLeaks(db, query.lat, query.lng, outer) };
      });
      const { inner, outer } = radiiFor(cfg, query.accuracy, source);

      const active = nearby.filter((l) => isActive(l.status));
      const exact = active.find((l) => l.distance_m <= inner) ?? null;
      const resolved = nearby.find((l) => l.status === "resuelta" && l.distance_m <= inner) ?? null;
      const view = (l: (typeof nearby)[number]) => ({
        id: l.id,
        distance_m: round1(l.distance_m),
        status: l.status,
        max_severity: l.max_severity,
        report_count: l.report_count,
        photo_url: l.photo_url,
      });

      return {
        radius: { inner_m: round1(inner), outer_m: round1(outer) },
        must_drag_pin: source === "gps" && (query.accuracy ?? Infinity) > cfg.force_pin_accuracy_m,
        exact: exact ? view(exact) : null,
        ambiguous: active.filter((l) => l !== exact).map(view),
        resolved: resolved
          ? { id: resolved.id, distance_m: round1(resolved.distance_m), resolved_at: resolved.resolved_at }
          : null,
      };
    },
    {
      query: t.Object({
        lat: t.Numeric({ minimum: 14, maximum: 33 }),
        lng: t.Numeric({ minimum: -119, maximum: -86 }),
        accuracy: t.Optional(t.Numeric({ minimum: 0, description: "Precisión del GPS en metros" })),
        source: t.Optional(LocationSource),
      }),
      response: t.Object({
        radius: t.Object({ inner_m: t.Number(), outer_m: t.Number() }),
        must_drag_pin: t.Boolean({ description: "GPS demasiado impreciso: pedir que arrastre el pin" }),
        exact: t.Nullable(NearbyLeak, { description: "Misma fuga: mostrar \"Ya se reportó aquí\" con Confirmar preseleccionado" }),
        ambiguous: t.Array(NearbyLeak, { description: "Banda ambigua: mostrar sin preseleccionar" }),
        resolved: t.Nullable(
          t.Object({ id: Uuid, distance_m: t.Number(), resolved_at: t.Nullable(t.String({ format: "date-time" })) }),
          { description: "Aquí se reparó una fuga: un reporte nuevo saldrá como reincidente" },
        ),
      }),
      detail: {
        summary: "Pre-check de duplicados",
        description:
          "Llamar ANTES de pedir la foto. Radio interno = 30 m + min(precisión, 70) × 0.5 (0 si el pin es manual); banda ambigua = interno + 80 m. Valores en app_config.",
      },
    },
  )
  .post(
    "/uploads",
    async ({ body, status }) => {
      const saved = await savePhoto(body.file);
      if (!saved) return status(415, { error: "Formato no soportado: usa JPG, PNG o WebP" });
      return status(201, { photo_key: saved.key, photo_url: saved.url });
    },
    {
      parse: "multipart/form-data",
      body: t.Object({ file: t.File({ maxSize: "5m", description: "Comprimir en el cliente a ~800 px / ~200 KB" }) }),
      response: { 201: t.Object({ photo_key: t.String(), photo_url: t.String() }), 415: ErrorRes },
      detail: {
        summary: "Subir foto",
        description: "multipart/form-data con el campo `file`. Devuelve `photo_key` para enviarlo en POST /reports.",
      },
    },
  )
  .post(
    "/reports",
    async ({ body, status }) => {
      const result = await withDb(async (db) => {
        const r = await createReport(db, { ...body, source: body.source ?? "gps" });
        return r.ok ? { ...r, leak: await rankedLeak(db, r.leakId) } : r;
      });
      if (!result.ok) {
        return result.status === 404 ? status(404, { error: result.error }) : status(409, { error: result.error });
      }
      // Ya hubo commit: avisa al dashboard sin retrasar la respuesta.
      notifyLeakEvent({ tipo: result.action, leak_id: result.leakId });
      return status(201, {
        action: result.action,
        leak_id: result.leakId,
        report_id: result.reportId,
        is_recurrent: result.isRecurrent,
        leak: toPin(result.leak),
      });
    },
    {
      body: t.Object({
        lat: Lat,
        lng: Lng,
        accuracy: t.Optional(t.Number({ minimum: 0, description: "Precisión del GPS en metros" })),
        source: t.Optional(LocationSource),
        severity: Severity,
        photo_key: t.Optional(t.String({ pattern: PHOTO_KEY_PATTERN, description: "De POST /uploads" })),
        note: t.Optional(t.String({ maxLength: 280 })),
        device_id: t.String({ minLength: 8, maxLength: 64, description: "UUID guardado en localStorage" }),
        leak_id: t.Optional(Uuid),
        force_new: t.Optional(t.Boolean()),
      }),
      response: {
        201: t.Object({
          action: oneOf(["created", "confirmed"], {
            description: "created: fuga nueva · confirmed: se sumó a una existente",
          }),
          leak_id: Uuid,
          report_id: Uuid,
          is_recurrent: t.Boolean(),
          leak: LeakPin,
        }),
        404: ErrorRes,
        409: ErrorRes,
      },
      detail: {
        summary: "Crear reporte o confirmación",
        description:
          "Con `leak_id` confirma esa fuga. Con `force_new: true` crea una nueva (\"Es otra fuga\"). Sin ninguno, el servidor agrupa por radio interno. 409 si el dispositivo ya reportó esa fuga o si la fuga está cerrada.\n\n" +
          "Tras guardar publica `{ \"tipo\": \"created\" | \"confirmed\", \"leak_id\" }` en el broker MQTT (`MQTT_TOPIC`, QoS 0, sin retain). Es solo un aviso: el dashboard debe volver a pedir `GET /admin/leaks`.",
      },
    },
  )
  .get(
    "/zones",
    async () => {
      const rows = await withDb((db) => db.select().from(zonesRanked).orderBy(desc(zonesRanked.litersPerDay)));
      return rows.map((z) => ({
        zone_id: z.zoneId,
        leak_count: z.leakCount,
        liters_per_day: z.litersPerDay,
        max_urgency: z.maxUrgency,
        center_lat: z.centerLat,
        center_lng: z.centerLng,
        leak_ids: z.leakIds,
      }));
    },
    {
      response: t.Array(Zone),
      detail: {
        summary: "Zonas de falla conjunta",
        description: "Grupos de ≥3 fugas activas a menos de 250 m entre sí: posible falla en la red primaria.",
      },
    },
  );
