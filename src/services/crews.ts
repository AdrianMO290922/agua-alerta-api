// Cuadrillas por zona: carga de trabajo, cuadrilla sugerida para una fuga y
// avisos al asignar. La regla es "sugerir y permitir": asignar una cuadrilla de
// otra zona o saturada no se bloquea, solo se avisa.
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { ACTIVE_STATUSES, crews, leaks, sectors, type Executor } from "../db";

export type CrewLoad = {
  id: number;
  name: string;
  sectorId: number | null;
  sectorName: string | null;
  /** Fugas pendientes o en atención asignadas a la cuadrilla. */
  activeLeaks: number;
  maxActiveLeaks: number;
  /** Ya tiene tantas fugas activas como su capacidad (o más). */
  saturated: boolean;
};

export type AssignWarning = { code: "crew_other_sector" | "crew_saturated"; message: string };

/** Cuadrillas activas con su zona y su carga, agrupadas por zona. */
export async function crewLoads(db: Executor): Promise<CrewLoad[]> {
  const rows = await db
    .select({
      id: crews.id,
      name: crews.name,
      sectorId: crews.sectorId,
      sectorName: sectors.name,
      maxActiveLeaks: crews.maxActiveLeaks,
      activeLeaks: sql<number>`count(${leaks.id})::int`,
    })
    .from(crews)
    .leftJoin(sectors, eq(sectors.id, crews.sectorId))
    .leftJoin(leaks, and(eq(leaks.crewId, crews.id), inArray(leaks.status, [...ACTIVE_STATUSES])))
    .where(eq(crews.active, true))
    .groupBy(crews.id, sectors.id)
    .orderBy(asc(crews.sectorId), asc(crews.id));
  return rows.map((r) => ({ ...r, saturated: r.activeLeaks >= r.maxActiveLeaks }));
}

/**
 * Cuadrilla sugerida para una zona: de las que pertenecen a ella, la no saturada
 * con menos carga relativa. Si todas están saturadas, la menos cargada.
 * null si la fuga está fuera de cobertura o la zona no tiene cuadrillas.
 */
export function suggestCrew(loads: CrewLoad[], sectorId: number | null): CrewLoad | null {
  if (sectorId == null) return null;
  const ratio = (c: CrewLoad) => c.activeLeaks / c.maxActiveLeaks;
  const candidates = loads.filter((c) => c.sectorId === sectorId);
  candidates.sort((a, b) => Number(a.saturated) - Number(b.saturated) || ratio(a) - ratio(b) || a.id - b.id);
  return candidates[0] ?? null;
}

/** Zona más frecuente de un grupo de fugas (para sugerir cuadrilla a un cluster). */
export function mostCommonSector(sectorIds: (number | null)[]): number | null {
  const counts = new Map<number, number>();
  for (const id of sectorIds) if (id != null) counts.set(id, (counts.get(id) ?? 0) + 1);
  let best: number | null = null;
  for (const [id, n] of counts) if (best == null || n > counts.get(best)!) best = id;
  return best;
}

/**
 * Avisos tras asignar `crew` (con su carga ya actualizada) a las fugas dadas.
 * Una cuadrilla sin zona nunca genera "otra zona"; una fuga fuera de cobertura tampoco.
 */
export function assignmentWarnings(
  crew: CrewLoad,
  assigned: { sectorId: number | null; sectorName: string | null }[],
  suggested: CrewLoad | null,
): AssignWarning[] {
  const warnings: AssignWarning[] = [];

  if (crew.sectorId != null) {
    const outside = assigned.filter((l) => l.sectorId != null && l.sectorId !== crew.sectorId);
    if (outside.length) {
      const where = [...new Set(outside.map((l) => l.sectorName))].join(", ");
      const what = assigned.length === 1 ? "la fuga está" : `${outside.length} de ${assigned.length} fugas están`;
      const hint = suggested && suggested.id !== crew.id ? ` Sugerida: ${suggested.name}.` : "";
      warnings.push({
        code: "crew_other_sector",
        message: `${crew.name} es de ${crew.sectorName}, pero ${what} en ${where}.${hint}`,
      });
    }
  }

  if (crew.activeLeaks > crew.maxActiveLeaks) {
    warnings.push({
      code: "crew_saturated",
      message: `${crew.name} queda con ${crew.activeLeaks} fugas activas y su capacidad es ${crew.maxActiveLeaks}.`,
    });
  }
  return warnings;
}
