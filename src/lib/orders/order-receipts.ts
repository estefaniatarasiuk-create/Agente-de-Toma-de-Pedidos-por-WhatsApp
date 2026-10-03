import { prisma } from "@/lib/prisma";

// Bug real reportado: un pedido puede recibir más de un comprobante
// legítimo con el tiempo (ej. el pago original y, más tarde, uno aparte por
// un producto agregado al mismo pedido) — grabar solo en "Order.receiptUrl"
// (un único valor) hacía que el segundo pisara al primero sin dejar rastro,
// y el panel nunca podía mostrar ambos. "receiptUrl"/"receiptReceivedAt"
// siguen siendo el ÚLTIMO comprobante recibido (de eso dependen el worker
// de auto-cancelación, la validación de "pasar a preparación", y la
// detección de reutilización de comprobantes — ver receipt-reuse.ts), pero
// acá además se guarda cada comprobante en su propia fila para que el panel
// pueda mostrar el historial completo. Una sola transacción: nunca queda
// una fila de historial sin el campo "más reciente" actualizado, o viceversa.
export async function recordOrderReceipt(params: {
  companyId: string;
  branchId: string;
  orderId: string;
  mediaUrl: string;
}): Promise<void> {
  await prisma.$transaction([
    prisma.order.update({
      where: { id: params.orderId },
      data: { receiptUrl: params.mediaUrl, receiptReceivedAt: new Date() },
    }),
    prisma.orderReceipt.create({
      data: {
        companyId: params.companyId,
        branchId: params.branchId,
        orderId: params.orderId,
        mediaUrl: params.mediaUrl,
      },
    }),
  ]);
}
