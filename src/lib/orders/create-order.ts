import { prisma } from "@/lib/prisma";
import type { Order } from "@prisma/client";
import type { DraftOrderState } from "@/lib/validations/order-engine";
import { scheduleReceiptJobs } from "@/lib/jobs/queues";
import { getMissingOrderFields } from "@/lib/orders/draft-step";

export type CreateOrderResult =
  | { status: "created"; order: Order; totalCents: number; changeAmountCents: number | null }
  | { status: "invalid_items" }
  | { status: "missing_info"; missing: string[] }
  | { status: "payment_not_enabled" };

const DUPLICATE_ORDER_WINDOW_MINUTES = 10;

// Compara los ítems de dos pedidos por producto+cantidad, sin importar el
// orden — para detectar cuándo un "nuevo" pedido es en realidad el mismo
// que uno reciente (ver el chequeo de duplicados más abajo). Exportada:
// apply-actions.ts la reusa para distinguir "el cliente está corrigiendo
// este mismo pedido" (sigue el merge silencioso de acá abajo) de "el
// cliente pidió algo genuinamente distinto mientras el anterior seguía
// activo" (eso deriva a un humano — ver ese archivo).
export function haveSameItems(
  existingItems: Array<{ productId: string | null; quantity: number }>,
  newItems: Array<{ productId: string; quantity: number }>,
): boolean {
  if (existingItems.length !== newItems.length) return false;
  // Un ítem sin productId (el producto se borró después) no se puede
  // comparar con confianza — mejor no tratarlo como duplicado.
  if (existingItems.some((item) => item.productId === null)) return false;
  const existingByProduct = new Map(existingItems.map((item) => [item.productId, item.quantity]));
  return newItems.every((item) => existingByProduct.get(item.productId) === item.quantity);
}

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

  const missing = getMissingOrderFields(draft);
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

  // Bug real reportado: después de confirmar un pedido, el cliente quiso
  // corregir un dato menor (cuánto efectivo iba a pagar) — la IA, en vez de
  // solo actualizar ese dato, rearmó TODO el pedido de cero (mismos
  // productos) y confirmó una segunda vez, duplicándolo en el tablero. Si
  // hay un pedido reciente (mismo cliente, mismos productos, todavía no
  // cancelado) creado hace pocos minutos, se actualiza el medio de pago y
  // el nombre de ESE pedido en vez de crear uno nuevo — nunca se toca el
  // domicilio ya guardado (la reconstrucción de la IA puede traer una
  // dirección peor que la que ya se había validado).
  const recentDuplicate = await prisma.order.findFirst({
    where: {
      branchId,
      customerPhone,
      status: { in: ["WAITING_RECEIPT", "PENDING"] },
      createdAt: { gte: new Date(Date.now() - DUPLICATE_ORDER_WINDOW_MINUTES * 60_000) },
    },
    orderBy: { createdAt: "desc" },
    include: { items: true },
  });

  if (recentDuplicate && haveSameItems(recentDuplicate.items, draft.items)) {
    const updated = await prisma.order.update({
      where: { id: recentDuplicate.id },
      data: {
        customerName: draft.customerName!,
        paymentMethod: draft.paymentMethod!,
        cashPaymentAmountCents: draft.cashPaymentAmountCents,
        changeAmountCents,
        status,
      },
    });
    return { status: "created", order: updated, totalCents, changeAmountCents };
  }

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
