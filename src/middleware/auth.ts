import jwt, { type JwtPayload } from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";

export interface AdminAuth {
  id: number;
  email: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      admin?: AdminAuth;
    }
  }
}

const BEARER_PREFIX = "Bearer ";

/**
 * Middleware que valida `Authorization: Bearer <jwt>`.
 *
 * Comportamiento:
 *  - Falta header o no empieza con `Bearer ` → 401 Token requerido.
 *  - Token mal firmado o expirado → 401 Token inválido o expirado.
 *  - OK → inyecta `req.admin = { id, email }` y llama a next().
 *
 * Aplicar a todas las rutas /admin/* salvo /admin/login.
 */
export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    // Fallo de configuración: el server arrancó sin secret. 500, no 401,
    // porque no es un problema del cliente.
    console.error("[auth] JWT_SECRET no está definido");
    res.status(500).json({ error: "InternalServerError", message: "Auth no configurada" });
    return;
  }

  const header = req.header("authorization");
  if (!header || !header.startsWith(BEARER_PREFIX)) {
    res.status(401).json({ error: "Unauthorized", message: "Token requerido" });
    return;
  }

  const token = header.slice(BEARER_PREFIX.length).trim();
  if (!token) {
    res.status(401).json({ error: "Unauthorized", message: "Token requerido" });
    return;
  }

  try {
    const payload = jwt.verify(token, secret) as JwtPayload & {
      sub: number | string;
      email: string;
    };

    const sub = typeof payload.sub === "string" ? Number(payload.sub) : payload.sub;
    if (typeof sub !== "number" || !Number.isInteger(sub) || sub <= 0) {
      res
        .status(401)
        .json({ error: "Unauthorized", message: "Token inválido o expirado" });
      return;
    }

    req.admin = { id: sub, email: payload.email };
    next();
  } catch {
    // jwt.verify lanza TokenExpiredError, JsonWebTokenError, NotBeforeError.
    // Al cliente le da igual el detalle: token inválido o expirado.
    res
      .status(401)
      .json({ error: "Unauthorized", message: "Token inválido o expirado" });
  }
}
