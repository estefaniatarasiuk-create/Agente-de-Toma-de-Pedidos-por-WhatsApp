import { describe, it, expect, afterAll, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { applyActions } from "@/lib/orders/apply-actions";
import { EMPTY_DRAFT_ORDER } from "@/lib/validations/order-engine";
import { formatCentsAsArs } from "@/lib/money";
import { createTestCompanyAndBranch, cleanupCompany } from "./fixtures";

vi.mock("@/lib/geocoding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/geocoding")>();
  return { ...actual, geocodeAddress: vi.fn(), reverseGeocodeLocality: vi.fn() };
});

const { geocodeAddress, reverseGeocodeLocality } = await import("@/lib/geocoding");
const geocodeAddressMock = vi.mocked(geocodeAddress);
const reverseGeocodeLocalityMock = vi.mocked(reverseGeocodeLocality);

// Regresión de un bug real reportado en la Fase 4: una dirección mal escrita
// o incompleta (ej. "guidi de franc 1510" sin el "Cid" de "Cid Guidi de
// Franc") podía geocodificar lejos y devolver "fuera de zona" aunque el
// domicilio real del cliente sí estuviera en zona — y antes, eso vaciaba
// TODO el borrador (productos, nombre, medio de pago incluidos), haciendo
// perder un pedido entero ya armado por un solo dato mal escrito. Ahora
// "fuera de zona" solo limpia el domicilio, igual que cualquier otro dato
// inválido — nunca el resto de lo que el cliente ya había dado.
describe("applyActions — set_customer_info fuera de zona", () => {
  const companiesToCleanup: string[] = [];

  afterAll(async () => {
    for (const companyId of companiesToCleanup) await cleanupCompany(companyId);
  });

  it("solo limpia el domicilio y avisa, sin borrar el resto del pedido ya armado", async () => {
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
      isPreciseMatch: true,
      hasStreetNumber: true,
      fromCache: false,
    });

    const draftWithItems = {
      ...EMPTY_DRAFT_ORDER,
      items: [{ productId: product.id, productName: product.name, unitPriceCents: product.priceCents, quantity: 1 }],
      customerName: "Cliente Test",
      paymentMethod: "CASH" as const,
    };

    const result = await applyActions({
      companyId: company.id,
      branchId: branch.id,
      conversationId: "conv-test",
      customerPhone: "5491100000000",
      draft: draftWithItems,
      actions: [{ type: "set_customer_info", address: "San Martín 123, Córdoba" }],
    });

    expect(result.draft.items).toEqual(draftWithItems.items);
    expect(result.draft.customerName).toBe("Cliente Test");
    expect(result.draft.paymentMethod).toBe("CASH");
    expect(result.draft.deliveryAddressRaw).toBeUndefined();
    expect(result.correctionNotes.some((note) => note.toLowerCase().includes("fuera de nuestra zona"))).toBe(true);
    expect(result.requiresHuman).toBe(false);
    expect(result.orderCreated).toBe(false);
  });
});

