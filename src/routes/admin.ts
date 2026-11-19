// App admin: login con usuario de la tabla `users`; el resto exige el token
// (salvo en modo pruebas, AUTH_DISABLED="true").
import { Elysia, t } from "elysia";
import { and, asc, desc, eq, getViewSelectedFields, inArray, sql } from "drizzle-orm";
import {
  ACTIVE_STATUSES,
  crews,
  leaks,
  leaksRanked,
  sectors,
  users,
  withDb,
  type Executor,
  type LeakStatus,
} from "../db";
import { authDisabled, authPlugin, SESSION_HOURS, signSession, userFromRequest } from "../lib/auth";
import {
  AdminLeak,
  AssignWarning,
  Crew,
  ErrorRes,
  HexColor,
  LeakStatus as LeakStatusT,
  oneOf,
  Sector,
  SessionUser,
  Severity,
  UserRole,
  Uuid,
  toAdminLeak,
  toCrew,
  type GeoMultiPolygon,
} from "../lib/schemas";
import { assignmentWarnings, crewLoads, mostCommonSector, suggestCrew, type CrewLoad } from "../services/crews";

const SessionRes = t.Object({
  token: t.String({ description: "Enviar como `Authorization: Bearer <token>`" }),
  expires_at: t.String({ format: "date-time" }),
  user: SessionUser,
});

const STATUS_FILTERS = {
  activas: [...ACTIVE_STATUSES],
  pendiente: ["pendiente"],
  en_atencion: ["en_atencion"],
  resuelta: ["resuelta"],
  descartada: ["descartada"],
  todas: ["pendiente", "en_atencion", "resuelta", "descartada"],
} satisfies Record<string, LeakStatus[]>;

const ONLY_ADMIN = "Solo un admin puede cambiar zonas y cuadrillas";

/**
 * Fugas del dashboard con su cuadrilla, su zona y la cuadrilla sugerida, de mayor
 * a menor urgencia. `loads` evita volver a consultar la carga si ya se tiene.
 */
async function adminLeaks(db: Executor, where: ReturnType<typeof and>, loads?: CrewLoad[]) {
  const rows = await db
    .select({
      leak: getViewSelectedFields(leaksRanked),
      crewName: crews.name,
      sectorName: sectors.name,
      sectorColor: sectors.color,
    })
    .from(leaksRanked)
    .leftJoin(crews, eq(crews.id, leaksRanked.crewId))
    .leftJoin(sectors, eq(sectors.id, leaksRanked.sectorId))
    .where(where)
    .orderBy(desc(leaksRanked.urgencyScore), asc(leaksRanked.firstReportedAt));
  const crewList = loads ?? (await crewLoads(db));
  return rows.map((r) =>
    toAdminLeak(r.leak, {
      crewName: r.crewName,
      sectorName: r.sectorName,
      sectorColor: r.sectorColor,
      suggested: suggestCrew(crewList, r.leak.sectorId),
    }),
  );
}

