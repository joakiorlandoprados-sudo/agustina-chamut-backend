import { Router, type Request, type Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { loginAdmin, AuthError } from "../services/admin.service";
import { requireAdmin } from "../middleware/auth";
import {
  findOverlap,
  planGeneration,
  timeToMinutes,
} from "../services/slots.service";

export const adminRouter = Router();

// ──────────────────────────────────────────────────────────────────────────
// Helpers de validación
// ──────────────────────────────────────────────────────────────────────────

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: "BadRequest", message });
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// ──────────────────────────────────────────────────────────────────────────
// POST /admin/login  (PÚBLICO)
// ──────────────────────────────────────────────────────────────────────────

interface LoginBody {
  email?: unknown;
  password?: unknown;
}

adminRouter.post("/login", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as LoginBody;
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!email) return badRequest(res, "email requerido");
  if (!password) return badRequest(res, "password requerido");

  try {
    const result = await loginAdmin(prisma, email, password);
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof AuthError) {
      return res
        .status(401)
        .json({ error: "Unauthorized", message: err.message });
    }
    console.error("[POST /admin/login] error inesperado:", err);
    return res
      .status(500)
      .json({ error: "InternalServerError", message: "Error inesperado" });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// GET /admin/slots  (protegido)
// ──────────────────────────────────────────────────────────────────────────

adminRouter.get("/slots", requireAdmin, async (_req: Request, res: Response) => {
  const slots = await prisma.availabilitySlot.findMany({
    orderBy: [{ date: "asc" }, { startTime: "asc" }],
    include: { booking: true },
  });
  res.json({ slots });
});

// ──────────────────────────────────────────────────────────────────────────
// POST /admin/slots/generate  (protegido)
//
// IMPORTANTE: declarado ANTES que POST /admin/slots/:id-equivalente para que
// Express no confunda "generate" con un :id. Aquí ":id" no aplica pero por las
// dudas la ruta "/generate" no entra en colisión porque POST /admin/slots
// recibe body, no path param. Aún así la pongo antes por claridad.
// ──────────────────────────────────────────────────────────────────────────

interface GenerateBody {
  date?: unknown;
  rangeStart?: unknown;
  rangeEnd?: unknown;
  durationMinutes?: unknown;
}

adminRouter.post(
  "/slots/generate",
  requireAdmin,
  async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as GenerateBody;
    const date = typeof body.date === "string" ? body.date.trim() : "";
    const rangeStart =
      typeof body.rangeStart === "string" ? body.rangeStart.trim() : "";
    const rangeEnd =
      typeof body.rangeEnd === "string" ? body.rangeEnd.trim() : "";
    const durationMinutes = Number(body.durationMinutes);

    if (!DATE_RE.test(date)) return badRequest(res, "date debe ser YYYY-MM-DD");
    if (!TIME_RE.test(rangeStart)) return badRequest(res, "rangeStart debe ser HH:mm");
    if (!TIME_RE.test(rangeEnd)) return badRequest(res, "rangeEnd debe ser HH:mm");
    if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) {
      return badRequest(res, "durationMinutes debe ser un entero positivo");
    }
    if (timeToMinutes(rangeEnd) <= timeToMinutes(rangeStart)) {
      return badRequest(res, "rangeEnd debe ser mayor que rangeStart");
    }

    let planned;
    try {
      planned = planGeneration({
        date: new Date(`${date}T00:00:00.000Z`),
        rangeStart,
        rangeEnd,
        durationMinutes,
      });
    } catch (err) {
      return badRequest(
        res,
        err instanceof Error ? err.message : "Planificación inválida"
      );
    }

    if (planned.length === 0) {
      return badRequest(
        res,
        `El rango no entra ni un slot completo de ${durationMinutes} min`
      );
    }

    const dateObj = new Date(`${date}T00:00:00.000Z`);

    // Chequeo de conflictos contra los existentes. Si CUALQUIER slot generado
    // choca con uno OPEN/BOOKED/BLOCKED, abortamos todo (atomicidad).
    // Devolvemos 409 con el primer conflicto encontrado.
    const existing = await prisma.availabilitySlot.findMany({
      where: { date: dateObj, status: { in: ["OPEN", "BOOKED", "BLOCKED"] } },
      select: { id: true, startTime: true, endTime: true, status: true },
    });
    for (const p of planned) {
      for (const e of existing) {
        const overlap =
          timeToMinutes(p.startTime) < timeToMinutes(e.endTime) &&
          timeToMinutes(e.startTime) < timeToMinutes(p.endTime);
        if (overlap) {
          return res.status(409).json({
            error: "Conflict",
            message: `El slot generado ${p.startTime}-${p.endTime} se superpone con el slot existente id=${e.id} (${e.startTime}-${e.endTime}, status=${e.status})`,
            conflict: {
              generated: p,
              existing: {
                id: e.id,
                startTime: e.startTime,
                endTime: e.endTime,
                status: e.status,
              },
            },
          });
        }
      }
    }

    // Creación atómica. Si el @@unique([date, startTime]) dispara en algún
    // INSERT (race con otro admin), el tx hace rollback de todo.
    try {
      const created = await prisma.$transaction(
        planned.map((p) =>
          prisma.availabilitySlot.create({
            data: {
              date: dateObj,
              startTime: p.startTime,
              endTime: p.endTime,
              status: "OPEN",
            },
          })
        )
      );
      return res.status(201).json({ slots: created });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        (err as { code?: string }).code === "P2002"
      ) {
        return res.status(409).json({
          error: "Conflict",
          message:
            "Otro proceso creó un slot conflictivo durante la generación. Reintentá.",
        });
      }
      console.error("[POST /admin/slots/generate] error inesperado:", err);
      return res
        .status(500)
        .json({ error: "InternalServerError", message: "Error inesperado" });
    }
  }
);

