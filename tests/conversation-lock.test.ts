import { describe, it, expect } from "vitest";
import { withConversationLock } from "@/lib/orders/conversation-lock";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Regresión de un bug real: dos mensajes de WhatsApp del mismo cliente
// llegando casi juntos ("una torta de ricota" y, un segundo después,
// "hay?") se procesaban en paralelo — el segundo turno leía el borrador
// ANTES de que el primero terminara de guardar el suyo, y la IA respondía
// con algo inventado (que un producto recién agregado "no estaba
// disponible"). El lock por conversación tiene que garantizar que el
// segundo turno arranca recién cuando el primero terminó del todo.
describe("withConversationLock", () => {
  it("serializa llamadas para la misma conversación (nunca corren en simultáneo)", async () => {
    const events: string[] = [];

    const first = withConversationLock("conv-1", async () => {
      events.push("first:start");
      await sleep(30);
      events.push("first:end");
    });

    // Arranca "casi al mismo tiempo" que el primero, como pasaría con dos
    // webhooks de Meta llegando con segundos de diferencia.
    await sleep(5);
    const second = withConversationLock("conv-1", async () => {
      events.push("second:start");
      await sleep(5);
      events.push("second:end");
    });

    await Promise.all([first, second]);

    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("no serializa conversaciones distintas entre sí", async () => {
    const events: string[] = [];

    const a = withConversationLock("conv-a", async () => {
      events.push("a:start");
      await sleep(30);
      events.push("a:end");
    });
    const b = withConversationLock("conv-b", async () => {
      events.push("b:start");
      await sleep(5);
      events.push("b:end");
    });

    await Promise.all([a, b]);

    // "b" no tiene por qué esperar a que termine "a" — corren en paralelo.
    expect(events.indexOf("b:end")).toBeLessThan(events.indexOf("a:end"));
  });

  it("una falla en un turno no deja trabada la conversación para el siguiente", async () => {
    const events: string[] = [];

    const failing = withConversationLock("conv-2", async () => {
      events.push("failing");
      throw new Error("falla simulada");
    });

    await expect(failing).rejects.toThrow("falla simulada");

    const next = withConversationLock("conv-2", async () => {
      events.push("next");
    });
    await next;

    expect(events).toEqual(["failing", "next"]);
  });
});
