import type { ConversationStatus } from "@prisma/client";
import type { DraftOrderState } from "@/lib/validations/order-engine";

// Al devolverle el control de una conversación a la IA — desde "necesita
// atención" (una persona la marcó resuelta) o desde "pausada" (ej. alguien
// usó "Hablar con el cliente" y después "Reactivar IA") — cualquier
// borrador que hubiera quedado tiene que vaciarse. Bug real reportado: el
// caso "pausada → activa" no limpiaba nada, así que un borrador abandonado
// mientras una persona charlaba directo con el cliente (ítems, domicilio,
// lo que fuera) resucitaba solo en el próximo pedido sin relación que
// armara la IA, sumando datos que el cliente nunca dio para ESE pedido.
export function shouldClearDraftOnHandoverToAI(currentStatus: ConversationStatus, newStatus: ConversationStatus): boolean {
  return (currentStatus === "REQUIRES_ATTENTION" || currentStatus === "AI_PAUSED") && newStatus === "ACTIVE";
}

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
  "monto de efectivo": "con cuánto efectivo vas a pagar",
  "monto de efectivo suficiente": "el monto correcto de efectivo (lo que dijiste no alcanza para cubrir el total)",
};

// Suma de los ítems del borrador — compartida entre el chequeo de "el
// efectivo no alcanza" de acá abajo y el mensaje específico con los montos
// reales que arma apply-actions.ts para ese mismo caso.
export function computeDraftItemsTotalCents(draft: DraftOrderState): number {
  return draft.items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);
}

