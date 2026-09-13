import { prisma } from "@/lib/prisma";
import { requireBranchContext } from "@/lib/branch-context";
import { ZoneManager } from "./zone-manager";

export default async function ZonaDeEntregaPage() {
  const context = await requireBranchContext();
  if (!context) return null;

  const zone = await prisma.deliveryZone.findUnique({ where: { branchId: context.branchId } });

  return <ZoneManager initialBranch={context.branch} initialZone={zone} />;
}
