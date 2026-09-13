import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { createOrderFromDraft } from "@/lib/orders/create-order";
import { createTestCompanyAndBranch, cleanupCompany } from "./fixtures";

describe("createOrderFromDraft — pedido feliz en efectivo", () => {
  const companiesToCleanup: string[] = [];

  afterAll(async () => {
    for (const companyId of companiesToCleanup) await cleanupCompany(companyId);
  });

  it("crea el pedido con status PENDING, recalcula el total desde el catálogo y calcula el vuelto", async () => {
    const { company, branch } = await createTestCompanyAndBranch({ currentDelayMinutes: 35 });
    companiesToCleanup.push(company.id);

    const product = await prisma.product.create({
      data: { companyId: company.id, branchId: branch.id, name: "Pizza Muzzarella", priceCents: 850000 },
    });
    await prisma.paymentMethodConfig.create({
      data: { companyId: company.id, branchId: branch.id, cashEnabled: true, transferEnabled: false },
    });
    const conversation = await prisma.conversation.create({
      data: { companyId: company.id, branchId: branch.id, customerPhone: "5491111111111" },
    });

    const result = await createOrderFromDraft({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491111111111",
      draft: {
        items: [{ productId: product.id, productName: product.name, unitPriceCents: 1, quantity: 2 }],
        customerName: "Juan Pérez",
        deliveryAddressRaw: "Calle Falsa 123, entre Rivadavia y San Martín",
        deliveryLatitude: -34.6,
        deliveryLongitude: -58.38,
        paymentMethod: "CASH",
        cashPaymentAmountCents: 2000000,
      },
    });

    expect(result.status).toBe("created");
    if (result.status !== "created") return;

    // El precio unitario del draft (1 centavo, como si el modelo lo hubiera
    // inventado) se ignora por completo: el total sale del catálogo real.
    expect(result.totalCents).toBe(850000 * 2);
    expect(result.order.status).toBe("PENDING");
    expect(result.order.paymentMethod).toBe("CASH");
    expect(result.changeAmountCents).toBe(2000000 - 850000 * 2);

    const items = await prisma.orderItem.findMany({ where: { orderId: result.order.id } });
    expect(items).toHaveLength(1);
    expect(items[0].unitPriceCents).toBe(850000);

    const statusEvents = await prisma.orderStatusEvent.findMany({ where: { orderId: result.order.id } });
    expect(statusEvents).toHaveLength(1);
    expect(statusEvents[0].toStatus).toBe("PENDING");
  });

  it("devuelve missing_info si falta algún dato obligatorio", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    const conversation = await prisma.conversation.create({
      data: { companyId: company.id, branchId: branch.id, customerPhone: "5491122222222" },
    });

    const result = await createOrderFromDraft({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491122222222",
      draft: { items: [] },
    });

    expect(result.status).toBe("missing_info");
    if (result.status === "missing_info") {
      expect(result.missing).toContain("productos");
      expect(result.missing).toContain("nombre");
      expect(result.missing).toContain("medio de pago");
    }
  });
});