// Misma lista de campos requeridos que usa create-order.ts para decidir si
// un pedido está completo — centralizada acá para que apply-actions.ts
// pueda mostrar el mismo detalle sin duplicar la lógica.
export function getMissingOrderFields(draft: DraftOrderState): string[] {
  const missing: string[] = [];
  if (draft.items.length === 0) missing.push("productos");
  if (!draft.customerName) missing.push("nombre");
  if (!draft.deliveryAddressRaw || draft.deliveryLatitude === undefined) missing.push("domicilio validado");
  if (!draft.paymentMethod) missing.push("medio de pago");
  // Bug real reportado: un pedido en efectivo se confirmó sin que el
  // cliente hubiera dado nunca el monto con el que iba a pagar — la IA
  // intentó confirmar en el mismo turno en el que el cliente respondía esa
  // pregunta, sin llegar a capturarla como "cashAmount", y como el medio de
  // pago ya estaba establecido ("Efectivo" a secas cuenta como dato
  // completo), nada bloqueaba la confirmación. El pedido quedó sin vuelto
  // calculable y sin mostrar el monto en el tablero. Exigir este dato antes
  // de poder confirmar, igual que cualquier otro dato faltante.
  if (draft.paymentMethod === "CASH") {
    if (draft.cashPaymentAmountCents === undefined) {
      missing.push("monto de efectivo");
    } else if (draft.cashPaymentAmountCents < computeDraftItemsTotalCents(draft)) {
      // Bug real reportado: el cliente dijo "10" (pensando en $10.000) en
      // respuesta a "¿con cuánto vas a abonar?", la IA no lo interpretó
      // como abreviación de miles ni preguntó para confirmar, y el pedido
      // se confirmó igual con un monto literal de $10 — muy por debajo del
      // total — y el cliente recién se enteró de que "faltaba plata" en el
      // mensaje DESPUÉS de confirmar. Un monto insuficiente es, en la
      // práctica, casi siempre este malentendido (nunca un pago parcial
      // intencional en este negocio) — bloquear la confirmación hasta que
      // dé un monto que alcance evita que el pedido quede mal armado desde
      // el vamos.
      missing.push("monto de efectivo suficiente");
    }
  }
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

// Bug real: con el pedido completo, la IA arma su propio resumen en texto
// libre antes de pedir confirmación — en un caso real ese resumen mostró
// una cantidad y un total que NO coincidían con el pedido de verdad (18x
// Chipa cuando el pedido real tenía 6x, "recordando" mal un pedido anterior
// ya entregado). El disparador típico de ese resumen es que el cliente
// diga que no quiere agregar nada más — se detecta en código para poder
// reemplazar el resumen de la IA por uno armado con los datos reales (ver
// apply-actions.ts), en vez de confiar en que el texto libre tenga los
// números bien.
const DECLINED_MORE_ITEMS_RE =
  /\b(nada m[aá]s|no,?\s*nada|no\s+gracias|eso es todo|solo eso|nada por ahora|por ahora no|ning[uú]na?\s*m[aá]s)\b/i;

export function looksLikeDeclinedMoreItemsText(text: string): boolean {
  return DECLINED_MORE_ITEMS_RE.test(text);
}

// Paso vigente de la máquina de estados del pedido en curso (spec §3.2).
// Compartido entre engine.ts (para guardar Conversation.currentStep) y
// apply-actions.ts (para exigir que confirm_order llegue en un turno
// aparte del que completó el último dato — ver ese archivo).
export function isDraftEmpty(draft: DraftOrderState): boolean {
  return draft.items.length === 0 && !draft.customerName && !draft.deliveryAddressRaw && !draft.paymentMethod;
}

export function computeCurrentStep(draft: DraftOrderState): string | null {
  if (isDraftEmpty(draft)) {
    return null;
  }
  const missing = getMissingOrderFields(draft);
  if (missing.includes("nombre") || missing.includes("domicilio validado")) return "ASKING_DELIVERY_INFO";
  if (
    missing.includes("medio de pago") ||
    missing.includes("monto de efectivo") ||
    missing.includes("monto de efectivo suficiente")
  )
    return "ASKING_PAYMENT_METHOD";
  return "CONFIRMING";
}

// Bug real reportado: el cliente respondió "transferencia" (sola, sin nada
// más) a la pregunta de medio de pago, y la IA no llamó a
// "set_payment_method" en ese turno — el sistema quedó pidiendo lo mismo en
// loop ("todavía me falta cómo vas a pagar"), pese a que la respuesta del
// cliente era inequívoca. Se usa como último respaldo en apply-actions.ts
// SOLO si la IA no mandó ningún "set_payment_method" en el turno: a
// propósito exige que el mensaje sea nada más que esta palabra (sin texto
// alrededor) para no interpretar mal una frase como "no quiero pagar por
// transferencia, prefiero efectivo".
const EXPLICIT_PAYMENT_METHOD_RE = /^(efectivo|efec|transferencia|transf)[.!¡]?$/i;

export function extractExplicitPaymentMethodText(text: string): "CASH" | "TRANSFER" | null {
  const match = EXPLICIT_PAYMENT_METHOD_RE.exec(text.trim());
  if (!match) return null;
  return match[1].toLowerCase().startsWith("efec") ? "CASH" : "TRANSFER";
}

// Bug real reportado: el cliente dio la dirección y el medio de pago EN EL
// MISMO mensaje ("...1510, entre peron y barbieri. Transferencia"), la
// dirección falló la validación, la IA se concentró en pedir de nuevo el
// domicilio y nunca mandó "set_payment_method" — el dato se perdió del
// todo, y el cliente tuvo que repetirlo varios mensajes más tarde
// ("pago por transferencia te dije"). extractExplicitPaymentMethodText no
// alcanza para este caso porque exige que el mensaje sea NADA MÁS que la
// palabra — acá hay que mirar la última frase del mensaje (separada por
// punto, exclamación o salto de línea), que es donde un cliente suele
// "tirar" la respuesta a una pregunta anterior después de dar otro dato.
// Mismo criterio estricto que la función de arriba (nada de texto extra en
// ESA frase puntual) para no malinterpretar una negación como "no quiero
// pagar por transferencia, prefiero efectivo" (ahí no hay una frase final
// que sea nada más que una de las dos palabras).
export function extractTrailingPaymentMethodMention(text: string): "CASH" | "TRANSFER" | null {
  const segments = text
    .split(/[.!¡\n]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const lastSegment = segments[segments.length - 1];
  if (!lastSegment) return null;
  return extractExplicitPaymentMethodText(lastSegment);
}

// Bug real reportado (se repitió varias veces, cada vez por un lugar
// distinto del código que tocaba draftOrder sin vaciarlo del todo): un
// borrador abandonado a medio armar — ítems, domicilio o medio de pago de
// un intento de pedido que el cliente nunca terminó ni confirmó — podía
// quedar vivo indefinidamente y resucitar solo en un pedido futuro sin
// relación, sumando productos que el cliente nunca pidió en esa conversación.
// Cada vez que apareció, la solución fue encontrar Y PARCHEAR el lugar
// puntual que no limpiaba el borrador al cambiar de estado — pero no hay
// forma de garantizar que esos sean TODOS los lugares posibles (y el job de
// BullMQ que vence la conversación por inactividad depende de que el worker
// esté corriendo). Este chequeo es la red de seguridad final, independiente
// de cuál haya sido la causa: si pasaron más minutos que el vencimiento
// configurado desde la última vez que se escribió el borrador, se lo trata
// como abandonado y se descarta ANTES de seguir — sin importar qué parte
// del código (conocida o no) fue la responsable de no limpiarlo antes.
// Extrae, de forma barata y sin IA, el número que el cliente mencionó en su
// mensaje — usada como respaldo en apply-actions.ts para confirmar si una
// cantidad que propone la IA (ver el bug real ahí) coincide con lo que el
// cliente realmente pidió EN ESTE mensaje. Cubre dígitos sueltos ("12"),
// números en palabras ("una", "dos", ..., "diez") y las formas típicas en
// que se pide chipa/facturas/etc. por docena ("una docena" = 12, "media
// docena" = 6). No intenta entender la frase completa (si hay varios
// números, no sabe a cuál se refiere) — es un respaldo de última instancia,
// no un parser de lenguaje natural.
const WORD_NUMBER_VALUES: Record<string, number> = {
  un: 1,
  una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
};
const WORD_NUMBER_RE = /\b(un|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\b/i;

export function extractQuantityMentioned(text: string): number | null {
  if (/\bmedia\s+docena\b/i.test(text)) return 6;
  if (/\bdocena\b/i.test(text)) return 12;
  const digitMatch = text.match(/\d+/);
  if (digitMatch) return parseInt(digitMatch[0], 10);
  const wordMatch = WORD_NUMBER_RE.exec(text);
  if (wordMatch) return WORD_NUMBER_VALUES[wordMatch[1].toLowerCase()];
  return null;
}

export function isDraftStale(params: {
  draft: DraftOrderState;
  draftOrderUpdatedAt: Date | null;
  expiryMinutes: number;
  now?: Date;
}): boolean {
  if (isDraftEmpty(params.draft)) return false;
  if (!params.draftOrderUpdatedAt) return false;
  const now = params.now ?? new Date();
  return now.getTime() - params.draftOrderUpdatedAt.getTime() > params.expiryMinutes * 60_000;
}
