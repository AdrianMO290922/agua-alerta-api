# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Qué es este proyecto

**Agua Alerta** ("gotaUrgente"): MVP de hackathon (8 horas) para reportar fugas de agua en México. La consigna completa y la rúbrica están en [contexto.md](contexto.md). Requisitos mínimos del MVP:

1. **Captura de reporte**: ubicación en mapa, nivel de desperdicio (`goteo`, `chorro`, `inundación`) y fotografía.
2. **Agrupación automática**: la prioridad sube cuando varios reportes caen dentro de un mismo radio de distancia (evita duplicados y calcula un índice de urgencia).
3. **Dashboard administrativo**: ordenado de mayor a menor urgencia, con cambio de estatus `Pendiente` → `En atención`.

Solo puntúa lo que se demuestra en vivo (Prototipo funcional 45 pts, Impacto 25, UX 15, Pitch 15). Prioriza que el flujo completo reporte → agrupación → dashboard funcione de punta a punta antes que el pulido. Se permiten datos simulados y APIs públicas.

## Estructura

- `contexto.md`: enunciado del reto (texto OCR de un PDF).
- `agua-alerta-api/`: backend en **Bun + Elysia** (TypeScript). Es el único repo git: la raíz `gotaUrgente/` no está versionada, así que los comandos `git` se corren dentro de `agua-alerta-api/`.

Estado actual: scaffold recién creado con `bun create elysia`. `src/index.ts` solo expone `GET /` en el puerto 3000. Ya están instaladas pero **sin configurar**:

- `@elysiajs/cors`, `@elysiajs/static`, `@elysiajs/swagger` (plugins de Elysia, se registran con `.use(...)`).
- `drizzle-orm` + `drizzle-kit`: no existe aún esquema, `drizzle.config.ts` ni base de datos, y no hay driver de BD instalado (`bun:sqlite`, integrado en Bun, funciona con `drizzle-orm/bun-sqlite` sin paquetes extra).

No hay frontend todavía.

## Comandos

Todos se corren desde `agua-alerta-api/`:

```bash
bun install          # instalar dependencias
bun run dev          # wrangler dev (Worker local, lee .env) en http://localhost:8787
bun run deploy       # wrangler deploy --minify (producción, Cloudflare Workers)
bunx tsc --noEmit    # verificación de tipos (tsconfig en modo strict)
```

No hay tests: el script `test` de `package.json` es un placeholder que sale con error. Si se agregan, usar el runner de Bun (`bun test`, o `bun test ruta/archivo.test.ts` para uno solo).

## Detalles a tener en cuenta

- `tsconfig.json` usa `"types": ["bun-types"]`, `module: ES2022`, `moduleResolution: node` y `strict: true`.
- El campo `"module": "src/index.js"` de `package.json` y el `.gitignore` (plantilla de Next.js) son restos del scaffold; el punto de entrada real es `src/index.ts`.
- `elysia` está fijado a `latest`.