// Pedido explícito del usuario: si la dirección da "fuera de zona" en la
// primera pasada, pero restringiendo la búsqueda a la localidad del local
// encontramos algo parecido DENTRO de la zona, se le propone al cliente en
// vez de rechazarla de plano o aceptarla en silencio.
describe("applyActions — propone una corrección de domicilio en vez de rechazarlo de plano", () => {
  const companiesToCleanup: string[] = [];

  afterAll(async () => {
    for (const companyId of companiesToCleanup) await cleanupCompany(companyId);
  });

  it("propone la dirección encontrada en la localidad del local y no confirma el pedido todavía", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    await prisma.deliveryZone.create({
      data: { companyId: company.id, branchId: branch.id, centerLatitude: -34.6083, centerLongitude: -58.3712, radiusKm: 5 },
    });
    const product = await prisma.product.create({
      data: { companyId: company.id, branchId: branch.id, name: "Chipa", priceCents: 300000 },
    });
    const conversation = await prisma.conversation.create({
      data: { companyId: company.id, branchId: branch.id, customerPhone: "5491100000015" },
    });

    // Primera pasada (sin restringir a la localidad): resuelve lejos.
    geocodeAddressMock.mockResolvedValueOnce({
      latitude: -31.4201,
      longitude: -64.1888,
      formattedAddress: "Guidi de Franc, Córdoba, Argentina",
      partialMatch: false,
      isPreciseMatch: true,
      hasStreetNumber: true,
      fromCache: false,
    });
    reverseGeocodeLocalityMock.mockResolvedValueOnce("Villa Centenario");
    // Reintento restringido a la localidad: resuelve cerca, dentro de zona,
    // y a nivel de calle puntual (no solo el centro de la localidad).
    geocodeAddressMock.mockResolvedValueOnce({
      latitude: -34.61,
      longitude: -58.3745,
      formattedAddress: "Cid Guidi de Franc 1510, Villa Centenario, Argentina",
      partialMatch: false,
      isPreciseMatch: true,
      hasStreetNumber: true,
      fromCache: false,
    });

    const draft = {
      items: [{ productId: product.id, productName: product.name, unitPriceCents: product.priceCents, quantity: 1 }],
      customerName: "Cliente Test",
      paymentMethod: "CASH" as const,
    };

    const result = await applyActions({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491100000015",
      draft,
      actions: [{ type: "set_customer_info", address: "guidi de franc 1510" }],
    });

    expect(result.draft.deliveryAddressRaw).toBeUndefined();
    expect(result.draft.pendingAddressSuggestion?.formattedAddress).toBe("Cid Guidi de Franc 1510, Villa Centenario, Argentina");
    expect(result.correctionNotes.some((note) => note.includes("¿Quisiste decir"))).toBe(true);
    expect(result.orderCreated).toBe(false);
  });

  it("acepta la propuesta si el cliente responde algo que suena a un sí, sin repetir la dirección", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    await prisma.deliveryZone.create({
      data: { companyId: company.id, branchId: branch.id, centerLatitude: -34.6083, centerLongitude: -58.3712, radiusKm: 5 },
    });
    const product = await prisma.product.create({
      data: { companyId: company.id, branchId: branch.id, name: "Chipa", priceCents: 300000 },
    });
    await prisma.paymentMethodConfig.create({
      data: { companyId: company.id, branchId: branch.id, cashEnabled: true, transferEnabled: false },
    });
    const conversation = await prisma.conversation.create({
      data: { companyId: company.id, branchId: branch.id, customerPhone: "5491100000016" },
    });

    const draftWithSuggestion = {
      items: [{ productId: product.id, productName: product.name, unitPriceCents: product.priceCents, quantity: 1 }],
      customerName: "Cliente Test",
      paymentMethod: "CASH" as const,
      pendingAddressSuggestion: {
        formattedAddress: "Cid Guidi de Franc 1510, Villa Centenario, Argentina",
        latitude: -34.61,
        longitude: -58.3745,
      },
    };

    const result = await applyActions({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491100000016",
      draft: draftWithSuggestion,
      actions: [],
      customerMessageText: "si, es esa",
    });

    expect(result.draft.pendingAddressSuggestion).toBeUndefined();
    expect(result.draft.deliveryAddressRaw).toBe("Cid Guidi de Franc 1510, Villa Centenario, Argentina");
    expect(result.draft.deliveryLatitude).toBe(-34.61);
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
    // Bug real reportado: el mensaje de bloqueo decía "fijate que quedó
    // bien" sin mostrar nada para revisar — ahora incluye el resumen
    // actualizado (15x Chipa, no el 10 original) en el mismo mensaje.
    expect(result.correctionNotes.some((note) => note.includes("15x Chipa"))).toBe(true);

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
      cashPaymentAmountCents: 3000000,
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
      customerMessageText: "confirmo",
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
      cashPaymentAmountCents: 3000000,
    };

    const result = await applyActions({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491100000002",
      draft,
      actions: [{ type: "confirm_order" }],
      customerMessageText: "confirmo",
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
      cashPaymentAmountCents: 3000000,
    };

    const firstResult = await applyActions({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491100000004",
      draft: firstDraft,
      actions: [{ type: "confirm_order" }],
      customerMessageText: "confirmo",
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
      actions: [{ type: "set_payment_method", method: "CASH", cashAmount: 20000 }, { type: "confirm_order" }],
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
      customerMessageText: "confirmo",
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

// Regresión de un caso real: la IA le mostró al cliente un resumen del
// pedido (productos, total, medio de pago) y le pidió confirmar SIN haberle
// pedido nunca el domicilio de entrega — el pedido en realidad nunca estuvo
// completo. Con el mensaje genérico anterior ("¡Ya tengo todos los datos!"),
// el cliente confirmaba una y otra vez sin enterarse de que faltaba algo.
// Ahora el mensaje de bloqueo nombra el dato puntual que falta.
describe("applyActions — el mensaje de confirmación bloqueada dice qué falta de verdad", () => {
  const companiesToCleanup: string[] = [];

  afterAll(async () => {
    for (const companyId of companiesToCleanup) await cleanupCompany(companyId);
  });

  it("avisa que falta el domicilio en vez de decir que ya tiene todos los datos", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    const product = await prisma.product.create({
      data: { companyId: company.id, branchId: branch.id, name: "Empanada de carne", priceCents: 60000 },
    });
    await prisma.paymentMethodConfig.create({
      data: { companyId: company.id, branchId: branch.id, cashEnabled: true, transferEnabled: true },
    });
    const conversation = await prisma.conversation.create({
      data: { companyId: company.id, branchId: branch.id, customerPhone: "5491100000010" },
    });

    // El pedido tiene productos, nombre y medio de pago, pero NUNCA se
    // cargó el domicilio — igual que en el caso real reportado.
    const draftMissingAddress = {
      items: [{ productId: product.id, productName: product.name, unitPriceCents: product.priceCents, quantity: 1 }],
      customerName: "Estefanía",
      paymentMethod: "TRANSFER" as const,
    };

    const result = await applyActions({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491100000010",
      draft: draftMissingAddress,
      actions: [{ type: "confirm_order" }],
    });

    expect(result.orderCreated).toBe(false);
    expect(result.correctionNotes.some((note) => note.includes("tu domicilio de entrega"))).toBe(true);
    expect(result.correctionNotes.some((note) => note.includes("Ya tengo todos los datos"))).toBe(false);
  });
});

// Regresión del bug más grave reportado en la Fase 4: un cliente confirmó un
// pedido completo TRES veces seguidas ("Si ya abone" → "Ok" → "Confirmo el
// pedido") y el sistema nunca lo registró — cada intento chocaba con la
// misma defensa de código (confirm_order bloqueado) y quedaba pidiendo
// "confirmame de nuevo" para siempre. Bloquear estaba bien para evitar
// duplicar datos, pero rebotar sin salida es peor: el negocio pierde el
// pedido por completo. A partir del 3er intento fallido seguido, se deriva
// a un humano (que ya puede resolverlo desde el panel) en vez de insistir.
describe("applyActions — deriva a un humano si confirm_order se bloquea repetidas veces seguidas", () => {
  const companiesToCleanup: string[] = [];

  afterAll(async () => {
    for (const companyId of companiesToCleanup) await cleanupCompany(companyId);
  });

  it("deriva a atención humana en el 3er confirm_order bloqueado seguido, sin crear el pedido", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    const product = await prisma.product.create({
      data: { companyId: company.id, branchId: branch.id, name: "Chipa", priceCents: 300000 },
    });
    await prisma.paymentMethodConfig.create({
      data: { companyId: company.id, branchId: branch.id, cashEnabled: true, transferEnabled: true },
    });
    const conversation = await prisma.conversation.create({
      data: { companyId: company.id, branchId: branch.id, customerPhone: "5491100000008" },
    });

    // Pedido YA completo, pero cada turno la IA reemite set_payment_method
    // (aunque el cliente solo está confirmando) — cada intento se bloquea.
    const draft = {
      items: [{ productId: product.id, productName: product.name, unitPriceCents: product.priceCents, quantity: 5 }],
      customerName: "Cliente Test",
      deliveryAddressRaw: "Calle Falsa 123",
      deliveryLatitude: -34.6,
      deliveryLongitude: -58.38,
      paymentMethod: "CASH" as const,
    };

    const first = await applyActions({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491100000008",
      draft,
      actions: [{ type: "set_payment_method", method: "TRANSFER" }, { type: "confirm_order" }],
    });
    expect(first.orderCreated).toBe(false);
    expect(first.requiresHuman).toBe(false);
    expect(first.draft.confirmAttempts).toBe(1);

    const second = await applyActions({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491100000008",
      draft: first.draft,
      actions: [{ type: "set_payment_method", method: "CASH" }, { type: "confirm_order" }],
    });
    expect(second.orderCreated).toBe(false);
    expect(second.requiresHuman).toBe(false);
    expect(second.draft.confirmAttempts).toBe(2);

    const third = await applyActions({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491100000008",
      draft: second.draft,
      actions: [{ type: "set_payment_method", method: "TRANSFER" }, { type: "confirm_order" }],
    });
    expect(third.orderCreated).toBe(false);
    expect(third.requiresHuman).toBe(true);

    const orders = await prisma.order.findMany({ where: { branchId: branch.id } });
    expect(orders).toHaveLength(0);
  });

  it("reinicia el contador de intentos si el cliente avanza el pedido en vez de intentar confirmar", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    const product = await prisma.product.create({
      data: { companyId: company.id, branchId: branch.id, name: "Chipa", priceCents: 300000 },
    });
    await prisma.paymentMethodConfig.create({
      data: { companyId: company.id, branchId: branch.id, cashEnabled: true, transferEnabled: true },
    });
    const conversation = await prisma.conversation.create({
      data: { companyId: company.id, branchId: branch.id, customerPhone: "5491100000009" },
    });

    const draft = {
      items: [{ productId: product.id, productName: product.name, unitPriceCents: product.priceCents, quantity: 5 }],
      customerName: "Cliente Test",
      deliveryAddressRaw: "Calle Falsa 123",
      deliveryLatitude: -34.6,
      deliveryLongitude: -58.38,
      paymentMethod: "CASH" as const,
      confirmAttempts: 2,
    };

    const result = await applyActions({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491100000009",
      draft,
      actions: [{ type: "add_item", productName: "Chipa", quantity: 6 }],
    });

    expect(result.requiresHuman).toBe(false);
    expect(result.draft.confirmAttempts).toBe(0);
  });
});

// Regresión: la IA reemite set_customer_info con la misma dirección (a
// veces redactada un poco distinto) casi cada vez que resume el pedido. Se
// compara por coordenadas, no por texto, para no tratarlo como un cambio
// real. Pedido del usuario: en vez de un mensaje aparte ("Anoté tu
// domicilio como...") cada vez que se valida una dirección, el domicilio ya
// normalizado se muestra directamente en el resumen del pedido.
describe("applyActions — el domicilio validado no se vuelve a contar como cambio si sigue siendo el mismo lugar", () => {
  const companiesToCleanup: string[] = [];

  afterAll(async () => {
    for (const companyId of companiesToCleanup) await cleanupCompany(companyId);
  });

  it("guarda el domicilio normalizado en el borrador, sin mandar un mensaje aparte", async () => {
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
      isPreciseMatch: true,
      hasStreetNumber: true,
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
    expect(first.draft.deliveryAddressNormalized).toBe("Av. de Mayo 700, CABA");
    expect(first.extras.some((extra) => extra.kind === "text" && extra.text.includes("Anoté tu domicilio"))).toBe(false);
  });

  it("no bloquea confirm_order por el domicilio si la nueva geocodificación cae muy cerca de la anterior", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    await prisma.deliveryZone.create({
      data: { companyId: company.id, branchId: branch.id, centerLatitude: -34.6083, centerLongitude: -58.3712, radiusKm: 5 },
    });
    const product = await prisma.product.create({
      data: { companyId: company.id, branchId: branch.id, name: "Chipa", priceCents: 300000 },
    });
    await prisma.paymentMethodConfig.create({
      data: { companyId: company.id, branchId: branch.id, cashEnabled: true, transferEnabled: false },
    });
    const conversation = await prisma.conversation.create({
      data: { companyId: company.id, branchId: branch.id, customerPhone: "5491100000014" },
    });

    const draftReady = {
      items: [{ productId: product.id, productName: product.name, unitPriceCents: product.priceCents, quantity: 1 }],
      customerName: "Cliente Test",
      deliveryAddressRaw: "Av. de Mayo 700, entre Perón y Bolívar",
      deliveryAddressNormalized: "Av. de Mayo 700, CABA",
      deliveryLatitude: -34.61,
      deliveryLongitude: -58.3745,
      paymentMethod: "CASH" as const,
      cashPaymentAmountCents: 500000,
    };

    // Mismo lugar (coordenadas casi idénticas), redactado distinto — no
    // tiene que contar como un cambio real que bloquee la confirmación.
    geocodeAddressMock.mockResolvedValueOnce({
      latitude: -34.6101,
      longitude: -58.37455,
      formattedAddress: "Av. de Mayo 700, CABA",
      partialMatch: false,
      isPreciseMatch: true,
      hasStreetNumber: true,
      fromCache: false,
    });
    const result = await applyActions({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491100000014",
      draft: draftReady,
      actions: [{ type: "set_customer_info", address: "Av. de Mayo 700" }, { type: "confirm_order" }],
      customerMessageText: "dale, confirmo",
    });

    expect(result.orderCreated).toBe(true);
    expect(result.extras.some((extra) => extra.kind === "text" && extra.text.includes("Anoté tu domicilio"))).toBe(false);
  });
});

