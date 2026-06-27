/* eslint-disable no-console */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL no está definida en .env");
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

/**
 * Devuelve { y, m, d } de "mañana" en Europe/Madrid.
 * Usamos Intl.DateTimeFormat con timeZone para no depender de la TZ del sistema.
 */
function tomorrowInMadrid(): { year: number; month: number; day: number } {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const today = Date.UTC(get("year"), get("month") - 1, get("day"));
  const tomorrow = new Date(today + 24 * 60 * 60 * 1000);

  // Re-extraemos componentes desde UTC para asegurar día correcto sin TZ drift.
  return {
    year: tomorrow.getUTCFullYear(),
    month: tomorrow.getUTCMonth() + 1,
    day: tomorrow.getUTCDate(),
  };
}

async function main() {
  const { year, month, day } = tomorrowInMadrid();
  // Construimos un Date en UTC-midnight para representar el "día" en Postgres DATE.
  const date = new Date(Date.UTC(year, month - 1, day));

  const startTime = "10:00";
  const endTime = "11:00";

  // Idempotente: si ya existe el slot mañana 10:00, no se duplica.
  const existing = await prisma.availabilitySlot.findFirst({
    where: { date, startTime },
  });

  if (existing) {
    console.log(
      `✔ Slot ya existía: id=${existing.id} ${date.toISOString().slice(0, 10)} ${startTime}-${endTime} status=${existing.status}`
    );
    return;
  }

  const slot = await prisma.availabilitySlot.create({
    data: { date, startTime, endTime, status: "OPEN" },
  });

  console.log(
    `✔ Slot creado: id=${slot.id} ${date.toISOString().slice(0, 10)} ${startTime}-${endTime} status=${slot.status}`
  );
}

main()
  .catch((err) => {
    console.error("Seed falló:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });