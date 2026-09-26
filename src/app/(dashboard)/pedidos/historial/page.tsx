import { prisma } from "@/lib/prisma";
import { requireBranchContext } from "@/lib/branch-context";
import { HistorialTable } from "./historial-table";

const PAGE_SIZE = 25;

export default async function HistorialPage() {
  const context = await requireBranchContext();

  const [orders, total] = context
    ? await Promise.all([
        prisma.order.findMany({
          where: { branchId: context.branchId },
          orderBy: { createdAt: "desc" },
          take: PAGE_SIZE,
          include: { items: true },
        }),
        prisma.order.count({ where: { branchId: context.branchId } }),
      ])
    : [[], 0];

  return <HistorialTable initialOrders={orders} initialTotal={total} pageSize={PAGE_SIZE} />;
}
