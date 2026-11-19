import { Elysia } from "elysia";
import { CloudflareAdapter } from "elysia/adapter/cloudflare-worker";
import { cors } from "@elysiajs/cors";
import postgres from "postgres";

// En Workers, `vars` y secretos de wrangler llegan en process.env (nodejs_compat).
const app = new Elysia({ adapter: CloudflareAdapter })
  .use(cors({ origin: process.env.CORS_ORIGIN || true }))
  .get("/", () => ({ servicio: "agua-alerta-api", estado: "ok" }))
  .get("/health", async ({ set }) => {
    const url = process.env.DATABASE_URL;
    if (!url) {
      set.status = 500;
      return { estado: "error", db: "DATABASE_URL no configurada" };
    }
    // Un cliente por request: en Workers no se comparten conexiones entre requests.
    const sql = postgres(url, { prepare: false, max: 1, connect_timeout: 5 });
    try {
      await sql`select 1`;
      return { estado: "ok", db: "ok" };
    } catch (e) {
      set.status = 503;
      return { estado: "error", db: "sin conexión" };
    } finally {
      await sql.end({ timeout: 1 });
    }
  })
  .compile(); // obligatorio con CloudflareAdapter

export default app;
