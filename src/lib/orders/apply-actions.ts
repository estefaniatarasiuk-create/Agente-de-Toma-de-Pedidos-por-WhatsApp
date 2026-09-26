import { prisma } from "@/lib/prisma";
import type { LlmAction, DraftOrderState } from "@/lib/validations/order-engine";
import { findProductMatch, findSimilarProducts } from "@/lib/orders/catalog-matching";
import { validateDeliveryAddress } from "@/lib/orders/zone-validation";
import { distanceKm } from "@/lib/geocoding";
import { parsePriceToCents } from "@/lib/validations/product";
import { createOrderFromDraft } from "@/lib/orders/create-order";
import { computeCurrentStep, getMissingOrderFields, looksLikeConfirmationText, MISSING_FIELD_LABEL } from "@/lib/orders/draft-step";
import {
  buildAmbiguousAddressMessage,
  buildFullOrderSummary,
  buildGeocodingUnavailableMessage,
  buildOrderConfirmedMessage,
  buildOutOfZoneMessage,
  buildPaymentInfoMessage,
  buildZoneNotConfiguredMessage,
} from "@/lib/orders/messages";

export type OutboundExtra = { kind: "text"; text: string } | { kind: "catalog_image" };

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
      if (existing) {
        if (existing.quantity !== action.quantity) draftChangedThisTurn = true;
        existing.quantity = action.quantity;
      } else {
        draft.items.push({
          productId: product.id,
          productName: product.name,
          unitPriceCents: product.priceCents,
          quantity: action.quantity,
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
      if (action.method !== draft.paymentMethod) draftChangedThisTurn = true;
      draft.paymentMethod = action.method;
      if (action.method === "CASH" && action.cashAmount !== undefined) {
        const cents = parsePriceToCents(action.cashAmount);
        if (cents !== null && cents !== draft.cashPaymentAmountCents) {
          draft.cashPaymentAmountCents = cents;
          draftChangedThisTurn = true;
        }
      }
      if (action.method === "TRANSFER" && paymentConfig) {
        extras.push({ kind: "text", text: buildPaymentInfoMessage(paymentConfig) });
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
              ? `Todavía me falta ${missing.map((field) => MISSING_FIELD_LABEL[field] ?? field).join(", ")} para poder confirmar el pedido.`
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

  // Si el cliente hizo un cambio real sin intentar confirmar en el mismo
  // turno, está avanzando el pedido de forma normal, no rebotando contra un
  // confirm_order bloqueado — reiniciamos el contador para no derivar a un
  // humano por una racha de mensajes que no tienen nada que ver entre sí.
  const attemptedConfirmThisTurn = params.actions.some((action) => action.type === "confirm_order");
  if (draftChangedThisTurn && !attemptedConfirmThisTurn && (draft.confirmAttempts ?? 0) > 0) {
    draft.confirmAttempts = 0;
  }

  return { draft, correctionNotes, extras, requiresHuman: requiresHumanForTechnicalFailure, orderCreated: false };
}