// Regresión de un caso real: el cliente escribió "nada más. Cuánto es" — una
// pregunta por el total, no una confirmación — y la IA igual incluyó
// confirm_order. Como el pedido ya estaba completo y sin cambios en ese
// turno, ninguna otra defensa lo detectó y el pedido se registró sin que el
// cliente lo hubiera pedido de verdad. Ahora confirm_order exige que el
// mensaje del cliente suene a una confirmación real.
describe("applyActions — no confirma si el cliente no dijo nada que suene a una confirmación", () => {
  const companiesToCleanup: string[] = [];

  afterAll(async () => {
    for (const companyId of companiesToCleanup) await cleanupCompany(companyId);
  });

  it("no crea el pedido si el mensaje del cliente es una pregunta, no una confirmación", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    const product = await prisma.product.create({
      data: { companyId: company.id, branchId: branch.id, name: "Chipa", priceCents: 300000 },
    });
    await prisma.paymentMethodConfig.create({
      data: { companyId: company.id, branchId: branch.id, cashEnabled: true, transferEnabled: false },
    });
    const conversation = await prisma.conversation.create({
      data: { companyId: company.id, branchId: branch.id, customerPhone: "5491100000012" },
    });

    const draft = {
      items: [{ productId: product.id, productName: product.name, unitPriceCents: product.priceCents, quantity: 2 }],
      customerName: "Cliente Test",
      deliveryAddressRaw: "Calle Falsa 123",
      deliveryLatitude: -34.6,
      deliveryLongitude: -58.38,
      paymentMethod: "CASH" as const,
      cashPaymentAmountCents: 1000000,
    };

    const result = await applyActions({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491100000012",
      draft,
      actions: [{ type: "confirm_order" }],
      customerMessageText: "nada mas. Cuanto es",
    });

    expect(result.orderCreated).toBe(false);
    // No es un intento fallido del cliente: no debe sumar al contador de
    // escalamiento (la IA actuó de más, el cliente no hizo nada mal).
    expect(result.draft.confirmAttempts ?? 0).toBe(0);
    const orders = await prisma.order.findMany({ where: { branchId: branch.id } });
    expect(orders).toHaveLength(0);
  });

  it("sí crea el pedido si el cliente responde con algo que suena a confirmación", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    const product = await prisma.product.create({
      data: { companyId: company.id, branchId: branch.id, name: "Chipa", priceCents: 300000 },
    });
    await prisma.paymentMethodConfig.create({
      data: { companyId: company.id, branchId: branch.id, cashEnabled: true, transferEnabled: false },
    });
    const conversation = await prisma.conversation.create({
      data: { companyId: company.id, branchId: branch.id, customerPhone: "5491100000013" },
    });

    const draft = {
      items: [{ productId: product.id, productName: product.name, unitPriceCents: product.priceCents, quantity: 2 }],
      customerName: "Cliente Test",
      deliveryAddressRaw: "Calle Falsa 123",
      deliveryLatitude: -34.6,
      deliveryLongitude: -58.38,
      paymentMethod: "CASH" as const,
      cashPaymentAmountCents: 1000000,
    };

    const result = await applyActions({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491100000013",
      draft,
      actions: [{ type: "confirm_order" }],
      customerMessageText: "Si, perfecto",
    });

    expect(result.orderCreated).toBe(true);
  });
});

