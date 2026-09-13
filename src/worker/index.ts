import "dotenv/config";
import { Worker, type Job } from "bullmq";
import { redisConnection } from "@/lib/jobs/redis";
import type { ReceiptJobData, ConversationExpiryJobData } from "@/lib/jobs/queues";
import {
  processConversationExpiryJob,
  processReceiptCancelJob,
  processReceiptReminderJob,
} from "@/worker/handlers";

// Proceso aparte del server web de Next (spec: colas con BullMQ + Redis).
// La lógica de cada job vive en handlers.ts (probada directo en Vitest, sin
// pasar por Redis) — acá solo se conectan las colas a esas funciones.

const receiptReminderWorker = new Worker<ReceiptJobData>(
  "receipt-reminder",
  async (job: Job<ReceiptJobData>) => processReceiptReminderJob(job.data.orderId),
  { connection: redisConnection },
);

const receiptCancelWorker = new Worker<ReceiptJobData>(
  "receipt-cancel",
  async (job: Job<ReceiptJobData>) => processReceiptCancelJob(job.data.orderId),
  { connection: redisConnection },
);

const conversationExpiryWorker = new Worker<ConversationExpiryJobData>(
  "conversation-expiry",
  async (job: Job<ConversationExpiryJobData>) =>
    processConversationExpiryJob(job.data.conversationId, job.data.expectedLastMessageAtIso),
  { connection: redisConnection },
);

for (const worker of [receiptReminderWorker, receiptCancelWorker, conversationExpiryWorker]) {
  worker.on("failed", (job, error) => {
    console.error(`Job ${job?.id} de la cola "${worker.name}" falló:`, error);
  });
}

console.log("Worker de BullMQ corriendo (receipt-reminder, receipt-cancel, conversation-expiry)...");

async function shutdown() {
  await Promise.all([receiptReminderWorker.close(), receiptCancelWorker.close(), conversationExpiryWorker.close()]);
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
