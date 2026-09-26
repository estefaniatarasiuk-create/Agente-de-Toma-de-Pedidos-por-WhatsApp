import { describe, it, expect, afterAll, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { applyActions } from "@/lib/orders/apply-actions";
import { EMPTY_DRAFT_ORDER } from "@/lib/validations/order-engine";
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
    };

    // Mismo lugar (coordenadas casi idénticas), redactado distinto — no
    // tiene que contar como un cambio real que bloquee la confirmación.
    geocodeAddressMock.mockResolvedValueOnce({
      latitude: -34.6101,
      longitude: -58.37455,
      formattedAddress: "Av. de Mayo 700, CABA",
      partialMatch: false,
      isPreciseMatch: true,
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
describe("applyActions — avisa si el cliente paga en efectivo menos que el total", () => {
  const companiesToCleanup: string[] = [];

  afterAll(async () => {
    for (const companyId of companiesToCleanup) await cleanupCompany(companyId);
  });

  it("el mensaje de confirmación dice cuánto falta cobrar, no un vuelto inexistente", async () => {
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

    expect(result.orderCreated).toBe(true);
    const confirmedText = result.extras.find((extra) => extra.kind === "text")?.text ?? "";
    expect(confirmedText).toContain("todavía faltan");
    expect(confirmedText).toContain("1.300,00");
    expect(confirmedText).not.toContain("de cambio");
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

    const orders = await prisma.order.findMany({ where: { branchId: branch.id, customerPhone: "5491100000020" } });
    expect(orders).toHaveLength(1);
    expect(orders[0].status).toBe("PENDING");
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