// Regresión de un caso real: el cliente dijo que iba a pagar en efectivo
// con MENOS plata que el total del pedido ($1.500 sobre un total de
// $2.800). La IA calculó mal el vuelto en su propio texto ("te da un
// cambio de $700", matemática invertida — en realidad faltaban $1.300),
// pero el sistema nunca avisaba la diferencia real a nadie. Ahora el
// mensaje de confirmación (el oficial, generado en código) avisa
// explícitamente cuánto falta cobrar en vez de quedarse callado.
// Regresión de un bug real reportado: el cliente respondió "10" a "¿con
// cuánto vas a abonar?" (total $3.000) y el sistema confirmó el pedido
// igual, avisando RECIÉN en el mensaje de confirmación final que faltaba
// plata — demasiado tarde, el pedido ya había quedado mal armado. Pedido
// explícito del usuario: si el efectivo declarado no alcanza, hay que
// pedirle que ponga el valor correcto ANTES de confirmar, nunca aceptarlo
// con un aviso después del hecho.
describe("applyActions — no confirma un pedido en efectivo si el monto declarado no alcanza", () => {
  const companiesToCleanup: string[] = [];

  afterAll(async () => {
    for (const companyId of companiesToCleanup) await cleanupCompany(companyId);
  });

  it("bloquea confirm_order y pide el monto correcto, mostrando el total real y lo que el cliente dijo", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    const product = await prisma.product.create({
      data: { companyId: company.id, branchId: branch.id, name: "Coca Cola 1.5L", priceCents: 280000 },
    });
    await prisma.paymentMethodConfig.create({
      data: { companyId: company.id, branchId: branch.id, cashEnabled: true, transferEnabled: false },
    });
    const conversation = await prisma.conversation.create({
      data: { companyId: company.id, branchId: branch.id, customerPhone: "5491100000011" },
    });

    const draft = {
      items: [{ productId: product.id, productName: product.name, unitPriceCents: product.priceCents, quantity: 1 }],
      customerName: "Cliente Test",
      deliveryAddressRaw: "Calle Falsa 123",
      deliveryLatitude: -34.6,
      deliveryLongitude: -58.38,
      paymentMethod: "CASH" as const,
      cashPaymentAmountCents: 150000,
    };

    const result = await applyActions({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491100000011",
      draft,
      actions: [{ type: "confirm_order" }],
      customerMessageText: "confirmo",
    });

    expect(result.orderCreated).toBe(false);
    const note = result.correctionNotes.join("\n");
    expect(note).toContain("no alcanza");
    expect(note).toContain(formatCentsAsArs(150000));
    expect(note).toContain(formatCentsAsArs(280000));
    const orders = await prisma.order.findMany({ where: { branchId: branch.id } });
    expect(orders).toHaveLength(0);
  });

  it("confirma una vez que el cliente corrige el monto a uno que sí alcanza", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    const product = await prisma.product.create({
      data: { companyId: company.id, branchId: branch.id, name: "Coca Cola 1.5L", priceCents: 280000 },
    });
    await prisma.paymentMethodConfig.create({
      data: { companyId: company.id, branchId: branch.id, cashEnabled: true, transferEnabled: false },
    });
    const conversation = await prisma.conversation.create({
      data: { companyId: company.id, branchId: branch.id, customerPhone: "5491100000046" },
    });

    const draft = {
      items: [{ productId: product.id, productName: product.name, unitPriceCents: product.priceCents, quantity: 1 }],
      customerName: "Cliente Test",
      deliveryAddressRaw: "Calle Falsa 123",
      deliveryLatitude: -34.6,
      deliveryLongitude: -58.38,
      paymentMethod: "CASH" as const,
      cashPaymentAmountCents: 150000,
    };

    // El cliente se dio cuenta y corrigió ("en realidad son 5 mil") — el
    // sistema deja confirmar sin problema una vez que el monto alcanza.
    const corrected = await applyActions({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491100000046",
      draft,
      actions: [{ type: "set_payment_method", method: "CASH", cashAmount: 5000 }],
    });
    expect(corrected.draft.cashPaymentAmountCents).toBe(500000);

    const result = await applyActions({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491100000046",
      draft: corrected.draft,
      actions: [{ type: "confirm_order" }],
      customerMessageText: "confirmo",
    });

    expect(result.orderCreated).toBe(true);
    const orders = await prisma.order.findMany({ where: { branchId: branch.id, customerPhone: "5491100000046" } });
    expect(orders).toHaveLength(1);
    expect(orders[0].cashPaymentAmountCents).toBe(500000);
  });
});

