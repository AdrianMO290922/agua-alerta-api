# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Qué es este proyecto

**Agua Alerta** ("gotaUrgente"): MVP de hackathon (8 horas) para reportar fugas de agua en México. La consigna completa y la rúbrica están en [Documentacion/contexto.md](Documentacion/contexto.md). **Las decisiones de diseño (reglas de duplicados, scoring, API, auth, flujo) están en [Documentacion/decisiones-tecnicas.md](Documentacion/decisiones-tecnicas.md) y mandan sobre el código.** `Documentacion/` está en `.gitignore` (solo existe en local). Requisitos mínimos del MVP:

1. **Captura de reporte**: ubicación en mapa, nivel de desperdicio (`goteo`, `chorro`, `inundación`) y fotografía.
2. **Agrupación automática**: la prioridad sube cuando varios reportes caen dentro de un mismo radio de distancia (evita duplicados y calcula un índice de urgencia).
3. **Dashboard administrativo**: ordenado de mayor a menor urgencia, con cambio de estatus `Pendiente` → `En atención`.

Solo puntúa lo que se demuestra en vivo (Prototipo funcional 45 pts, Impacto 25, UX 15, Pitch 15). Prioriza que el flujo completo reporte → agrupación → dashboard funcione de punta a punta antes que el pulido. Se permiten datos simulados y APIs públicas.

## Estructura

`agua-alerta-api/` es el backend en **Bun + Elysia** (TypeScript) desplegado en **Cloudflare Workers** (`CloudflareAdapter`, `.compile()` obligatorio, sin `.listen()` ni sistema de archivos). Es el único repo git: la raíz `gotaUrgente/` no está versionada.

- `src/index.ts`: arma la app: CORS, OpenAPI/Scalar en `/docs` (spec en `/docs/json`), `onError`, `GET /`, `GET /health`.
- `src/routes/public.ts`: app ciudadana, sin login. `src/routes/admin.ts`: app admin (`/admin/*`), JWT.
- `src/services/reports.ts`: `createReport()`, la regla de agrupación de `POST /reports` (transacción + advisory lock global).
- `src/lib/`: `config.ts` (lee `app_config`, `radiiFor()`), `auth.ts` (JWT HS256 con `jose` + macro `auth: true`), `storage.ts` (fotos a R2), `schemas.ts` (esquemas TypeBox de entrada/salida y mapeo fila → JSON).
- `src/db/schema.ts`: espejo Drizzle de tablas, enums y vistas. `src/db/index.ts`: `withDb()` (una conexión por request, porque en Workers no se comparten), `findNearbyLeaks()` y re-exporta el esquema.
- `scripts/crear-usuario.ts` (`bun run usuario:crear <email> "<nombre>" [admin|operador]`): alta de usuarios del panel; corre en Bun, no en el Worker.
- `supabase/migrations/`: SQL aplicado en Supabase vía MCP (`apply_migration`). **Es la fuente de verdad del esquema; no se usa drizzle-kit.** Si cambias el SQL, actualiza `src/db/schema.ts`.
- `supabase/seed.sql`: datos de demo en Morelia. Empieza con `TRUNCATE reports, leaks`: resetea la demo, no lo corras sobre datos que quieras conservar.
- Fotos en **Cloudflare R2** (binding `FOTOS` en `wrangler.jsonc`), no en Supabase Storage.

No hay frontend todavía (será Nuxt; ver §3 de decisiones-tecnicas).

## Base de datos (Supabase Postgres 17 + PostGIS 3.3)

- Tablas: `app_config` (radios y parámetros ajustables en vivo), `crews` (3 sembradas), `leaks` (fuga agrupada), `reports` (cada envío ciudadano; una confirmación también es un reporte con `kind = 'confirmation'`), `users` (login del panel; roles `admin`/`operador`).
- `users.password_hash` es bcrypt calculado **en Postgres** con pgcrypto (`extensions.crypt(pw, extensions.gen_salt('bf', 10))`), no en el Worker: bcrypt en JS excede el límite de CPU de Workers. El login compara con `password_hash = extensions.crypt(pw, password_hash)`.
- Vistas: `leaks_ranked` (urgencia 0–100, nivel, litros, `zone_id`; incluye fugas resueltas, filtra por `status`) y `zones_ranked` (clusters DBSCAN de ≥3 fugas en 250 m, EPSG 6372). `zone_id` cambia en cada consulta: no es un id estable.
- `find_nearby_leaks(lat, lng, radio)`: búsqueda espacial para el pre-check y para agrupar. Excluye `descartada` pero incluye `resuelta` (para detectar reincidencia).
- Trigger `trg_leak_status`: llena `attended_at`/`resolved_at` al cambiar `status`.
- `reports_one_per_device unique (leak_id, device_id)`: un error `23505` con ese `constraint_name` significa "ya confirmaste esta fuga" → 409.
- Columnas `geom` (`geography(Point, 4326)`): escribirlas siempre con `geoPoint(lat, lng)` de `src/db/schema.ts`. `st_makepoint` recibe `(lng, lat)`.
- `leaks.max_severity` se puede subir con `greatest(max_severity, 'chorro'::severity_level)`: el enum está ordenado goteo < chorro < inundacion.
- Conexión: en el Worker, por **Hyperdrive** (binding `HYPERDRIVE`, origen = session pooler 5432, `sslmode=require`, caché de consultas desactivada para que el dashboard vea los reportes al instante). En Bun (scripts), por `DATABASE_URL` (transaction pooler 6543) con `ssl: "require"`. No se puede conectar directo desde Workers con TLS: el pooler usa un certificado de la CA privada de Supabase y Workers solo acepta CAs públicas. `withDb()` elige la vía según el runtime.
- Sin RLS a propósito: Elysia es la frontera de seguridad y se conecta como `postgres` (`prepare: false`). Los privilegios por defecto del proyecto no dan acceso a `anon`/`authenticated` sobre `public`, así que la Data API de Supabase no expone nada. El advisory lock debe ser `pg_advisory_xact_lock` (de transacción): los de sesión no funcionan con el pooler.