/** Zonas de servicio con sus cuadrillas, su carga y la cuadrilla sugerida. */
async function sectorList(db: Executor, id?: number) {
  const rows = await db
    .select({
      id: sectors.id,
      name: sectors.name,
      color: sectors.color,
      neighborhoods: sectors.neighborhoods,
      managerName: sectors.managerName,
      managerPhone: sectors.managerPhone,
      priorityPoints: sectors.priorityPoints,
      priorityReason: sectors.priorityReason,
      geometry: sql<GeoMultiPolygon>`extensions.st_asgeojson(${sectors.geom}, 6)::json`,
    })
    .from(sectors)
    .where(id === undefined ? undefined : eq(sectors.id, id))
    .orderBy(asc(sectors.id));
  const loads = await crewLoads(db);
  return rows.map((s) => ({
    id: s.id,
    name: s.name,
    color: s.color,
    neighborhoods: s.neighborhoods,
    manager_name: s.managerName,
    manager_phone: s.managerPhone,
    priority_points: s.priorityPoints,
    priority_reason: s.priorityReason,
    crews: loads.filter((c) => c.sectorId === s.id).map(toCrew),
    suggested_crew_id: suggestCrew(loads, s.id)?.id ?? null,
    geometry: s.geometry,
  }));
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
      response: { 200: SessionRes, 401: ErrorRes },
      detail: {
        summary: "Iniciar sesión",
        description: `Compara la contraseña con el hash bcrypt en Postgres y devuelve un JWT válido por ${SESSION_HOURS} h.`,
      },
    },
  )
  .post(
    "/register",
    async ({ body, request, status }) => {
      const email = body.email.trim().toLowerCase();
      const result = await withDb(async (db) => {
        // Quién puede registrar: cualquiera si aún no hay usuarios (el primero) o en
        // modo pruebas; si no, solo un admin con sesión.
        const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(users);
        if (total > 0 && !authDisabled()) {
          const caller = await userFromRequest(request);
          if (!caller) return { code: 401 as const, error: "Inicia sesión como admin para registrar usuarios" };
          if (caller.role !== "admin") return { code: 403 as const, error: "Solo un admin puede registrar usuarios" };
        }

        const [dup] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
        if (dup) return { code: 409 as const, error: "Ya existe un usuario con ese correo" };

        const [user] = await db
          .insert(users)
          .values({
            email,
            name: body.name.trim(),
            role: body.role ?? "operador",
            // bcrypt (cost 10) calculado por Postgres, igual que lo compara el login
            passwordHash: sql`extensions.crypt(${body.password}, extensions.gen_salt('bf', 10))`,
          })
          .returning({ id: users.id, email: users.email, name: users.name, role: users.role });
        return { user };
      });

      if (result.code === 401) return status(401, { error: result.error });
      if (result.code === 403) return status(403, { error: result.error });
      if (result.code === 409) return status(409, { error: result.error });
      const { token, expiresAt } = await signSession(result.user);
      return status(201, { token, expires_at: expiresAt.toISOString(), user: result.user });
    },
    {
      body: t.Object({
        email: t.String({ format: "email" }),
        name: t.String({ minLength: 1, maxLength: 100 }),
        // bcrypt solo usa los primeros 72 bytes
        password: t.String({ minLength: 8, maxLength: 72 }),
        role: t.Optional(UserRole),
      }),
      response: { 201: SessionRes, 401: ErrorRes, 403: ErrorRes, 409: ErrorRes },
      detail: {
        summary: "Registrar usuario",
        description:
          "Crea un usuario del panel (rol `operador` por defecto) y devuelve su sesión, igual que el login. " +
          "Abierto si todavía no hay usuarios o en modo pruebas (AUTH_DISABLED); si no, requiere token de un `admin`.",
      },
    },
  )
  .get("/me", ({ user }) => user, {
    auth: true,
    response: SessionUser,
    detail: { summary: "Usuario de la sesión" },
  })
  .get("/crews", () => withDb(async (db) => (await crewLoads(db)).map(toCrew)), {
    auth: true,
    response: t.Array(Crew),
    detail: {
      summary: "Cuadrillas activas",
      description: "Con su zona, su carga (fugas activas asignadas) y su capacidad. Vienen agrupadas por zona.",
    },
  })
  .patch(
    "/crews/:id",
    async ({ params, body, user, status }) => {
      if (user.role !== "admin") return status(403, { error: ONLY_ADMIN });
      const result = await withDb(async (db) => {
        if (body.sector_id != null) {
          const [sector] = await db.select({ id: sectors.id }).from(sectors).where(eq(sectors.id, body.sector_id));
          if (!sector) return "sector" as const;
        }
        const updated = await db
          .update(crews)
          .set({
            ...(body.sector_id !== undefined && { sectorId: body.sector_id }),
            ...(body.max_active_leaks !== undefined && { maxActiveLeaks: body.max_active_leaks }),
          })
          .where(and(eq(crews.id, params.id), eq(crews.active, true)))
          .returning({ id: crews.id });
        if (!updated.length) return null;
        return (await crewLoads(db)).find((c) => c.id === params.id) ?? null;
      });
      if (result === "sector") return status(422, { error: "La zona no existe" });
      if (!result) return status(404, { error: "La cuadrilla no existe o está inactiva" });
      return toCrew(result);
    },
    {
      auth: true,
      params: t.Object({ id: t.Integer() }),
      body: t.Object(
        {
          sector_id: t.Optional(t.Nullable(t.Integer({ description: "null = sin zona (comodín)" }))),
          max_active_leaks: t.Optional(t.Integer({ minimum: 1, maximum: 50, description: "Capacidad" })),
        },
        { minProperties: 1 },
      ),
      response: { 200: Crew, 403: ErrorRes, 404: ErrorRes, 422: ErrorRes },
      detail: { summary: "Cambiar zona o capacidad de una cuadrilla", description: "Solo rol `admin`." },
    },
  )
  .get("/sectors", () => withDb((db) => sectorList(db)), {
    auth: true,
    response: t.Array(Sector),
    detail: {
      summary: "Zonas de servicio",
      description:
        "Zonas fijas de la ciudad (no confundir con `GET /zones`, que son grupos de fugas cercanas). " +
        "Cada una trae sus cuadrillas con su carga, la cuadrilla sugerida, su prioridad y su polígono en GeoJSON.",
    },
  })
  .patch(
    "/sectors/:id",
    async ({ params, body, user, status }) => {
      if (user.role !== "admin") return status(403, { error: ONLY_ADMIN });
      const result = await withDb(async (db) => {
        const updated = await db
          .update(sectors)
          .set({
            ...(body.color !== undefined && { color: body.color }),
            ...(body.neighborhoods !== undefined && { neighborhoods: body.neighborhoods }),
            ...(body.manager_name !== undefined && { managerName: body.manager_name }),
            ...(body.manager_phone !== undefined && { managerPhone: body.manager_phone }),
            ...(body.priority_points !== undefined && { priorityPoints: body.priority_points }),
            ...(body.priority_reason !== undefined && { priorityReason: body.priority_reason }),
          })
          .where(eq(sectors.id, params.id))
          .returning({ id: sectors.id });
        if (!updated.length) return null;
        const [sector] = await sectorList(db, params.id);
        return sector;
      });
      if (!result) return status(404, { error: "La zona no existe" });
      return result;
    },
    {
      auth: true,
      params: t.Object({ id: t.Integer() }),
      body: t.Object(
        {
          color: t.Optional(HexColor),
          neighborhoods: t.Optional(t.Array(t.String({ minLength: 1, maxLength: 80 }), { maxItems: 50 })),
          manager_name: t.Optional(t.Nullable(t.String({ maxLength: 100 }))),
          manager_phone: t.Optional(t.Nullable(t.String({ maxLength: 30 }))),
          priority_points: t.Optional(
            t.Integer({ minimum: 0, maximum: 15, description: "Se suman al índice de urgencia de sus fugas" }),
          ),
          priority_reason: t.Optional(t.Nullable(t.String({ maxLength: 200 }))),
        },
        { minProperties: 1 },
      ),
      response: { 200: Sector, 403: ErrorRes, 404: ErrorRes },
      detail: {
        summary: "Editar datos o prioridad de una zona",
        description: "Solo rol `admin`. Cambiar `priority_points` recalcula al instante la urgencia de sus fugas.",
      },
    },
  )
  .get(
    "/leaks",
    async ({ query }) => {
      const statuses = STATUS_FILTERS[query.status ?? "activas"];
      return withDb((db) =>
        adminLeaks(
          db,
          and(
            inArray(leaksRanked.status, statuses),
            query.sector_id === undefined ? undefined : eq(leaksRanked.sectorId, query.sector_id),
          ),
        ),
      );
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
        sector_id: t.Optional(t.Integer({ description: "Solo fugas de esa zona de servicio" })),
      }),
      response: t.Array(AdminLeak),
      detail: {
        summary: "Fugas ordenadas por urgencia",
        description:
          "Lista del dashboard, de mayor a menor urgencia. Cada fuga trae su zona de servicio y la cuadrilla sugerida (la de su zona con menos carga).",
      },
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

        // Carga ya actualizada: incluye esta fuga si quedó activa.
        const loads = await crewLoads(db);
        const [leak] = await adminLeaks(db, and(eq(leaksRanked.id, params.id)), loads);
        const crew = body.crew_id != null ? loads.find((c) => c.id === body.crew_id) : undefined;
        const warnings = crew
          ? assignmentWarnings(
              crew,
              [{ sectorId: leak.sector_id, sectorName: leak.sector_name }],
              suggestCrew(loads, leak.sector_id),
            )
          : [];
        return { ...leak, warnings };
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
      response: {
        200: t.Composite([
          AdminLeak,
          t.Object({
            warnings: t.Array(AssignWarning, {
              description: "Avisos de la asignación (cuadrilla de otra zona o saturada). No bloquean: vacío si todo bien.",
            }),
          }),
        ]),
        404: ErrorRes,
        422: ErrorRes,
      },
      detail: {
        summary: "Cambiar estatus, severidad o cuadrilla",
        description:
          "Al pasar a en_atencion o resuelta/descartada, la BD registra attended_at / resolved_at. `severity` corrige la severidad máxima de la fuga.\n\n" +
          "Se puede asignar cualquier cuadrilla, pero si es de otra zona o rebasa su capacidad la respuesta trae `warnings` para mostrarlos al admin.",
      },
    },
  )
  .post(
    "/zones/assign",
    async ({ body, status }) => {
      const result = await withDb(async (db) => {
        if (!(await activeCrewExists(db, body.crew_id))) return null;
        const updated = await db
          .update(leaks)
          .set({ crewId: body.crew_id })
          .where(and(inArray(leaks.id, body.leak_ids), inArray(leaks.status, [...ACTIVE_STATUSES])))
          .returning({ id: leaks.id });
        const ids = updated.map((r) => r.id);
        if (!ids.length) return { ids, warnings: [] };

        const assigned = await db
          .select({ sectorId: leaksRanked.sectorId, sectorName: sectors.name })
          .from(leaksRanked)
          .leftJoin(sectors, eq(sectors.id, leaksRanked.sectorId))
          .where(inArray(leaksRanked.id, ids));
        const loads = await crewLoads(db);
        const crew = loads.find((c) => c.id === body.crew_id);
        const suggested = suggestCrew(loads, mostCommonSector(assigned.map((a) => a.sectorId)));
        return { ids, warnings: crew ? assignmentWarnings(crew, assigned, suggested) : [] };
      });
      if (!result) return status(422, { error: "La cuadrilla no existe o está inactiva" });
      return { updated: result.ids.length, leak_ids: result.ids, warnings: result.warnings };
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
          warnings: t.Array(AssignWarning, { description: "Igual que en PATCH /admin/leaks/:id" }),
        }),
        422: ErrorRes,
      },
      detail: {
        summary: "Asignar una cuadrilla a toda una zona",
        description:
          "Recibe los `leak_ids` de un grupo de `GET /zones`. Ese grupo trae `sector_id`: la cuadrilla sugerida es `suggested_crew_id` de esa zona en `GET /admin/sectors`.",
      },
    },
  );
