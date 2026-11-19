-- Agua Alerta · Esquema MVP v2 (tipos, tablas, scoring, búsqueda espacial, vistas)
-- Aplicada en Supabase vía MCP (apply_migration) el 2026-11-19.
-- Fuente: Documentacion/agua-alerta-schema.sql, secciones 2–11, sin cambios.
--
-- Sin RLS a propósito: la frontera de seguridad es Elysia. En este proyecto los
-- privilegios por defecto de public no dan SELECT/INSERT/UPDATE/DELETE a anon ni
-- authenticated, así que la Data API de Supabase no expone estas tablas ni vistas.
-- EPSG 6372 existe en esta instancia (verificado), por eso la vista lo usa tal cual.

-- 2. Tipos ------------------------------------------------------------
create type severity_level as enum ('goteo', 'chorro', 'inundacion');
create type leak_status    as enum ('pendiente', 'en_atencion', 'resuelta', 'descartada');
create type report_kind    as enum ('initial', 'confirmation');
create type location_src   as enum ('gps', 'manual');

-- 3. Configuración (ajustable en vivo durante la demo) -----------------
create table app_config (
  key   text primary key,
  value numeric not null
);
insert into app_config (key, value) values
  ('inner_base_m',        30),   -- radio de agrupamiento automático
  ('accuracy_factor',     0.5),  -- inner = inner_base + min(accuracy,70)*factor
  ('accuracy_cap_m',      70),
  ('band_m',              80),   -- banda ambigua: se pregunta al usuario
  ('force_pin_accuracy_m', 150), -- arriba de esto se obliga a arrastrar el pin
  ('zone_eps_m',          250),  -- informativo: el valor real va en la vista
  ('zone_min_leaks',      3),    -- informativo: idem
  ('rate_limit_per_hour', 10);

