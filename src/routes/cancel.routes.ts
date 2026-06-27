import { Router, type Request, type Response } from "express";
import { prisma } from "../db";

export const cancelRouter = Router();

// ────────────────────────────────────────────────────────────────────────
// GET /cancel/:token  (PÚBLICO, sin auth)
//
// Cancela una reserva a partir de un token opaco (cuid) que vino en el
// email de confirmación. Borra el booking y libera el slot (status=OPEN).
// Validaciones:
//   404 si el token no existe (o el booking ya fue borrado)
//   410 si el slot es de un día anterior a hoy (Europe/Madrid)
//   410 si el slot es de hoy (falta menos de 24hs)
//   200 si todo OK
// ────────────────────────────────────────────────────────────────────────

/** Devuelve "YYYY-MM-DD" del día actual en Europe/Madrid. */
function todayInMadrid(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value ?? "0000";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}

function badRequest(res: Response, status: number, error: string, message: string): void {
  res.status(status).json({ error, message });
}

cancelRouter.get("/:token", async (req: Request, res: Response) => {
  const token = typeof req.params.token === "string" ? req.params.token.trim() : "";
  if (!token) {
    return badRequest(res, 400, "BadRequest", "Token requerido");
  }

  // Buscamos el booking por token. Si no existe (o ya fue borrado), 404.
  // Como borramos el booking al cancelar, un reuso del mismo link da 404
  // (consistente: el token se "gastó" con la fila).
  const booking = await prisma.booking.findUnique({
    where: { cancellationToken: token },
    include: { slot: true },
  });

  if (!booking) {
    return badRequest(res, 404, "NotFound", "Token inválido o reserva no encontrada");
  }

  // Defensa: si por alguna razón el slot ya no está linkeado (no debería
  // pasar con esta lógica, pero el schema lo permite), 409.
  if (!booking.slot || booking.slotId == null) {
    return badRequest(res, 409, "Conflict", "Esta reserva ya fue cancelada anteriormente");
  }

  // Comparación por día (la columna `date` es @db.Date). Strings
  // "YYYY-MM-DD" comparan lexicográficamente igual que como fechas.
  const dateKey = booking.slot.date.toISOString().slice(0, 10);
  const today = todayInMadrid();

  if (dateKey < today) {
    return badRequest(res, 410, "Gone", "No se puede cancelar un turno pasado");
  }
  if (dateKey === today) {
    return badRequest(
      res,
      410,
      "Gone",
      "Falta menos de 24 horas para el turno. Contactanos por WhatsApp para cancelarlo."
    );
  }

  // Cancelar = borrar el booking + volver el slot a OPEN. Transacción para
  // que las dos cosas pasen o ninguna.
  try {
    await prisma.$transaction(async (tx) => {
      await tx.booking.delete({ where: { id: booking.id } });
      await tx.availabilitySlot.update({
        where: { id: booking.slotId! },
        data: { status: "OPEN" },
      });
    });
  } catch (err) {
    console.error("[GET /cancel/:token] error inesperado:", err);
    return res
      .status(500)
      .json({ error: "InternalServerError", message: "Error inesperado" });
  }

  return res.status(200).json({ message: "Reserva cancelada correctamente" });
});
