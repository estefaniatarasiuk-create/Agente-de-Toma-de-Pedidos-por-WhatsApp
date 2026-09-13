import { prisma } from "@/lib/prisma";
import { sendOutboundText } from "@/lib/whatsapp/outbound";
import {
  buildAutoCancelMessage,
  buildConversationExpiredMessage,
  buildReceiptReminderMessage,
} from "@/lib/orders/messages";

// Lógica de cada job separada de BullMQ (src/worker/index.ts solo la
// conecta a las colas) para poder probarla directo, sin depender de Redis
// ni de la demora real de un job programado.

async function findLineForBranch(branchId: string) {
  return prisma.whatsAppLine.findUnique({ where: { branchId } });
}

// Recordatorio de comprobante (spec §3.4, default 45 min): si a esta altura
// ya llegó el comprobante o el pedido cambió de estado por otro motivo, no
// hace nada — no hay recordatorio que mandar.
export async function processReceiptReminderJob(orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order || order.status !== "WAITING_RECEIPT" || order.receiptUrl || !order.conversationId) return;

  const line = await findLineForBranch(order.branchId);
  await sendOutboundText({
    companyId: order.companyId,
    branchId: order.branchId,
    conversationId: order.conversationId,
    customerPhone: order.customerPhone,
    line,
    text: buildReceiptReminderMessage(),
  });
}

// Cancelación automática (spec §3.4, default 60 min). Regla de seguridad NO
// NEGOCIABLE: un pedido con comprobante adjunto (receiptUrl != null) nunca
// se cancela automáticamente, sin importar cuánto tiempo pasó desde que se
// programó este job — se vuelve a chequear acá, no solo al agendarlo.
export async function processReceiptCancelJob(orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order || order.status !== "WAITING_RECEIPT" || order.receiptUrl || !order.conversationId) return;

  await prisma.$transaction([
    prisma.order.update({
      where: { id: order.id },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancellationReason: "No se recibió el comprobante de transferencia a tiempo.",
        cancelledBy: "SYSTEM",
      },
    }),
    prisma.orderStatusEvent.create({
      data: {
        companyId: order.companyId,
        branchId: order.branchId,
        orderId: order.id,
        fromStatus: order.status,
        toStatus: "CANCELLED",
        changedByAI: true,
        reason: "Vencimiento del plazo para recibir el comprobante de transferencia.",
      },
    }),
  ]);

  const line = await findLineForBranch(order.branchId);
  await sendOutboundText({
    companyId: order.companyId,
    branchId: order.branchId,
    conversationId: order.conversationId,
    customerPhone: order.customerPhone,
    line,
    text: buildAutoCancelMessage(),
  });
}

// Vencimiento de conversación (spec §3.3): si el cliente mandó un mensaje
// nuevo después de programarse este job, lastMessageAt ya cambió y no hay
// nada que expirar — el turno siguiente se encarga de reprogramarlo.
export async function processConversationExpiryJob(
  conversationId: string,
  expectedLastMessageAtIso: string,
): Promise<void> {
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!conversation || !conversation.currentStep) return;
  if (conversation.lastMessageAt.toISOString() !== expectedLastMessageAtIso) return;

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { draftOrder: { items: [] }, currentStep: null },
  });

  const line = await findLineForBranch(conversation.branchId);
  await sendOutboundText({
    companyId: conversation.companyId,
    branchId: conversation.branchId,
    conversationId: conversation.id,
    customerPhone: conversation.customerPhone,
    line,
    text: buildConversationExpiredMessage(),
  });
}
