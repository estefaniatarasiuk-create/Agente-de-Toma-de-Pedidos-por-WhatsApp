import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { isWithinBusinessHours } from "@/lib/orders/business-hours";
import { createTestCompanyAndBranch, cleanupCompany } from "./fixtures";

// Ruta crítica: fuera de horario tiene que resolverse 100% determinístico,
// sin depender de la IA (spec §3.3).
describe("isWithinBusinessHours", () => {
  const companiesToCleanup: string[] = [];

  afterAll(async () => {
    for (const companyId of companiesToCleanup) await cleanupCompany(companyId);
  });

  it("devuelve true dentro de una franja activa y false fuera de ella", async () => {
    const { company, branch } = await createTestCompanyAndBranch({ timezone: "America/Argentina/Buenos_Aires" });
    companiesToCleanup.push(company.id);

    // Miércoles (dayOfWeek 3) de 12:00 a 15:00.
    await prisma.businessHourSlot.create({
      data: { companyId: company.id, branchId: branch.id, dayOfWeek: 3, startMinute: 12 * 60, endMinute: 15 * 60 },
    });

    // 2024-01-03 es un miércoles. Usamos horas UTC que, en America/Argentina
    // (UTC-3), caen dentro y fuera de la franja sin depender del huso del
    // entorno donde corre el test.
    const insideSlot = new Date("2024-01-03T16:00:00.000Z"); // 13:00 ART
    const outsideSlot = new Date("2024-01-03T20:00:00.000Z"); // 17:00 ART

    expect(await isWithinBusinessHours(branch.id, insideSlot)).toBe(true);
    expect(await isWithinBusinessHours(branch.id, outsideSlot)).toBe(false);
  });

  it("devuelve false cuando no hay ninguna franja configurada", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);

    expect(await isWithinBusinessHours(branch.id, new Date())).toBe(false);
  });
});
