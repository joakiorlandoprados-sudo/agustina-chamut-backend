/* eslint-disable no-console */
/**
 * Crea (o actualiza) el AdminUser inicial.
 *
 * Uso:
 *   ADMIN_EMAIL=admin@test.com ADMIN_PASSWORD="Password123!" npx ts-node --transpile-only scripts/create-admin.ts
 *
 *   o con argumentos posicionales:
 *   npx ts-node --transpile-only scripts/create-admin.ts admin@test.com "Password123!"
 *
 * - Hashea la password con bcrypt (cost 10).
 * - Hace upsert: si el email ya existe, actualiza el hash (útil para reset).
 * - Imprime email e id, nunca el hash.
 */
import "dotenv/config";
import bcrypt from "bcrypt";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL no está definida en .env");
}

const email = (process.env.ADMIN_EMAIL ?? process.argv[2] ?? "").trim();
const password = process.env.ADMIN_PASSWORD ?? process.argv[3] ?? "";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

if (!EMAIL_RE.test(email)) {
  console.error("❌ Email inválido (pasalo como ADMIN_EMAIL o argv[2]).");
  process.exit(1);
}
if (password.length < 8) {
  console.error("❌ Password muy corta (mínimo 8 chars).");
  process.exit(1);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

async function main() {
  const passwordHash = await bcrypt.hash(password, 10);

  const user = await prisma.adminUser.upsert({
    where: { email },
    create: { email, passwordHash },
    update: { passwordHash },
  });

  console.log("✅ AdminUser listo:");
  console.log(`   id    : ${user.id}`);
  console.log(`   email : ${user.email}`);
  console.log(`   createdAt: ${user.createdAt.toISOString()}`);
}

main()
  .catch((err) => {
    console.error("[create-admin] Error:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
