import { prisma } from "@/lib/prisma";
import type { LlmAction, DraftOrderState } from "@/lib/validations/order-engine";
import { findProductMatch, findSimilarProducts } from "@/lib/orders/catalog-matching";
import { validateDeliveryAddress } from "@/lib/orders/zone-validation";
import { distanceKm } from "@/lib/geocoding";
import { parsePriceToCents } from "@/lib/validations/product";
import { createOrderFromDraft } from "@/lib/orders/create-order";
import { computeCurrentStep } from "@/lib/orders/draft-step";
import {
  buildAmbiguousAddressMessage,
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
};

const MISSING_FIELD_LABEL: Record<string, string> = {
  productos: "los productos que querés pedir",
  nombre: "tu nombre",
  "domicilio validado": "tu domicilio de entrega",
  "medio de pago": "cómo vas a pagar",
};

export async function applyActions(params: {
  companyId: string;
  branchId: string;
  conversationId: string;
  customerPhone: string;
  draft: DraftOrderState;
  actions: LlmAction[];
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
  // Nunca se confirma un pedido en el mismo turno en que se modificaron los
  // ítems (aunque la IA haya emitido confirm_order igual): en pruebas reales
  // el modelo a veces reemite un add_item de algo que ya estaba en el
  // pedido justo al confirmar (al "resumirlo" en su reply), duplicando la
  // cantidad — el cliente terminaba viendo un total el doble del acordado.
  // Es más seguro pedirle una confirmación aparte, sin cambios en el mismo
  // mensaje, que confiar en que el modelo nunca vuelva a hacer esto.
  let itemsChangedThisTurn = false;
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
        if (existing.quantity !== action.quantity) itemsChangedThisTurn = true;
        existing.quantity = action.quantity;
      } else {
        draft.items.push({
          productId: product.id,
          productName: product.name,
          unitPriceCents: product.priceCents,
          quantity: action.quantity,
        });
        itemsChangedThisTurn = true;
      }
      continue;
    }

    if (action.type === "remove_item") {
      const normalizedQuery = action.productName.trim().toLowerCase();
      const itemCountBefore = draft.items.length;
      draft.items = draft.items.filter((item) => item.productName.toLowerCase() !== normalizedQuery);
      if (draft.items.length !== itemCountBefore) itemsChangedThisTurn = true;
      continue;
    }

    if (action.type === "set_customer_info") {
      if (action.name) draft.customerName = action.name;
      if (action.addressNotes) draft.deliveryAddressNotes = action.addressNotes;

      if (action.address) {
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

          if (!isSameLocationAsBefore) {
            // Confirmarle al cliente el domicilio COMPLETO que entendimos
            // (con localidad/barrio) es la única forma de que note si la
            // geocodificación se equivocó de zona con un nombre de calle
            // repetido — no alcanza con aceptarlo en silencio.
            extras.push({
              kind: "text",
              text: `Anoté tu domicilio como: ${validation.formattedAddress}. Si no es el correcto, contame de nuevo con más detalle (localidad, entre qué calles, etc.).`,
            });
          }
        } else if (validation.status === "out_of_zone") {
          correctionNotes.push(buildOutOfZoneMessage());
          // Fuera de zona: no tiene sentido seguir armando este pedido.
          draft = { items: [] };
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
      draft.paymentMethod = action.method;
      if (action.method === "CASH" && action.cashAmount !== undefined) {
        const cents = parsePriceToCents(action.cashAmount);
        if (cents !== null) draft.cashPaymentAmountCents = cents;
      }
      if (action.method === "TRANSFER" && paymentConfig) {
        extras.push({ kind: "text", text: buildPaymentInfoMessage(paymentConfig) });
      }
      continue;
    }

    if (action.type === "confirm_order") {
      if (!wasReadyToConfirmBeforeThisTurn) {
        correctionNotes.push(
          "¡Ya tengo todos los datos de tu pedido! Fijate el resumen y confirmámelo en tu próximo mensaje para registrarlo.",
        );
        continue;
      }
      if (itemsChangedThisTurn) {
        correctionNotes.push(
          "Antes de confirmar, actualicé tu pedido con el cambio que me pediste. Fijate que quedó bien y confirmame de nuevo para registrarlo.",
        );
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
            estimatedDeliveryMinutes: branch.currentDelayMinutes,
          }),
        });
        draft = { items: [] };
        return { draft, correctionNotes, extras, requiresHuman: false, orderCreated: true };
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

  return { draft, correctionNotes, extras, requiresHuman: requiresHumanForTechnicalFailure, orderCreated: false };
}
