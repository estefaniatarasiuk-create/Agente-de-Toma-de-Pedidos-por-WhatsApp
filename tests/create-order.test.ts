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

// Regresión de un bug real reportado: después de confirmar un pedido, el
// cliente quiso corregir un dato menor (cuánto efectivo iba a pagar) — la
// IA, en vez de solo actualizar ese dato, rearmó TODO el pedido de cero
// (mismos productos) y lo confirmó de nuevo, duplicándolo en el tablero. Un
// pedido reciente con los mismos productos para el mismo cliente se
// actualiza en vez de crear una fila nueva.
describe("createOrderFromDraft — no duplica un pedido reciente con los mismos productos", () => {
  const companiesToCleanup: string[] = [];

  afterAll(async () => {
    for (const companyId of companiesToCleanup) await cleanupCompany(companyId);
  });

  it("actualiza el medio de pago del pedido reciente en vez de crear uno nuevo", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    const product = await prisma.product.create({
      data: { companyId: company.id, branchId: branch.id, name: "Chipa", priceCents: 300000 },
    });
    await prisma.paymentMethodConfig.create({
      data: { companyId: company.id, branchId: branch.id, cashEnabled: true, transferEnabled: false },
    });
    const conversation = await prisma.conversation.create({
      data: { companyId: company.id, branchId: branch.id, customerPhone: "5491133333333" },
    });

    const baseDraft = {
      items: [{ productId: product.id, productName: product.name, unitPriceCents: product.priceCents, quantity: 3 }],
      customerName: "Estefi",
      deliveryAddressRaw: "Calle Falsa 123, entre Rivadavia y San Martín",
      deliveryAddressNormalized: "Calle Falsa 123, CABA",
      deliveryLatitude: -34.6,
      deliveryLongitude: -58.38,
      paymentMethod: "CASH" as const,
      cashPaymentAmountCents: 2000, // el cliente dijo "20" queriendo decir $20.000
    };

    const first = await createOrderFromDraft({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491133333333",
      draft: baseDraft,
    });
    expect(first.status).toBe("created");

    // El cliente corrige el monto ("son 20 mil") y la IA rearma el pedido
    // completo de cero con los mismos productos pero el monto corregido —
    // y, en este caso real, con una dirección peor (reconstruida sin
    // entrecalles) que la que ya se había validado.
    const correctionDraft = {
      ...baseDraft,
      deliveryAddressRaw: "Villa Centenario, Buenos Aires Province, Argentina",
      deliveryAddressNormalized: "Villa Centenario, Buenos Aires Province, Argentina",
      cashPaymentAmountCents: 2000000,
    };

    const second = await createOrderFromDraft({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491133333333",
      draft: correctionDraft,
    });

    expect(second.status).toBe("created");
    if (second.status === "created" && first.status === "created") {
      // Mismo pedido actualizado, no uno nuevo.
      expect(second.order.id).toBe(first.order.id);
      expect(second.order.cashPaymentAmountCents).toBe(2000000);
      // El domicilio original (mejor, validado) nunca se pisa con la
      // reconstrucción peor de la IA.
      expect(second.order.deliveryAddressRaw).toBe(baseDraft.deliveryAddressRaw);
    }

    const orders = await prisma.order.findMany({ where: { branchId: branch.id, customerPhone: "5491133333333" } });
    expect(orders).toHaveLength(1);
  });

  it("sí crea un pedido nuevo si los productos son distintos", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    const product = await prisma.product.create({
      data: { companyId: company.id, branchId: branch.id, name: "Chipa", priceCents: 300000 },
    });
    const otherProduct = await prisma.product.create({
      data: { companyId: company.id, branchId: branch.id, name: "Coca Cola 1.5L", priceCents: 280000 },
    });
    await prisma.paymentMethodConfig.create({
      data: { companyId: company.id, branchId: branch.id, cashEnabled: true, transferEnabled: false },
    });
    const conversation = await prisma.conversation.create({
      data: { companyId: company.id, branchId: branch.id, customerPhone: "5491144444444" },
    });

    const draftBase = {
      customerName: "Cliente Test",
      deliveryAddressRaw: "Calle Falsa 123",
      deliveryLatitude: -34.6,
      deliveryLongitude: -58.38,
      paymentMethod: "CASH" as const,
    };

    const first = await createOrderFromDraft({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491144444444",
      draft: {
        ...draftBase,
        items: [{ productId: product.id, productName: product.name, unitPriceCents: product.priceCents, quantity: 3 }],
      },
    });
    expect(first.status).toBe("created");

    const second = await createOrderFromDraft({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491144444444",
      draft: {
        ...draftBase,
        items: [
          { productId: otherProduct.id, productName: otherProduct.name, unitPriceCents: otherProduct.priceCents, quantity: 1 },
        ],
      },
    });
    expect(second.status).toBe("created");
    if (second.status === "created" && first.status === "created") {
      expect(second.order.id).not.toBe(first.order.id);
    }

    const orders = await prisma.order.findMany({ where: { branchId: branch.id, customerPhone: "5491144444444" } });
    expect(orders).toHaveLength(2);
  });
});
