import { describe, it, expect } from "vitest";
import {
  extractExplicitPaymentMethodText,
  extractQuantityMentioned,
  extractTrailingPaymentMethodMention,
  isDraftEmpty,
  isDraftStale,
  isNewOrderIntentText,
  looksLikeConfirmationText,
  shouldClearDraftOnHandoverToAI,
} from "@/lib/orders/draft-step";
import { EMPTY_DRAFT_ORDER, type DraftOrderState } from "@/lib/validations/order-engine";

describe("isNewOrderIntentText", () => {
  it("detecta frases típicas de arrancar un pedido nuevo", () => {
    expect(isNewOrderIntentText("quiero pedir")).toBe(true);
    expect(isNewOrderIntentText("Quiero pedir algo")).toBe(true);
    expect(isNewOrderIntentText("quiero hacer un pedido")).toBe(true);
    expect(isNewOrderIntentText("Quiero hacer otro pedido")).toBe(true);
    expect(isNewOrderIntentText("necesito hacer un pedido porfa")).toBe(true);
    expect(isNewOrderIntentText("che, otro pedido")).toBe(true);
  });

  it("no detecta mensajes normales de armado de pedido", () => {
    expect(isNewOrderIntentText("una pizza muzzarella porfa")).toBe(false);
    expect(isNewOrderIntentText("nada más, gracias")).toBe(false);
    expect(isNewOrderIntentText("confirmo")).toBe(false);
  });
});

describe("looksLikeConfirmationText", () => {
  it("detecta confirmaciones explícitas típicas", () => {
    expect(looksLikeConfirmationText("Si, perfecto")).toBe(true);
    expect(looksLikeConfirmationText("dale")).toBe(true);
    expect(looksLikeConfirmationText("confirmo")).toBe(true);
    expect(looksLikeConfirmationText("ok")).toBe(true);
    expect(looksLikeConfirmationText("quedo bien")).toBe(true);
    expect(looksLikeConfirmationText("está bien así")).toBe(true);
  });

  it("no confunde una pregunta con una confirmación (bug real reportado)", () => {
    expect(looksLikeConfirmationText("nada mas. Cuanto es")).toBe(false);
    expect(looksLikeConfirmationText("cuánto sale")).toBe(false);
    expect(looksLikeConfirmationText("una torta de ricota porfa")).toBe(false);
  });

  it("detecta expresiones informales argentinas de acuerdo (caso real reportado)", () => {
    expect(looksLikeConfirmationText("impecable")).toBe(true);
    expect(looksLikeConfirmationText("buenísimo")).toBe(true);
    expect(looksLikeConfirmationText("buenisimo")).toBe(true);
    expect(looksLikeConfirmationText("genial")).toBe(true);
    expect(looksLikeConfirmationText("bárbaro")).toBe(true);
    expect(looksLikeConfirmationText("de una")).toBe(true);
    expect(looksLikeConfirmationText("sipi")).toBe(true);
    expect(looksLikeConfirmationText("sisi")).toBe(true);
  });
});

// Regresión de un bug real: devolverle el control a la IA desde "pausada"
// (AI_PAUSED → ACTIVE, ej. "Hablar con el cliente" y después "Reactivar
// IA") no vaciaba el borrador de la conversación — un ítem/domicilio que
// hubiera quedado de antes de la pausa resucitaba solo en el próximo
// pedido sin relación que armara la IA.
describe("shouldClearDraftOnHandoverToAI", () => {
  it("vacía el borrador al volver de 'necesita atención' o de 'pausada'", () => {
    expect(shouldClearDraftOnHandoverToAI("REQUIRES_ATTENTION", "ACTIVE")).toBe(true);
    expect(shouldClearDraftOnHandoverToAI("AI_PAUSED", "ACTIVE")).toBe(true);
  });

  it("no vacía nada si no se vuelve a ACTIVE, o si ya estaba activa", () => {
    expect(shouldClearDraftOnHandoverToAI("ACTIVE", "AI_PAUSED")).toBe(false);
    expect(shouldClearDraftOnHandoverToAI("ACTIVE", "ACTIVE")).toBe(false);
    expect(shouldClearDraftOnHandoverToAI("REQUIRES_ATTENTION", "AI_PAUSED")).toBe(false);
    expect(shouldClearDraftOnHandoverToAI("CLOSED", "ACTIVE")).toBe(false);
  });
});

