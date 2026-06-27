import { Prisma, type PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

export interface CreateBookingInput {
  slotId: number;
  clientName: string;
  clientPhone: string;
  clientEmail: string;
  notes?: string;
}

export class BookingError extends Error {
  constructor(
    public readonly code: "SLOT_NOT_FOUND" | "SLOT_NOT_OPEN",
    message: string
  ) {
    super(message);
    this.name = "BookingError";
  }
}

/**
 * Crea un booking de forma atómica.
 *
 * Concurrencia: transacción interactiva con SELECT ... FOR UPDATE sobre el slot.
 * - tx.$queryRaw `SELECT ... FOR UPDATE` toma un lock de fila en Postgres hasta el COMMIT.
 * - Las peticiones concurrentes sobre el mismo slotId se serializan en la fila.
 * - La primera ve status=OPEN → actualiza a BOOKED + crea Booking.
 * - Las siguientes leen status=BOOKED (post-actualización) → BookingError SLOT_NOT_OPEN → 409.
 *
 * Defensa en profundidad:
 * - El UNIQUE(slotId) en Booking hace que la inserción sea imposible si dos tx
 *   lograran saltarse el lock (p. ej. con un race window). Se traduce a P2002.
 */
export async function createBooking(
  prisma: PrismaClient,
  input: CreateBookingInput
) {
  return prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      // SELECT ... FOR UPDATE: bloquea la fila del slot hasta fin de transacción.
      const rows = await tx.$queryRaw<
        Array<{ id: number; status: "OPEN" | "BOOKED" | "BLOCKED" }>
      >`SELECT id, status FROM "AvailabilitySlot" WHERE id = ${input.slotId} FOR UPDATE`;

      const slot = rows[0];
      if (!slot) {
        throw new BookingError("SLOT_NOT_FOUND", "Slot no existe");
      }
      if (slot.status !== "OPEN") {
        throw new BookingError(
          "SLOT_NOT_OPEN",
          `Slot no está disponible (status=${slot.status})`
        );
      }

      // 1) Marcar slot como BOOKED
      await tx.availabilitySlot.update({
        where: { id: input.slotId },
        data: { status: "BOOKED" },
      });

      // 2) Crear booking. Si por algún motivo el UNIQUE(slotId) se viola, Prisma lanza P2002.
      //
      // IMPORTANTE: generamos `cancellationToken` server-side y lo pasamos
      // explícito. Prisma 7 con driver adapters (@prisma/adapter-pg) ya no
      // inyecta los @default() client-side, así que si dejamos que Prisma
      // lo genere automáticamente el INSERT llega con NULL y la BD rebota
      // con P2011 "Null constraint violation". randomUUID() es opaco,
      // URL-safe y único (igual que cuid); no hace falta lib extra.
      const cancellationToken = randomUUID();
      const booking = await tx.booking.create({
        data: {
          slotId: input.slotId,
          clientName: input.clientName,
          clientPhone: input.clientPhone,
          clientEmail: input.clientEmail,
          notes: input.notes ?? null,
          cancellationToken,
        },
      });

      // Devolvemos el booking con el slot cargado: el caller (POST /bookings)
      // lo necesita para mandar el email de confirmación con fecha/horas.
      return tx.booking.findUnique({
        where: { id: booking.id },
        include: { slot: true },
      });
    },
    { timeout: 10_000, isolationLevel: "ReadCommitted" }
  );
}
