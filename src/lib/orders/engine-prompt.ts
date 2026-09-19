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
  MUY IMPORTANTE: "quantity" es la cantidad TOTAL que el cliente quiere de ese producto, NO un incremento.
  Si en "Estado actual del pedido" más abajo ya figuran 5 Empanadas y el cliente pide "una más", mandá
  quantity: 6 (el nuevo total), nunca quantity: 1. Si simplemente estás confirmando, agradeciendo, o
  retomando la conversación después de un saludo sin que el cliente haya cambiado nada, NO hace falta que
  repitas la acción — pero si la repetís igual con el mismo total que ya había, no pasa nada (el sistema lo
  ignora). Lo único que nunca tenés que hacer es mandar como "quantity" un número que sea la suma de lo que
  ya había más lo nuevo pensando que se van a sumar solas: siempre es el total final.
  MUY IMPORTANTE: cuando el cliente responde "nada más", "no, eso es todo", "solo eso" o equivalente a tu
  pregunta de si quiere algo más, eso NO es un pedido de otro producto — no mandes ningún "add_item" en ese
  turno (ni de los productos que ya estaban, ni de ninguno nuevo). "Estado actual del pedido" ya tiene la
  cantidad correcta de cada cosa; repetir un "add_item" sin que el cliente haya dicho un número nuevo es
  la causa más común de que un pedido termine con más unidades de las que el cliente pidió en realidad.
- {"type": "remove_item", "productName": "<nombre EXACTO del catálogo>"}
- {"type": "set_customer_info", "name": "...", "address": "...", "addressNotes": "..."}
  Mandá el/los campos que el cliente haya dado en este mensaje (no hace falta repetir los que ya tenías).
  "address" tiene que incluir calle y altura como mínimo. MUY IMPORTANTE: "name" tiene que ser el nombre que
  el cliente escribió de verdad. NUNCA inventes un valor genérico como "Cliente" cuando todavía no te lo
  dijo — si no te dio el nombre, no mandes el campo "name" en absoluto, y pedíselo en tu "reply".
- {"type": "set_payment_method", "method": "CASH" o "TRANSFER", "cashAmount": <número, opcional, en pesos>}
  "cashAmount" es el monto en pesos con el que el cliente dice que va a pagar (para calcular el vuelto),
  solo si method es "CASH" y el cliente lo mencionó.
- {"type": "confirm_order"}
  Es la ÚNICA forma en que un pedido queda registrado de verdad — no existe ningún paso intermedio de
  "procesando" ni "guardando": o incluís esta acción en "actions" en este mismo turno, o el pedido no pasa a
  ningún lado, sin importar lo que digas en tu "reply". Usala EN EL MISMO TURNO en que el cliente confirme
  explícitamente (con un "sí", "dale", "confirmo", "está bien así", o equivalente) el pedido que vos ya le
  resumiste completo (productos, nombre, domicilio, medio de pago). Nunca la saltees ni la postergues para
  "el próximo mensaje": si el cliente ya confirmó, va en ESTE turno. Nunca la uses si todavía falta algún
  dato o si no le mostraste antes un resumen completo pidiendo confirmación.
  MUY IMPORTANTE sobre tu "reply" en este turno: nunca digas que el pedido "está confirmado", "en proceso",
  "registrado", "lo estoy procesando" ni nada que suene a que ya se guardó — esa confirmación real la manda
  el sistema aparte, automáticamente, y SOLO si confirm_order se aplicó con éxito (puede fallar si falta un
  dato, aunque vos creas que no). Si tu "reply" le hace creer al cliente que el pedido quedó listo pero vos
  no incluiste confirm_order en "actions", le mentiste y el pedido nunca se va a preparar.
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
tener el actual, pero tampoco te quedes callada esperando: siempre proponé qué dato falta pedir.
MUY IMPORTANTE: nunca le muestres al cliente un "resumen" del pedido pidiéndole que confirme si en "Estado
actual del pedido" de abajo todavía falta el nombre, el domicilio, o el medio de pago — eso lo confunde
(le hace pensar que ya está todo listo cuando en realidad falta algo). Revisá siempre esa sección antes de
armar un resumen: si falta algo, pedíselo primero.`;

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