// Pedido explícito del usuario (mejora al panel de operación): si un
// cliente que ya tiene un pedido activo (sin entregar) confirma algo
// DISTINTO a ese pedido, no se arma un segundo pedido separado por su
// cuenta — se deriva a una persona para que lo sume al pedido original
// desde el panel, en vez de duplicar pedidos de un mismo cliente.
describe("applyActions — deriva a un humano en vez de duplicar el pedido si el cliente ya tiene uno activo", () => {
  const companiesToCleanup: string[] = [];

  afterAll(async () => {
    for (const companyId of companiesToCleanup) await cleanupCompany(companyId);
  });

  async function createActiveOrder(params: {
    companyId: string;
    branchId: string;
    conversationId: string;
    customerPhone: string;
    productId: string;
    productName: string;
    unitPriceCents: number;
  }) {
    return prisma.order.create({
      data: {
        companyId: params.companyId,
        branchId: params.branchId,
        conversationId: params.conversationId,
        customerPhone: params.customerPhone,
        customerName: "Cliente Test",
        deliveryAddressRaw: "Calle Falsa 123",
        status: "PENDING",
        paymentMethod: "CASH",
        subtotalCents: params.unitPriceCents,
        totalCents: params.unitPriceCents,
        delayMinutesAtOrder: 30,
        estimatedDeliveryAt: new Date(Date.now() + 30 * 60_000),
        items: {
          create: [
            {
              companyId: params.companyId,
              branchId: params.branchId,
              productId: params.productId,
              productName: params.productName,
              unitPriceCents: params.unitPriceCents,
              quantity: 1,
              subtotalCents: params.unitPriceCents,
            },
          ],
        },
      },
    });
  }

  it("no arma un segundo pedido con productos distintos: deriva y preserva el borrador para que el panel lo sume", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    const chipa = await prisma.product.create({
      data: { companyId: company.id, branchId: branch.id, name: "Chipa", priceCents: 300000 },
    });
    const coca = await prisma.product.create({
      data: { companyId: company.id, branchId: branch.id, name: "Coca Cola 1.5L", priceCents: 280000 },
    });
    await prisma.paymentMethodConfig.create({
      data: { companyId: company.id, branchId: branch.id, cashEnabled: true, transferEnabled: false },
    });
    const conversation = await prisma.conversation.create({
      data: { companyId: company.id, branchId: branch.id, customerPhone: "5491100000020" },
    });
    await createActiveOrder({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491100000020",
      productId: chipa.id,
      productName: chipa.name,
      unitPriceCents: chipa.priceCents,
    });

    // El cliente pide algo DISTINTO (una Coca, no otra Chipa) mientras el
    // pedido de Chipa sigue activo.
    const draft = {
      items: [{ productId: coca.id, productName: coca.name, unitPriceCents: coca.priceCents, quantity: 1 }],
      customerName: "Cliente Test",
      deliveryAddressRaw: "Calle Falsa 123",
      deliveryLatitude: -34.6,
      deliveryLongitude: -58.38,
      paymentMethod: "CASH" as const,
      cashPaymentAmountCents: 300000,
    };

    const result = await applyActions({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491100000020",
      draft,
      actions: [{ type: "confirm_order" }],
      customerMessageText: "confirmo",
    });

    expect(result.orderCreated).toBe(false);
    expect(result.requiresHuman).toBe(true);
    expect(result.preserveDraftOnEscalation).toBe(true);
    // El borrador con la Coca NO se limpia — es justo lo que el panel
    // necesita mostrar para que el personal lo sume al pedido de Chipa.
    expect(result.draft.items).toEqual(draft.items);
    // Pedido explícito del usuario: el aviso de derivación tiene que
    // mostrar el total combinado (pedido activo $3.000 + lo nuevo $2.800)
    // y, como el pedido activo es en efectivo, volver a pedir con cuánto
    // paga en total para poder calcular bien el vuelto.
    expect(result.correctionNotes.some((note) => note.includes(formatCentsAsArs(580000)))).toBe(true);
    expect(result.correctionNotes.some((note) => note.includes("con cuánto vas a pagar en total"))).toBe(true);

    const orders = await prisma.order.findMany({ where: { branchId: branch.id, customerPhone: "5491100000020" } });
    expect(orders).toHaveLength(1);
    expect(orders[0].status).toBe("PENDING");
  });

  it("no pide reconfirmar el efectivo si el pedido activo es por transferencia", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    const chipa = await prisma.product.create({
      data: { companyId: company.id, branchId: branch.id, name: "Chipa", priceCents: 300000 },
    });
    const coca = await prisma.product.create({
      data: { companyId: company.id, branchId: branch.id, name: "Coca Cola 1.5L", priceCents: 280000 },
    });
    await prisma.paymentMethodConfig.create({
      data: { companyId: company.id, branchId: branch.id, cashEnabled: true, transferEnabled: true },
    });
    const conversation = await prisma.conversation.create({
      data: { companyId: company.id, branchId: branch.id, customerPhone: "5491100000045" },
    });
    const activeOrder = await createActiveOrder({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491100000045",
      productId: chipa.id,
      productName: chipa.name,
      unitPriceCents: chipa.priceCents,
    });
    await prisma.order.update({ where: { id: activeOrder.id }, data: { paymentMethod: "TRANSFER" } });

    const draft = {
      items: [{ productId: coca.id, productName: coca.name, unitPriceCents: coca.priceCents, quantity: 1 }],
      customerName: "Cliente Test",
      deliveryAddressRaw: "Calle Falsa 123",
      deliveryLatitude: -34.6,
      deliveryLongitude: -58.38,
      paymentMethod: "TRANSFER" as const,
    };

    const result = await applyActions({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491100000045",
      draft,
      actions: [{ type: "confirm_order" }],
      customerMessageText: "confirmo",
    });

    expect(result.requiresHuman).toBe(true);
    expect(result.correctionNotes.some((note) => note.includes(formatCentsAsArs(580000)))).toBe(true);
    expect(result.correctionNotes.some((note) => note.includes("con cuánto vas a pagar en total"))).toBe(false);
  });

  it("no deriva si es una corrección del mismo pedido (mismos ítems) — sigue el merge silencioso normal", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    const chipa = await prisma.product.create({
      data: { companyId: company.id, branchId: branch.id, name: "Chipa", priceCents: 300000 },
    });
    await prisma.paymentMethodConfig.create({
      data: { companyId: company.id, branchId: branch.id, cashEnabled: true, transferEnabled: false },
    });
    const conversation = await prisma.conversation.create({
      data: { companyId: company.id, branchId: branch.id, customerPhone: "5491100000021" },
    });
    await createActiveOrder({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491100000021",
      productId: chipa.id,
      productName: chipa.name,
      unitPriceCents: chipa.priceCents,
    });

    // Mismos ítems que el pedido activo (ej. el cliente corrige el monto en
    // efectivo, no está pidiendo algo nuevo) — esto NO tiene que derivar.
    const draft = {
      items: [{ productId: chipa.id, productName: chipa.name, unitPriceCents: chipa.priceCents, quantity: 1 }],
      customerName: "Cliente Test",
      deliveryAddressRaw: "Calle Falsa 123",
      deliveryLatitude: -34.6,
      deliveryLongitude: -58.38,
      paymentMethod: "CASH" as const,
      cashPaymentAmountCents: 2000000,
    };

    const result = await applyActions({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491100000021",
      draft,
      actions: [{ type: "confirm_order" }],
      customerMessageText: "confirmo",
    });

    expect(result.requiresHuman).toBe(false);
    expect(result.orderCreated).toBe(true);
    // Se actualizó el pedido existente (merge silencioso de
    // create-order.ts), no se creó uno nuevo.
    const orders = await prisma.order.findMany({ where: { branchId: branch.id, customerPhone: "5491100000021" } });
    expect(orders).toHaveLength(1);
    expect(orders[0].cashPaymentAmountCents).toBe(2000000);
  });
});

