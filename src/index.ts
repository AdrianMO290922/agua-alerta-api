import { Elysia } from "elysia";
import { CloudflareAdapter } from "elysia/adapter/cloudflare-worker";
import { cors } from "@elysiajs/cors";
import { openapi } from "@elysiajs/openapi";
import { sql } from "drizzle-orm";
import { withDb } from "./db";
import { publicRoutes } from "./routes/public";
import { adminRoutes } from "./routes/admin";

// En Workers, `vars` y secretos de wrangler llegan en process.env (nodejs_compat).
// CORS_ORIGIN admite varios orígenes separados por coma (app ciudadana y app admin).
const origins = (process.env.CORS_ORIGIN ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const app = new Elysia({ adapter: CloudflareAdapter })
  .use(cors({ origin: origins.length ? origins : true }))
  .use(
    openapi({
      path: "/docs", // Scalar en /docs, especificación en /docs/json
      // Versión fija: con "latest" una publicación nueva de Scalar podría romper /docs el día de la demo.
      scalar: { version: "1.77.0" },
      documentation: {
        info: {
          title: "Agua Alerta API",
          version: "1.0.0",
          description:
            "Reporte ciudadano de fugas de agua con agrupación automática e índice de urgencia.\n\n" +
            "- **Ciudadano**: acceso libre, sin login.\n" +
            "- **Admin**: inicia sesión en `POST /admin/login` y usa el token con el botón *Authorize*.",
        },
        tags: [
          { name: "Ciudadano", description: "App pública de reporte" },
          { name: "Admin", description: "Panel del municipio (requiere token)" },
          { name: "Sistema" },
        ],
        components: {
          securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
        },
      },
    }),
  )
  .onError(({ code, error, set }) => {
    if (code === "VALIDATION") return; // respuesta por defecto de Elysia (422 con el detalle)
    if (code === "NOT_FOUND") {
      set.status = 404;
      return { error: "Ruta no encontrada" };
    }
    if (code === "PARSE") {
      set.status = 400;
      return { error: "Cuerpo de la petición inválido" };
    }
    console.error(error);
    set.status = 500;
    return { error: "Error interno del servidor" };
  })
  .get("/", () => ({ servicio: "agua-alerta-api", estado: "ok", docs: "/docs" }), {
    detail: { tags: ["Sistema"], summary: "Estado del servicio" },
  })
  .get(
    "/health",
    async ({ set }) => {
      if (!process.env.DATABASE_URL) {
        set.status = 500;
        return { estado: "error", db: "DATABASE_URL no configurada" };
      }
      try {
        await withDb((db) => db.execute(sql`select 1`));
        return { estado: "ok", db: "ok" };
      } catch {
        set.status = 503;
        return { estado: "error", db: "sin conexión" };
      }
    },
    { detail: { tags: ["Sistema"], summary: "Conexión a la base de datos" } },
  )
  .use(publicRoutes)
  .use(adminRoutes)
  .compile(); // obligatorio con CloudflareAdapter

export default app;
