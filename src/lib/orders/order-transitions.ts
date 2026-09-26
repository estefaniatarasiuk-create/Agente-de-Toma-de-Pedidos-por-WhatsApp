import { prisma } from "@/lib/prisma";
import { sendOutboundText } from "@/lib/whatsapp/outbound";
import {
  buildOrderCancelledByCompanyMessage,
  buildOrderItemsUpdatedMessage,
  buildOrderOnTheWayMessage,
  buildPaymentValidatedMessage,
} from "@/lib/orders/messages";
import type { Order, OrderStatus } from "@prisma/client";

// Único lugar que mueve el estado de un pedido desde el tablero de
// operación (Fase 4): humano, no IA — cada cambio queda en
// OrderStatusEvent con changedByAI: false para la trazabilidad IA vs.
// humano (objetivo de negocio §4.3).
const NEXT_STATUS: Partial<Record<OrderStatus, OrderStatus>> = {
  PENDING: "PREPARING",
  PREPARING: "ON_THE_WAY",
  ON_THE_WAY: "DELIVERED",
};

export type OrderTransitionResult =
  | { status: "ok"; order: Order }
  | { status: "invalid_transition" }
  | { status: "not_found" };

async function notifyCustomer(order: Order, userId: string, text: string): Promise<void> {
  // Un pedido puede quedar sin conversación asociada (ej. si se borró) —
  // en ese caso no hay a quién mandarle el WhatsApp, seguimos igual.
  if (!order.conversationId) return;
  const line = await prisma.whatsAppLine.findUnique({ where: { branchId: order.branchId } });
  await sendOutboundText({
    companyId: order.companyId,
    branchId: order.branchId,
    conversationId: order.conversationId,
    customerPhone: order.customerPhone,
    line,
    text,
    sentByUserId: userId,
  });
}

export async function advanceOrderStatus(params: {
  branchId: string;
  orderId: string;
  userId: string;
}): Promise<OrderTransitionResult> {
  const order = await prisma.order.findFirst({ where: { id: params.orderId, branchId: params.branchId } });
  if (!order) return { status: "not_found" };

  const nextStatus = NEXT_STATUS[order.status];
  if (!nextStatus) return { status: "invalid_transition" };

  const updated = await prisma.order.update({
    where: { id: order.id },
    data: {
      status: nextStatus,
      isDelayed: false,
      deliveredAt: nextStatus === "DELIVERED" ? new Date() : undefined,
    },
  });
  await prisma.orderStatusEvent.create({
    data: {
      companyId: order.companyId,
      branchId: order.branchId,
      orderId: order.id,
      fromStatus: order.status,
      toStatus: nextStatus,
      changedByUserId: params.userId,
      changedByAI: false,
    },
  });

  // "Entregado" es un registro interno del local (se marca a mano en el
  // tablero, no hay forma de confirmar que el pedido llegó de verdad en
  // ese momento) — a diferencia de "en camino", no le mandamos WhatsApp al
  // cliente por este cambio, para no arriesgarnos a avisarle "entregado"
  // antes de que en realidad le llegue (pedido explícito de la Fase 4).
  if (nextStatus === "ON_THE_WAY") await notifyCustomer(updated, params.userId, buildOrderOnTheWayMessage());

  return { status: "ok", order: updated };
}

// Revisar y aceptar el comprobante de una transferencia (spec §3.4): pasa
// el pedido de "esperando comprobante" a "pendiente de preparación", igual
// que si hubiera sido en efectivo. Solo lo puede hacer una persona — nunca
// se valida un pago automáticamente.
export async function validateOrderPayment(params: {
  branchId: string;
  orderId: string;
  userId: string;
}): Promise<OrderTransitionResult> {
  const order = await prisma.order.findFirst({ where: { id: params.orderId, branchId: params.branchId } });
  if (!order) return { status: "not_found" };
  if (order.status !== "WAITING_RECEIPT" || !order.receiptUrl) return { status: "invalid_transition" };

  const updated = await prisma.order.update({
    where: { id: order.id },
    data: {
      status: "PENDING",
      paymentValidated: true,
      paymentValidatedAt: new Date(),
      paymentValidatedByUserId: params.userId,
    },
  });
  await prisma.orderStatusEvent.create({
    data: {
      companyId: order.companyId,
      branchId: order.branchId,
      orderId: order.id,
      fromStatus: "WAITING_RECEIPT",
      toStatus: "PENDING",
      changedByUserId: params.userId,
      changedByAI: false,
      reason: "Comprobante de transferencia validado manualmente.",
    },
  });
  await notifyCustomer(updated, params.userId, buildPaymentValidatedMessage());

  return { status: "ok", order: updated };
}

