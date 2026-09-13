import { prisma } from "@/lib/prisma";
import { requireBranchContext } from "@/lib/branch-context";
import { HoursManager } from "./hours-manager";

export default async function HorariosPage() {
  const context = await requireBranchContext();
  const slots = context
    ? await prisma.businessHourSlot.findMany({
        where: { branchId: context.branchId },
        orderBy: [{ dayOfWeek: "asc" }, { startMinute: "asc" }],
      })
    : [];

  return <HoursManager initialSlots={slots} />;
}
