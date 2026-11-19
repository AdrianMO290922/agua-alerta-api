// Borra TODAS las fugas y sus reportes para empezar de cero.
//   bun run fugas:reiniciar          → deja fugas y reportes vacíos
//   bun run fugas:reiniciar --demo   → además carga los datos de demo (supabase/seed.sql)
//
// No toca usuarios, cuadrillas, zonas de servicio (sectors) ni app_config.
// Las fotos en R2 no se borran: quedan huérfanas y no estorban.
//
// OJO: usa DATABASE_URL de .env, que apunta a la base de PRODUCCIÓN (la misma
// que usa el front). Pide escribir BORRAR antes de tocar nada.
import { sql } from "drizzle-orm";
import { withDb } from "../src/db";

const demo = process.argv.includes("--demo");
const seed = demo ? await Bun.file(new URL("../supabase/seed.sql", import.meta.url)).text() : "";

const host = (() => {
  try {
    return new URL(process.env.DATABASE_URL ?? "").hostname; // solo el host, nunca la contraseña
  } catch {
    return "(DATABASE_URL no configurada)";
  }
})();

const [counts] = await withDb((db) =>
  db.execute<{ leaks: number; reports: number }>(
    sql`select (select count(*)::int from leaks) as leaks, (select count(*)::int from reports) as reports`,
  ),
);

console.log(`Base: ${host}`);
console.log(`Se borrarán ${counts.leaks} fugas y ${counts.reports} reportes.`);
console.log(demo ? "Después se cargan los datos de demo de supabase/seed.sql." : "Las tablas quedan vacías.");

if (prompt("Escribe BORRAR para confirmar:")?.trim() !== "BORRAR") {
  console.log("Cancelado. No se borró nada.");
  process.exit(0);
}

try {
  await withDb(async (db) => {
    if (demo) {
      // seed.sql empieza con su propio TRUNCATE. Varias sentencias en una sola
      // consulta simple = una transacción implícita: si algo falla, no se borra nada.
      await db.$client.unsafe(seed).simple();
    } else {
      await db.execute(sql`truncate table reports, leaks`);
    }
  });
} catch (e: any) {
  console.error("No se pudo reiniciar:", e?.cause?.message ?? e?.message ?? e);
  process.exit(1);
}

const [after] = await withDb((db) =>
  db.execute<{ leaks: number; reports: number }>(
    sql`select (select count(*)::int from leaks) as leaks, (select count(*)::int from reports) as reports`,
  ),
);
console.log(`✓ Listo: ${after.leaks} fugas y ${after.reports} reportes.`);
