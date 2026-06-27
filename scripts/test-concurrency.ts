/* eslint-disable no-console */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL no está definida en .env");
}

const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const SLOT_ID_ENV = process.env.TEST_SLOT_ID;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

function tomorrowInMadrid(): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(new Date());
  const y = Number(parts.find((p) => p.type === "year")?.value);
  const m = Number(parts.find((p) => p.type === "month")?.value);
  const d = Number(parts.find((p) => p.type === "day")?.value);
  const todayUtc = Date.UTC(y, m - 1, d);
  const tomorrow = new Date(todayUtc + 24 * 60 * 60 * 1000);
  return {
    year: tomorrow.getUTCFullYear(),
    month: tomorrow.getUTCMonth() + 1,
    day: tomorrow.getUTCDate(),
  };
}

async function ensureFreshSlot(): Promise<{ slotId: number; cleanup: () => Promise<void> }> {
  if (SLOT_ID_ENV) {
    const id = Number(SLOT_ID_ENV);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`TEST_SLOT_ID inválido: ${SLOT_ID_ENV}`);
    }
    // Reset duro del slot: borramos cualquier booking previo y lo marcamos OPEN.
    await prisma.booking.deleteMany({ where: { slotId: id } });
    await prisma.availabilitySlot.update({
      where: { id },
      data: { status: "OPEN" },
    });
    console.log(`[setup] Slot ${id} reseteado a OPEN`);
    return {
      slotId: id,
      // Si el slot vino de afuera (TEST_SLOT_ID), no lo borramos: cleanup
      // igual limpia el booking que haya podido quedar tras el test.
      cleanup: async () => {
        const del = await prisma.booking.deleteMany({ where: { slotId: id } });
        console.log(`[cleanup] Slot ${id}: ${del.count} booking(s) borrado(s)`);
      },
    };
  }

  const { year, month, day } = tomorrowInMadrid();
  const date = new Date(Date.UTC(year, month - 1, day));
  // startTime único por ejecución para no chocar con @@unique([date, startTime]).
  // El formato HH:mm lo relajamos solo en este slot sintético del test.
  const startTime = `99:99-${Date.now()}`;

  const slot = await prisma.availabilitySlot.create({
    data: { date, startTime, endTime: "00:00", status: "OPEN" },
  });
  console.log(`[setup] Slot fresco creado: id=${slot.id} (startTime=${startTime})`);
  return {
    slotId: slot.id,
    cleanup: async () => {
      // Borramos bookings primero (FK UNIQUE(slotId) → cascade manual).
      const delBookings = await prisma.booking.deleteMany({
        where: { slotId: slot.id },
      });
      const delSlots = await prisma.availabilitySlot.deleteMany({
        where: { id: slot.id },
      });
      console.log(
        `[cleanup] Slot sintético ${slot.id}: ${delBookings.count} booking(s), ${delSlots.count} slot(s) borrado(s)`
      );
    },
  };
}

interface Counters {
  success: number;
  conflict: number;
  other: number;
  otherStatuses: number[];
}

async function postBooking(slotId: number, i: number): Promise<void> {
  const res = await fetch(`${BASE_URL}/bookings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      slotId,
      clientName: `Cliente Concurrente ${i}`,
      clientPhone: `+3460000000${i}`,
      clientEmail: `conc${i}@example.com`,
      notes: `intento ${i}`,
    }),
  });

  const text = await res.text();
  if (res.status === 201) {
    counters.success++;
    console.log(`  ✔ #${i} → 201 Created`);
  } else if (res.status === 409) {
    counters.conflict++;
    console.log(`  ✗ #${i} → 409 Conflict`);
  } else {
    counters.other++;
    counters.otherStatuses.push(res.status);
    console.log(`  ! #${i} → ${res.status} ${text}`);
  }
}

const counters: Counters = { success: 0, conflict: 0, other: 0, otherStatuses: [] };

async function main() {
  console.log(`[concurrency-test] Base URL: ${BASE_URL}`);
  const { slotId, cleanup } = await ensureFreshSlot();

  // Verificación rápida: ¿el server está arriba?
  try {
    const h = await fetch(`${BASE_URL}/health`);
    if (!h.ok) throw new Error(`/health devolvió ${h.status}`);
  } catch (err) {
    console.error(
      `[concurrency-test] No puedo conectar a ${BASE_URL}. ¿Está el server corriendo? (npm run dev)`
    );
    throw err;
  }

  console.log(`[concurrency-test] Disparando 5 POST /bookings contra slotId=${slotId}...`);

  // Promise.all dispara las 5 a la vez; el lock FOR UPDATE las serializa en BD.
  await Promise.all(
    Array.from({ length: 5 }, (_, i) => postBooking(slotId, i + 1))
  );

  console.log("\n[concurrency-test] Resultados:");
  console.log(`  201 Created: ${counters.success}  (esperado: 1)`);
  console.log(`  409 Conflict: ${counters.conflict} (esperado: 4)`);
  if (counters.other > 0) {
    console.log(`  Otros: ${counters.other} (statuses=${counters.otherStatuses.join(",")})`);
  }

  const ok =
    counters.success === 1 && counters.conflict === 4 && counters.other === 0;

  console.log(
    ok
      ? "\n✅ Test PASÓ — exactamente 1 éxito y 4 conflictos."
      : "\n❌ Test FALLÓ — los números no coinciden con lo esperado."
  );

  // Cleanup SIEMPRE, pase o falle. Guardamos el resultado del test para
  // salir con el código correcto después de limpiar.
  try {
    await cleanup();
  } catch (err) {
    console.error("[concurrency-test] Cleanup falló:", err);
    // Si el cleanup falla, salimos con error aunque el test haya pasado,
    // para que el operador investigue.
    process.exit(1);
  }
  process.exit(ok ? 0 : 1);
}

main()
  .catch((err) => {
    console.error("[concurrency-test] Error:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });