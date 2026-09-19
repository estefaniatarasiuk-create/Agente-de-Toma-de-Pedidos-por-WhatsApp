import { prisma } from "@/lib/prisma";
import { requireBranchContext } from "@/lib/branch-context";
import { OrdersBoard } from "./orders-board";

export default async function PedidosPage() {
  const context = await requireBranchContext();

  const orders = context
    ? await prisma.order.findMany({
        where: { branchId: context.branchId },
        orderBy: { createdAt: "desc" },
        take: 200,
        include: { items: true },
      })
    : [];

  return <OrdersBoard initialOrders={orders} />;
}