// Regresión de un bug real reportado: el cliente eligió transferencia justo
// en el mismo mensaje en el que la dirección que dio necesitaba una
// corrección ("Barbieri y Namuncurá") — el sistema le mandó los datos
// bancarios de una y le preguntó por la dirección en otro mensaje aparte, en
// vez de resolver primero el problema pendiente y recién después hablar de
// pago. También se reportó que, al confirmar la dirección sugerida en el
// turno siguiente (donde la IA reemite set_payment_method con TRANSFER
// porque ya estaba establecido), los datos bancarios se repetían de nuevo.
describe("applyActions — no manda los datos bancarios si queda un problema sin resolver en el mismo turno", () => {
  const companiesToCleanup: string[] = [];

  afterAll(async () => {
    for (const companyId of companiesToCleanup) await cleanupCompany(companyId);
  });

  it("no incluye los datos bancarios si la dirección del mismo turno necesita una corrección", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    await prisma.deliveryZone.create({
      data: { companyId: company.id, branchId: branch.id, centerLatitude: -34.6083, centerLongitude: -58.3712, radiusKm: 5 },
    });
    const product = await prisma.product.create({
      data: { companyId: company.id, branchId: branch.id, name: "Chipa", priceCents: 300000 },
    });
    await prisma.paymentMethodConfig.create({
      data: {
        companyId: company.id,
        branchId: branch.id,
        cashEnabled: true,
        transferEnabled: true,
        transferAlias: "negocio.mp",
        transferCbu: "0000000000000000000000",
        transferHolder: "Negocio SA",
      },
    });
    const conversation = await prisma.conversation.create({
      data: { companyId: company.id, branchId: branch.id, customerPhone: "5491100000040" },
    });

    // Misma mecánica que el test de "propone una corrección de domicilio":
    // primera pasada resuelve lejos, el reintento restringido a la
    // localidad resuelve cerca, dentro de zona.
    geocodeAddressMock.mockResolvedValueOnce({
      latitude: -31.4201,
      longitude: -64.1888,
      formattedAddress: "Barbieri, Córdoba, Argentina",
      partialMatch: false,
      isPreciseMatch: true,
      hasStreetNumber: true,
      fromCache: false,
    });
    reverseGeocodeLocalityMock.mockResolvedValueOnce("Villa Centenario");
    geocodeAddressMock.mockResolvedValueOnce({
      latitude: -34.61,
      longitude: -58.3745,
      formattedAddress: "Barbieri y Namuncurá, Villa Centenario, Argentina",
      partialMatch: false,
      isPreciseMatch: true,
      hasStreetNumber: true,
      fromCache: false,
    });

    const draft = {
      items: [{ productId: product.id, productName: product.name, unitPriceCents: product.priceCents, quantity: 2 }],
      customerName: "Cliente Test",
    };

    const result = await applyActions({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491100000040",
      draft,
      // El texto incluye un número para llegar hasta la geocodificación y
      // ejercitar el flujo de "suggested_correction" — el chequeo de
      // altura por texto (sin NINGÚN dígito) se prueba aparte.
      actions: [
        { type: "set_customer_info", address: "Barbieri y Namuncurá, altura 1500 aprox" },
        { type: "set_payment_method", method: "TRANSFER" },
      ],
    });

    expect(result.draft.pendingAddressSuggestion).toBeDefined();
    expect(result.correctionNotes.some((note) => note.includes("No encontré esa dirección tal cual"))).toBe(true);
    expect(result.draft.paymentMethod).toBe("TRANSFER");
    const sentBankDetails = result.extras.some(
      (extra) => extra.kind === "text" && extra.text.includes("estos son los datos de la cuenta"),
    );
    expect(sentBankDetails).toBe(false);
  });

  it("manda los datos bancarios una sola vez: no se repiten cuando el turno siguiente reconfirma la dirección y reemite TRANSFER sin ningún otro problema", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    await prisma.deliveryZone.create({
      data: { companyId: company.id, branchId: branch.id, centerLatitude: -34.6083, centerLongitude: -58.3712, radiusKm: 5 },
    });
    const product = await prisma.product.create({
      data: { companyId: company.id, branchId: branch.id, name: "Chipa", priceCents: 300000 },
    });
    await prisma.paymentMethodConfig.create({
      data: {
        companyId: company.id,
        branchId: branch.id,
        cashEnabled: true,
        transferEnabled: true,
        transferAlias: "negocio.mp",
        transferCbu: "0000000000000000000000",
        transferHolder: "Negocio SA",
      },
    });
    const conversation = await prisma.conversation.create({
      data: { companyId: company.id, branchId: branch.id, customerPhone: "5491100000041" },
    });

    const draftFirstTurn = {
      items: [{ productId: product.id, productName: product.name, unitPriceCents: product.priceCents, quantity: 2 }],
      customerName: "Cliente Test",
      deliveryAddressRaw: "Calle Falsa 123",
      deliveryLatitude: -34.6,
      deliveryLongitude: -58.38,
    };

    // Primer turno: elige transferencia por primera vez, sin ningún otro
    // problema pendiente — acá SÍ tiene que mandar los datos bancarios.
    const first = await applyActions({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491100000041",
      draft: draftFirstTurn,
      actions: [{ type: "set_payment_method", method: "TRANSFER" }],
    });
    expect(first.draft.paymentMethod).toBe("TRANSFER");
    expect(
      first.extras.some((extra) => extra.kind === "text" && extra.text.includes("estos son los datos de la cuenta")),
    ).toBe(true);

    // Segundo turno: la IA reemite set_payment_method con TRANSFER (ya
    // establecido desde el turno anterior) junto con la confirmación —
    // no tiene que volver a mandar los datos bancarios.
    const second = await applyActions({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491100000041",
      draft: first.draft,
      actions: [{ type: "set_payment_method", method: "TRANSFER" }, { type: "confirm_order" }],
      customerMessageText: "sisi, confirmo",
    });
    expect(
      second.extras.some((extra) => extra.kind === "text" && extra.text.includes("estos son los datos de la cuenta")),
    ).toBe(false);
  });
});