## API

Documentación interactiva en `/docs` (Scalar, versión fija). Convenciones: JSON en snake_case, fechas ISO 8601, errores como `{ "error": "mensaje" }`; los errores de validación son 422 con el formato propio de Elysia.

- Ciudadano: `GET /leaks?bbox=`, `GET /leaks/nearby`, `POST /uploads` (multipart; el Worker guarda en R2 y devuelve `photo_key`, porque el binding de R2 no puede firmar URLs), `POST /reports`, `GET /zones`.
- Admin: `POST /admin/register` y `POST /admin/login` → `{ token, expires_at, user }` (JWT de 12 h, `Authorization: Bearer`), `GET /admin/me`, `GET /admin/crews`, `GET /admin/leaks?status=`, `PATCH /admin/leaks/:id`, `POST /admin/zones/assign`.
- Registro: abierto si la tabla `users` está vacía (primer usuario) o en modo pruebas; si no, exige token de un `admin` (401 sin token, 403 si es `operador`). Rol `operador` por defecto.
- Rutas protegidas: agregar `auth: true` a la ruta (macro de `src/lib/auth.ts`); deja `user` en el contexto y pone el candado en la documentación. El rol viaja en el JWT para cuando haya rutas solo de `admin`.
- **Modo pruebas** (`AUTH_DISABLED: "true"` en `vars` de `wrangler.jsonc`, activo ahora para que el front pruebe todo): las rutas con `auth: true` dejan pasar sin token con un usuario ficticio admin ("Modo pruebas (sin login)"); si llega un token válido se usa ese usuario. `GET /` y `/docs` lo avisan. **Ponerlo en `"false"` antes de la demo.** Para probar el modo con auth en local: `wrangler dev --var AUTH_DISABLED:false`.
- **Enums en esquemas: usar `oneOf()` de `src/lib/schemas.ts`, nunca `t.UnionEnum` directo.** El de Elysia trae `default: values[0]` y rellena los campos opcionales ausentes: un `PATCH` de solo `crew_id` llegaba con `status: "pendiente"`.
- Consultas con `db.execute()` (SQL directo): el driver devuelve fechas como texto, no `Date`. Formatearlas en SQL (ver `findNearbyLeaks`).
- Sin rate limit todavía (decisiones-tecnicas §6 pide 10 reportes/hora por IP).

## Despliegue

- Producción: https://agua-alerta-api.adrian9012.workers.dev (docs en `/docs`).
- **No desplegar con `--minify`.** Elysia decide qué partes del request procesar (p. ej. `headers`) leyendo el código fuente de cada handler; minificado no lo detecta y las rutas protegidas daban 500. Producción debe correr el mismo código que `wrangler dev`.
- CORS abierto a cualquier origen (sin `CORS_ORIGIN` en `wrangler.jsonc`) y modo pruebas de auth activo, por decisión del equipo durante el hackathon.
- El front ya usa la API de producción, que comparte la base con `wrangler dev`: no asumir que los datos de demo siguen como los dejó `seed.sql`.
- Secretos del Worker: solo `JWT_SECRET`. `DATABASE_URL` no hace falta allí (la conexión va por Hyperdrive).

## Comandos

Todos se corren desde `agua-alerta-api/`:

```bash
bun install          # instalar dependencias
bun run dev          # wrangler dev (Worker local, lee .env) en http://localhost:8787
bun run deploy       # wrangler deploy (producción, Cloudflare Workers; sin --minify)
bunx tsc --noEmit    # verificación de tipos (tsconfig en modo strict)
bun run usuario:crear <email> "<nombre>" [admin|operador]   # alta de usuario del panel
```

No hay tests: el script `test` de `package.json` es un placeholder que sale con error. Si se agregan, usar el runner de Bun (`bun test`, o `bun test ruta/archivo.test.ts` para uno solo).

## Detalles a tener en cuenta

- `tsconfig.json` usa `"types": ["bun-types"]`, `module: ES2022`, `moduleResolution: bundler` y `strict: true`.
- Variables: en Workers llegan por `process.env` (flag `nodejs_compat`), también a nivel de módulo. No secretas en `vars` de `wrangler.jsonc`; secretas (`JWT_SECRET`) con `wrangler secret put`. En local, wrangler lee `.env`, incluida `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` para emular Hyperdrive. `CORS_ORIGIN` (opcional) acepta varios orígenes separados por coma.
- Los bindings (R2 `FOTOS`, `HYPERDRIVE`) **no** están en `process.env`: se importan con `import { env } from "cloudflare:workers"`. Sus tipos mínimos están en `src/types/cloudflare.d.ts` (no se usa `@cloudflare/workers-types` porque choca con `bun-types`).
- En `wrangler dev` las fotos van al R2 local simulado, así que su `photo_url` pública no existe. Para usar el bucket real en dev, agregar `"remote": true` al binding.
- El campo `"module": "src/index.js"` de `package.json` y el `.gitignore` (plantilla de Next.js) son restos del scaffold; el punto de entrada real es `src/index.ts`.
- `elysia` está fijado a `latest`.
