import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireBranchContext } from "@/lib/branch-context";
import { orderActionSchema } from "@/lib/validations/order-actions";
import { advanceOrderStatus, cancelOrder, updateOrderItems, validateOrderPayment } from "@/lib/orders/order-transitions";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await requireBranchContext();
  if (!context) return NextResponse.json({ error: "No autorizado." }, { status: 401 });

  const { id } = await params;
  const order = await prisma.order.findFirst({
    where: { id, branchId: context.branchId },
    include: {
      items: true,
      statusEvents: { orderBy: { createdAt: "asc" }, include: { changedByUser: { select: { name: true } } } },
      // Para mostrar en el panel si el cliente pidió algo más por WhatsApp
      // mientras este pedido seguía activo (ver apply-actions.ts) — el
      // borrador de esa conversación queda con los productos pendientes de
      // sumar acá, en vez de perderse.
      conversation: { select: { id: true, status: true, draftOrder: true } },
    },
  });
  if (!order) return NextResponse.json({ error: "Pedido no encontrado." }, { status: 404 });

  return NextResponse.json({ order });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await requireBranchContext();
  if (!context) return NextResponse.json({ error: "No autorizado." }, { status: 401 });

  const { id } = await params;
  const body = await request.json().catch(() => null);
  const parsed = orderActionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Datos inválidos." }, { status: 400 });
  }

  const result =
    parsed.data.action === "advance_status"
      ? await advanceOrderStatus({ branchId: context.branchId, orderId: id, userId: context.userId })
      : parsed.data.action === "validate_payment"
        ? await validateOrderPayment({ branchId: context.branchId, orderId: id, userId: context.userId })
        : parsed.data.action === "update_items"
          ? await updateOrderItems({ branchId: context.branchId, orderId: id, userId: context.userId, items: parsed.data.items })
          : await cancelOrder({ branchId: context.branchId, orderId: id, userId: context.userId, reason: parsed.data.reason });

  if (result.status === "not_found") return NextResponse.json({ error: "Pedido no encontrado." }, { status: 404 });
  if (result.status === "invalid_transition") {
    return NextResponse.json({ error: "Ese cambio no es válido para el estado actual del pedido." }, { status: 409 });
  }
  if (result.status === "invalid_items") {
    return NextResponse.json(
      { error: "Uno de los productos ya no está disponible en el catálogo. Revisá la lista e intentá de nuevo." },
      { status: 409 },
    );
  }

  return NextResponse.json({ order: result.order });
}
