import { describe, it, expect } from "vitest";
import { isNewOrderIntentText, looksLikeConfirmationText } from "@/lib/orders/draft-step";

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
