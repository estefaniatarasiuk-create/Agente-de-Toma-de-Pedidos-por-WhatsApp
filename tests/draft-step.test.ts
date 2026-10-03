import { describe, it, expect } from "vitest";
import {
  extractExplicitPaymentMethodText,
  isNewOrderIntentText,
  looksLikeConfirmationText,
  shouldClearDraftOnHandoverToAI,
} from "@/lib/orders/draft-step";

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
