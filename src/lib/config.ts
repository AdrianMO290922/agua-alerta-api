import { appConfig, type Executor } from "../db";

/** Valores de respaldo si falta una fila en app_config (los reales viven en la BD). */
const DEFAULTS = {
  inner_base_m: 30,
  accuracy_factor: 0.5,
  accuracy_cap_m: 70,
  band_m: 80,
  force_pin_accuracy_m: 150,
  rate_limit_per_hour: 10,
};

export type AppConfig = typeof DEFAULTS;

export async function loadConfig(db: Executor): Promise<AppConfig> {
  const rows = await db.select().from(appConfig);
  return { ...DEFAULTS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
}

export type LocationSource = "gps" | "manual";

/**
 * Radios de duplicados (decisiones-tecnicas §5).
 * inner: misma fuga → se agrupa sola. outer: banda ambigua → se le pregunta al usuario.
 * Un pin arrastrado a mano cuenta como precisión 0 (radio mínimo); un GPS sin
 * precisión reportada se toma como el peor caso permitido.
 */
export function radiiFor(cfg: AppConfig, accuracy: number | undefined, source: LocationSource) {
  const acc =
    source === "manual" ? 0 : Math.min(Math.max(accuracy ?? cfg.accuracy_cap_m, 0), cfg.accuracy_cap_m);
  const inner = cfg.inner_base_m + acc * cfg.accuracy_factor;
  return { inner, outer: inner + cfg.band_m };
}
