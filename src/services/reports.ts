import { and, eq, sql } from "drizzle-orm";
import {
  ACTIVE_STATUSES,
  findNearbyLeaks,
  geoPoint,
  leaks,
  reports,
  type Db,
  type LeakStatus,
  type Severity,
} from "../db";
import { loadConfig, radiiFor, type LocationSource } from "../lib/config";
import { photoUrl } from "../lib/storage";

export type ReportInput = {
  lat: number;
  lng: number;
  accuracy?: number;
  source: LocationSource;
  severity: Severity;
  photo_key?: string;
  note?: string;
  device_id: string;
  /** Confirmar esta fuga (el usuario tocó "Confirmar" en el pre-check). */
  leak_id?: string;
  /** "Es otra fuga": crear una nueva aunque haya una dentro del radio interno. */
  force_new?: boolean;
};

export type ReportResult =
  | { ok: true; action: "created" | "confirmed"; leakId: string; reportId: string; isRecurrent: boolean }
  | { ok: false; status: 404 | 409; error: string };

// Un solo candado global para todas las altas de reportes: serializa los envíos
// para que dos personas en el mismo punto no creen dos fugas. A volumen de MVP
// (decenas por minuto) no se nota. Es de transacción, compatible con el pooler.
const REPORTS_LOCK = 7_210_001;

const isActive = (s: LeakStatus) => (ACTIVE_STATUSES as readonly LeakStatus[]).includes(s);

/**
 * Crea un reporte y lo agrupa (decisiones-tecnicas §5 y §11):
 * - leak_id      → confirmación de esa fuga
 * - force_new    → fuga nueva sin agrupar
 * - ninguno      → se une a la fuga activa más cercana dentro del radio interno;
 *                  si solo hay una ya resuelta ahí, se abre una nueva como reincidente.
 */
export async function createReport(db: Db, input: ReportInput): Promise<ReportResult> {
  const cfg = await loadConfig(db);

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${REPORTS_LOCK})`);

    let targetId: string | null = null;
    let isRecurrent = false;

    if (input.leak_id) {
      const [leak] = await tx
        .select({ id: leaks.id, status: leaks.status })
        .from(leaks)
        .where(eq(leaks.id, input.leak_id));
      if (!leak) return { ok: false, status: 404, error: "La fuga que quieres confirmar no existe" };
      if (!isActive(leak.status)) {
        return { ok: false, status: 409, error: "Esa fuga ya está cerrada: repórtala como una nueva" };
      }
      targetId = leak.id;
    } else {
      const { inner } = radiiFor(cfg, input.accuracy, input.source);
      const nearby = await findNearbyLeaks(tx, input.lat, input.lng, inner);
      if (!input.force_new) targetId = nearby.find((l) => isActive(l.status))?.id ?? null;
      if (!targetId) isRecurrent = nearby.some((l) => l.status === "resuelta");
    }

    const report = {
      lat: input.lat,
      lng: input.lng,
      geom: geoPoint(input.lat, input.lng),
      accuracyM: input.source === "manual" ? 0 : (input.accuracy ?? null),
      locationSource: input.source,
      severity: input.severity,
      photoUrl: input.photo_key ? photoUrl(input.photo_key) : null,
      note: input.note?.trim() || null,
      deviceId: input.device_id,
    };

    // --- Confirmación de una fuga existente ---
    if (targetId) {
      const leakId = targetId;
      // Con el candado tomado esta revisión no tiene carrera; el unique de la
      // tabla queda como respaldo.
      const [dup] = await tx
        .select({ id: reports.id })
        .from(reports)
        .where(and(eq(reports.leakId, leakId), eq(reports.deviceId, input.device_id)));
      if (dup) return { ok: false, status: 409, error: "Ya reportaste o confirmaste esta fuga" };

      const [created] = await tx
        .insert(reports)
        .values({ ...report, leakId, kind: "confirmation" })
        .returning({ id: reports.id });
      // Cada reporte es de un dispositivo distinto (unique leak_id + device_id),
      // así que report_count y confirmation_count suben juntos.
      await tx
        .update(leaks)
        .set({
          reportCount: sql`${leaks.reportCount} + 1`,
          confirmationCount: sql`${leaks.confirmationCount} + 1`,
          // El enum está ordenado goteo < chorro < inundacion: se queda con la peor.
          maxSeverity: sql`greatest(${leaks.maxSeverity}, ${input.severity}::severity_level)`,
        })
        .where(eq(leaks.id, leakId));
      return { ok: true, action: "confirmed", leakId, reportId: created.id, isRecurrent: false };
    }

    // --- Fuga nueva ---
    const [leak] = await tx
      .insert(leaks)
      .values({
        lat: input.lat,
        lng: input.lng,
        geom: geoPoint(input.lat, input.lng),
        maxSeverity: input.severity,
        isRecurrent,
      })
      .returning({ id: leaks.id });
    const [created] = await tx
      .insert(reports)
      .values({ ...report, leakId: leak.id, kind: "initial" })
      .returning({ id: reports.id });
    return { ok: true, action: "created", leakId: leak.id, reportId: created.id, isRecurrent };
  });
}
