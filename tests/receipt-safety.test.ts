import { describe, it, expect, afterAll, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { processReceiptCancelJob } from "@/worker/handlers";
import { createTestCompanyAndBranch, cleanupCompany } from "./fixtures";

// Sin línea de WhatsApp vinculada, sendOutboundText intentaría mandar el
// mensaje real y solo puede persistirlo (no hay accessToken) — logueando un
// warning esperado. No es necesario mockearlo para este test.
vi.spyOn(console, "warn").mockImplementation(() => {});

// Regla de seguridad NO NEGOCIABLE del circuito de comprobante (spec §3.4 +
// decisión de arquitectura explícita): un pedido con comprobante adjunto
// jamás se cancela automáticamente, sin importar cuánto tiempo pasó.
describe("processReceiptCancelJob — circuito de comprobante", () => {
  const companiesToCleanup: string[] = [];

  afterAll(async () => {
    for (const companyId of companiesToCleanup) await cleanupCompany(companyId);
  });

  async function createWaitingOrder(companyId: string, branchId: string, receiptUrl: string | null) {
    const conversation = await prisma.conversation.create({
      data: { companyId, branchId, customerPhone: "5491133333333" },
    });
    return prisma.order.create({
      data: {
        companyId,
        branchId,
        conversationId: conversation.id,
        customerPhone: "5491133333333",
        customerName: "María López",
        deliveryAddressRaw: "Av. Siempre Viva 742",
        status: "WAITING_RECEIPT",
        paymentMethod: "TRANSFER",
        subtotalCents: 500000,
        totalCents: 500000,
        delayMinutesAtOrder: 40,
        estimatedDeliveryAt: new Date(Date.now() + 40 * 60_000),
        receiptUrl,
        receiptReceivedAt: receiptUrl ? new Date() : null,
      },
    });
  }

  it("NUNCA cancela un pedido que ya tiene comprobante adjunto", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    const order = await createWaitingOrder(company.id, branch.id, "/uploads/comprobante-real.jpg");

    await processReceiptCancelJob(order.id);

    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloaded.status).toBe("WAITING_RECEIPT");
    expect(reloaded.cancelledAt).toBeNull();

    const events = await prisma.orderStatusEvent.findMany({ where: { orderId: order.id } });
    expect(events).toHaveLength(0);
  });

  it("sí cancela un pedido que sigue esperando comprobante (control, para probar que el chequeo no es un no-op)", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    const order = await createWaitingOrder(company.id, branch.id, null);

    await processReceiptCancelJob(order.id);

    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloaded.status).toBe("CANCELLED");
    expect(reloaded.cancelledBy).toBe("SYSTEM");
    expect(reloaded.cancelledAt).not.toBeNull();

    const events = await prisma.orderStatusEvent.findMany({ where: { orderId: order.id } });
    expect(events).toHaveLength(1);
    expect(events[0].toStatus).toBe("CANCELLED");
  });

  it("no hace nada si el pedido ya no está en WAITING_RECEIPT (por ejemplo ya se canceló o se le adjuntó comprobante)", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    const order = await createWaitingOrder(company.id, branch.id, null);
    await prisma.order.update({ where: { id: order.id }, data: { status: "PREPARING" } });

    await processReceiptCancelJob(order.id);

    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloaded.status).toBe("PREPARING");
  });
});
