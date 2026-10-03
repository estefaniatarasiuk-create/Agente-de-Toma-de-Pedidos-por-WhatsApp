import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { recordOrderReceipt } from "@/lib/orders/order-receipts";
import { createTestCompanyAndBranch, cleanupCompany } from "./fixtures";

// Regresión de un bug real: un pedido puede recibir más de un comprobante
// legítimo con el tiempo (ej. el pago original y, más tarde, uno aparte por
// un producto agregado al mismo pedido) — antes solo se guardaba el último
// en Order.receiptUrl, y el anterior se perdía sin dejar rastro en el
// panel. recordOrderReceipt ahora guarda cada comprobante en su propia fila
// (OrderReceipt), además de seguir actualizando Order.receiptUrl con el más
// reciente (de eso dependen el worker de auto-cancelación, la validación de
// "pasar a preparación", y la detección de reutilización de comprobantes).
describe("recordOrderReceipt", () => {
  const companiesToCleanup: string[] = [];

  afterAll(async () => {
    for (const companyId of companiesToCleanup) await cleanupCompany(companyId);
  });

  async function createWaitingOrder(companyId: string, branchId: string, customerPhone: string) {
    return prisma.order.create({
      data: {
        companyId,
        branchId,
        customerPhone,
        customerName: "Cliente Test",
        deliveryAddressRaw: "Calle Falsa 123",
        status: "WAITING_RECEIPT",
        paymentMethod: "TRANSFER",
        subtotalCents: 300000,
        totalCents: 300000,
        delayMinutesAtOrder: 40,
        estimatedDeliveryAt: new Date(Date.now() + 40 * 60_000),
      },
    });
  }

  it("guarda el comprobante en Order.receiptUrl y también en el historial", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    const order = await createWaitingOrder(company.id, branch.id, "5491100000050");

    await recordOrderReceipt({
      companyId: company.id,
      branchId: branch.id,
      orderId: order.id,
      mediaUrl: "whatsapp/comprobante-1.jpg",
    });

    const updated = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(updated.receiptUrl).toBe("whatsapp/comprobante-1.jpg");
    expect(updated.receiptReceivedAt).not.toBeNull();

    const receipts = await prisma.orderReceipt.findMany({ where: { orderId: order.id } });
    expect(receipts).toHaveLength(1);
    expect(receipts[0].mediaUrl).toBe("whatsapp/comprobante-1.jpg");
  });

  it("un segundo comprobante no pisa al primero en el historial, aunque sí actualice Order.receiptUrl", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    const order = await createWaitingOrder(company.id, branch.id, "5491100000051");

    await recordOrderReceipt({
      companyId: company.id,
      branchId: branch.id,
      orderId: order.id,
      mediaUrl: "whatsapp/comprobante-original.jpg",
    });
    await recordOrderReceipt({
      companyId: company.id,
      branchId: branch.id,
      orderId: order.id,
      mediaUrl: "whatsapp/comprobante-agregado.jpg",
    });

    // El campo "más reciente" en Order sigue reflejando el último (de él
    // depende la lógica del sistema: auto-cancelación, validar el pasaje a
    // preparación, reutilización de comprobantes).
    const updated = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(updated.receiptUrl).toBe("whatsapp/comprobante-agregado.jpg");

    // Pero el panel tiene que poder mostrar AMBOS — ninguno se pierde.
    const receipts = await prisma.orderReceipt.findMany({
      where: { orderId: order.id },
      orderBy: { receivedAt: "asc" },
    });
    expect(receipts).toHaveLength(2);
    expect(receipts.map((r) => r.mediaUrl)).toEqual(["whatsapp/comprobante-original.jpg", "whatsapp/comprobante-agregado.jpg"]);
  });
});
