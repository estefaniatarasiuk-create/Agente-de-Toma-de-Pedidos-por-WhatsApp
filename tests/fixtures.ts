import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";

// Cada test crea su propia Company/Branch con nombres únicos y borra la
// Company al final — el borrado cascadea (ver prisma/schema.prisma) a todo
// lo que cuelga de la sucursal, así que alcanza con un solo delete.
export async function createTestCompanyAndBranch(overrides?: { timezone?: string; currentDelayMinutes?: number }) {
  const suffix = randomUUID().slice(0, 8);
  const company = await prisma.company.create({ data: { name: `Test Co ${suffix}` } });
  const branch = await prisma.branch.create({
    data: {
      companyId: company.id,
      name: `Test Branch ${suffix}`,
      timezone: overrides?.timezone ?? "America/Argentina/Buenos_Aires",
      currentDelayMinutes: overrides?.currentDelayMinutes ?? 40,
    },
  });
  return { company, branch };
}

export async function cleanupCompany(companyId: string): Promise<void> {
  await prisma.company.delete({ where: { id: companyId } }).catch(() => {});
}
