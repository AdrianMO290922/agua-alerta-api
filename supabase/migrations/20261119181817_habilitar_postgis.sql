-- Agua Alerta · PostGIS
-- Aplicada en Supabase vía MCP (apply_migration) el 2026-11-19.
-- Fuente: Documentacion/agua-alerta-schema.sql, sección 1.

-- 1. Extensiones ------------------------------------------------------
create extension if not exists postgis with schema extensions;
