import { Router, type Request, type Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { createBooking, BookingError } from "../services/booking.service";
import {
  sendBookingConfirmationToClient,
  sendBookingNotificationToAdmin,
} from "../services/email.service";

export const bookingsRouter = Router();

interface CreateBookingBody {
  slotId?: unknown;
  clientName?: unknown;
  clientPhone?: unknown;
  clientEmail?: unknown;
  notes?: unknown;
}

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: "BadRequest", message });
}

bookingsRouter.post("/", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as CreateBookingBody;
  const slotId = Number(body.slotId);
  const clientName =
    typeof body.clientName === "string" ? body.clientName.trim() : "";
  const clientPhone =
    typeof body.clientPhone === "string" ? body.clientPhone.trim() : "";
  const clientEmail =
    typeof body.clientEmail === "string" ? body.clientEmail.trim() : "";
  const notes =
    typeof body.notes === "string" && body.notes.trim() !== ""
      ? body.notes.trim()
      : undefined;

  if (!Number.isInteger(slotId) || slotId <= 0) {
    return badRequest(res, "slotId inválido");
  }
  if (!clientName) return badRequest(res, "clientName requerido");
  if (!clientPhone) return badRequest(res, "clientPhone requerido");
  if (!clientEmail) return badRequest(res, "clientEmail requerido");

  try {
    const booking = await createBooking(prisma, {
      slotId,
      clientName,
      clientPhone,
      clientEmail,
      notes,
    });

    // La reserva ya está confirmada en DB. Mandamos los dos emails en
    // paralelo pero con allSettled: si alguno falla, NO revierte la reserva.
    // Solo logueamos y devolvemos 201 igual.
    if (booking && booking.slot) {
      const dateKey = booking.slot.date.toISOString().slice(0, 10);
      const results = await Promise.allSettled([
        sendBookingConfirmationToClient({
          to: booking.clientEmail,
          clientName: booking.clientName,
          date: dateKey,
          startTime: booking.slot.startTime,
          endTime: booking.slot.endTime,
          cancellationToken: booking.cancellationToken,
        }),
        sendBookingNotificationToAdmin({
          to: process.env.ADMIN_EMAIL ?? "",
          clientName: booking.clientName,
          clientPhone: booking.clientPhone,
          clientEmail: booking.clientEmail,
          notes: booking.notes,
          date: dateKey,
          startTime: booking.slot.startTime,
          endTime: booking.slot.endTime,
        }),
      ]);
      results.forEach((r, i) => {
        if (r.status === "rejected") {
          const which = i === 0 ? "cliente" : "admin";
          console.error(
            `[POST /bookings] email a ${which} falló:`,
            r.reason
          );
        }
      });
    }

    return res.status(201).json({ booking });
  } catch (err) {
    if (err instanceof BookingError) {
      if (err.code === "SLOT_NOT_FOUND") {
        return res.status(404).json({ error: "NotFound", message: err.message });
      }
      return res.status(409).json({ error: "Conflict", message: err.message });
    }
    // Defensa en profundidad: si el UNIQUE(slotId) dispara, lo tratamos como 409.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      (err as { code?: string }).code === "P2002"
    ) {
      return res
        .status(409)
        .json({ error: "Conflict", message: "El slot ya está reservado" });
    }
    console.error("[POST /bookings] error inesperado:", err);
    return res
      .status(500)
      .json({ error: "InternalServerError", message: "Error inesperado" });
  }
});