// Regresión de un bug real reportado: el cliente dio un cruce de calles sin
// altura ("namuncura y barbieri") y el sistema lo aceptó como domicilio
// válido, sin pedir nunca el número de puerta — el repartidor no tenía con
// qué número entregar.
describe("applyActions — set_customer_info con un cruce de calles sin altura", () => {
  const companiesToCleanup: string[] = [];

  afterAll(async () => {
    for (const companyId of companiesToCleanup) await cleanupCompany(companyId);
  });

  it("pide la altura en vez de aceptar el domicilio, y no deja confirmar el pedido", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    await prisma.deliveryZone.create({
      data: { companyId: company.id, branchId: branch.id, centerLatitude: -34.6083, centerLongitude: -58.3712, radiusKm: 5 },
    });
    const product = await prisma.product.create({
      data: { companyId: company.id, branchId: branch.id, name: "Chipa", priceCents: 300000 },
    });
    await prisma.paymentMethodConfig.create({
      data: { companyId: company.id, branchId: branch.id, cashEnabled: true, transferEnabled: true },
    });
    const conversation = await prisma.conversation.create({
      data: { companyId: company.id, branchId: branch.id, customerPhone: "5491100000042" },
    });

    // El texto del cliente no tiene NI UN dígito — el chequeo de altura
    // por texto (zone-validation.ts) corta antes de llamar a geocodificar,
    // así que no hace falta mockear ninguna respuesta de Google acá.
    const draft = {
      items: [{ productId: product.id, productName: product.name, unitPriceCents: product.priceCents, quantity: 1 }],
      customerName: "Estefania",
    };

    const result = await applyActions({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491100000042",
      draft,
      actions: [{ type: "set_customer_info", address: "namuncura y barbieri" }],
    });

    expect(result.draft.deliveryAddressRaw).toBeUndefined();
    expect(result.draft.pendingAddressSuggestion).toBeUndefined();
    expect(result.correctionNotes.some((note) => note.includes("me falta la altura"))).toBe(true);
    expect(result.orderCreated).toBe(false);
    expect(geocodeAddressMock).not.toHaveBeenCalled();
  });
});

// Regresión de un bug real reportado: el cliente eligió efectivo, respondió
// "10" a la pregunta de con cuánto iba a pagar, pero la IA no capturó ese
// número como "cashAmount" e igual intentó confirmar el pedido — se
// registró (en otro intento posterior) sin ningún monto de efectivo, sin
// poder calcular vuelto ni mostrarlo en el tablero de pedidos.
describe("applyActions — no confirma un pedido en efectivo sin el monto con el que paga", () => {
  const companiesToCleanup: string[] = [];

  afterAll(async () => {
    for (const companyId of companiesToCleanup) await cleanupCompany(companyId);
  });

  it("bloquea confirm_order y pide el monto de efectivo si method es CASH sin cashAmount", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    const product = await prisma.product.create({
      data: { companyId: company.id, branchId: branch.id, name: "Chipa", priceCents: 300000 },
    });
    await prisma.paymentMethodConfig.create({
      data: { companyId: company.id, branchId: branch.id, cashEnabled: true, transferEnabled: true },
    });
    const conversation = await prisma.conversation.create({
      data: { companyId: company.id, branchId: branch.id, customerPhone: "5491100000043" },
    });

    const draft = {
      items: [{ productId: product.id, productName: product.name, unitPriceCents: product.priceCents, quantity: 1 }],
      customerName: "Estefania",
      deliveryAddressRaw: "Calle Falsa 123",
      deliveryLatitude: -34.6,
      deliveryLongitude: -58.38,
      paymentMethod: "CASH" as const,
      // cashPaymentAmountCents nunca se cargó — igual que en el caso real.
    };

    const result = await applyActions({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491100000043",
      draft,
      actions: [{ type: "confirm_order" }],
      customerMessageText: "10",
    });

    expect(result.orderCreated).toBe(false);
    expect(result.correctionNotes.some((note) => note.includes("con cuánto efectivo vas a pagar"))).toBe(true);
    const orders = await prisma.order.findMany({ where: { branchId: branch.id } });
    expect(orders).toHaveLength(0);
  });

  it("permite confirmar una vez que se captura el monto de efectivo, y lo guarda en el pedido", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    const product = await prisma.product.create({
      data: { companyId: company.id, branchId: branch.id, name: "Chipa", priceCents: 300000 },
    });
    await prisma.paymentMethodConfig.create({
      data: { companyId: company.id, branchId: branch.id, cashEnabled: true, transferEnabled: true },
    });
    const conversation = await prisma.conversation.create({
      data: { companyId: company.id, branchId: branch.id, customerPhone: "5491100000044" },
    });

    const draftReady = {
      items: [{ productId: product.id, productName: product.name, unitPriceCents: product.priceCents, quantity: 1 }],
      customerName: "Estefania",
      deliveryAddressRaw: "Calle Falsa 123",
      deliveryLatitude: -34.6,
      deliveryLongitude: -58.38,
      paymentMethod: "CASH" as const,
    };

    // Turno en el que el cliente responde "10.000" a la pregunta de con
    // cuánto va a pagar: la IA captura el monto en el mismo turno.
    const first = await applyActions({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491100000044",
      draft: draftReady,
      actions: [{ type: "set_payment_method", method: "CASH", cashAmount: 10000 }],
      customerMessageText: "10.000",
    });
    expect(first.draft.cashPaymentAmountCents).toBe(1000000);

    const second = await applyActions({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491100000044",
      draft: first.draft,
      actions: [{ type: "confirm_order" }],
      customerMessageText: "confirmo",
    });

    expect(second.orderCreated).toBe(true);
    const orders = await prisma.order.findMany({ where: { branchId: branch.id, customerPhone: "5491100000044" } });
    expect(orders).toHaveLength(1);
    expect(orders[0].cashPaymentAmountCents).toBe(1000000);
  });
});

