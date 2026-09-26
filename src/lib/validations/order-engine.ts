import { z } from "zod";

// Pedido en construcción, guardado en Conversation.draftOrder mientras se
// arma por chat. Los precios acá son solo referencia de lo último calculado
// — al confirmar, create-order.ts recalcula todo desde el catálogo vigente.
export const draftOrderItemSchema = z.object({
  productId: z.string(),
  productName: z.string(),
  unitPriceCents: z.number().int(),
  quantity: z.number().int().positive(),
});

export const draftOrderStateSchema = z.object({
  items: z.array(draftOrderItemSchema).default([]),
  customerName: z.string().optional(),
  deliveryAddressRaw: z.string().optional(),
  deliveryAddressNotes: z.string().optional(),
  deliveryLatitude: z.number().optional(),
  deliveryLongitude: z.number().optional(),
  deliveryAddressNormalized: z.string().optional(),
  paymentMethod: z.enum(["CASH", "TRANSFER"]).optional(),
  cashPaymentAmountCents: z.number().int().optional(),
  // Cuenta confirm_order bloqueados seguidos (el cliente confirma pero el
  // pedido no se registra, por ej. porque la IA reemite un dato ya
  // establecido en el mismo turno). Es la salida de emergencia para no
  // quedar rebotando para siempre: ver apply-actions.ts.
  confirmAttempts: z.number().int().nonnegative().optional(),
  // Cuando la dirección que dio el cliente no geocodificó dentro de la
  // zona, pero SÍ encontramos algo parecido restringiendo la búsqueda a la
  // localidad del local, se guarda acá como propuesta en vez de aceptarla
  // en silencio — el cliente tiene que confirmarla antes de que cuente
  // como su domicilio real (pedido explícito del usuario en Fase 4). Ver
  // apply-actions.ts y zone-validation.ts.
  pendingAddressSuggestion: z
    .object({ formattedAddress: z.string(), latitude: z.number(), longitude: z.number() })
    .optional(),
});

export type DraftOrderState = z.infer<typeof draftOrderStateSchema>;
export type DraftOrderItem = z.infer<typeof draftOrderItemSchema>;

export const EMPTY_DRAFT_ORDER: DraftOrderState = { items: [] };

// Lo que la IA devuelve cada turno: un texto conversacional más cero o más
// "acciones" estructuradas. El código valida y ejecuta cada acción contra
// la base — la IA nunca escribe directamente el pedido, solo propone.
export const llmActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("add_item"),
    productName: z.string(),
    quantity: z.number().int().positive().default(1),
  }),
  z.object({ type: z.literal("remove_item"), productName: z.string() }),
  z.object({
    type: z.literal("set_customer_info"),
    name: z.string().optional(),
    address: z.string().optional(),
    addressNotes: z.string().optional(),
  }),
  z.object({
    type: z.literal("set_payment_method"),
    method: z.enum(["CASH", "TRANSFER"]),
    cashAmount: z.number().nonnegative().optional(),
  }),
  z.object({ type: z.literal("confirm_order") }),
  z.object({ type: z.literal("request_human") }),
  z.object({ type: z.literal("send_catalog_image") }),
]);

export type LlmAction = z.infer<typeof llmActionSchema>;

export const llmTurnResponseSchema = z.object({
  reply: z.string(),
  actions: z.array(llmActionSchema).default([]),
});

export type LlmTurnResponse = z.infer<typeof llmTurnResponseSchema>;
