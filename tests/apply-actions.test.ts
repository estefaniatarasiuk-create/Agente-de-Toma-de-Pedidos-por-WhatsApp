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

// Pedido del usuario: "asegurar que si un pedido ya fue marcado como
// enviado o entregado, no se sume a un próximo pedido que se haga". El
// borrador se limpia al CONFIRMAR (no al entregar), así que un pedido
// nuevo nunca puede heredar ítems de uno anterior, sea cual sea su estado.
describe("applyActions — un pedido nuevo nunca hereda ítems de uno previo ya entregado", () => {
  const companiesToCleanup: string[] = [];

  afterAll(async () => {
    for (const companyId of companiesToCleanup) await cleanupCompany(companyId);
  });

  it("el borrador que devuelve confirm_order queda vacío, y sigue vacío aunque el pedido anterior ya se haya entregado", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);

    const product = await prisma.product.create({
      data: { companyId: company.id, branchId: branch.id, name: "Chipa", priceCents: 300000 },
    });
    await prisma.paymentMethodConfig.create({
      data: { companyId: company.id, branchId: branch.id, cashEnabled: true, transferEnabled: false },
    });
    const conversation = await prisma.conversation.create({
      data: { companyId: company.id, branchId: branch.id, customerPhone: "5491100000004" },
    });

    const firstDraft = {
      items: [{ productId: product.id, productName: product.name, unitPriceCents: product.priceCents, quantity: 10 }],
      customerName: "Cliente Test",
      deliveryAddressRaw: "Calle Falsa 123",
      deliveryLatitude: -34.6,
      deliveryLongitude: -58.38,
      paymentMethod: "CASH" as const,
    };

    const firstResult = await applyActions({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491100000004",
      draft: firstDraft,
      actions: [{ type: "confirm_order" }],
    });
    expect(firstResult.orderCreated).toBe(true);
    expect(firstResult.draft.items).toEqual([]);

    // El primer pedido se marca como entregado (como haría el tablero de la Fase 4).
    const firstOrder = await prisma.order.findFirstOrThrow({ where: { branchId: branch.id } });
    await prisma.order.update({ where: { id: firstOrder.id }, data: { status: "DELIVERED", deliveredAt: new Date() } });

    // El cliente arma un pedido nuevo, arrancando del borrador que quedó (vacío) tras confirmar el primero.
    const secondResult = await applyActions({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491100000004",
      draft: firstResult.draft,
      actions: [{ type: "add_item", productName: "Chipa", quantity: 2 }],
    });

    expect(secondResult.draft.items).toEqual([
      { productId: product.id, productName: product.name, unitPriceCents: product.priceCents, quantity: 2 },
    ]);
  });
});

