import { prisma } from "@/lib/prisma";
import type { LlmAction, DraftOrderState } from "@/lib/validations/order-engine";
import { findProductMatch, findSimilarProducts } from "@/lib/orders/catalog-matching";
import { validateDeliveryAddress } from "@/lib/orders/zone-validation";
import { distanceKm } from "@/lib/geocoding";
import { formatCentsAsArs } from "@/lib/money";
import { parsePriceToCents } from "@/lib/validations/product";
import { createOrderFromDraft, haveSameItems } from "@/lib/orders/create-order";
import {
  computeCurrentStep,
  computeDraftItemsTotalCents,
  extractExplicitPaymentMethodText,
  extractQuantityMentioned,
  extractTrailingPaymentMethodMention,
  getMissingOrderFields,
  looksLikeConfirmationText,
  looksLikeDeclinedMoreItemsText,
  MISSING_FIELD_LABEL,
} from "@/lib/orders/draft-step";
import {
  buildAmbiguousAddressMessage,
  buildFullOrderSummary,
  buildGeocodingUnavailableMessage,
  buildMissingHouseNumberMessage,
  buildOrderConfirmedMessage,
  buildOutOfZoneMessage,
  buildPaymentInfoMessage,
  buildZoneNotConfiguredMessage,
} from "@/lib/orders/messages";

export type OutboundExtra = { kind: "text"; text: string } | { kind: "catalog_image" };

// Compartido entre el bloqueo de confirm_order y el recordatorio proactivo
// de abajo (ver "declinedMoreItems" más adelante en este archivo) — mismo
// mensaje, código, para cualquier lugar que necesite decirle al cliente
// exactamente qué falta, sin confiar en que la IA lo redacte bien.
function buildMissingFieldsMessage(draft: DraftOrderState): string {
  const missing = getMissingOrderFields(draft);
  if (missing.length === 1 && missing[0] === "monto de efectivo suficiente") {
    // Bug real reportado: en vez del genérico "todavía me falta el monto
    // correcto", acá sí tenemos los números a mano — mostrar la plata real
    // (lo que dijo vs. el total) es mucho más claro que una frase vaga.
    const itemsTotalCents = computeDraftItemsTotalCents(draft);
    return `Dijiste que ibas a pagar con ${formatCentsAsArs(draft.cashPaymentAmountCents!)}, pero el total es ${formatCentsAsArs(itemsTotalCents)} — ese monto no alcanza. ¿Con cuánto vas a pagar en total?`;
  }
  return `Todavía me falta ${missing.map((field) => MISSING_FIELD_LABEL[field] ?? field).join(", ")} para poder confirmar el pedido.`;
}

export type ApplyActionsResult = {
  draft: DraftOrderState;
  // Si hay notas de corrección, REEMPLAZAN el "reply" de la IA (se generó
  // sin saber que algo no era válido). Si no hay, se usa el reply tal cual.
  correctionNotes: string[];
  extras: OutboundExtra[];
  requiresHuman: boolean;
  orderCreated: boolean;
  // Solo presente si orderCreated es true — para poder adjuntarle el
  // comprobante al pedido recién creado sin tener que volver a buscarlo.
  orderId?: string;
  // Pedido explícito del usuario: cuando se deriva a un humano porque el
  // cliente ya tiene un pedido activo y confirmó algo adicional (ver más
  // abajo), el borrador NO se limpia como en cualquier otra derivación —
  // es justo lo que el personal necesita ver en el panel para sumarlo al
  // pedido original. engine.ts usa esta bandera para decidir si limpia el
  // borrador al escalar o no.
  preserveDraftOnEscalation?: boolean;
};

