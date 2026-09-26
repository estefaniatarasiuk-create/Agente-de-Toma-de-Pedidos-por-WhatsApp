import type { DraftOrderState } from "@/lib/validations/order-engine";

// Nombres legibles de los campos que puede faltar para completar un pedido.
// Compartido entre create-order.ts (mensaje de "missing_info") y
// apply-actions.ts (para avisarle al cliente EXACTAMENTE qué falta si
// intenta confirmar antes de tiempo, en vez de un mensaje genérico que
// puede ser engañoso si en realidad falta un dato).
export const MISSING_FIELD_LABEL: Record<string, string> = {
  productos: "los productos que querés pedir",
  nombre: "tu nombre",
  "domicilio validado": "tu domicilio de entrega",
  "medio de pago": "cómo vas a pagar",
};

// Misma lista de campos requeridos que usa create-order.ts para decidir si
// un pedido está completo — centralizada acá para que apply-actions.ts
// pueda mostrar el mismo detalle sin duplicar la lógica.
export function getMissingOrderFields(draft: DraftOrderState): string[] {
  const missing: string[] = [];
  if (draft.items.length === 0) missing.push("productos");
  if (!draft.customerName) missing.push("nombre");
  if (!draft.deliveryAddressRaw || draft.deliveryLatitude === undefined) missing.push("domicilio validado");
  if (!draft.paymentMethod) missing.push("medio de pago");
  return missing;
}

// Frases típicas con las que un cliente arranca a pedir de nuevo ("quiero
// pedir", "hacer un pedido", "otro pedido"). Bug real reportado en la Fase
// 4: si un pedido anterior quedó bloqueado sin confirmar (ej. el cliente
// intentó confirmar antes de tiempo y después se distrajo) o ya fue
// cancelado/entregado, el borrador seguía teniendo esos ítems/datos viejos
// — y si el cliente arrancaba un pedido totalmente nuevo, esos ítems
// abandonados se sumaban en silencio al nuevo, inflando el total. Detectar
// esta frase en código (no confiar en que la IA se dé cuenta sola, que en
// la práctica no siempre pasa) y limpiar el borrador es la única forma
// confiable de garantizar que un pedido nuevo arranca de cero.
const NEW_ORDER_INTENT_RE =
  /\b(quiero|quisiera|necesito)\s+(hacer\s+)?pedir\b|\b(hacer|armar|realizar)\s+(un|otro)\s+pedido\b|\botro\s+pedido\b/i;

export function isNewOrderIntentText(text: string): boolean {
  return NEW_ORDER_INTENT_RE.test(text);
}

// Bug real: la IA confirmó un pedido cuando el cliente escribió "nada más.
// Cuánto es" — una pregunta por el total, no una confirmación. Como el
// pedido ya estaba completo y nada cambió en ese turno, ninguna de las
// otras defensas de código lo detectó. Esta es la última: confirm_order
// solo tiene efecto si el mensaje del cliente en este turno realmente
// suena a una confirmación explícita — si no, no cuenta como intento
// fallido (no escala a un humano por esto), simplemente se le vuelve a
// mostrar el resumen.
const CONFIRMATION_RE =
  /\b(s[ií]+|sip|sipi|sisi|dale|confirmo|confirmado|confirmar|ok|okay|okey|oka|listo|correcto|exacto|perfecto|impecable|buen[ií]simo|genial|b[aá]rbaro|de una|de acuerdo|vale|as[ií] est[aá] bien|est[aá] bien|todo bien|todo correcto|qued[oó] bien|eso es|eso mismo|aceptado|joya)\b/i;

export function looksLikeConfirmationText(text: string): boolean {
  return CONFIRMATION_RE.test(text);
}

// Paso vigente de la máquina de estados del pedido en curso (spec §3.2).
// Compartido entre engine.ts (para guardar Conversation.currentStep) y
// apply-actions.ts (para exigir que confirm_order llegue en un turno
// aparte del que completó el último dato — ver ese archivo).
export function computeCurrentStep(draft: DraftOrderState): string | null {
  if (draft.items.length === 0 && !draft.customerName && !draft.deliveryAddressRaw && !draft.paymentMethod) {
    return null;
  }
  const missing = getMissingOrderFields(draft);
  if (missing.includes("nombre") || missing.includes("domicilio validado")) return "ASKING_DELIVERY_INFO";
  if (missing.includes("medio de pago")) return "ASKING_PAYMENT_METHOD";
  return "CONFIRMING";
}
