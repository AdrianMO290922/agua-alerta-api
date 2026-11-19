-- =====================================================================
-- AGUA ALERTA · Datos de demo (Morelia, Michoacán)
-- Fuente: Documentacion/agua-alerta-schema.sql, secciones 12 y 13.
--
-- Sirve para RESETEAR la demo antes del pitch: el TRUNCATE de abajo borra
-- TODAS las fugas y reportes (incluidos los creados en vivo). app_config y
-- crews no se tocan. Correr en Supabase > SQL Editor, o con:
--   psql "$DATABASE_URL_MIGRATIONS" -f supabase/seed.sql
--
-- La carga inicial del 2026-11-19 se hizo sin el TRUNCATE (tablas vacías).
-- =====================================================================

truncate table reports, leaks;

-- =====================================================================
-- 12. DATOS DE DEMO · Morelia, Michoacán
-- Referencia: Catedral de Morelia 19.70267, -101.19230
--
-- Qué demuestra cada caso:
--   A  → 3 reportes dentro de 30 m = UNA fuga con 2 confirmaciones
--   A,B,C → 3 fugas distintas dentro de 250 m = ZONA CRÍTICA (59,040 L/día)
--   D  → inundación recién reportada: gana el primer lugar por gravedad
--   E  → goteo aislado y reciente: urgencia baja
--   F  → fuga reincidente sobre un punto ya reparado
--
-- Orden esperado en el dashboard: D(60) A(55) B(48) F(38) C(37) E(12)
-- =====================================================================
do $$
declare
  a uuid; b uuid; c uuid; d uuid; e uuid; f_old uuid; f_new uuid;
  g extensions.geography;