export async function applyActions(params: {
  companyId: string;
  branchId: string;
  conversationId: string;
  customerPhone: string;
  draft: DraftOrderState;
  actions: LlmAction[];
  // Texto del mensaje entrante que disparó este turno, para verificar que
  // confirm_order realmente venga acompañado de algo que suene a una
  // confirmación del cliente (ver más abajo). No hace falta si
  // assumeConfirmed es true (ej. el comprobante de pago ya cuenta como
  // confirmación implícita — ver engine.ts).
  customerMessageText?: string;
  assumeConfirmed?: boolean;
}): Promise<ApplyActionsResult> {
  let draft: DraftOrderState = {
    ...params.draft,
    items: [...params.draft.items],
  };
  const correctionNotes: string[] = [];
  const extras: OutboundExtra[] = [];
  // Falla técnica validando un domicilio (ej. sin API key de geocoding
  // configurada): no podemos confiar en la regla dura de zona, así que se
  // deriva a un humano en vez de seguir como si no hubiera pasado nada.
  let requiresHumanForTechnicalFailure = false;
  // Nunca se confirma un pedido en el mismo turno en que se modificó algún
  // dato de verdad (ítems, nombre, domicilio o medio de pago) — aunque la IA
  // haya emitido confirm_order igual. En pruebas reales el modelo llegó a
  // reemitir un add_item de algo que ya estaba en el pedido justo al
  // confirmar (duplicando la cantidad), y por separado incluyó confirm_order
  // en un mensaje donde el cliente solo cambiaba el medio de pago (no
  // confirmaba nada). Es más seguro pedirle una confirmación aparte, sin
  // cambios en el mismo mensaje, que confiar en que el modelo distinga
  // "el cliente está confirmando" de "el cliente está dando/cambiando un dato".
  let draftChangedThisTurn = false;
  // Otra defensa de código, no de prompt: confirm_order solo puede tener
  // éxito si el pedido YA estaba completo (los 4 datos: productos, nombre,
  // domicilio, pago) ANTES de este turno — nunca en el mismo mensaje que
  // recién completó el último dato que faltaba. En pruebas reales la IA
  // llegó a incluir confirm_order en un mensaje donde el cliente solo
  // cambiaba el medio de pago (no estaba confirmando nada), y el pedido
  // hubiera quedado registrado sin que el cliente lo pidiera de verdad.
  // Exigir un mensaje aparte para confirmar es más seguro que confiar en
  // que el modelo distinga "cliente confirma" de "cliente completa un dato".
  const wasReadyToConfirmBeforeThisTurn = computeCurrentStep(params.draft) === "CONFIRMING";

  // Si el cliente pide hablar con una persona, eso manda por sobre
  // cualquier otra cosa que la IA haya intentado hacer en el mismo turno.
  if (params.actions.some((action) => action.type === "request_human")) {
    return { draft, correctionNotes: [], extras: [], requiresHuman: true, orderCreated: false };
  }

  // Hay una dirección corregida propuesta esperando confirmación (ver
  // zone-validation.ts): si el cliente responde con algo que suena a un
  // "sí" y no dio una dirección nueva en este mismo turno, se toma como
  // que confirmó la propuesta — código, no la IA, decide esto, para no
  // depender de que el modelo repita el texto exacto de la sugerencia.
  const hasNewAddressThisTurn = params.actions.some(
    (action) => action.type === "set_customer_info" && Boolean(action.address),
  );
  if (
    draft.pendingAddressSuggestion &&
    !hasNewAddressThisTurn &&
    !params.assumeConfirmed &&
    looksLikeConfirmationText(params.customerMessageText ?? "")
  ) {
    draft.deliveryAddressRaw = draft.pendingAddressSuggestion.formattedAddress;
    draft.deliveryAddressNormalized = draft.pendingAddressSuggestion.formattedAddress;
    draft.deliveryLatitude = draft.pendingAddressSuggestion.latitude;
    draft.deliveryLongitude = draft.pendingAddressSuggestion.longitude;
    draft.pendingAddressSuggestion = undefined;
    draftChangedThisTurn = true;
  }

  for (const action of params.actions) {
    if (action.type === "add_item") {
      const product = await findProductMatch(params.branchId, action.productName);
      if (!product) {
        const alternatives = await findSimilarProducts(params.branchId, action.productName);
        const suggestion =
          alternatives.length > 0
            ? ` ¿Te sirve alguno de estos: ${alternatives.map((p) => p.name).join(", ")}?`
            : "";
        correctionNotes.push(`No tenemos "${action.productName}" en el menú.${suggestion}`);
        continue;
      }
      // "quantity" es la cantidad TOTAL deseada de ese producto (no un
      // incremento — ver la instrucción en engine-prompt.ts): fijarla en
      // vez de sumarla hace que, si el modelo repite la misma acción por
      // las dudas en otro turno (algo que pasa seguido en la práctica),
      // no infle el pedido — fijar el mismo número de nuevo es un no-op.
      const existing = draft.items.find((item) => item.productId === product.id);
      const baselineQuantity = existing?.quantity ?? 0;
      let finalQuantity = action.quantity;

      // Bug real reportado DOS VECES, de dos formas distintas: un cliente
      // pidió 12 Chipa, las confirmó, y poco después (misma conversación)
      // pidió más Chipa — una vez como "¿algo más?" sobre un pedido todavía
      // en curso (la IA reemitió add_item con 24 en vez de 12, sumando el
      // pedido anterior), y otra vez como un pedido NUEVO después de marcar
      // el primero "Entregado" ("te pido una docena de chipa adicional" →
      // la IA respondió "el total ahora será de 24 chipa", de nuevo
      // sumando el pedido anterior aunque ya estaba entregado). El panel
      // (estado del pedido) no es lo que la IA mira — mira el historial de
      // la conversación, y ahí los dos pedidos conviven sin distinción.
      // Esta defensa cubre AMBAS formas: si la cantidad propuesta, restando
      // la cantidad de este mismo producto en un pedido RECIENTE (últimas 2
      // horas, sin importar su estado) de este cliente, da exactamente la
      // cantidad que ya había en el borrador (quedó intacta, la IA solo
      // "pegó" el pedido viejo encima) O exactamente el número que el
      // cliente mencionó en ESTE mensaje (dígito, "una docena", "media
      // docena", o un número en palabras), esa resta es casi seguro la
      // cantidad real que el cliente pidió — se usa esa en vez de la que
      // mandó la IA.
      if (action.quantity > baselineQuantity) {
        const recentPastOrder = await prisma.order.findFirst({
          where: {
            branchId: params.branchId,
            customerPhone: params.customerPhone,
            createdAt: { gte: new Date(Date.now() - 2 * 60 * 60 * 1000) },
            items: { some: { productId: product.id } },
          },
          orderBy: { createdAt: "desc" },
          include: { items: { where: { productId: product.id } } },
        });
        const recentPastOrderQuantity = recentPastOrder?.items[0]?.quantity;
        if (recentPastOrderQuantity) {
          const correctedQuantity = action.quantity - recentPastOrderQuantity;
          const mentionedQuantity = extractQuantityMentioned(params.customerMessageText ?? "");
          const correctionJustified =
            correctedQuantity > 0 && (correctedQuantity === baselineQuantity || correctedQuantity === mentionedQuantity);
          if (correctionJustified) {
            console.warn(
              `add_item corregido: la IA pidió "${product.name}" x${action.quantity}, pero eso coincide con sumar un pedido reciente de este cliente (x${recentPastOrderQuantity}) — se usa x${correctedQuantity} en su lugar.`,
            );
            finalQuantity = correctedQuantity;
          }
        }
      }

      if (existing) {
        if (existing.quantity !== finalQuantity) draftChangedThisTurn = true;
        existing.quantity = finalQuantity;
      } else {
        draft.items.push({
          productId: product.id,
          productName: product.name,
          unitPriceCents: product.priceCents,
          quantity: finalQuantity,
        });
        draftChangedThisTurn = true;
      }
      continue;
    }

    if (action.type === "remove_item") {
      const normalizedQuery = action.productName.trim().toLowerCase();
      const itemCountBefore = draft.items.length;
      draft.items = draft.items.filter((item) => item.productName.toLowerCase() !== normalizedQuery);
      if (draft.items.length !== itemCountBefore) draftChangedThisTurn = true;
      continue;
    }

    if (action.type === "set_customer_info") {
      if (action.name && action.name !== draft.customerName) {
        draft.customerName = action.name;
        draftChangedThisTurn = true;
      }
      if (action.addressNotes) draft.deliveryAddressNotes = action.addressNotes;

      if (action.address) {
        // Cualquier intento nuevo de dirección reemplaza a una propuesta
        // pendiente anterior — la respuesta a ESTE intento decide qué pasa.
        draft.pendingAddressSuggestion = undefined;

        const validation = await validateDeliveryAddress(params.branchId, action.address);
        if (validation.status === "ok") {
          // La IA reemite set_customer_info con la misma dirección casi cada
          // vez que resume el pedido, a veces con una redacción levemente
          // distinta (con o sin entrecalles) — comparar por coordenadas en
          // vez de por el texto evita repetir "Anoté tu domicilio como..."
          // cuando en realidad sigue siendo el mismo lugar de siempre.
          const isSameLocationAsBefore =
            draft.deliveryLatitude !== undefined &&
            draft.deliveryLongitude !== undefined &&
            distanceKm(
              { latitude: draft.deliveryLatitude, longitude: draft.deliveryLongitude },
              { latitude: validation.latitude, longitude: validation.longitude },
            ) < 0.05;

          draft.deliveryAddressRaw = action.address;
          draft.deliveryAddressNormalized = validation.formattedAddress;
          draft.deliveryLatitude = validation.latitude;
          draft.deliveryLongitude = validation.longitude;

          if (!isSameLocationAsBefore) draftChangedThisTurn = true;
          // Antes se mandaba acá un mensaje aparte ("Anoté tu domicilio
          // como...") cada vez que se validaba una dirección — pedido del
          // usuario: sonaba repetitivo entre saludo y resumen. La misma
          // función de seguridad (que el cliente note si la geocodificación
          // se equivocó de zona con un nombre de calle repetido) se cumple
          // mostrando el domicilio COMPLETO ya normalizado en el resumen
          // final del pedido, en vez de en un mensaje separado.
        } else if (validation.status === "out_of_zone") {
          correctionNotes.push(buildOutOfZoneMessage());
          // Bug real reportado: esto vaciaba TODO el borrador (productos,
          // nombre, medio de pago incluidos) — si la geocodificación se
          // equivocaba con una dirección mal escrita o incompleta (ej. "guidi
          // de franc 1510" sin el "Cid", que resolvió lejos, cuando la
          // dirección real sí estaba en zona), el cliente perdía un pedido
          // entero ya armado sin ningún aviso, solo por un dato mal escrito.
          // Igual que con cualquier otro dato inválido (nombre, pago), la
          // respuesta correcta es pedir de nuevo SOLO ese dato — nunca borrar
          // lo demás que el cliente ya había dado.
          draft.deliveryAddressRaw = undefined;
          draft.deliveryAddressNormalized = undefined;
          draft.deliveryLatitude = undefined;
          draft.deliveryLongitude = undefined;
        } else if (validation.status === "suggested_correction") {
          // Pedido explícito del usuario: en vez de rechazar de plano o
          // aceptar en silencio una coincidencia que restringimos a la
          // localidad del local, se le propone al cliente para que confirme
          // — se acepta sola en el próximo turno si el cliente responde algo
          // que suene a un "sí" (ver el chequeo al principio de esta función).
          draft.pendingAddressSuggestion = {
            formattedAddress: validation.formattedAddress,
            latitude: validation.latitude,
            longitude: validation.longitude,
          };
          correctionNotes.push(
            `No encontré esa dirección tal cual. ¿Quisiste decir "${validation.formattedAddress}"? Contame si es así para confirmarlo, o si no, decime de nuevo con más detalle.`,
          );
        } else if (validation.status === "ambiguous") {
          correctionNotes.push(buildAmbiguousAddressMessage());
        } else if (validation.status === "missing_house_number") {
          correctionNotes.push(buildMissingHouseNumberMessage());
        } else if (validation.status === "geocoding_unavailable") {
          correctionNotes.push(buildGeocodingUnavailableMessage());
          requiresHumanForTechnicalFailure = true;
        } else {
          correctionNotes.push(buildZoneNotConfiguredMessage());
        }
      }
      continue;
    }

    if (action.type === "set_payment_method") {
      const paymentConfig = await prisma.paymentMethodConfig.findUnique({ where: { branchId: params.branchId } });
      const enabled =
        action.method === "CASH" ? paymentConfig?.cashEnabled : paymentConfig?.transferEnabled;
      if (!enabled) {
        correctionNotes.push(`Ese medio de pago no está disponible acá. Contame cómo vas a pagar de las opciones que te ofrecimos.`);
        continue;
      }
      if (action.method !== draft.paymentMethod) {
        draftChangedThisTurn = true;
        // Nuevo medio de pago elegido (incluso si antes ya había sido
        // transferencia y el cliente la volvió a elegir después de pasar
        // por otra opción): si termina en transferencia, hay que volver a
        // mandar los datos bancarios — ver el chequeo al final del archivo.
        draft.bankDetailsSent = false;
      }
      draft.paymentMethod = action.method;
      if (action.method === "CASH" && action.cashAmount !== undefined) {
        const cents = parsePriceToCents(action.cashAmount);
        if (cents !== null && cents !== draft.cashPaymentAmountCents) {
          draft.cashPaymentAmountCents = cents;
          draftChangedThisTurn = true;
        }
      }
      continue;
    }

    if (action.type === "confirm_order") {
      if (!wasReadyToConfirmBeforeThisTurn || draftChangedThisTurn) {
        // Cada vez que el cliente intenta confirmar y no se puede, sumamos
        // un intento. Si esto se repite (en pruebas reales llegó a pasar 3
        // veces seguidas, siempre con el mismo mensaje, sin que el cliente
        // entendiera por qué), seguir pidiendo "confirmame de nuevo" es
        // peor que el problema que evitamos: el negocio pierde el pedido
        // por completo. A partir del 3er intento fallido se deriva a un
        // humano en vez de seguir rebotando — ya puede verlo y resolverlo
        // desde el panel de Fase 4.
        draft.confirmAttempts = (draft.confirmAttempts ?? 0) + 1;
        if (draft.confirmAttempts >= 3) {
          correctionNotes.push(
            "Perdón, tuve un problema para registrar tu pedido. Ya avisé para que alguien del local lo revise y te contacte en breve.",
          );
          return { draft, correctionNotes, extras, requiresHuman: true, orderCreated: false };
        }
        if (draftChangedThisTurn) {
          // Bug real reportado: este mensaje le pedía "fijate que quedó
          // bien" sin mostrarle nada — el cliente no tenía forma de
          // revisar el cambio antes de confirmar de nuevo. Ahora se
          // reincluye el resumen actualizado en el mismo mensaje.
          correctionNotes.push(
            `Antes de confirmar, actualicé tu pedido con el cambio que me pediste:\n\n${buildFullOrderSummary(draft)}\n\nSi quedó bien, confirmame de nuevo para registrarlo.`,
          );
        } else {
          // El mensaje genérico "ya tengo todos los datos" es engañoso si en
          // realidad todavía falta algo (ej. la IA saltó el paso de pedir el
          // domicilio y mostró un resumen incompleto como si estuviera
          // completo) — en ese caso el cliente confirma una y otra vez sin
          // saber qué falta de verdad. Si hay campos faltantes, se los
          // decimos explícitamente en vez del mensaje genérico.
          const missing = getMissingOrderFields(draft);
          correctionNotes.push(
            missing.length > 0
              ? buildMissingFieldsMessage(draft)
              : `¡Ya tengo todos los datos de tu pedido!\n\n${buildFullOrderSummary(draft)}\n\nSi está todo bien, confirmámelo en tu próximo mensaje para registrarlo.`,
          );
        }
        continue;
      }

      // Bug real: la IA incluyó confirm_order en un turno donde el cliente
      // solo preguntó "cuánto es" (no dijo nada que sonara a confirmar) —
      // como el pedido ya estaba completo y sin cambios, las defensas de
      // arriba no lo detectaron y el pedido se registró sin que el cliente
      // lo hubiera pedido de verdad. Esto NO cuenta como un intento
      // fallido del cliente (no suma a confirmAttempts ni puede escalar a
      // un humano): es la IA actuando de más, así que solo se le vuelve a
      // mostrar el resumen, sin penalizar nada.
      if (!params.assumeConfirmed && !looksLikeConfirmationText(params.customerMessageText ?? "")) {
        correctionNotes.push(`${buildFullOrderSummary(draft)}\n\n¿Confirmás este pedido?`);
        continue;
      }

      // Pedido explícito del usuario: si el cliente ya tiene un pedido
      // activo (sin entregar) y confirma algo DISTINTO a ese pedido, no se
      // arma un segundo pedido separado por su cuenta — se deriva a una
      // persona para que lo sume al pedido original desde el panel, en vez
      // de duplicar pedidos de un mismo cliente. Si los ítems son
      // IDÉNTICOS al pedido activo, esto es en realidad una corrección
      // (ej. "me equivoqué, son 20 mil no 20") y sigue su curso normal: el
      // merge silencioso de create-order.ts ya la maneja.
      const activeOrder = await prisma.order.findFirst({
        where: {
          branchId: params.branchId,
          customerPhone: params.customerPhone,
          status: { in: ["WAITING_RECEIPT", "PENDING", "PREPARING", "ON_THE_WAY"] },
        },
        orderBy: { createdAt: "desc" },
        include: { items: true },
      });
      if (activeOrder && !haveSameItems(activeOrder.items, draft.items)) {
        // Pedido explícito del usuario: avisar solo "le aviso a alguien del
        // local" no le dice al cliente cuánto va a terminar pagando en
        // total (el pedido activo + lo nuevo) — y si paga en efectivo, el
        // monto que había dado en el pedido original quedó calculado sobre
        // un total que ya no es el real, así que el vuelto que se le
        // prometió puede quedar mal. Se lo avisamos acá mismo, en el mismo
        // mensaje de derivación (el merge real lo hace una persona desde el
        // panel, pero el cliente no tiene por qué esperar a eso para saber
        // el total y que le vuelvan a preguntar el efectivo).
        const newItemsTotalCents = draft.items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);
        const combinedTotalCents = activeOrder.totalCents + newItemsTotalCents;
        const cashReconfirmNote =
          activeOrder.paymentMethod === "CASH"
            ? ` Contame también con cuánto vas a pagar en total para calcular bien el vuelto.`
            : "";
        correctionNotes.push(
          `Veo que ya tenés un pedido en curso — le aviso a alguien del local para que te sume esto ahí. Con lo nuevo, el total sería ${formatCentsAsArs(combinedTotalCents)}.${cashReconfirmNote} En breve te confirman.`,
        );
        return {
          draft,
          correctionNotes,
          extras,
          requiresHuman: true,
          orderCreated: false,
          preserveDraftOnEscalation: true,
        };
      }

      const result = await createOrderFromDraft({
        companyId: params.companyId,
        branchId: params.branchId,
        conversationId: params.conversationId,
        customerPhone: params.customerPhone,
        draft,
      });

      if (result.status === "created") {
        const branch = await prisma.branch.findUniqueOrThrow({ where: { id: params.branchId } });
        extras.push({
          kind: "text",
          text: buildOrderConfirmedMessage({
            totalCents: result.totalCents,
            paymentMethod: result.order.paymentMethod,
            changeAmountCents: result.changeAmountCents,
            cashPaymentAmountCents: result.order.cashPaymentAmountCents ?? undefined,
            estimatedDeliveryMinutes: branch.currentDelayMinutes,
          }),
        });
        draft = { items: [] };
        return { draft, correctionNotes, extras, requiresHuman: false, orderCreated: true, orderId: result.order.id };
      }

      if (result.status === "missing_info") {
        const labels = result.missing.map((field) => MISSING_FIELD_LABEL[field] ?? field);
        correctionNotes.push(`Todavía me falta ${labels.join(", ")} para poder confirmar el pedido.`);
        continue;
      }

      correctionNotes.push("Uno de los productos de tu pedido ya no está disponible, o el medio de pago no es válido. Revisemos el pedido de nuevo.");
      continue;
    }

    if (action.type === "send_catalog_image") {
      extras.push({ kind: "catalog_image" });
      continue;
    }
  }

  // Bug real reportado: el cliente respondió "transferencia" sola, sin
  // nada más, a la pregunta de medio de pago — y la IA no mandó
  // "set_payment_method" en ese turno, dejando al cliente repitiendo la
  // misma respuesta mientras el sistema insistía "todavía me falta cómo
  // vas a pagar". Último respaldo: si el turno no trajo NINGÚN
  // "set_payment_method" y el mensaje del cliente es, textualmente, nada
  // más que "efectivo" o "transferencia", lo aplicamos directo.
  if (!draft.paymentMethod && params.customerMessageText && !params.actions.some((action) => action.type === "set_payment_method")) {
    const explicitMethod =
      extractExplicitPaymentMethodText(params.customerMessageText) ??
      extractTrailingPaymentMethodMention(params.customerMessageText);
    if (explicitMethod) {
      const paymentConfig = await prisma.paymentMethodConfig.findUnique({ where: { branchId: params.branchId } });
      const enabled = explicitMethod === "CASH" ? paymentConfig?.cashEnabled : paymentConfig?.transferEnabled;
      if (enabled) {
        draft.paymentMethod = explicitMethod;
        draft.bankDetailsSent = false;
        draftChangedThisTurn = true;
      }
    }
  }

  // Recién ACÁ, con todas las acciones del turno ya procesadas, se decide si
  // corresponde mandar los datos bancarios — nunca si quedó algo más sin
  // resolver en este mismo turno. A propósito NO depende de que la
  // transferencia se haya elegido justo EN ESTE turno (bug real reportado:
  // el cliente la eligió en el mismo mensaje en que el domicilio todavía
  // tenía un problema sin resolver, y como esa elección nunca contó como
  // "nueva" en un turno posterior ya sin problemas, los datos bancarios no
  // se mandaban nunca) — alcanza con que el pedido esté en transferencia,
  // no se le hayan mandado todavía para ESTA elección puntual
  // (bankDetailsSent, que se resetea cada vez que el medio de pago cambia
  // de verdad), y no quede nada más pendiente en este turno.
  if (draft.paymentMethod === "TRANSFER" && !draft.bankDetailsSent && correctionNotes.length === 0) {
    const paymentConfig = await prisma.paymentMethodConfig.findUnique({ where: { branchId: params.branchId } });
    if (paymentConfig) {
      extras.push({ kind: "text", text: buildPaymentInfoMessage(paymentConfig) });
      draft.bankDetailsSent = true;
    }
  }

  // Red de seguridad final: el "Estado actual del pedido" en el prompt (ver
  // engine-prompt.ts) ya le dice a la IA en cada turno qué dato falta, pero
  // hubo un caso real donde igual armó una respuesta que sonaba a que el
  // pedido ya estaba completo (se concentró en resolver el domicilio, que
  // había fallado antes, y nunca volvió a pedir el nombre) — sin llegar a
  // confirmar nada (confirm_order sigue bloqueado en código si falta un
  // dato), pero dejando al cliente con la idea de que no faltaba nada. Si al
  // terminar el turno el pedido quedó A UN SOLO dato de estar completo — el
  // momento en que más suena a que ya terminó — nos aseguramos de que el
  // cliente se entere de forma confiable, sin depender de que la IA se haya
  // acordado de pedirlo en su propio texto. Antes de "productos" (que recién
  // se empieza a pedir) no aplica: ahí es normal y esperado que falten
  // varios datos a la vez.
  const attemptedConfirmThisTurn = params.actions.some((action) => action.type === "confirm_order");
  // Bug real reportado: el cliente dijo "nada más" con el pedido TODAVÍA
  // incompleto (ej. le faltaba el monto de efectivo, porque confirmó un
  // pedido nuevo que arrancó de cero tras entregarse uno anterior) — la IA
  // redactó su propio resumen "final" en texto libre, inventando nombre,
  // domicilio y hasta un monto de pago que en los hechos NO estaban en el
  // borrador real (los copió de memoria del pedido anterior, ya entregado,
  // de la misma conversación), y encima se contradijo preguntando ese
  // mismo dato de nuevo. "nada más" es la señal de que terminó de pedir
  // productos — en ESE momento, pase lo que pase con el resto del pedido,
  // la respuesta se arma siempre en código a partir del borrador real.
  const declinedMoreItems = looksLikeDeclinedMoreItemsText(params.customerMessageText ?? "");

  // Red de seguridad final: el "Estado actual del pedido" en el prompt (ver
  // engine-prompt.ts) ya le dice a la IA en cada turno qué dato falta, pero
  // hubo un caso real donde igual armó una respuesta que sonaba a que el
  // pedido ya estaba completo (se concentró en resolver el domicilio, que
  // había fallado antes, y nunca volvió a pedir el nombre) — sin llegar a
  // confirmar nada (confirm_order sigue bloqueado en código si falta un
  // dato), pero dejando al cliente con la idea de que no faltaba nada. Si al
  // terminar el turno el pedido quedó A UN SOLO dato de estar completo — el
  // momento en que más suena a que ya terminó — nos aseguramos de que el
  // cliente se entere de forma confiable, sin depender de que la IA se haya
  // acordado de pedirlo en su propio texto. Antes de "productos" (que recién
  // se empieza a pedir) no aplica: ahí es normal y esperado que falten
  // varios datos a la vez. No aplica tampoco si ya se va a cubrir el caso
  // de "nada más" de abajo, que cubre CUALQUIER cantidad de datos faltantes.
  if (correctionNotes.length === 0 && draftChangedThisTurn && !declinedMoreItems) {
    const missingAfterTurn = getMissingOrderFields(draft);
    if (missingAfterTurn.length === 1 && missingAfterTurn[0] !== "productos") {
      correctionNotes.push(
        `¡Ya casi! Todavía me falta ${MISSING_FIELD_LABEL[missingAfterTurn[0]] ?? missingAfterTurn[0]} para poder armar tu pedido.`,
      );
    }
  }

  // Bug real reportado: con el pedido ya completo, la IA redacta su propio
  // resumen en texto libre antes de pedir la confirmación — y en un caso
  // real ese resumen mostró una cantidad y un total que NO coincidían con
  // el pedido de verdad (18x Chipa/$54.000 cuando el pedido real tenía 6x
  // Chipa/$18.000: la IA "recordó" mal, mezclando un pedido anterior ya
  // entregado). Acá se reemplaza ese resumen por uno armado en código con
  // los datos reales del borrador, igual que ya se hace cuando confirm_order
  // se bloquea por un cambio en el mismo turno — nunca se confía en que el
  // texto libre de la IA tenga los números bien. Y si el cliente dijo "nada
  // más" pero el pedido TODAVÍA no está completo (el otro caso real, de
  // arriba), se le dice qué falta con el mismo mensaje confiable que usa
  // confirm_order cuando se bloquea — en vez de dejar que la IA invente.
  if (correctionNotes.length === 0 && !attemptedConfirmThisTurn && (draftChangedThisTurn || declinedMoreItems)) {
    if (computeCurrentStep(draft) === "CONFIRMING") {
      correctionNotes.push(`${buildFullOrderSummary(draft)}\n\n¿Confirmás este pedido?`);
    } else if (declinedMoreItems) {
      correctionNotes.push(buildMissingFieldsMessage(draft));
    }
  }

  // Si el cliente hizo un cambio real sin intentar confirmar en el mismo
  // turno, está avanzando el pedido de forma normal, no rebotando contra un
  // confirm_order bloqueado — reiniciamos el contador para no derivar a un
  // humano por una racha de mensajes que no tienen nada que ver entre sí.
  if (draftChangedThisTurn && !attemptedConfirmThisTurn && (draft.confirmAttempts ?? 0) > 0) {
    draft.confirmAttempts = 0;
  }

  return { draft, correctionNotes, extras, requiresHuman: requiresHumanForTechnicalFailure, orderCreated: false };
}
