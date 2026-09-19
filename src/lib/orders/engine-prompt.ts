import { prisma } from "@/lib/prisma";
import { buildBranchConfigBlock } from "@/lib/ai/branch-system-prompt";
import { buildDraftSummary } from "@/lib/orders/messages";
import type { DraftOrderState } from "@/lib/validations/order-engine";

// Spec §3.6: si preguntan por la demora de un pedido en curso, la IA
// responde según el estado y la hora estimada guardada — nunca un tiempo
// genérico. Estos datos se calculan acá, en código, y se inyectan como
// hecho ya resuelto: la IA solo los redacta, no los inventa.
async function buildActiveOrderStatusText(branchId: string, customerPhone: string): Promise<string | null> {
  const order = await prisma.order.findFirst({
    where: { branchId, customerPhone, status: { in: ["WAITING_RECEIPT", "PENDING", "PREPARING", "ON_THE_WAY"] } },
    orderBy: { createdAt: "desc" },
  });
  if (!order) return null;

  if (order.status === "WAITING_RECEIPT") {
    return "Tiene un pedido en curso esperando el comprobante de transferencia.";
  }
  if (order.status === "ON_THE_WAY") {
    return "Tiene un pedido en curso que ya salió y está en camino.";
  }

  const now = new Date();
  if (now < order.estimatedDeliveryAt) {
    const minutesLeft = Math.max(1, Math.round((order.estimatedDeliveryAt.getTime() - now.getTime()) / 60_000));
    return `Tiene un pedido en curso en preparación, faltan aproximadamente ${minutesLeft} minutos.`;
  }

  if (!order.isDelayed) {
    await prisma.order.update({ where: { id: order.id }, data: { isDelayed: true } });
  }
  return "Tiene un pedido en curso cuyo tiempo estimado ya venció y todavía no salió. Si pregunta, decile que vas a consultar con el local — NUNCA prometas un nuevo horario.";
}

const RESPONSE_FORMAT_INSTRUCTIONS = `Tenés que responder ÚNICAMENTE con un JSON (sin markdown, sin explicación
fuera del JSON) con esta forma exacta:

{
  "reply": "mensaje conversacional para mandarle al cliente por WhatsApp",
  "actions": [ ... ]
}

"actions" es un array (puede estar vacío) con cero o más de estas acciones, en el orden en que corresponda
aplicarlas:

- {"type": "add_item", "productName": "<nombre EXACTO del catálogo>", "quantity": <número>}
  Usá esta acción por cada producto distinto que el cliente pida EN ESTE MENSAJE, incluso si lo dice todo
  en un mismo mensaje. El nombre tiene que ser EXACTAMENTE como aparece en el catálogo de arriba.
  MUY IMPORTANTE: "quantity" se SUMA a lo que ya había de ese producto (no lo reemplaza), así que NUNCA
  generes un add_item de un producto que ya figura en "Estado actual del pedido" más abajo solo porque lo
  mencionás en tu "reply" (para confirmarlo, agradecer, o retomar la conversación después de un saludo) —
  eso duplicaría la cantidad. Usala de nuevo para el mismo producto SOLO cuando el cliente pida
  explícitamente sumar más unidades en este mensaje puntual.
- {"type": "remove_item", "productName": "<nombre EXACTO del catálogo>"}
- {"type": "set_customer_info", "name": "...", "address": "...", "addressNotes": "..."}
  Mandá el/los campos que el cliente haya dado en este mensaje (no hace falta repetir los que ya tenías).
  "address" tiene que incluir calle y altura como mínimo.
- {"type": "set_payment_method", "method": "CASH" o "TRANSFER", "cashAmount": <número, opcional, en pesos>}
  "cashAmount" es el monto en pesos con el que el cliente dice que va a pagar (para calcular el vuelto),
  solo si method es "CASH" y el cliente lo mencionó.
- {"type": "confirm_order"}
  Usala SOLO cuando el cliente confirme explícitamente que el pedido (tal como se lo resumiste) está
  correcto y quiere continuar. Nunca la uses si todavía falta algún dato o si no pediste confirmación antes.
- {"type": "request_human"}
  Usala si el cliente pide explícitamente hablar con una persona, o si no entendés qué está pidiendo
  después de intentarlo.
- {"type": "send_catalog_image"}
  Usala si el cliente pide ver el catálogo completo, el menú completo, o la lista de precios completa (no
  para preguntas por uno o dos productos puntuales, ahí respondé directo en tu "reply" con nombre y precio).

No calcules vos los precios ni el total: el sistema los recalcula siempre a partir del catálogo real, así
que en tu "reply" no hace falta que muestres montos exactos salvo que te los pasen en "Estado actual del
pedido" más abajo (ese sí es el estado ya validado por el sistema, y podés citarlo tal cual).

COMPORTAMIENTO ESPERADO: vos manejás el ritmo de la conversación, el cliente no. Nunca dejes tu "reply" en
un punto muerto donde el cliente tiene que adivinar qué sigue — cada respuesta tuya tiene que terminar
empujando la conversación al siguiente paso. Después de agregar un producto, en la MISMA respuesta preguntá
si quiere algo más O directamente seguí pidiendo lo próximo que falte, en este orden: 1) productos, 2)
nombre y domicilio de entrega (con entrecalles), 3) medio de pago (de los habilitados), 4) resumen completo
del pedido pidiendo confirmación explícita antes de usar "confirm_order". No pases al siguiente paso hasta
tener el actual, pero tampoco te quedes callada esperando: siempre proponé qué dato falta pedir.`;

export async function buildEngineSystemPrompt(params: {
  branchId: string;
  customerPhone: string;
  draft: DraftOrderState;
}): Promise<{ branchName: string; system: string }> {
  const { branchName, block } = await buildBranchConfigBlock(params.branchId);
  const draftSummary = buildDraftSummary(params.draft);
  const activeOrderText = await buildActiveOrderStatusText(params.branchId, params.customerPhone);

  const system = `${block}

${RESPONSE_FORMAT_INSTRUCTIONS}

Estado actual del pedido en construcción (validado por el sistema, podés citarlo tal cual):
${draftSummary}
${params.draft.customerName ? `Nombre del cliente: ${params.draft.customerName}` : ""}
${params.draft.deliveryAddressRaw ? `Domicilio: ${params.draft.deliveryAddressRaw}${params.draft.deliveryAddressNotes ? ` (${params.draft.deliveryAddressNotes})` : ""}` : ""}
${params.draft.paymentMethod ? `Medio de pago elegido: ${params.draft.paymentMethod === "CASH" ? "efectivo" : "transferencia"}` : ""}
${activeOrderText ? `\nEste cliente ya tiene un pedido en curso (independiente del que se esté armando arriba): ${activeOrderText}` : ""}`;

  return { branchName, system };
}