// Regresión de un bug real: el cliente respondió "transferencia" sola, sin
// nada más, y la IA no llamó a set_payment_method — el sistema quedó
// pidiendo lo mismo en loop pese a que la respuesta era inequívoca.
describe("extractExplicitPaymentMethodText", () => {
  it("reconoce la palabra sola, con variantes y mayúsculas/minúsculas", () => {
    expect(extractExplicitPaymentMethodText("transferencia")).toBe("TRANSFER");
    expect(extractExplicitPaymentMethodText("Transferencia")).toBe("TRANSFER");
    expect(extractExplicitPaymentMethodText("transf")).toBe("TRANSFER");
    expect(extractExplicitPaymentMethodText("transferencia.")).toBe("TRANSFER");
    expect(extractExplicitPaymentMethodText("  transferencia  ")).toBe("TRANSFER");
    expect(extractExplicitPaymentMethodText("efectivo")).toBe("CASH");
    expect(extractExplicitPaymentMethodText("efec")).toBe("CASH");
  });

  it("no reconoce la palabra mezclada en una frase más larga (para no malinterpretar una negación)", () => {
    expect(extractExplicitPaymentMethodText("no quiero pagar por transferencia, prefiero efectivo")).toBeNull();
    expect(extractExplicitPaymentMethodText("con transferencia está bien")).toBeNull();
    expect(extractExplicitPaymentMethodText("una pizza muzzarella porfa")).toBeNull();
  });
});

// Regresión de un bug real: el cliente dio la dirección y el medio de pago
// en el mismo mensaje ("...1510, entre peron y barbieri. Transferencia"),
// la dirección falló la validación, y la IA nunca mandó "set_payment_method"
// — el dato se perdió, y el cliente tuvo que repetirlo varios mensajes
// después ("pago por transferencia te dije").
describe("extractTrailingPaymentMethodMention", () => {
  it("reconoce el medio de pago como última frase de un mensaje más largo", () => {
    expect(extractTrailingPaymentMethodMention("cid guidi de franc 1510, entre peron y barbieri. Transferencia")).toBe(
      "TRANSFER",
    );
    expect(extractTrailingPaymentMethodMention("Juan Pérez, mi domicilio es Falsa 123. efectivo")).toBe("CASH");
    expect(extractTrailingPaymentMethodMention("Falsa 123.\nTransferencia")).toBe("TRANSFER");
  });

  it("sigue reconociendo el mensaje que es nada más que la palabra (mismo criterio que la función base)", () => {
    expect(extractTrailingPaymentMethodMention("transferencia")).toBe("TRANSFER");
  });

  it("no reconoce nada si la última frase tiene más texto que la palabra sola (evita malinterpretar una negación)", () => {
    expect(extractTrailingPaymentMethodMention("no quiero pagar por transferencia, prefiero efectivo")).toBeNull();
    expect(extractTrailingPaymentMethodMention("con transferencia está bien")).toBeNull();
    expect(extractTrailingPaymentMethodMention("Falsa 123. mejor pago en efectivo")).toBeNull();
  });
});

describe("isDraftEmpty", () => {
  it("un borrador recién creado está vacío", () => {
    expect(isDraftEmpty(EMPTY_DRAFT_ORDER)).toBe(true);
  });

  it("cualquier dato real lo deja de considerar vacío", () => {
    expect(isDraftEmpty({ items: [{ productId: "1", productName: "Pizza", unitPriceCents: 100, quantity: 1 }] })).toBe(
      false,
    );
    expect(isDraftEmpty({ items: [], customerName: "Juan" })).toBe(false);
    expect(isDraftEmpty({ items: [], deliveryAddressRaw: "Calle 123" })).toBe(false);
    expect(isDraftEmpty({ items: [], paymentMethod: "CASH" })).toBe(false);
  });
});

