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

// Regresión del bug encontrado probando la Fase 3 en vivo: la IA a veces
// reemite un add_item de un producto que ya estaba en el pedido justo en el
// mismo mensaje donde confirma (al "resumirlo" en su reply), duplicando la
// cantidad — el cliente terminó viendo el doble del total acordado. La
// defensa es de código, no solo de prompt: nunca se confirma un pedido en
// el mismo turno en que se modificaron los ítems.
describe("applyActions — nunca confirma en el mismo turno en que se tocan los ítems", () => {
  const companiesToCleanup: string[] = [];

  afterAll(async () => {
    for (const companyId of companiesToCleanup) await cleanupCompany(companyId);
  });

  it("no crea el pedido si confirm_order llega junto con un add_item del mismo turno", async () => {
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

    const result = await applyActions({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491100000001",
      draft,
      actions: [
        { type: "add_item", productName: "Chipa", quantity: 10 },
        { type: "confirm_order" },
      ],
    });

    expect(result.orderCreated).toBe(false);
    expect(result.draft.items[0].quantity).toBe(20);
    expect(result.correctionNotes.some((note) => note.toLowerCase().includes("confirmame de nuevo"))).toBe(true);

    const orders = await prisma.order.findMany({ where: { branchId: branch.id } });
    expect(orders).toHaveLength(0);
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
