import { Elysia } from "elysia";
import { SignJWT, jwtVerify } from "jose";
import type { UserRole } from "../db";

export type SessionUser = { id: string; email: string; name: string; role: UserRole };

const ISSUER = "agua-alerta-api";
export const SESSION_HOURS = 12;

// Se lee en cada request (no al cargar el módulo): si falta, solo falla el login
// del admin y la app ciudadana sigue funcionando.
function secretKey(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("JWT_SECRET no configurado (mínimo 32 caracteres)");
  }
  return new TextEncoder().encode(secret);
}

export async function signSession(user: SessionUser): Promise<{ token: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600_000);
  const token = await new SignJWT({ email: user.email, name: user.name, role: user.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(secretKey());
  return { token, expiresAt };
}

export async function verifySession(token: string): Promise<SessionUser | null> {
  const key = secretKey(); // fuera del try: un secreto faltante es 500, no 401
  try {
    const { payload } = await jwtVerify(token, key, { issuer: ISSUER, algorithms: ["HS256"] });
    if (!payload.sub) return null;
    return {
      id: payload.sub,
      email: String(payload.email),
      name: String(payload.name),
      role: payload.role as UserRole,
    };
  } catch {
    return null; // firma inválida, expirado o mal formado
  }
}

/**
 * Macro `auth: true`: exige `Authorization: Bearer <token>` y deja `user` en el contexto.
 * También marca la ruta con el candado de bearerAuth en la documentación.
 */
export const authPlugin = new Elysia({ name: "auth" }).macro({
  auth: {
    detail: { security: [{ bearerAuth: [] }] },
    // `request.headers` y no `headers`: Elysia solo llena `headers` si detecta su
    // uso leyendo el código fuente, y con el código minificado no lo detecta.
    async resolve({ request, status }) {
      const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
      const user = token ? await verifySession(token) : null;
      if (!user) return status(401, { error: "No autenticado: inicia sesión de nuevo" });
      return { user };
    },
  },
});
