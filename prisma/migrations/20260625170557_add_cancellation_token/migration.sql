-- AlterTable
ALTER TABLE "Booking" ADD COLUMN "cancelledAt" TIMESTAMP(3);

-- Paso 1: agregar la columna como nullable
ALTER TABLE "Booking" ADD COLUMN "cancellationToken" TEXT;

-- Paso 2: rellenar las filas existentes con un cuid generado en SQL
UPDATE "Booking" SET "cancellationToken" = gen_random_uuid()::text
WHERE "cancellationToken" IS NULL;

-- Paso 3: agregar NOT NULL y el índice único
ALTER TABLE "Booking" ALTER COLUMN "cancellationToken" SET NOT NULL;
CREATE UNIQUE INDEX "Booking_cancellationToken_key" ON "Booking"("cancellationToken");