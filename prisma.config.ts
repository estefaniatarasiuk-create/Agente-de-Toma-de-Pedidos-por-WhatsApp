import "dotenv/config";
import { defineConfig } from "prisma/config";

// Prisma 7 ya no acepta la connection string dentro de schema.prisma: Migrate
// la toma de acá. El PrismaClient en tiempo de ejecución usa el driver
// adapter definido en src/lib/prisma.ts (misma DATABASE_URL).
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
