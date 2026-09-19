import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireBranchContext } from "@/lib/branch-context";

// Endpoint liviano para el sondeo del panel (Fase 4): solo ids y conteos,
// nunca el contenido completo de conversaciones/pedidos — lo consulta el
// navegador cada pocos segundos mientras el panel está abierto.
export async function GET() {
  const context = await requireBranchContext();
  if (!context) return NextResponse.json({ error: "No autorizado." }, { status: 401 });

  const [requiresAttention, pendingOrders] = await Promise.all([
    prisma.conversation.findMany({
      where: { branchId: context.branchId, status: "REQUIRES_ATTENTION" },
      select: { id: true },
    }),
    prisma.order.findMany({
      where: { branchId: context.branchId, status: { in: ["WAITING_RECEIPT", "PENDING"] } },
      select: { id: true },
    }),
  ]);

  return NextResponse.json({
    requiresAttentionIds: requiresAttention.map((c) => c.id),
    newOrderIds: pendingOrders.map((o) => o.id),
  });
}
