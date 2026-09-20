import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { advanceOrderStatus, cancelOrder, validateOrderPayment } from "@/lib/orders/order-transitions";
import { createTestCompanyAndBranch, cleanupCompany } from "./fixtures";

// Rutas críticas del tablero de operación (Fase 4): mover el estado de un
// pedido a mano nunca debe saltear reglas ni dejar de registrar quién lo
// hizo (trazabilidad IA vs. humano).
describe("order-transitions", () => {
  const companiesToCleanup: string[] = [];

  afterAll(async () => {
    for (const companyId of companiesToCleanup) await cleanupCompany(companyId);
  });

  async function createOrder(branchId: string, companyId: string, overrides?: Partial<{ status: "WAITING_RECEIPT" | "PENDING" | "PREPARING" | "ON_THE_WAY" | "DELIVERED" | "CANCELLED"; receiptUrl: string | null }>) {
    const customerPhone = `549110000${Math.floor(Math.random() * 9000 + 1000)}`;
    const conversation = await prisma.conversation.create({
      data: { companyId, branchId, customerPhone },
    });
    return prisma.order.create({
      data: {
        companyId,
        branchId,
        conversationId: conversation.id,
        customerPhone,
        customerName: "Cliente Test",
        deliveryAddressRaw: "Calle Falsa 123",
        status: overrides?.status ?? "PENDING",
        paymentMethod: "CASH",
        subtotalCents: 500000,
        totalCents: 500000,
        delayMinutesAtOrder: 40,
        estimatedDeliveryAt: new Date(Date.now() + 40 * 60_000),
        receiptUrl: overrides?.receiptUrl ?? null,
      },
    });
  }

  it("avanza PENDING -> PREPARING -> ON_THE_WAY -> DELIVERED y registra cada evento", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    const user = await prisma.user.create({
      data: { companyId: company.id, email: `op-${Date.now()}@test.com`, passwordHash: "x", name: "Operador" },
    });
    const order = await createOrder(branch.id, company.id, { status: "PENDING" });

    const r1 = await advanceOrderStatus({ branchId: branch.id, orderId: order.id, userId: user.id });
    expect(r1.status).toBe("ok");
    if (r1.status === "ok") expect(r1.order.status).toBe("PREPARING");

    const r2 = await advanceOrderStatus({ branchId: branch.id, orderId: order.id, userId: user.id });
    if (r2.status === "ok") expect(r2.order.status).toBe("ON_THE_WAY");

    // "En camino" sí le avisa al cliente por WhatsApp (queda un Message
    // OUTBOUND persistido, incluso sin línea configurada en el test).
    const messagesAfterOnTheWay = await prisma.message.findMany({
      where: { conversationId: order.conversationId!, direction: "OUTBOUND" },
    });
    expect(messagesAfterOnTheWay.some((m) => m.textContent?.includes("salió"))).toBe(true);

    const r3 = await advanceOrderStatus({ branchId: branch.id, orderId: order.id, userId: user.id });
    if (r3.status === "ok") {
      expect(r3.order.status).toBe("DELIVERED");
      expect(r3.order.deliveredAt).not.toBeNull();
    }

    // Pedido explícito del usuario en Fase 4: "Entregado" es un registro
    // interno (nadie confirma que el pedido llegó de verdad en ese
    // momento), así que NO le manda ningún mensaje nuevo al cliente.
    const messagesAfterDelivered = await prisma.message.findMany({
      where: { conversationId: order.conversationId!, direction: "OUTBOUND" },
    });
    expect(messagesAfterDelivered).toHaveLength(messagesAfterOnTheWay.length);

    const events = await prisma.orderStatusEvent.findMany({ where: { orderId: order.id }, orderBy: { createdAt: "asc" } });
    expect(events.map((e) => e.toStatus)).toEqual(["PREPARING", "ON_THE_WAY", "DELIVERED"]);
    expect(events.every((e) => e.changedByUserId === user.id && e.changedByAI === false)).toBe(true);
  });

  it("no avanza un pedido ya DELIVERED o CANCELLED", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    const user = await prisma.user.create({
      data: { companyId: company.id, email: `op-${Date.now()}@test.com`, passwordHash: "x", name: "Operador" },
    });
    const order = await createOrder(branch.id, company.id, { status: "DELIVERED" });

    const result = await advanceOrderStatus({ branchId: branch.id, orderId: order.id, userId: user.id });
    expect(result.status).toBe("invalid_transition");
  });

  it("valida el pago solo si el pedido está WAITING_RECEIPT y tiene comprobante", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    const user = await prisma.user.create({
      data: { companyId: company.id, email: `op-${Date.now()}@test.com`, passwordHash: "x", name: "Operador" },
    });

    const withoutReceipt = await createOrder(branch.id, company.id, { status: "WAITING_RECEIPT", receiptUrl: null });
    const resultWithout = await validateOrderPayment({ branchId: branch.id, orderId: withoutReceipt.id, userId: user.id });
    expect(resultWithout.status).toBe("invalid_transition");

    const withReceipt = await createOrder(branch.id, company.id, { status: "WAITING_RECEIPT", receiptUrl: "whatsapp/x.jpg" });
    const resultWith = await validateOrderPayment({ branchId: branch.id, orderId: withReceipt.id, userId: user.id });
    expect(resultWith.status).toBe("ok");
    if (resultWith.status === "ok") {
      expect(resultWith.order.status).toBe("PENDING");
      expect(resultWith.order.paymentValidated).toBe(true);
      expect(resultWith.order.paymentValidatedByUserId).toBe(user.id);
    }
  });

  it("cancela un pedido activo pero no uno ya entregado", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    const user = await prisma.user.create({
      data: { companyId: company.id, email: `op-${Date.now()}@test.com`, passwordHash: "x", name: "Operador" },
    });

    const active = await createOrder(branch.id, company.id, { status: "PREPARING" });
    const result = await cancelOrder({ branchId: branch.id, orderId: active.id, userId: user.id, reason: "No hay stock" });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.order.status).toBe("CANCELLED");
      expect(result.order.cancelledBy).toBe("COMPANY");
      expect(result.order.cancellationReason).toBe("No hay stock");
    }

    const delivered = await createOrder(branch.id, company.id, { status: "DELIVERED" });
    const resultDelivered = await cancelOrder({ branchId: branch.id, orderId: delivered.id, userId: user.id, reason: "x" });
    expect(resultDelivered.status).toBe("invalid_transition");
  });
});
