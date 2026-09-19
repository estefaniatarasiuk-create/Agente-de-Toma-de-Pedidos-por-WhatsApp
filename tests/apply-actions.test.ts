import { describe, it, expect, afterAll, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { applyActions } from "@/lib/orders/apply-actions";
import { EMPTY_DRAFT_ORDER } from "@/lib/validations/order-engine";
import { createTestCompanyAndBranch, cleanupCompany } from "./fixtures";

vi.mock("@/lib/geocoding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/geocoding")>();
  return { ...actual, geocodeAddress: vi.fn() };
});

const { geocodeAddress } = await import("@/lib/geocoding");
const geocodeAddressMock = vi.mocked(geocodeAddress);

// Regresión del otro bug que encontró el usuario en la Fase 1: el preview
// aceptaba una dirección lejos de la zona de entrega sin avisar. En el
// motor real (Fase 3), set_customer_info valida contra la zona configurada
// y, si está fuera de rango, corta el armado del pedido en curso.
describe("applyActions — set_customer_info fuera de zona", () => {
  const companiesToCleanup: string[] = [];

  afterAll(async () => {
    for (const companyId of companiesToCleanup) await cleanupCompany(companyId);
  });

  it("limpia el borrador y avisa cuando el domicilio está fuera de la zona de entrega", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);

    await prisma.deliveryZone.create({
      data: { companyId: company.id, branchId: branch.id, centerLatitude: -34.6083, centerLongitude: -58.3712, radiusKm: 5 },
    });
    const product = await prisma.product.create({
      data: { companyId: company.id, branchId: branch.id, name: "Hamburguesa", priceCents: 500000 },
    });

    geocodeAddressMock.mockResolvedValueOnce({
      latitude: -31.4201,
      longitude: -64.1888,
      formattedAddress: "Córdoba, Argentina",
      partialMatch: false,
      fromCache: false,
    });

    const draftWithItems = {
      ...EMPTY_DRAFT_ORDER,
      items: [{ productId: product.id, productName: product.name, unitPriceCents: product.priceCents, quantity: 1 }],
    };

    const result = await applyActions({
      companyId: company.id,
      branchId: branch.id,
      conversationId: "conv-test",
      customerPhone: "5491100000000",
      draft: draftWithItems,
      actions: [{ type: "set_customer_info", address: "San Martín 123, Córdoba" }],
    });

    expect(result.draft.items).toEqual([]);
    expect(result.draft.deliveryAddressRaw).toBeUndefined();
    expect(result.correctionNotes.some((note) => note.toLowerCase().includes("fuera de nuestra zona"))).toBe(true);
    expect(result.requiresHuman).toBe(false);
    expect(result.orderCreated).toBe(false);
  });
});