// ──────────────────────────────────────────────────────────────────────────
// POST /admin/slots  (protegido)
// Crea un slot en status OPEN. Rechaza si overlap con OPEN/BOOKED existente.
// ──────────────────────────────────────────────────────────────────────────

interface CreateSlotBody {
  date?: unknown;
  startTime?: unknown;
  endTime?: unknown;
}

adminRouter.post("/slots", requireAdmin, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as CreateSlotBody;
  const date = typeof body.date === "string" ? body.date.trim() : "";
  const startTime = typeof body.startTime === "string" ? body.startTime.trim() : "";
  const endTime = typeof body.endTime === "string" ? body.endTime.trim() : "";

  if (!DATE_RE.test(date)) return badRequest(res, "date debe ser YYYY-MM-DD");
  if (!TIME_RE.test(startTime)) return badRequest(res, "startTime debe ser HH:mm");
  if (!TIME_RE.test(endTime)) return badRequest(res, "endTime debe ser HH:mm");
  if (timeToMinutes(endTime) <= timeToMinutes(startTime)) {
    return badRequest(res, "endTime debe ser mayor que startTime");
  }

  const dateObj = new Date(`${date}T00:00:00.000Z`);

  // Validación de solapamiento: si hay un slot OPEN/BOOKED en esa fecha cuyo
  // rango se solape, devolvemos 409 con el detalle. Los BLOCKED no cuentan
  // (ya están "no-disponibles" por sí mismos y podríamos querer permitir
  // overlay… pero por ahora el contrato es claro: OPEN/BOOKED solamente).
  const conflict = await findOverlap(prisma, dateObj, { startTime, endTime });
  if (conflict) {
    return res.status(409).json({
      error: "Conflict",
      message: `Solapamiento con slot existente id=${conflict.existingId} (${conflict.existingStart}-${conflict.existingEnd}, status=${conflict.existingStatus})`,
      conflict,
    });
  }

  try {
    const slot = await prisma.availabilitySlot.create({
      data: { date: dateObj, startTime, endTime, status: "OPEN" },
    });
    return res.status(201).json({ slot });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      (err as { code?: string }).code === "P2002"
    ) {
      return res.status(409).json({
        error: "Conflict",
        message: "Ya existe un slot en esa fecha y hora",
      });
    }
    console.error("[POST /admin/slots] error inesperado:", err);
    return res
      .status(500)
      .json({ error: "InternalServerError", message: "Error inesperado" });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// PATCH /admin/slots/:id  (protegido)
// ──────────────────────────────────────────────────────────────────────────

interface PatchSlotBody {
  status?: unknown;
}

const PATCHABLE_STATUSES = new Set(["OPEN", "BLOCKED"]);

adminRouter.patch(
  "/slots/:id",
  requireAdmin,
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return badRequest(res, "id inválido");
    }

    const body = (req.body ?? {}) as PatchSlotBody;
    const status =
      typeof body.status === "string" ? body.status.trim() : "";
    if (!PATCHABLE_STATUSES.has(status)) {
      return badRequest(
        res,
        "status debe ser 'OPEN' o 'BLOCKED' (BOOKED se asigna vía reservas)"
      );
    }

    const existing = await prisma.availabilitySlot.findUnique({ where: { id } });
    if (!existing) {
      return res
        .status(404)
        .json({ error: "NotFound", message: "Slot no existe" });
    }
    if (existing.status === "BOOKED") {
      return res.status(409).json({
        error: "Conflict",
        message:
          "El slot tiene una reserva activa. Cancelá la reserva antes de cambiar su estado.",
      });
    }

    const slot = await prisma.availabilitySlot.update({
      where: { id },
      data: { status: status as "OPEN" | "BLOCKED" },
    });
    return res.json({ slot });
  }
);

// ──────────────────────────────────────────────────────────────────────────
// DELETE /admin/bookings/:id  (protegido)
// ──────────────────────────────────────────────────────────────────────────

adminRouter.delete(
  "/bookings/:id",
  requireAdmin,
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return badRequest(res, "id inválido");
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        const booking = await tx.booking.findUnique({ where: { id } });
        if (!booking) {
          throw new DeleteBookingError("NOT_FOUND");
        }
        await tx.booking.delete({ where: { id } });
        await tx.availabilitySlot.update({
          where: { id: booking.slotId },
          data: { status: "OPEN" },
        });
        return { bookingId: id, slotId: booking.slotId };
      });
      return res.json({ cancelled: result });
    } catch (err) {
      if (err instanceof DeleteBookingError) {
        return res
          .status(404)
          .json({ error: "NotFound", message: "Reserva no existe" });
      }
      console.error("[DELETE /admin/bookings/:id] error inesperado:", err);
      return res
        .status(500)
        .json({ error: "InternalServerError", message: "Error inesperado" });
    }
  }
);

class DeleteBookingError extends Error {
  constructor(public readonly code: "NOT_FOUND") {
    super(code);
    this.name = "DeleteBookingError";
  }
}