// Regresión del "borrador fantasma": el bug de ítems que resucitaban solos
// en un pedido nuevo se reportó y se "arregló" tres veces seguidas, cada vez
// parchando un lugar puntual del código que no vaciaba el borrador al
// cambiar de estado (resolvesPendingDraft, AI_PAUSED→ACTIVE, CLOSED→ACTIVE)
// — y volvió a pasar una cuarta vez, con la conversación activa todo el
// tiempo (ningún cambio de estado de por medio). isDraftStale es la red de
// seguridad final: no importa POR QUÉ nadie limpió el borrador, si pasó más
// tiempo que el vencimiento configurado desde la última escritura, se lo
// descarta antes de seguir.
describe("isDraftStale", () => {
  const draftConItems: DraftOrderState = {
    items: [{ productId: "1", productName: "Pizza muzzarella", unitPriceCents: 450000, quantity: 1 }],
    deliveryAddressRaw: "Prof Cid Guidi de Franc 1510",
  };

  it("un borrador vacío nunca es 'viejo' (no hay nada que descartar)", () => {
    expect(
      isDraftStale({
        draft: EMPTY_DRAFT_ORDER,
        draftOrderUpdatedAt: new Date("2026-01-01T00:00:00Z"),
        expiryMinutes: 30,
        now: new Date("2026-06-01T00:00:00Z"),
      }),
    ).toBe(false);
  });

  it("sin fecha de última escritura, no se asume viejo (dato legado antes de esta protección)", () => {
    expect(
      isDraftStale({ draft: draftConItems, draftOrderUpdatedAt: null, expiryMinutes: 30, now: new Date() }),
    ).toBe(false);
  });

  it("un borrador recién tocado, aunque tenga datos, no es viejo", () => {
    const now = new Date("2026-03-10T12:30:00Z");
    const draftOrderUpdatedAt = new Date("2026-03-10T12:15:00Z"); // hace 15 min
    expect(isDraftStale({ draft: draftConItems, draftOrderUpdatedAt, expiryMinutes: 30, now })).toBe(false);
  });

  it("caso real reportado: un pedido sin confirmar (pizza + domicilio) sigue vivo pasado el vencimiento configurado, sin que la conversación haya cambiado de estado nunca — se descarta", () => {
    const now = new Date("2026-03-10T13:00:00Z");
    const draftOrderUpdatedAt = new Date("2026-03-10T12:00:00Z"); // hace 60 min
    expect(isDraftStale({ draft: draftConItems, draftOrderUpdatedAt, expiryMinutes: 30, now })).toBe(true);
  });

  it("justo en el límite todavía no es viejo; un instante después sí", () => {
    const draftOrderUpdatedAt = new Date("2026-03-10T12:00:00Z");
    expect(
      isDraftStale({
        draft: draftConItems,
        draftOrderUpdatedAt,
        expiryMinutes: 30,
        now: new Date("2026-03-10T12:30:00Z"),
      }),
    ).toBe(false);
    expect(
      isDraftStale({
        draft: draftConItems,
        draftOrderUpdatedAt,
        expiryMinutes: 30,
        now: new Date("2026-03-10T12:30:01Z"),
      }),
    ).toBe(true);
  });
});

describe("extractQuantityMentioned", () => {
  it("reconoce dígitos sueltos", () => {
    expect(extractQuantityMentioned("quiero 12 chipas")).toBe(12);
    expect(extractQuantityMentioned("mandame 2")).toBe(2);
  });

  it("reconoce docena y media docena (caso real: chipa se pide por docena)", () => {
    expect(extractQuantityMentioned("una docena de chipa")).toBe(12);
    expect(extractQuantityMentioned("Te pido una docena de chipa adicional")).toBe(12);
    expect(extractQuantityMentioned("media docena nomás")).toBe(6);
  });

  it("reconoce números en palabras del uno al diez", () => {
    expect(extractQuantityMentioned("una pizza porfa")).toBe(1);
    expect(extractQuantityMentioned("dale, mandame dos")).toBe(2);
    expect(extractQuantityMentioned("diez empanadas")).toBe(10);
  });

  it("devuelve null si no hay ningún número reconocible", () => {
    expect(extractQuantityMentioned("sisi, es esa")).toBeNull();
    expect(extractQuantityMentioned("Transferencia")).toBeNull();
    expect(extractQuantityMentioned("")).toBeNull();
  });
});