// Regresión del bug encontrado probando la Fase 4 en vivo: un cliente real
// confirmó un pedido completo varias veces y el sistema nunca lo registró
// porque la IA no incluía confirm_order pese a decir que sí. Reforzar el
// prompt no alcanzó del todo — acá se prueba la defensa de código: no
// alcanza con que el pedido esté completo, tiene que haber estado completo
// ANTES de este turno (la confirmación tiene que ser un mensaje aparte del
// que completó el último dato).
describe("applyActions — confirm_order exige un turno aparte del que completó el pedido", () => {
  const companiesToCleanup: string[] = [];

  afterAll(async () => {
    for (const companyId of companiesToCleanup) await cleanupCompany(companyId);
  });

  it("no confirma si el pedido recién se completó en este mismo turno", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    const product = await prisma.product.create({
      data: { companyId: company.id, branchId: branch.id, name: "Chipa", priceCents: 300000 },
    });
    await prisma.paymentMethodConfig.create({
      data: { companyId: company.id, branchId: branch.id, cashEnabled: true, transferEnabled: false },
    });
    const conversation = await prisma.conversation.create({
      data: { companyId: company.id, branchId: branch.id, customerPhone: "5491100000005" },
    });

    // Draft incompleto (falta medio de pago) al empezar el turno — el
    // cliente lo completa Y la IA (de más) intenta confirmar en el mismo mensaje.
    const draftMissingPayment = {
      items: [{ productId: product.id, productName: product.name, unitPriceCents: product.priceCents, quantity: 5 }],
      customerName: "Cliente Test",
      deliveryAddressRaw: "Calle Falsa 123",
      deliveryLatitude: -34.6,
      deliveryLongitude: -58.38,
    };

    const result = await applyActions({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491100000005",
      draft: draftMissingPayment,
      actions: [{ type: "set_payment_method", method: "CASH" }, { type: "confirm_order" }],
    });

    expect(result.orderCreated).toBe(false);
    expect(result.draft.paymentMethod).toBe("CASH");
    const orders = await prisma.order.findMany({ where: { branchId: branch.id } });
    expect(orders).toHaveLength(0);

    // En el turno SIGUIENTE, con el pedido ya completo desde el arranque, sí confirma.
    const secondResult = await applyActions({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491100000005",
      draft: result.draft,
      actions: [{ type: "confirm_order" }],
    });
    expect(secondResult.orderCreated).toBe(true);
  });

  it("no confirma si el cliente cambia un medio de pago YA establecido en el mismo turno (bug real reportado en la Fase 4)", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    const product = await prisma.product.create({
      data: { companyId: company.id, branchId: branch.id, name: "Chipa", priceCents: 300000 },
    });
    await prisma.paymentMethodConfig.create({
      data: { companyId: company.id, branchId: branch.id, cashEnabled: true, transferEnabled: true },
    });
    const conversation = await prisma.conversation.create({
      data: { companyId: company.id, branchId: branch.id, customerPhone: "5491100000007" },
    });

    // Pedido YA completo, con pago en efectivo — igual que en el reporte real,
    // el cliente solo pide cambiar el medio de pago, no confirma nada.
    const draftReady = {
      items: [{ productId: product.id, productName: product.name, unitPriceCents: product.priceCents, quantity: 5 }],
      customerName: "Estefanía",
      deliveryAddressRaw: "Calle Falsa 123",
      deliveryLatitude: -34.6,
      deliveryLongitude: -58.38,
      paymentMethod: "CASH" as const,
    };

    const result = await applyActions({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491100000007",
      draft: draftReady,
      actions: [{ type: "set_payment_method", method: "TRANSFER" }, { type: "confirm_order" }],
    });

    expect(result.orderCreated).toBe(false);
    expect(result.draft.paymentMethod).toBe("TRANSFER");
    const orders = await prisma.order.findMany({ where: { branchId: branch.id } });
    expect(orders).toHaveLength(0);
  });
});

// Regresión: la IA reemite set_customer_info con la misma dirección (a
// veces redactada un poco distinto) casi cada vez que resume el pedido —
// sin este fix, cada repetición volvía a mandar "Anoté tu domicilio
// como...", generando spam. Se compara por coordenadas, no por texto.
describe("applyActions — no repite la confirmación de domicilio si sigue siendo el mismo lugar", () => {
  const companiesToCleanup: string[] = [];

  afterAll(async () => {
    for (const companyId of companiesToCleanup) await cleanupCompany(companyId);
  });

  it("no vuelve a mandar el aviso de domicilio si la nueva geocodificación cae muy cerca de la anterior", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    await prisma.deliveryZone.create({
      data: { companyId: company.id, branchId: branch.id, centerLatitude: -34.6083, centerLongitude: -58.3712, radiusKm: 5 },
    });
    const conversation = await prisma.conversation.create({
      data: { companyId: company.id, branchId: branch.id, customerPhone: "5491100000006" },
    });

    geocodeAddressMock.mockResolvedValueOnce({
      latitude: -34.61,
      longitude: -58.3745,
      formattedAddress: "Av. de Mayo 700, CABA",
      partialMatch: false,
      fromCache: false,
    });
    const first = await applyActions({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491100000006",
      draft: EMPTY_DRAFT_ORDER,
      actions: [{ type: "set_customer_info", address: "Av. de Mayo 700, entre Perón y Bolívar" }],
    });
    expect(first.extras.some((extra) => extra.kind === "text" && extra.text.includes("Anoté tu domicilio"))).toBe(true);

    // Mismo lugar (coordenadas casi idénticas), redactado distinto.
    geocodeAddressMock.mockResolvedValueOnce({
      latitude: -34.6101,
      longitude: -58.37455,
      formattedAddress: "Av. de Mayo 700, CABA",
      partialMatch: false,
      fromCache: false,
    });
    const second = await applyActions({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491100000006",
      draft: first.draft,
      actions: [{ type: "set_customer_info", address: "Av. de Mayo 700" }],
    });
    expect(second.extras.some((extra) => extra.kind === "text" && extra.text.includes("Anoté tu domicilio"))).toBe(false);
  });
});
