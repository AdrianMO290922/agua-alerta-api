-- Zonas de servicio ("sectors"): áreas fijas de Morelia, cada una con sus
-- cuadrillas, una prioridad y datos de contacto. Cada fuga cae en la zona que
-- contiene su punto (se calcula al leer, así que editar un polígono reubica
-- todo al instante).
--
-- No confundir con zone_id de leaks_ranked / zones_ranked: esos son clusters
-- DBSCAN (posible falla en red primaria) que se recalculan en cada consulta.
--
-- Polígonos, colonias, responsables y teléfonos son DATOS DE EJEMPLO para la
-- demo: ajustarlos con PATCH /admin/sectors/:id o aquí.

-- 1. Zonas ---------------------------------------------------------------
create table sectors (
  id              serial primary key,
  name            text not null unique,
  color           text not null check (color ~ '^#[0-9a-fA-F]{6}$'),
  neighborhoods   text[] not null default '{}',
  manager_name    text,
  manager_phone   text,
  -- Puntos que se suman al índice de urgencia de las fugas de la zona.
  priority_points int  not null default 0 check (priority_points between 0 and 15),
  priority_reason text,
  -- geometry y no geography: solo se usa para "¿qué zona contiene este punto?".
  geom            extensions.geometry(MultiPolygon, 4326) not null,
  created_at      timestamptz not null default now()
);
create index sectors_geom_idx on sectors using gist (geom);

-- Centro = rectángulo alrededor del Centro Histórico (19.695–19.713 N,
-- 101.212–101.172 O). Norte y Sur = el resto de la ciudad partido en 19.704 N.
-- Si un punto cae justo en un borde compartido, gana la zona de menor id.
insert into sectors (name, color, neighborhoods, manager_name, manager_phone, priority_points, priority_reason, geom)
values (
  'Zona Norte', '#3b82f6',
  array['Industrial', 'Santiaguito', 'Tierra y Libertad', 'Eduardo Ruiz', 'Prados Verdes'],
  'Ing. Laura Méndez', '443 000 0101',
  5, 'Colonias de alta densidad de población',
  extensions.st_multi(extensions.st_difference(
    extensions.st_makeenvelope(-101.32, 19.704, -101.08, 19.80, 4326),
    extensions.st_makeenvelope(-101.212, 19.695, -101.172, 19.713, 4326)))
);
insert into sectors (name, color, neighborhoods, manager_name, manager_phone, priority_points, priority_reason, geom)
values (
  'Zona Centro', '#8b5cf6',
  array['Centro Histórico', 'Obrera', 'Molino de Parras', 'Cuauhtémoc', 'Ventura Puente'],
  'Ing. Ricardo Torres', '443 000 0102',
  10, 'Centro Histórico: más afluencia, hospitales y escuelas',
  extensions.st_multi(extensions.st_makeenvelope(-101.212, 19.695, -101.172, 19.713, 4326))
);
insert into sectors (name, color, neighborhoods, manager_name, manager_phone, priority_points, priority_reason, geom)
values (
  'Zona Sur', '#14b8a6',
  array['Chapultepec Sur', 'Félix Ireta', 'Nueva Chapultepec', 'Las Américas', 'Club Campestre'],
  'Ing. Sofía Ramírez', '443 000 0103',
  0, 'Zona residencial de menor densidad',
  extensions.st_multi(extensions.st_difference(
    extensions.st_makeenvelope(-101.32, 19.60, -101.08, 19.704, 4326),
    extensions.st_makeenvelope(-101.212, 19.695, -101.172, 19.713, 4326)))
);

-- 2. Cuadrillas: zona y capacidad ----------------------------------------
-- sector_id null = cuadrilla sin zona (comodín, nunca genera aviso de "otra zona").
alter table crews
  add column sector_id        int references sectors(id) on delete set null,
  add column max_active_leaks int not null default 5 check (max_active_leaks > 0);

update crews c
set sector_id = s.id, max_active_leaks = v.capacity
from (values (1, 'Zona Norte', 4), (2, 'Zona Centro', 5), (3, 'Zona Sur', 3)) as v(crew_id, sector, capacity)
join sectors s on s.name = v.sector
where c.id = v.crew_id;

-- 3. Vista rankeada: zona de cada fuga + prioridad en el índice ------------
-- Igual que antes, más sector_id (al final: create or replace solo deja
-- agregar columnas al final) y + priority_points de la zona en el score.
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
    sec.id as sector_id,
    coalesce(sec.priority_points, 0) as sector_points,
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
  left join lateral (
    select s.id, s.priority_points
    from sectors s
    where extensions.st_covers(s.geom, l.geom::extensions.geometry)
    order by s.id
    limit 1
  ) sec on true
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
    order by r.created_at desc limit 1) as photo_url,
  c.sector_id
from calc c
cross join lateral (
  select least(100, round(
      severity_points(c.max_severity)
    + least((c.confirmation_count - 1) * 5, 15)
    + least(c.days_open * 1.5, 15)
    + case when c.zone_size >= 3 then 10 else 0 end
    + case when c.is_recurrent     then  5 else 0 end
    + c.sector_points
  ))::int as urgency_score
) s
order by s.urgency_score desc, c.first_reported_at asc;

-- 4. Zonas DBSCAN: zona de servicio donde cae la mayoría de sus fugas -------
create or replace view zones_ranked as
select
  zone_id,
  count(*)                        as leak_count,
  sum(liters_per_day)             as liters_per_day,
  max(urgency_score)              as max_urgency,
  round(avg(lat)::numeric, 6)     as center_lat,
  round(avg(lng)::numeric, 6)     as center_lng,
  array_agg(id)                   as leak_ids,
  mode() within group (order by sector_id) as sector_id
from leaks_ranked
where zone_id is not null and zone_size >= 3
group by zone_id
order by liters_per_day desc;
