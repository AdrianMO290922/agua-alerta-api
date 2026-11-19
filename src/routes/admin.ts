// App admin: login con usuario de la tabla `users`; el resto exige el token.
import { Elysia, t } from "elysia";
import { and, asc, desc, eq, getViewSelectedFields, inArray, sql } from "drizzle-orm";
import { ACTIVE_STATUSES, crews, leaks, leaksRanked, users, withDb, type Executor, type LeakStatus } from "../db";
import { authPlugin, SESSION_HOURS, signSession } from "../lib/auth";
import {
  AdminLeak,
  Crew,
  ErrorRes,
  LeakStatus as LeakStatusT,
  oneOf,
  SessionUser,
  Severity,
  Uuid,
  toAdminLeak,
} from "../lib/schemas";

const STATUS_FILTERS = {
  activas: [...ACTIVE_STATUSES],
  pendiente: ["pendiente"],
  en_atencion: ["en_atencion"],
  resuelta: ["resuelta"],
  descartada: ["descartada"],
  todas: ["pendiente", "en_atencion", "resuelta", "descartada"],
} satisfies Record<string, LeakStatus[]>;

/** Fugas del dashboard con el nombre de su cuadrilla, de mayor a menor urgencia. */
function adminLeaks(db: Executor, where: ReturnType<typeof and>) {
  return db
    .select({ leak: getViewSelectedFields(leaksRanked), crewName: crews.name })
    .from(leaksRanked)
    .leftJoin(crews, eq(crews.id, leaksRanked.crewId))
    .where(where)
    .orderBy(desc(leaksRanked.urgencyScore), asc(leaksRanked.firstReportedAt));
}

async function activeCrewExists(db: Executor, id: number) {
  const [crew] = await db.select({ id: crews.id }).from(crews).where(and(eq(crews.id, id), eq(crews.active, true)));
  return Boolean(crew);
}

export const adminRoutes = new Elysia({ prefix: "/admin", tags: ["Admin"] })
  .use(authPlugin)
  .post(
    "/login",
    async ({ body, status }) => {
      // bcrypt se compara dentro de Postgres (pgcrypto). Una sola consulta:
      // valida contraseña, que el usuario esté activo y registra el acceso.
      const [user] = await withDb((db) =>
        db
          .update(users)
          .set({ lastLoginAt: sql`now()` })
          .where(
            and(
              eq(users.email, body.email.trim().toLowerCase()),
              eq(users.active, true),
              sql`${users.passwordHash} = extensions.crypt(${body.password}, ${users.passwordHash})`,
            ),
          )
          .returning({ id: users.id, email: users.email, name: users.name, role: users.role }),
      );
      if (!user) return status(401, { error: "Correo o contraseña incorrectos" });

      const { token, expiresAt } = await signSession(user);
      return { token, expires_at: expiresAt.toISOString(), user };
    },
    {
      body: t.Object({
        email: t.String({ format: "email" }),
        password: t.String({ minLength: 1 }),
      }),
      response: {
        200: t.Object({
          token: t.String({ description: "Enviar como `Authorization: Bearer <token>`" }),
          expires_at: t.String({ format: "date-time" }),
          user: SessionUser,
        }),
        401: ErrorRes,
      },
      detail: {
        summary: "Iniciar sesión",
        description: `Devuelve un JWT válido por ${SESSION_HOURS} h. Los usuarios se crean con \`bun run usuario:crear\`.`,
      },
    },
  )
  .get("/me", ({ user }) => user, {
    auth: true,
    response: SessionUser,
    detail: { summary: "Usuario de la sesión" },
  })
  .get(
    "/crews",
    () =>
      withDb((db) =>
        db.select({ id: crews.id, name: crews.name }).from(crews).where(eq(crews.active, true)).orderBy(asc(crews.id)),
      ),
    {
      auth: true,
      response: t.Array(Crew),
      detail: { summary: "Cuadrillas activas" },
    },
  )
  .get(
    "/leaks",
    async ({ query }) => {
      const statuses = STATUS_FILTERS[query.status ?? "activas"];
      const rows = await withDb((db) => adminLeaks(db, and(inArray(leaksRanked.status, statuses))));
      return rows.map((r) => toAdminLeak(r.leak, r.crewName));
    },
    {
      auth: true,
      query: t.Object({
        status: t.Optional(
          oneOf(["activas", "pendiente", "en_atencion", "resuelta", "descartada", "todas"], {
            default: "activas",
            description: "activas = pendiente + en_atencion",
          }),
        ),
      }),
      response: t.Array(AdminLeak),
      detail: { summary: "Fugas ordenadas por urgencia", description: "Lista del dashboard, de mayor a menor urgencia." },
    },
  )
  .patch(
    "/leaks/:id",
    async ({ params, body, status }) => {
      const result = await withDb(async (db) => {
        if (body.crew_id != null && !(await activeCrewExists(db, body.crew_id))) return "crew" as const;

        const updated = await db
          .update(leaks)
          .set({
            ...(body.status && { status: body.status }),
            ...(body.severity && { maxSeverity: body.severity }),
            ...(body.crew_id !== undefined && { crewId: body.crew_id }),
          })
          .where(eq(leaks.id, params.id))
          .returning({ id: leaks.id });
        if (!updated.length) return null;

        const [row] = await adminLeaks(db, and(eq(leaksRanked.id, params.id)));
        return toAdminLeak(row.leak, row.crewName);
      });
      if (result === "crew") return status(422, { error: "La cuadrilla no existe o está inactiva" });
      if (!result) return status(404, { error: "La fuga no existe" });
      return result;
    },
    {
      auth: true,
      params: t.Object({ id: Uuid }),
      body: t.Object(
        {
          status: t.Optional(LeakStatusT),
          severity: t.Optional(Severity),
          crew_id: t.Optional(t.Nullable(t.Integer({ description: "null para quitar la cuadrilla" }))),
        },
        { minProperties: 1 },
      ),
      response: { 200: AdminLeak, 404: ErrorRes, 422: ErrorRes },
      detail: {
        summary: "Cambiar estatus, severidad o cuadrilla",
        description:
          "Al pasar a en_atencion o resuelta/descartada, la BD registra attended_at / resolved_at. `severity` corrige la severidad máxima de la fuga.",
      },
    },
  )
  .post(
    "/zones/assign",
    async ({ body, status }) => {
      const result = await withDb(async (db) => {
        if (!(await activeCrewExists(db, body.crew_id))) return null;
        return db
          .update(leaks)
          .set({ crewId: body.crew_id })
          .where(and(inArray(leaks.id, body.leak_ids), inArray(leaks.status, [...ACTIVE_STATUSES])))
          .returning({ id: leaks.id });
      });
      if (!result) return status(422, { error: "La cuadrilla no existe o está inactiva" });
      return { updated: result.length, leak_ids: result.map((r) => r.id) };
    },
    {
      auth: true,
      body: t.Object({
        leak_ids: t.Array(Uuid, { minItems: 1, maxItems: 200, description: "Los leak_ids de GET /zones" }),
        crew_id: t.Integer(),
      }),
      response: {
        200: t.Object({
          updated: t.Integer({ description: "Fugas activas asignadas (las cerradas se ignoran)" }),
          leak_ids: t.Array(Uuid),
        }),
        422: ErrorRes,
      },
      detail: { summary: "Asignar una cuadrilla a toda una zona" },
    },
  );
