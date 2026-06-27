import express, { type Request, type Response } from "express";
import cors from "cors";
import { bookingsRouter } from "./routes/bookings.routes";
import { adminRouter } from "./routes/admin.routes";
import { cancelRouter } from "./routes/cancel.routes";
import { prisma } from "./db";

/**
 * Medianoche de hoy en Europe/Madrid como Date UTC.
 *
 * Usamos `Intl` con la zona Europe/Madrid para derivar el día "actual" del
 * cliente (la terapeuta está en España, no en UTC del servidor). Devolvemos
 * un `Date` UTC con HH:00:00:00 para que el filtro `gte` en Prisma funcione
 * contra la columna `date` (que es `@db.Date`, así que la hora es irrelevante,
 * pero el día es lo que se compara).
 *
 * Sin librerías: solo Intl nativo.
 */
function startOfTodayMadrid(): Date {
  const now = new Date();
  const madridStr = now.toLocaleDateString("es-ES", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // madridStr es "26/06/2026" en es-ES.
  const [day, month, year] = madridStr.split("/").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

export function createApp(): express.Express {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  // GET /slots  (PÚBLICO)
  // Devuelve solo slots OPEN con fecha >= hoy (Europe/Madrid). El cliente ya
  // filtra los OPEN localmente, pero el filtro de fecha va en el server para
  // no exponer turnos pasados (privacy + correcto) y para no transportarlos
  // en cada request. La terapeuta vive en Europe/Madrid así que "hoy" se
  // calcula en esa zona, no en UTC del server.
  app.get("/slots", async (_req: Request, res: Response) => {
    const slots = await prisma.availabilitySlot.findMany({
      where: {
        status: "OPEN",
        date: { gte: startOfTodayMadrid() },
      },
      orderBy: [{ date: "asc" }, { startTime: "asc" }],
    });
    res.json({ slots });
  });

  app.use("/bookings", bookingsRouter);
  app.use("/admin", adminRouter);
  app.use("/cancel", cancelRouter);

  return app;
}
