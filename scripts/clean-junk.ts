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

async function main() {
  const junkSlots = await prisma.availabilitySlot.findMany({
    where: { startTime: { startsWith: "99:99-" } },
    include: { booking: true },
  });
  console.log(`Slots basura encontrados: ${junkSlots.length}`);
  for (const s of junkSlots) {
    console.log(
      `  slot ${s.id} startTime=${s.startTime} status=${s.status} bookingId=${
        s.booking?.id ?? "none"
      }`
    );
  }

  const delBookings = await prisma.booking.deleteMany({
    where: { slot: { startTime: { startsWith: "99:99-" } } },
  });
  const delSlots = await prisma.availabilitySlot.deleteMany({
    where: { startTime: { startsWith: "99:99-" } },
  });
  console.log(`Borrados: ${delBookings.count} bookings, ${delSlots.count} slots`);

  const remaining = await prisma.availabilitySlot.findMany({
    orderBy: { id: "asc" },
  });
  console.log("Slots restantes:");
  for (const s of remaining) {
    console.log(`  id=${s.id} date=${s.date.toISOString().slice(0, 10)} startTime=${s.startTime} status=${s.status}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
