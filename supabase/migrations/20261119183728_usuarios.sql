-- Agua Alerta · Usuarios del panel administrativo
--
-- La app ciudadana no tiene login. Esta tabla respalda el login de la app admin
-- y deja lugar para crecer (más usuarios, roles, auditoría).
--
-- Las contraseñas se hashean con bcrypt en Postgres (pgcrypto, ya instalado en
-- el esquema `extensions`), no en el Worker: bcrypt en JS excede el límite de
-- CPU de Workers. Crear usuarios con `bun run usuario:crear`.

-- admin    → todo, incluida la futura gestión de usuarios
-- operador → opera el dashboard (estatus, severidad, cuadrillas)
create type user_role as enum ('admin', 'operador');

create table users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null,
  name          text not null,
  password_hash text not null,               -- bcrypt: extensions.crypt(pw, extensions.gen_salt('bf', 10))
  role          user_role not null default 'operador',
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  last_login_at timestamptz,
  constraint users_email_key   unique (email),
  constraint users_email_lower check (email = lower(email))
);
