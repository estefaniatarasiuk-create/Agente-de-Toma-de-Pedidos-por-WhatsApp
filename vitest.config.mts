import { defineConfig } from "vitest/config";
import path from "node:path";

// Fase 3: tests de integración de las rutas críticas del motor de pedidos
// contra una base Postgres real (no mocks de Prisma) — requiere DATABASE_URL
// apuntando a una base con las migraciones aplicadas (.env de desarrollo).
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Los tests comparten una misma base de datos: correrlos en paralelo
    // pisaría filas entre sí. Cada archivo aísla sus datos bajo una Company
    // propia, pero mantenemos los archivos en serie para no depender de eso.
    fileParallelism: false,
  },
});
