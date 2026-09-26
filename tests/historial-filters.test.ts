import { describe, it, expect } from "vitest";
import { buildHistorialWhere } from "@/lib/orders/historial-filters";

describe("buildHistorialWhere", () => {
  it("sin filtros, solo restringe por sucursal", () => {
    const where = buildHistorialWhere("branch-1", { from: null, to: null, cliente: null, estado: null });
    expect(where).toEqual({ branchId: "branch-1" });
  });

  it("arma un rango [from, to+1día) para que el día 'hasta' quede incluido completo", () => {
    const where = buildHistorialWhere("branch-1", { from: "2026-09-01", to: "2026-09-05", cliente: null, estado: null });
    const createdAt = where.createdAt as { gte: Date; lt: Date };
    expect(createdAt.gte.getDate()).toBe(1);
    expect(createdAt.lt.getDate()).toBe(6);
  });

  it("busca por nombre O teléfono cuando hay texto de cliente", () => {
    const where = buildHistorialWhere("branch-1", { from: null, to: null, cliente: "Jorge", estado: null });
    expect(where.OR).toEqual([
      { customerName: { contains: "Jorge", mode: "insensitive" } },
      { customerPhone: { contains: "Jorge" } },
    ]);
  });

  it("ignora un estado inválido en vez de romper la consulta", () => {
    const where = buildHistorialWhere("branch-1", { from: null, to: null, cliente: null, estado: "NO_EXISTE" });
    expect(where.status).toBeUndefined();
  });

  it("acepta un estado válido", () => {
    const where = buildHistorialWhere("branch-1", { from: null, to: null, cliente: null, estado: "DELIVERED" });
    expect(where.status).toBe("DELIVERED");
  });
});