// Regresión de un bug real: el cliente respondió "transferencia" sola, sin
// nada más, a la pregunta de medio de pago — y la IA no incluyó
// set_payment_method en ese turno. El sistema quedó pidiendo lo mismo en
// loop ("todavía me falta cómo vas a pagar") pese a que la respuesta del
// cliente era inequívoca. Último respaldo: si el turno no trae ningún
// set_payment_method y el mensaje es, textualmente, nada más que
// "efectivo" o "transferencia", se aplica directo.
describe("applyActions — reconoce 'transferencia'/'efectivo' solos aunque la IA no haya mandado set_payment_method", () => {
  const companiesToCleanup: string[] = [];

  afterAll(async () => {
    for (const companyId of companiesToCleanup) await cleanupCompany(companyId);
  });

  it("aplica TRANSFER y manda los datos bancarios si la IA se olvidó de set_payment_method", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    const product = await prisma.product.create({
      data: { companyId: company.id, branchId: branch.id, name: "Chipa", priceCents: 300000 },
    });
    await prisma.paymentMethodConfig.create({
      data: { companyId: company.id, branchId: branch.id, cashEnabled: true, transferEnabled: true },
    });
    const conversation = await prisma.conversation.create({
      data: { companyId: company.id, branchId: branch.id, customerPhone: "5491100000047" },
    });

    const draft = {
      items: [{ productId: product.id, productName: product.name, unitPriceCents: product.priceCents, quantity: 1 }],
      customerName: "Cliente Test",
      deliveryAddressRaw: "Calle Falsa 123",
      deliveryLatitude: -34.6,
      deliveryLongitude: -58.38,
    };

    const result = await applyActions({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491100000047",
      draft,
      actions: [],
      customerMessageText: "transferencia",
    });

    expect(result.draft.paymentMethod).toBe("TRANSFER");
    expect(
      result.extras.some((extra) => extra.kind === "text" && extra.text.includes("estos son los datos de la cuenta")),
    ).toBe(true);
  });

  it("aplica CASH si el mensaje es solo 'efectivo'", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    const product = await prisma.product.create({
      data: { companyId: company.id, branchId: branch.id, name: "Chipa", priceCents: 300000 },
    });
    await prisma.paymentMethodConfig.create({
      data: { companyId: company.id, branchId: branch.id, cashEnabled: true, transferEnabled: true },
    });
    const conversation = await prisma.conversation.create({
      data: { companyId: company.id, branchId: branch.id, customerPhone: "5491100000048" },
    });

    const draft = {
      items: [{ productId: product.id, productName: product.name, unitPriceCents: product.priceCents, quantity: 1 }],
      customerName: "Cliente Test",
      deliveryAddressRaw: "Calle Falsa 123",
      deliveryLatitude: -34.6,
      deliveryLongitude: -58.38,
    };

    const result = await applyActions({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491100000048",
      draft,
      actions: [],
      customerMessageText: "efectivo",
    });

    expect(result.draft.paymentMethod).toBe("CASH");
  });

  it("no hace nada si la IA ya mandó set_payment_method en el mismo turno (no duplica el trabajo)", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    const product = await prisma.product.create({
      data: { companyId: company.id, branchId: branch.id, name: "Chipa", priceCents: 300000 },
    });
    await prisma.paymentMethodConfig.create({
      data: { companyId: company.id, branchId: branch.id, cashEnabled: true, transferEnabled: false },
    });
    const conversation = await prisma.conversation.create({
      data: { companyId: company.id, branchId: branch.id, customerPhone: "5491100000049" },
    });

    const draft = {
      items: [{ productId: product.id, productName: product.name, unitPriceCents: product.priceCents, quantity: 1 }],
      customerName: "Cliente Test",
      deliveryAddressRaw: "Calle Falsa 123",
      deliveryLatitude: -34.6,
      deliveryLongitude: -58.38,
    };

    // El medio de pago que pide el cliente en texto está deshabilitado,
    // pero la IA ya mandó set_payment_method con CASH (habilitado) — el
    // respaldo no tiene que pisar esa decisión.
    const result = await applyActions({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491100000049",
      draft,
      actions: [{ type: "set_payment_method", method: "CASH" }],
      customerMessageText: "transferencia",
    });

    expect(result.draft.paymentMethod).toBe("CASH");
  });

  it("no interpreta la palabra si viene dentro de una frase más larga (evita malinterpretar una negación)", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    const product = await prisma.product.create({
      data: { companyId: company.id, branchId: branch.id, name: "Chipa", priceCents: 300000 },
    });
    await prisma.paymentMethodConfig.create({
      data: { companyId: company.id, branchId: branch.id, cashEnabled: true, transferEnabled: true },
    });
    const conversation = await prisma.conversation.create({
      data: { companyId: company.id, branchId: branch.id, customerPhone: "5491100000050" },
    });

    const draft = {
      items: [{ productId: product.id, productName: product.name, unitPriceCents: product.priceCents, quantity: 1 }],
      customerName: "Cliente Test",
      deliveryAddressRaw: "Calle Falsa 123",
      deliveryLatitude: -34.6,
      deliveryLongitude: -58.38,
    };

    const result = await applyActions({
      companyId: company.id,
      branchId: branch.id,
      conversationId: conversation.id,
      customerPhone: "5491100000050",
      draft,
      actions: [],
      customerMessageText: "no quiero pagar por transferencia, prefiero efectivo",
    });

    expect(result.draft.paymentMethod).toBeUndefined();
  });
});
