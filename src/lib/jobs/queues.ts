import { Queue } from "bullmq";
import { redisConnection } from "@/lib/jobs/redis";

export type ReceiptJobData = { orderId: string };
export type ConversationExpiryJobData = { conversationId: string; expectedLastMessageAtIso: string };

const globalForQueues = globalThis as unknown as {
  receiptReminderQueue: Queue<ReceiptJobData> | undefined;
  receiptCancelQueue: Queue<ReceiptJobData> | undefined;
  conversationExpiryQueue: Queue<ConversationExpiryJobData> | undefined;
};

export const receiptReminderQueue =
  globalForQueues.receiptReminderQueue ??
  new Queue<ReceiptJobData>("receipt-reminder", { connection: redisConnection });

export const receiptCancelQueue =
  globalForQueues.receiptCancelQueue ??
  new Queue<ReceiptJobData>("receipt-cancel", { connection: redisConnection });

export const conversationExpiryQueue =
  globalForQueues.conversationExpiryQueue ??
  new Queue<ConversationExpiryJobData>("conversation-expiry", { connection: redisConnection });

if (process.env.NODE_ENV !== "production") {
  globalForQueues.receiptReminderQueue = receiptReminderQueue;
  globalForQueues.receiptCancelQueue = receiptCancelQueue;
  globalForQueues.conversationExpiryQueue = conversationExpiryQueue;
}

// Circuito del comprobante (spec §3.4): programa el recordatorio y la
// cancelación automática al confirmarse un pedido por transferencia. Ambos
// jobs son idempotentes por diseño: al dispararse, releen el pedido y solo
// actúan si sigue en "Esperando comprobante" (ver src/worker).
export async function scheduleReceiptJobs(params: {
  orderId: string;
  reminderMinutes: number;
  cancelMinutes: number;
}): Promise<void> {
  await Promise.all([
    receiptReminderQueue.add(
      "remind",
      { orderId: params.orderId },
      { delay: params.reminderMinutes * 60_000, jobId: `remind-${params.orderId}` },
    ),
    receiptCancelQueue.add(
      "cancel",
      { orderId: params.orderId },
      { delay: params.cancelMinutes * 60_000, jobId: `cancel-${params.orderId}` },
    ),
  ]);
}

// Vencimiento de conversación (spec §3.3, "cliente abandona la
// conversación"): programa un chequeo de inactividad. El job compara la
// hora de último mensaje que había al programarlo contra la actual — si no
// cambió, expira el paso en curso sin registrar pedido.
export async function scheduleConversationExpiry(params: {
  conversationId: string;
  expiryMinutes: number;
  lastMessageAt: Date;
}): Promise<void> {
  await conversationExpiryQueue.add(
    "expire",
    { conversationId: params.conversationId, expectedLastMessageAtIso: params.lastMessageAt.toISOString() },
    { delay: params.expiryMinutes * 60_000 },
  );
}