// Regresiones de dos bugs encontrados probando la Fase 3 en vivo con un
// pedido real de punta a punta:
//
// 1. "quantity" de add_item se FIJA (no se suma) al total ya existente. La
//    IA reemite la acción todo el tiempo al restatear el pedido (al
//    confirmarlo, agradecer, o retomar la conversación) — con semántica de
//    "sumar", cada repetición duplicaba/triplicaba la cantidad real (un
//    pedido de 9 Chipa terminó facturando 27). Con semántica de "fijar",
//    repetir el mismo total no hace nada.
// 2. Como defensa adicional, nunca se confirma un pedido en el mismo turno
//    en que la cantidad de algún ítem CAMBIÓ de verdad (no alcanza con que
//    la acción add_item esté presente: si fija el mismo total que ya
//    había, no cuenta como cambio).
describe("applyActions — add_item fija el total, no lo suma, y protege la confirmación", () => {
  const companiesToCleanup: string[] = [];

  afterAll(async () => {
    for (const companyId of companiesToCleanup) await cleanupCompany(companyId);
  });

  it("no crea el pedido si confirm_order llega junto con un cambio real de cantidad, y no lo suma sobre lo anterior", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);

    const product = await prisma.product.create({
      data: { companyId: company.id, branchId: branch.id, name: "Chipa", priceCents: 300000 },
    });
    await prisma.paymentMethodConfig.create({
      data: { companyId: company.id, branchId: branch.id, cashEnabled: true, transferEnabled: false },
    });
    const conversation = await prisma.conversation.create({
      data: { companyId: company.id, branchId: branch.id, customerPhone: "5491100000001" },
    });

    const draft = {
      items: [{ productId: product.id, productName: product.name, unitPriceCents: product.priceCents, quantity: 10 }],
      customerName: "Cliente Test",
      deliveryAddressRaw: "Calle Falsa 123",
      deliveryLatitude: -34.6,
      deliveryLongitude: -58.38,
      paymentMethod: "CASH" as const,
    };

    // El modelo manda 15 como el nuevo total (no como "sumale 15 más").
    const result = await applyActions({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491100000001",
      draft,
      actions: [
        { type: "add_item", productName: "Chipa", quantity: 15 },
        { type: "confirm_order" },
      ],
    });

    expect(result.orderCreated).toBe(false);
    expect(result.draft.items[0].quantity).toBe(15);
    expect(result.correctionNotes.some((note) => note.toLowerCase().includes("confirmame de nuevo"))).toBe(true);

    const orders = await prisma.order.findMany({ where: { branchId: branch.id } });
    expect(orders).toHaveLength(0);
  });

  it("sí crea el pedido si add_item repite el mismo total ya existente junto con confirm_order (no es un cambio real)", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);

    const product = await prisma.product.create({
      data: { companyId: company.id, branchId: branch.id, name: "Chipa", priceCents: 300000 },
    });
    await prisma.paymentMethodConfig.create({
      data: { companyId: company.id, branchId: branch.id, cashEnabled: true, transferEnabled: false },
    });
    const conversation = await prisma.conversation.create({
      data: { companyId: company.id, branchId: branch.id, customerPhone: "5491100000003" },
    });

    const draft = {
      items: [{ productId: product.id, productName: product.name, unitPriceCents: product.priceCents, quantity: 9 }],
      customerName: "Cliente Test",
      deliveryAddressRaw: "Calle Falsa 123",
      deliveryLatitude: -34.6,
      deliveryLongitude: -58.38,
      paymentMethod: "CASH" as const,
    };

    // El modelo "restatea" el pedido (mismo total: 9) en el mismo turno
    // donde confirma — no tiene que bloquearse ni duplicar la cantidad.
    const result = await applyActions({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491100000003",
      draft,
      actions: [
        { type: "add_item", productName: "Chipa", quantity: 9 },
        { type: "confirm_order" },
      ],
    });

    expect(result.orderCreated).toBe(true);
    const orders = await prisma.order.findMany({ where: { branchId: branch.id } });
    expect(orders).toHaveLength(1);
    expect(orders[0].totalCents).toBe(2700000);
  });

  it("sí crea el pedido cuando confirm_order llega solo, sin cambios de ítems en el mismo turno", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);

    const product = await prisma.product.create({
      data: { companyId: company.id, branchId: branch.id, name: "Chipa", priceCents: 300000 },
    });
    await prisma.paymentMethodConfig.create({
      data: { companyId: company.id, branchId: branch.id, cashEnabled: true, transferEnabled: false },
    });
    const conversation = await prisma.conversation.create({
      data: { companyId: company.id, branchId: branch.id, customerPhone: "5491100000002" },
    });

    const draft = {
      items: [{ productId: product.id, productName: product.name, unitPriceCents: product.priceCents, quantity: 10 }],
      customerName: "Cliente Test",
      deliveryAddressRaw: "Calle Falsa 123",
      deliveryLatitude: -34.6,
      deliveryLongitude: -58.38,
      paymentMethod: "CASH" as const,
    };

    const result = await applyActions({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491100000002",
      draft,
      actions: [{ type: "confirm_order" }],
    });

    expect(result.orderCreated).toBe(true);
    const orders = await prisma.order.findMany({ where: { branchId: branch.id } });
    expect(orders).toHaveLength(1);
    expect(orders[0].totalCents).toBe(3000000);
  });
});
