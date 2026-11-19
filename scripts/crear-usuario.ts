// Crea un usuario del panel admin.
//   bun run usuario:crear <email> "<nombre>" [admin|operador]
// Pide la contraseña; si la dejas vacía genera una y la muestra una sola vez.
// Usa DATABASE_URL de .env (Bun lo carga solo).
import { sql } from "drizzle-orm";
import { users, withDb, type UserRole } from "../src/db";

const ROLES: UserRole[] = ["admin", "operador"];
const [rawEmail, name, role = "operador"] = process.argv.slice(2);
const email = rawEmail?.trim().toLowerCase();

if (!email?.includes("@") || !name?.trim() || !ROLES.includes(role as UserRole)) {
  console.error('Uso: bun run usuario:crear <email> "<nombre>" [admin|operador]');
  process.exit(1);
}

const typed = prompt("Contraseña (Enter para generar una):")?.trim() ?? "";
const password = typed || Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64url");
if (password.length < 10) {
  console.error("La contraseña debe tener al menos 10 caracteres.");
  process.exit(1);
}

try {
  const [user] = await withDb((db) =>
    db
      .insert(users)
      .values({
        email,
        name: name.trim(),
        role: role as UserRole,
        // bcrypt (cost 10) calculado por Postgres, igual que la verificación del login
        passwordHash: sql`extensions.crypt(${password}, extensions.gen_salt('bf', 10))`,
      })
      .returning({ id: users.id, email: users.email, role: users.role }),
  );
  console.log(`✓ Usuario creado: ${user.email} (${user.role}) · ${user.id}`);
  if (!typed) console.log(`  Contraseña generada (no se vuelve a mostrar): ${password}`);
} catch (e: any) {
  const cause = e?.cause ?? e;
  if (cause?.code === "23505") console.error(`Ya existe un usuario con el correo ${email}.`);
  else console.error("No se pudo crear el usuario:", cause?.message ?? e);
  process.exit(1);
}
