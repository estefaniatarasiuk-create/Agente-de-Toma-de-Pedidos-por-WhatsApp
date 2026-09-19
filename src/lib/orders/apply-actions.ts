import { prisma } from "@/lib/prisma";
import type { LlmAction, DraftOrderState } from "@/lib/validations/order-engine";
import { findProductMatch, findSimilarProducts } from "@/lib/orders/catalog-matching";
import { validateDeliveryAddress } from "@/lib/orders/zone-validation";
import { parsePriceToCents } from "@/lib/validations/product";
import { createOrderFromDraft } from "@/lib/orders/create-order";
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
      const existing = draft.items.find((item) => item.productId === product.id);
      if (existing) {
        existing.quantity += action.quantity;
      } else {
        draft.items.push({
          productId: product.id,
          productName: product.name,
          unitPriceCents: product.priceCents,
          quantity: action.quantity,
        });
      }
      continue;
    }

    if (action.type === "remove_item") {
      const normalizedQuery = action.productName.trim().toLowerCase();
      draft.items = draft.items.filter((item) => item.productName.toLowerCase() !== normalizedQuery);
      continue;
    }

    if (action.type === "set_customer_info") {
      if (action.name) draft.customerName = action.name;
      if (action.addressNotes) draft.deliveryAddressNotes = action.addressNotes;

      if (action.address) {
        const validation = await validateDeliveryAddress(params.branchId, action.address);
        if (validation.status === "ok") {
          draft.deliveryAddressRaw = action.address;
          draft.deliveryAddressNormalized = validation.formattedAddress;
          draft.deliveryLatitude = validation.latitude;
          draft.deliveryLongitude = validation.longitude;
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
