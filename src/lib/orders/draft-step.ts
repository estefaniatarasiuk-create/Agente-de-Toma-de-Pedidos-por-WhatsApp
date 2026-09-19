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
