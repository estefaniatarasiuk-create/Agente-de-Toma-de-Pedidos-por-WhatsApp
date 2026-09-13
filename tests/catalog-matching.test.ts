import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { findProductMatch, findSimilarProducts } from "@/lib/orders/catalog-matching";
import { createTestCompanyAndBranch, cleanupCompany } from "./fixtures";

// Regresión del bug que encontró el usuario en la Fase 1: la IA pedía
// "Fanta" (no está en el catálogo) y el preview lo reemplazaba en silencio
// por Coca-Cola. findProductMatch NUNCA debe devolver un producto distinto
// al pedido — eso lo resuelve apply-actions.ts mostrando alternativas, no
// esta función.
describe("findProductMatch", () => {
  const companiesToCleanup: string[] = [];

  afterAll(async () => {
    for (const companyId of companiesToCleanup) await cleanupCompany(companyId);
  });

  it("no sustituye en silencio un producto que no está en el catálogo", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);

    await prisma.product.create({
      data: { companyId: company.id, branchId: branch.id, name: "Coca-Cola 500ml", priceCents: 150000 },
    });

    const match = await findProductMatch(branch.id, "Fanta");
    expect(match).toBeNull();

    const alternatives = await findSimilarProducts(branch.id, "Fanta");
    expect(alternatives).toEqual([]);
  });

  it("matchea por nombre exacto y por variaciones menores de tipeo/mayúsculas", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);

    const product = await prisma.product.create({
      data: { companyId: company.id, branchId: branch.id, name: "Coca-Cola 500ml", priceCents: 150000 },
    });

    expect((await findProductMatch(branch.id, "Coca-Cola 500ml"))?.id).toBe(product.id);
    expect((await findProductMatch(branch.id, "coca-cola 500ml"))?.id).toBe(product.id);
    expect((await findProductMatch(branch.id, "Coca-Cola"))?.id).toBe(product.id);
  });
});