-- 4. Cuadrillas -------------------------------------------------------
create table crews (
  id         serial primary key,
  name       text not null,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
insert into crews (name) values
  ('Cuadrilla 1 · Norte'),
  ('Cuadrilla 2 · Centro'),
  ('Cuadrilla 3 · Sur');

-- 5. Fugas (incidente agrupado: lo que ve la cuadrilla) ----------------
create table leaks (
  id                 uuid primary key default gen_random_uuid(),
  lat                double precision not null,
  lng                double precision not null,
  geom               extensions.geography(Point, 4326) not null,
  max_severity       severity_level not null,
  report_count       int not null default 1,
  confirmation_count int not null default 1,  -- dispositivos distintos
  status             leak_status not null default 'pendiente',
  is_recurrent       boolean not null default false,
  crew_id            int references crews(id),
  first_reported_at  timestamptz not null default now(),
  attended_at        timestamptz,
  resolved_at        timestamptz
);
create index leaks_geom_idx   on leaks using gist (geom);
create index leaks_status_idx on leaks (status);

-- 6. Reportes (lo que manda cada ciudadano) ----------------------------
create table reports (
  id              uuid primary key default gen_random_uuid(),
  leak_id         uuid not null references leaks(id) on delete cascade,
  kind            report_kind not null default 'initial',
  lat             double precision not null,
  lng             double precision not null,
  geom            extensions.geography(Point, 4326) not null,
  accuracy_m      double precision,
  location_source location_src not null default 'gps',
  severity        severity_level not null,
  photo_url       text,
  note            text check (char_length(note) <= 280),
  device_id       text not null,
  created_at      timestamptz not null default now(),
  -- Rango aproximado de México: filtra basura y spam básico
  constraint reports_mx_bounds check (lat between 14 and 33 and lng between -119 and -86),
  -- Un dispositivo cuenta una sola vez por fuga (el reporte inicial ya ocupa su lugar)
  constraint reports_one_per_device unique (leak_id, device_id)
);
create index reports_leak_idx on reports (leak_id);
create index reports_geom_idx on reports using gist (geom);

-- 7. Pesos del scoring ------------------------------------------------
-- Severidad: comprimida a propósito respecto a los litros, para que una
-- fuga chica no quede olvidada para siempre.
create or replace function severity_points(s severity_level)
returns int language sql immutable as $$
  select case s when 'goteo' then 10 when 'chorro' then 30 when 'inundacion' then 60 end
$$;

-- Litros por minuto, estimación conservadora.
create or replace function severity_lpm(s severity_level)
returns numeric language sql immutable as $$
  select case s when 'goteo' then 1 when 'chorro' then 20 when 'inundacion' then 150 end
$$;

-- 8. Sellos de tiempo al cambiar de estatus ----------------------------
create or replace function handle_leak_status()
returns trigger language plpgsql as $$
begin
  if new.status is distinct from old.status then
    if new.status = 'en_atencion' and new.attended_at is null then
      new.attended_at := now();
    end if;
    if new.status in ('resuelta', 'descartada') and new.resolved_at is null then
      new.resolved_at := now();
    end if;
  end if;
  return new;
end $$;

create trigger trg_leak_status
  before update on leaks
  for each row execute function handle_leak_status();

-- 9. Búsqueda espacial ------------------------------------------------
-- La usan el pre-check (GET /leaks/nearby) y el insert (POST /reports).
-- Elysia pasa el radio externo y clasifica el resultado en interno/banda
-- según la precisión del GPS.
create or replace function find_nearby_leaks(
  p_lat    double precision,
  p_lng    double precision,
  p_radius numeric
)
returns table (
  id            uuid,
  distance_m    double precision,
  status        leak_status,
  max_severity  severity_level,
  report_count  int,
  photo_url     text,
  resolved_at   timestamptz
)
language sql stable as $$
  with p as (
    select extensions.st_setsrid(
             extensions.st_makepoint(p_lng, p_lat), 4326
           )::extensions.geography as g
  )
  select
    l.id,
    extensions.st_distance(l.geom, p.g) as distance_m,
    l.status,
    l.max_severity,
    l.report_count,
    (select r.photo_url from reports r
      where r.leak_id = l.id and r.photo_url is not null
      order by r.created_at desc limit 1),
    l.resolved_at
  from leaks l, p
  where l.status <> 'descartada'
    and extensions.st_dwithin(l.geom, p.g, p_radius)
  order by distance_m
$$;

-- 10. Vista rankeada (la consume el dashboard) -------------------------
-- eps y minpoints van hardcodeados: PostGIS los quiere constantes, no
-- acepta leerlos de app_config por fila.
-- Si EPSG 6372 no existe en esta instancia, cambiar a 3857 con eps := 265
-- (a la latitud de Morelia, 3857 infla las distancias ~6%).
create or replace view leaks_ranked as
with zoned as (
  select
    id,
    extensions.st_clusterdbscan(
      extensions.st_transform(geom::extensions.geometry, 6372),
      eps := 250, minpoints := 3
    ) over () as zone_id
  from leaks
  where status in ('pendiente', 'en_atencion')
),
zone_sizes as (
  select zone_id, count(*) as zone_size
  from zoned
  where zone_id is not null
  group by zone_id
),
calc as (
  select
    l.*,
    z.zone_id,
    coalesce(zs.zone_size, 0) as zone_size,
    case
      when l.status in ('pendiente', 'en_atencion')
      then extract(epoch from (now() - l.first_reported_at)) / 86400.0
      else 0
    end as days_open,
    extract(epoch from (coalesce(l.resolved_at, now()) - l.first_reported_at)) / 60.0
      as minutes_open
  from leaks l
  left join zoned      z  on z.id = l.id
  left join zone_sizes zs on zs.zone_id = z.zone_id
)
select
  c.id, c.lat, c.lng, c.status, c.max_severity,
  c.report_count, c.confirmation_count, c.is_recurrent,
  c.crew_id, c.first_reported_at, c.attended_at, c.resolved_at,
  c.zone_id, c.zone_size,
  round(c.minutes_open * severity_lpm(c.max_severity))::bigint as liters_wasted,
  round(severity_lpm(c.max_severity) * 1440)::bigint           as liters_per_day,
  s.urgency_score,
  case
    when s.urgency_score >= 60 then 'critica'
    when s.urgency_score >= 40 then 'alta'
    when s.urgency_score >= 20 then 'media'
    else 'baja'
  end as urgency_level,
  (select r.photo_url from reports r
    where r.leak_id = c.id and r.photo_url is not null
    order by r.created_at desc limit 1) as photo_url
from calc c
cross join lateral (
  select least(100, round(
      severity_points(c.max_severity)
    + least((c.confirmation_count - 1) * 5, 15)
    + least(c.days_open * 1.5, 15)
    + case when c.zone_size >= 3 then 10 else 0 end
    + case when c.is_recurrent     then  5 else 0 end
  ))::int as urgency_score
) s
order by s.urgency_score desc, c.first_reported_at asc;

-- 11. Vista de zonas (posible falla en red primaria) -------------------
-- OJO: zone_id es un entero que DBSCAN reasigna en cada ejecución. No lo
-- uses como identificador estable: el endpoint de asignación debe recibir
-- la lista de leak_ids en el body, no un id de zona.
create or replace view zones_ranked as
select
  zone_id,
  count(*)                        as leak_count,
  sum(liters_per_day)             as liters_per_day,
  max(urgency_score)              as max_urgency,
  round(avg(lat)::numeric, 6)     as center_lat,
  round(avg(lng)::numeric, 6)     as center_lng,
  array_agg(id)                   as leak_ids
from leaks_ranked
where zone_id is not null and zone_size >= 3
group by zone_id
order by liters_per_day desc;
