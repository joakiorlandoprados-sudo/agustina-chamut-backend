import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import type { PrismaClient } from "@prisma/client";

export class AuthError extends Error {
  constructor(message: string = "Credenciales inválidas") {
    super(message);
    this.name = "AuthError";
  }
}

export interface LoginResult {
  token: string;
  expiresIn: number; // segundos
  admin: { id: number; email: string };
}

const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 días

/**
 * Valida credenciales de admin y emite un JWT firmado con HS256.
 *
 * Mensaje de error genérico: si el email no existe O la password es incorrecta,
 * devolvemos el mismo AuthError. Esto evita enumeración de cuentas.
 */
export async function loginAdmin(
  prisma: PrismaClient,
  email: string,
  password: string
): Promise<LoginResult> {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET no está definido en .env");
  }

  const user = await prisma.adminUser.findUnique({ where: { email } });

  // Hacemos bcrypt.compare igual cuando no hay user, contra un hash dummy,
  // para no regalar timing information sobre la existencia de la cuenta.
  const hashToCompare = user?.passwordHash ?? "$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva";
  const ok = await bcrypt.compare(password, hashToCompare);

  if (!user || !ok) {
    throw new AuthError();
  }

  const token = jwt.sign(
    { sub: user.id, email: user.email },
    secret,
    { expiresIn: TOKEN_TTL_SECONDS }
  );

  return {
    token,
    expiresIn: TOKEN_TTL_SECONDS,
    admin: { id: user.id, email: user.email },
  };
}
