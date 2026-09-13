import { prisma } from "@/lib/prisma";
import type { Order } from "@prisma/client";
import type { DraftOrderState } from "@/lib/validations/order-engine";
import { scheduleReceiptJobs } from "@/lib/jobs/queues";

export type CreateOrderResult =
  | { status: "created"; order: Order; totalCents: number; changeAmountCents: number | null }
  | { status: "invalid_items" }
  | { status: "missing_info"; missing: string[] }
  | { status: "payment_not_enabled" };

// Punto único donde un pedido pasa de "borrador de chat" a fila real en la
// base. Todo lo que importa (precios, medio de pago habilitado, demora
// vigente) se recalcula acá desde la configuración actual — el draft que
// vino de la conversación es solo una propuesta, nunca la fuente de verdad.
export async function createOrderFromDraft(params: {
  companyId: string;
  branchId: string;
  conversationId: string;
  customerPhone: string;
  draft: DraftOrderState;
}): Promise<CreateOrderResult> {
  const { draft, companyId, branchId, conversationId, customerPhone } = params;

  const missing: string[] = [];
  if (draft.items.length === 0) missing.push("productos");
  if (!draft.customerName) missing.push("nombre");
  if (!draft.deliveryAddressRaw || draft.deliveryLatitude === undefined) missing.push("domicilio validado");
  if (!draft.paymentMethod) missing.push("medio de pago");
  if (missing.length > 0) return { status: "missing_info", missing };

  const products = await prisma.product.findMany({
    where: { id: { in: draft.items.map((item) => item.productId) }, branchId, isActive: true },
  });
  const productById = new Map(products.map((product) => [product.id, product]));

  const items: Array<{
    companyId: string;
    branchId: string;
    productId: string;
    productName: string;
    unitPriceCents: number;
    quantity: number;
    subtotalCents: number;
  }> = [];
  for (const draftItem of draft.items) {
    const product = productById.get(draftItem.productId);
    if (!product) return { status: "invalid_items" };
    items.push({
      companyId,
      branchId,
      productId: product.id,
      productName: product.name,
      unitPriceCents: product.priceCents,
      quantity: draftItem.quantity,
      subtotalCents: product.priceCents * draftItem.quantity,
    });
  }

  const paymentConfig = await prisma.paymentMethodConfig.findUnique({ where: { branchId } });
  if (!paymentConfig) return { status: "payment_not_enabled" };
  if (draft.paymentMethod === "CASH" && !paymentConfig.cashEnabled) return { status: "payment_not_enabled" };
  if (draft.paymentMethod === "TRANSFER" && !paymentConfig.transferEnabled) return { status: "payment_not_enabled" };

  const totalCents = items.reduce((sum, item) => sum + item.subtotalCents, 0);
  const branch = await prisma.branch.findUniqueOrThrow({ where: { id: branchId } });
  const estimatedDeliveryAt = new Date(Date.now() + branch.currentDelayMinutes * 60_000);
  const status = draft.paymentMethod === "CASH" ? "PENDING" : "WAITING_RECEIPT";
  const changeAmountCents =
    draft.paymentMethod === "CASH" && draft.cashPaymentAmountCents !== undefined
      ? Math.max(0, draft.cashPaymentAmountCents - totalCents)
      : null;

  const order = await prisma.order.create({
    data: {
      companyId,
      branchId,
      conversationId,
      customerPhone,
      customerName: draft.customerName!,
      deliveryAddressRaw: draft.deliveryAddressRaw!,
      deliveryAddressNormalized: draft.deliveryAddressNormalized,
      deliveryLatitude: draft.deliveryLatitude,
      deliveryLongitude: draft.deliveryLongitude,
      deliveryNotes: draft.deliveryAddressNotes,
      status,
      paymentMethod: draft.paymentMethod!,
      cashPaymentAmountCents: draft.cashPaymentAmountCents,
      changeAmountCents,
      subtotalCents: totalCents,
      totalCents,
      delayMinutesAtOrder: branch.currentDelayMinutes,
      estimatedDeliveryAt,
      resolvedByAI: true,
      items: { create: items },
    },
  });

  await prisma.orderStatusEvent.create({
    data: { companyId, branchId, orderId: order.id, toStatus: status, changedByAI: true },
  });

  if (status === "WAITING_RECEIPT") {
    await scheduleReceiptJobs({
      orderId: order.id,
      reminderMinutes: branch.receiptReminderMinutes,
      cancelMinutes: branch.receiptCancelMinutes,
    });
  }

  return { status: "created", order, totalCents, changeAmountCents };
}