// Cancelación manual: a diferencia de la cancelación automática del
// circuito de comprobante (que nunca actúa si ya hay receiptUrl), acá sí
// se puede cancelar en cualquier estado no terminal — es una decisión de
// una persona, no una regla dura del sistema.
export async function cancelOrder(params: {
  branchId: string;
  orderId: string;
  userId: string;
  reason: string;
}): Promise<OrderTransitionResult> {
  const order = await prisma.order.findFirst({ where: { id: params.orderId, branchId: params.branchId } });
  if (!order) return { status: "not_found" };
  if (order.status === "DELIVERED" || order.status === "CANCELLED") return { status: "invalid_transition" };

  const updated = await prisma.order.update({
    where: { id: order.id },
    data: { status: "CANCELLED", cancelledAt: new Date(), cancellationReason: params.reason, cancelledBy: "COMPANY" },
  });
  await prisma.orderStatusEvent.create({
    data: {
      companyId: order.companyId,
      branchId: order.branchId,
      orderId: order.id,
      fromStatus: order.status,
      toStatus: "CANCELLED",
      changedByUserId: params.userId,
      changedByAI: false,
      reason: params.reason,
    },
  });
  await notifyCustomer(updated, params.userId, buildOrderCancelledByCompanyMessage(params.reason));

  return { status: "ok", order: updated };
}

export type UpdateItemsResult =
  | { status: "ok"; order: Order }
  | { status: "invalid_transition" }
  | { status: "invalid_items" }
  | { status: "not_found" };

// Editar los productos de un pedido ya confirmado, desde el panel (pedido
// explícito del usuario: agregar/quitar/cambiar cantidades — típicamente
// para sumar algo que el cliente pidió por WhatsApp después de confirmar el
// pedido original, sin tener que armar un pedido aparte). Igual que en
// create-order.ts, el precio SIEMPRE sale del catálogo actual — nunca se
// confía en un precio que venga del cliente de la petición.
export async function updateOrderItems(params: {
  branchId: string;
  orderId: string;
  userId: string;
  items: Array<{ productId: string; quantity: number }>;
}): Promise<UpdateItemsResult> {
  const order = await prisma.order.findFirst({ where: { id: params.orderId, branchId: params.branchId } });
  if (!order) return { status: "not_found" };
  // Igual que la cancelación manual: solo tiene sentido en un estado no
  // terminal — un pedido ya entregado o cancelado no se puede "editar".
  if (order.status === "DELIVERED" || order.status === "CANCELLED") return { status: "invalid_transition" };

  const products = await prisma.product.findMany({
    where: { id: { in: params.items.map((item) => item.productId) }, branchId: params.branchId, isActive: true },
  });
  const productById = new Map(products.map((product) => [product.id, product]));

  const items: Array<{
    companyId: string;
    branchId: string;
    orderId: string;
    productId: string;
    productName: string;
    unitPriceCents: number;
    quantity: number;
    subtotalCents: number;
  }> = [];
  for (const item of params.items) {
    const product = productById.get(item.productId);
    if (!product) return { status: "invalid_items" };
    items.push({
      companyId: order.companyId,
      branchId: order.branchId,
      orderId: order.id,
      productId: product.id,
      productName: product.name,
      unitPriceCents: product.priceCents,
      quantity: item.quantity,
      subtotalCents: product.priceCents * item.quantity,
    });
  }

  const totalCents = items.reduce((sum, item) => sum + item.subtotalCents, 0);
  const changeAmountCents =
    order.paymentMethod === "CASH" && order.cashPaymentAmountCents !== null
      ? Math.max(0, order.cashPaymentAmountCents - totalCents)
      : null;

  const updated = await prisma.$transaction(async (tx) => {
    await tx.orderItem.deleteMany({ where: { orderId: order.id } });
    await tx.orderItem.createMany({ data: items });
    return tx.order.update({
      where: { id: order.id },
      data: { subtotalCents: totalCents, totalCents, changeAmountCents },
    });
  });

  // No es un cambio de estado (from/to quedan iguales), pero reusar
  // OrderStatusEvent para esto deja la edición en el mismo historial que ya
  // se muestra en el panel, en vez de necesitar una tabla nueva solo para esto.
  await prisma.orderStatusEvent.create({
    data: {
      companyId: order.companyId,
      branchId: order.branchId,
      orderId: order.id,
      fromStatus: order.status,
      toStatus: order.status,
      changedByUserId: params.userId,
      changedByAI: false,
      reason: "Productos del pedido editados manualmente desde el panel.",
    },
  });

  await notifyCustomer(
    updated,
    params.userId,
    buildOrderItemsUpdatedMessage({
      items,
      totalCents,
      paymentMethod: updated.paymentMethod,
      cashPaymentAmountCents: updated.cashPaymentAmountCents,
    }),
  );

  return { status: "ok", order: updated };
}
