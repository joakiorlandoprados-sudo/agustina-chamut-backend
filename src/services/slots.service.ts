import type { Prisma, PrismaClient } from "@prisma/client";

/** "HH:mm" → minutos desde 00:00. */
export function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Minutos → "HH:mm" (con padding). */
export function minutesToTime(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export interface TimeRange {
  startTime: string; // "HH:mm"
  endTime: string;   // "HH:mm"
}

/**
 * Dos rangos [a.start, a.end) y [b.start, b.end) se solapan si:
 *   a.start < b.end  AND  b.start < a.end
 * Adyacentes (a.end == b.start) NO se solapan.
 */
export function rangesOverlap(a: TimeRange, b: TimeRange): boolean {
  return timeToMinutes(a.startTime) < timeToMinutes(b.endTime) &&
         timeToMinutes(b.startTime) < timeToMinutes(a.endTime);
}

/** Estados que cuentan como "ocupados" para validar overlap.
 *  Incluye BLOCKED: la forma de "reabrir" un slot bloqueado es PATCH sobre
 *  el mismo registro, no crear uno nuevo superpuesto. */
export const ACTIVE_STATUSES = ["OPEN", "BOOKED", "BLOCKED"] as const;

export type ActiveStatus = (typeof ACTIVE_STATUSES)[number];

export interface OverlapConflict {
  existingId: number;
  existingStart: string;
  existingEnd: string;
  existingStatus: ActiveStatus;
}

/**
 * Devuelve el primer slot existente en `date` (OPEN/BOOKED/BLOCKED) cuyo
 * rango se solape con `candidate`. Si no hay conflicto, devuelve null.
 *
 * Lo carga todo en memoria y compara con JS: la cantidad de slots por día
 * siempre va a ser O(decenas) como mucho (un humano, franjas de 50 min),
 * así que un SELECT + filter es suficiente.
 */
export async function findOverlap(
  prisma: PrismaClient | Prisma.TransactionClient,
  date: Date,
  candidate: TimeRange
): Promise<OverlapConflict | null> {
  const existing = await prisma.availabilitySlot.findMany({
    where: {
      date,
      status: { in: [...ACTIVE_STATUSES] },
    },
    select: { id: true, startTime: true, endTime: true, status: true },
  });

  for (const s of existing) {
    if (rangesOverlap(candidate, { startTime: s.startTime, endTime: s.endTime })) {
      return {
        existingId: s.id,
        existingStart: s.startTime,
        existingEnd: s.endTime,
        existingStatus: s.status as ActiveStatus,
      };
    }
  }
  return null;
}

export interface GenerateInput {
  date: Date;
  rangeStart: string;
  rangeEnd: string;
  durationMinutes: number;
}

export interface GeneratedSlot {
  startTime: string;
  endTime: string;
}

/**
 * Divide [rangeStart, rangeEnd) en slots consecutivos de `durationMinutes`.
 * - El último slot se trunca si no entra completo (no se crea parcial).
 *   El comportamiento esperado es "hasta llenar el rango", así que cualquier
 *   cola que no cubra durationMinutes completo se descarta.
 * - Devuelve [] si el rango no entra ni un slot completo.
 */
export function planGeneration(input: GenerateInput): GeneratedSlot[] {
  const start = timeToMinutes(input.rangeStart);
  const end = timeToMinutes(input.rangeEnd);
  const dur = input.durationMinutes;

  if (dur <= 0) throw new Error("durationMinutes debe ser positivo");
  if (end <= start) throw new Error("rangeEnd debe ser mayor que rangeStart");

  const out: GeneratedSlot[] = [];
  let cursor = start;
  while (cursor + dur <= end) {
    out.push({
      startTime: minutesToTime(cursor),
      endTime: minutesToTime(cursor + dur),
    });
    cursor += dur;
  }
  return out;
}
