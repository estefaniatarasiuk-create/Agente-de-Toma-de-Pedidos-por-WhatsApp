import type { DraftOrderState } from "@/lib/validations/order-engine";

// Paso vigente de la máquina de estados del pedido en curso (spec §3.2).
// Compartido entre engine.ts (para guardar Conversation.currentStep) y
// apply-actions.ts (para exigir que confirm_order llegue en un turno
// aparte del que completó el último dato — ver ese archivo).
export function computeCurrentStep(draft: DraftOrderState): string | null {
  if (draft.items.length === 0 && !draft.customerName && !draft.deliveryAddressRaw && !draft.paymentMethod) {
    return null;
  }
  if (!draft.customerName || !draft.deliveryAddressRaw) return "ASKING_DELIVERY_INFO";
  if (!draft.paymentMethod) return "ASKING_PAYMENT_METHOD";
  return "CONFIRMING";
}
