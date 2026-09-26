import { z } from "zod";

// Acciones que un operador humano puede aplicar a un pedido desde el
// tablero (Fase 4). Nunca se recalculan precios ni catálogo acá — eso ya
// quedó fijo al confirmarse el pedido (Fase 3); esto solo mueve estado.
export const orderActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("advance_status") }),
  z.object({ action: z.literal("validate_payment") }),
  z.object({ action: z.literal("cancel"), reason: z.string().trim().min(1, "Contá el motivo de la cancelación.") }),
  z.object({
    action: z.literal("update_items"),
    items: z
      .array(z.object({ productId: z.string().min(1), quantity: z.number().int().min(1) }))
      .min(1, "El pedido necesita al menos un producto."),
  }),
]);

export type OrderAction = z.infer<typeof orderActionSchema>;

export const conversationStatusSchema = z.object({
  status: z.enum(["ACTIVE", "AI_PAUSED", "CLOSED"]),
});

export const sendMessageSchema = z.object({
  text: z.string().trim().min(1, "Escribí un mensaje."),
});
