import { formatCentsAsArs } from "@/lib/money";
import type { DraftOrderState } from "@/lib/validations/order-engine";
import type { PaymentMethodConfig } from "@prisma/client";

// Mensajes que contienen hechos exactos (precios, totales, datos bancarios,
// horarios de entrega) se arman acá, en código, palabra por palabra — nunca
// se le pide a la IA que los redacte, para garantizar que nunca inventa ni
// desactualiza un número.

export function buildPaymentInfoMessage(payment: PaymentMethodConfig): string {
  const lines = ["Para pagar por transferencia, estos son los datos de la cuenta:"];
  if (payment.transferAlias) lines.push(`Alias: ${payment.transferAlias}`);
  if (payment.transferCbu) lines.push(`CBU: ${payment.transferCbu}`);
  if (payment.transferHolder) lines.push(`Titular: ${payment.transferHolder}`);
  if (payment.transferCuit) lines.push(`CUIT: ${payment.transferCuit}`);
  lines.push("", "Verificá que los datos coincidan antes de transferir.");
  return lines.join("\n");
}

export function buildDraftSummary(draft: DraftOrderState): string {
  if (draft.items.length === 0) return "Todavía no agregaste productos a tu pedido.";
  const lines = draft.items.map(
    (item) => `- ${item.quantity}x ${item.productName}: ${formatCentsAsArs(item.unitPriceCents * item.quantity)}`,
  );
  const totalCents = draft.items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);
  lines.push(`Total: ${formatCentsAsArs(totalCents)}`);
  return lines.join("\n");
}

export function buildOrderConfirmedMessage(params: {
  totalCents: number;
  paymentMethod: "CASH" | "TRANSFER";
  changeAmountCents: number | null;
  cashPaymentAmountCents?: number;
  estimatedDeliveryMinutes: number;
}): string {
  const lines = [
    `¡Pedido confirmado! Total: ${formatCentsAsArs(params.totalCents)}.`,
  ];
  if (params.paymentMethod === "CASH" && params.changeAmountCents !== null && params.changeAmountCents > 0) {
    lines.push(`El repartidor va a llevar ${formatCentsAsArs(params.changeAmountCents)} de cambio.`);
  }
  // Si el cliente dijo que iba a pagar con MENOS plata que el total (el
  // vuelto calculado da 0 en vez de negativo), avisamos la diferencia en
  // vez de quedarnos calladas — si no, ni el cliente ni el repartidor se
  // enteran de que falta cobrar algo al entregar.
  if (
    params.paymentMethod === "CASH" &&
    params.cashPaymentAmountCents !== undefined &&
    params.cashPaymentAmountCents < params.totalCents
  ) {
    lines.push(
      `Ojo: dijiste que ibas a pagar con ${formatCentsAsArs(params.cashPaymentAmountCents)}, que es menos que el total — todavía faltan ${formatCentsAsArs(params.totalCents - params.cashPaymentAmountCents)} para completar el pago.`,
    );
  }
  if (params.paymentMethod === "TRANSFER") {
    lines.push("Quedamos esperando tu comprobante de transferencia para empezar a preparar tu pedido.");
  }
  lines.push(`Demora estimada: ${params.estimatedDeliveryMinutes} minutos.`);
  return lines.join("\n");
}

export function buildOutOfZoneMessage(): string {
  return "Che, me fijé y tu domicilio está fuera de nuestra zona de entrega. Por ahora no podemos llevarte el pedido hasta ahí, ¡disculpá las molestias!";
}

export function buildAmbiguousAddressMessage(): string {
  return "No pude encontrar bien esa dirección. ¿Me pasás la calle, altura, y entre qué calles está (entrecalles) o el barrio?";
}

export function buildZoneNotConfiguredMessage(): string {
  return "Por ahora no podemos validar domicilios de entrega, estamos terminando de configurar la zona. ¡Escribinos en un rato!";
}

export function buildGeocodingUnavailableMessage(): string {
  return "Tuvimos un problema técnico validando tu domicilio. Ya avisamos a una persona de nuestro equipo para que te ayude a terminar el pedido.";
}

export function buildRequiresHumanMessage(): string {
  return "Ya te voy a comunicar con una persona de nuestro equipo para que te ayude. Danos un momento, por favor.";
}

export function buildReceiptReminderMessage(): string {
  return "¡Hola! ¿Pudiste realizar la transferencia? Cuando la hagas, mandanos la foto del comprobante para empezar a preparar tu pedido.";
}

export function buildAutoCancelMessage(): string {
  return "Como no recibimos el comprobante de la transferencia, cancelamos tu pedido. Si todavía lo querés, escribinos de nuevo y lo armamos otra vez.";
}

export function buildConversationExpiredMessage(): string {
  return "Como pasó un rato sin novedades, cancelamos el pedido que estabas armando. ¡Escribinos cuando quieras y lo empezamos de nuevo!";
}

// Notificaciones de cambio de estado del pedido desde el tablero de
// operación (Fase 4): las dispara una persona del local, no la IA.
export function buildPaymentValidatedMessage(): string {
  return "¡Recibimos y validamos tu comprobante! Ya pasamos tu pedido a preparación.";
}

export function buildOrderOnTheWayMessage(): string {
  return "¡Tu pedido ya salió! En breve llega a tu domicilio.";
}

export function buildOrderCancelledByCompanyMessage(reason: string): string {
  return `Tuvimos que cancelar tu pedido: ${reason}. Disculpá las molestias — si querés, podés hacer el pedido de nuevo.`;
}
