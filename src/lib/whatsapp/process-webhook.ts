import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/lib/crypto";
import { downloadWhatsAppMedia } from "@/lib/whatsapp/graph-api";
import { isSupportedUploadMimeType, saveUploadedFile } from "@/lib/uploads";
import type { MessageType } from "@prisma/client";

type InboundMessage = {
  id: string;
  from: string;
  type: string;
  text?: { body: string };
  image?: { id: string; mime_type: string; caption?: string };
  audio?: { id: string; mime_type: string };
  document?: { id: string; mime_type: string; filename?: string };
  location?: { latitude: number; longitude: number };
};

type WebhookChangeValue = {
  metadata?: { phone_number_id: string };
  contacts?: Array<{ profile?: { name?: string }; wa_id: string }>;
  messages?: InboundMessage[];
};

type WhatsAppWebhookPayload = {
  entry?: Array<{
    changes?: Array<{ field: string; value: WebhookChangeValue }>;
  }>;
};

const MESSAGE_TYPE_BY_WHATSAPP_TYPE: Record<string, MessageType> = {
  text: "TEXT",
  image: "IMAGE",
  audio: "AUDIO",
  document: "DOCUMENT",
  location: "LOCATION",
  interactive: "INTERACTIVE",
};

// Todo mensaje entrante ya se persistió como WebhookEvent antes de llegar
// acá (idempotencia ante reintentos de Meta). Esto interpreta el payload y
// lo vuelca a Conversation/Message — la respuesta automática de la IA es
// responsabilidad del motor de pedidos (Fase 3), acá solo se recibe y guarda.
export async function processWhatsAppWebhookPayload(payload: WhatsAppWebhookPayload): Promise<void> {
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages" || !change.value.messages) continue;
      await processMessagesChange(change.value);
    }
  }
}

async function processMessagesChange(value: WebhookChangeValue): Promise<void> {
  const phoneNumberId = value.metadata?.phone_number_id;
  if (!phoneNumberId) return;

  const line = await prisma.whatsAppLine.findUnique({ where: { phoneNumberId } });
  if (!line) {
    console.warn(`Webhook de un phone_number_id sin línea vinculada: ${phoneNumberId}`);
    return;
  }

  const accessToken = line.accessTokenEncrypted ? decryptSecret(line.accessTokenEncrypted) : null;

  for (const message of value.messages ?? []) {
    const customerName = value.contacts?.find((contact) => contact.wa_id === message.from)?.profile?.name;

    const conversation = await prisma.conversation.upsert({
      where: { branchId_customerPhone: { branchId: line.branchId, customerPhone: message.from } },
      create: {
        companyId: line.companyId,
        branchId: line.branchId,
        customerPhone: message.from,
        customerName: customerName ?? null,
        lastMessageAt: new Date(),
      },
      update: {
        lastMessageAt: new Date(),
        ...(customerName ? { customerName } : {}),
      },
    });

    // Si estaba cerrada, un mensaje nuevo la reabre. Si un humano la pausó o
    // la marcó "requiere atención", eso lo maneja la Fase 4: no lo pisamos acá.
    if (conversation.status === "CLOSED") {
      await prisma.conversation.update({ where: { id: conversation.id }, data: { status: "ACTIVE" } });
    }

    const messageType = MESSAGE_TYPE_BY_WHATSAPP_TYPE[message.type] ?? "SYSTEM";
    const mediaUrl = await downloadMediaIfPresent(message, accessToken);

    await prisma.message.upsert({
      where: { whatsappMessageId: message.id },
      create: {
        companyId: line.companyId,
        branchId: line.branchId,
        conversationId: conversation.id,
        direction: "INBOUND",
        messageType,
        textContent: message.text?.body ?? message.image?.caption ?? null,
        mediaUrl,
        whatsappMessageId: message.id,
        rawPayload: message as object,
      },
      update: {},
    });
  }
}

async function downloadMediaIfPresent(message: InboundMessage, accessToken: string | null): Promise<string | null> {
  const mediaRef = message.image ?? message.audio ?? message.document;
  if (!mediaRef || !accessToken) return null;
  if (!isSupportedUploadMimeType(mediaRef.mime_type)) return null;

  try {
    const { buffer, mimeType } = await downloadWhatsAppMedia(mediaRef.id, accessToken);
    return await saveUploadedFile({ subdir: "whatsapp", buffer, mimeType });
  } catch (error) {
    console.error("Error descargando archivo multimedia de WhatsApp:", error);
    return null;
  }
}
