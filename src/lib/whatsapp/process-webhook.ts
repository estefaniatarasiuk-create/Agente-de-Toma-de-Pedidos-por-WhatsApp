import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/lib/crypto";
import { downloadWhatsAppMedia } from "@/lib/whatsapp/graph-api";
import { isSupportedUploadMimeType, saveUploadedFile } from "@/lib/uploads";
import { transcribeAudio } from "@/lib/ai/transcribe-audio";
import { processInboundMessage } from "@/lib/orders/engine";
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

    const alreadyProcessed = await prisma.message.findUnique({ where: { whatsappMessageId: message.id } });
    if (alreadyProcessed) continue;

    const messageType = MESSAGE_TYPE_BY_WHATSAPP_TYPE[message.type] ?? "SYSTEM";
    const { mediaUrl, transcription } = await downloadMediaIfPresent({
      message,
      accessToken,
      companyId: line.companyId,
      branchId: line.branchId,
      conversationId: conversation.id,
    });

    const createdMessage = await prisma.message.create({
      data: {
        companyId: line.companyId,
        branchId: line.branchId,
        conversationId: conversation.id,
        direction: "INBOUND",
        messageType,
        textContent: message.text?.body ?? message.image?.caption ?? null,
        mediaUrl,
        transcription,
        whatsappMessageId: message.id,
        rawPayload: message as object,
      },
    });

    await processInboundMessage({ conversationId: conversation.id, messageId: createdMessage.id });
  }
}

async function downloadMediaIfPresent(params: {
  message: InboundMessage;
  accessToken: string | null;
  companyId: string;
  branchId: string;
  conversationId: string;
}): Promise<{ mediaUrl: string | null; transcription: string | null }> {
  const mediaRef = params.message.image ?? params.message.audio ?? params.message.document;
  if (!mediaRef || !params.accessToken) return { mediaUrl: null, transcription: null };
  if (!isSupportedUploadMimeType(mediaRef.mime_type)) return { mediaUrl: null, transcription: null };

  try {
    const { buffer, mimeType } = await downloadWhatsAppMedia(mediaRef.id, params.accessToken);
    const mediaUrl = await saveUploadedFile({ subdir: "whatsapp", buffer, mimeType });

    let transcription: string | null = null;
    if (params.message.type === "audio") {
      try {
        transcription = await transcribeAudio({
          buffer,
          mimeType,
          companyId: params.companyId,
          branchId: params.branchId,
          conversationId: params.conversationId,
        });
      } catch (error) {
        console.error("Error transcribiendo audio de WhatsApp:", error);
      }
    }

    return { mediaUrl, transcription };
  } catch (error) {
    console.error("Error descargando archivo multimedia de WhatsApp:", error);
    return { mediaUrl: null, transcription: null };
  }
}