begin

  -- helper inline: st_setsrid(st_makepoint(lng,lat),4326)::geography

  -- FUGA A · Av. Madero frente a Catedral · chorro · hace 3 días
  insert into leaks (lat, lng, geom, max_severity, report_count, confirmation_count, first_reported_at)
  values (19.70267, -101.19230,
          extensions.st_setsrid(extensions.st_makepoint(-101.19230, 19.70267), 4326)::extensions.geography,
          'chorro', 3, 3, now() - interval '3 days')
  returning id into a;

  insert into reports (leak_id, kind, lat, lng, geom, accuracy_m, location_source, severity, device_id, note, created_at) values
    (a, 'initial',      19.70267, -101.19230,
     extensions.st_setsrid(extensions.st_makepoint(-101.19230, 19.70267), 4326)::extensions.geography,
     12, 'gps', 'chorro', 'demo-device-01', 'Sale agua por la banqueta', now() - interval '3 days'),
    (a, 'confirmation', 19.70275, -101.19238,
     extensions.st_setsrid(extensions.st_makepoint(-101.19238, 19.70275), 4326)::extensions.geography,
     18, 'gps', 'goteo',  'demo-device-02', 'Sigue mojado desde ayer',   now() - interval '2 days'),
    (a, 'confirmation', 19.70259, -101.19224,
     extensions.st_setsrid(extensions.st_makepoint(-101.19224, 19.70259), 4326)::extensions.geography,
     9,  'manual','chorro','demo-device-03', 'Ya hay un charco grande',  now() - interval '18 hours');

  -- FUGA B · ~140 m al noroeste de A · chorro · hace 5 días
  insert into leaks (lat, lng, geom, max_severity, report_count, confirmation_count, first_reported_at)
  values (19.70350, -101.19330,
          extensions.st_setsrid(extensions.st_makepoint(-101.19330, 19.70350), 4326)::extensions.geography,
          'chorro', 1, 1, now() - interval '5 days')
  returning id into b;
  insert into reports (leak_id, lat, lng, geom, accuracy_m, severity, device_id, note, created_at)
  values (b, 19.70350, -101.19330,
          extensions.st_setsrid(extensions.st_makepoint(-101.19330, 19.70350), 4326)::extensions.geography,
          15, 'chorro', 'demo-device-04', 'Brota agua a media calle', now() - interval '5 days');

  -- FUGA C · ~150 m al suroeste de A · goteo · hace 8 días
  insert into leaks (lat, lng, geom, max_severity, report_count, confirmation_count, first_reported_at)
  values (19.70190, -101.19350,
          extensions.st_setsrid(extensions.st_makepoint(-101.19350, 19.70190), 4326)::extensions.geography,
          'goteo', 2, 2, now() - interval '8 days')
  returning id into c;
  insert into reports (leak_id, kind, lat, lng, geom, accuracy_m, severity, device_id, created_at) values
    (c, 'initial',      19.70190, -101.19350,
     extensions.st_setsrid(extensions.st_makepoint(-101.19350, 19.70190), 4326)::extensions.geography,
     20, 'goteo', 'demo-device-05', now() - interval '8 days'),
    (c, 'confirmation', 19.70185, -101.19344,
     extensions.st_setsrid(extensions.st_makepoint(-101.19344, 19.70185), 4326)::extensions.geography,
     25, 'goteo', 'demo-device-06', now() - interval '4 days');

  -- FUGA D · ~1.2 km al este · INUNDACIÓN recién reportada
  insert into leaks (lat, lng, geom, max_severity, report_count, confirmation_count, first_reported_at)
  values (19.69800, -101.18200,
          extensions.st_setsrid(extensions.st_makepoint(-101.18200, 19.69800), 4326)::extensions.geography,
          'inundacion', 1, 1, now() - interval '20 minutes')
  returning id into d;
  insert into reports (leak_id, lat, lng, geom, accuracy_m, severity, device_id, note, created_at)
  values (d, 19.69800, -101.18200,
          extensions.st_setsrid(extensions.st_makepoint(-101.18200, 19.69800), 4326)::extensions.geography,
          8, 'inundacion', 'demo-device-07', 'La calle está inundada, no pasan los coches', now() - interval '20 minutes');

  -- FUGA E · noroeste, aislada · goteo · ayer
  insert into leaks (lat, lng, geom, max_severity, report_count, confirmation_count, first_reported_at)
  values (19.71200, -101.20500,
          extensions.st_setsrid(extensions.st_makepoint(-101.20500, 19.71200), 4326)::extensions.geography,
          'goteo', 1, 1, now() - interval '1 day')
  returning id into e;
  insert into reports (leak_id, lat, lng, geom, accuracy_m, severity, device_id, created_at)
  values (e, 19.71200, -101.20500,
          extensions.st_setsrid(extensions.st_makepoint(-101.20500, 19.71200), 4326)::extensions.geography,
          30, 'goteo', 'demo-device-08', now() - interval '1 day');

  -- FUGA F · reincidente: ya se había reparado hace 20 días
  insert into leaks (lat, lng, geom, max_severity, report_count, confirmation_count, status, first_reported_at, attended_at, resolved_at)
  values (19.70900, -101.18800,
          extensions.st_setsrid(extensions.st_makepoint(-101.18800, 19.70900), 4326)::extensions.geography,
          'chorro', 1, 1, 'resuelta',
          now() - interval '35 days', now() - interval '25 days', now() - interval '20 days')
  returning id into f_old;
  insert into reports (leak_id, lat, lng, geom, accuracy_m, severity, device_id, created_at)
  values (f_old, 19.70900, -101.18800,
          extensions.st_setsrid(extensions.st_makepoint(-101.18800, 19.70900), 4326)::extensions.geography,
          14, 'chorro', 'demo-device-09', now() - interval '35 days');

  insert into leaks (lat, lng, geom, max_severity, report_count, confirmation_count, is_recurrent, first_reported_at)
  values (19.70905, -101.18805,
          extensions.st_setsrid(extensions.st_makepoint(-101.18805, 19.70905), 4326)::extensions.geography,
          'chorro', 1, 1, true, now() - interval '2 days')
  returning id into f_new;
  insert into reports (leak_id, lat, lng, geom, accuracy_m, severity, device_id, note, created_at)
  values (f_new, 19.70905, -101.18805,
          extensions.st_setsrid(extensions.st_makepoint(-101.18805, 19.70905), 4326)::extensions.geography,
          11, 'chorro', 'demo-device-10', 'Otra vez abierta, la repararon el mes pasado', now() - interval '2 days');

end $$;

-- =====================================================================
-- 13. VERIFICACIÓN (correr después del seed)
-- =====================================================================
-- Debe devolver 6 filas pendientes, ordenadas: inundacion 60, chorro 55, ...
--   select max_severity, confirmation_count, zone_size, urgency_score, urgency_level,
--          liters_wasted
--   from leaks_ranked where status = 'pendiente';
--
-- Debe devolver UNA zona con 3 fugas y ~59,040 L/día:
--   select * from zones_ranked;
--
-- El pre-check desde la Catedral debe encontrar la fuga A a ~0 m:
--   select * from find_nearby_leaks(19.70267, -101.19230, 110);
-- =====================================================================
