import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/lib/crypto";
import { sendWhatsAppImageMessage, uploadWhatsAppMedia } from "@/lib/whatsapp/graph-api";
import { sendOutboundText } from "@/lib/whatsapp/outbound";
import { resolveUploadPath } from "@/lib/uploads";
import { readFile } from "node:fs/promises";
import { isWithinBusinessHours, buildOutOfHoursMessage } from "@/lib/orders/business-hours";
import { buildEngineSystemPrompt } from "@/lib/orders/engine-prompt";
import { applyActions, type OutboundExtra } from "@/lib/orders/apply-actions";
import { runAiTask } from "@/lib/ai/run-ai-task";
import { extractJsonBlock, type LlmMessage } from "@/lib/ai/provider";
import { draftOrderStateSchema, llmTurnResponseSchema, EMPTY_DRAFT_ORDER } from "@/lib/validations/order-engine";
import { buildRequiresHumanMessage } from "@/lib/orders/messages";
import { scheduleConversationExpiry } from "@/lib/jobs/queues";
import { computeCurrentStep } from "@/lib/orders/draft-step";
import type { Message } from "@prisma/client";

const HISTORY_LENGTH = 12;

function messageToHistoryText(message: Message): string {
  if (message.textContent) return message.textContent;
  if (message.transcription) return message.transcription;
  if (message.messageType === "IMAGE") return "[el cliente mandó una imagen]";
  if (message.messageType === "DOCUMENT") return "[el cliente mandó un documento]";
  if (message.messageType === "LOCATION") return "[el cliente compartió una ubicación]";
  return "[mensaje sin contenido de texto]";
}

// Procesa el turno disparado por un mensaje entrante ya persistido. Es el
// punto de entrada único del motor de pedidos: decide si corresponde
// responder automáticamente por horario, si un archivo es el comprobante de
// un pedido en curso, o si toca invocar a la IA para seguir la conversación.
export async function processInboundMessage(params: { conversationId: string; messageId: string }): Promise<void> {
  const conversation = await prisma.conversation.findUniqueOrThrow({
    where: { id: params.conversationId },
    include: { branch: { include: { whatsappLine: true } } },
  });

  // Un humano tomó la conversación, o la IA la tiene pausada: no respondemos
  // automáticamente (Fase 4 le devuelve el control).
  if (conversation.status === "REQUIRES_ATTENTION" || conversation.status === "AI_PAUSED" || conversation.status === "CLOSED") {
    return;
  }

  const line = conversation.branch.whatsappLine;
  const accessToken = line?.accessTokenEncrypted ? decryptSecret(line.accessTokenEncrypted) : null;

  async function sendText(text: string) {
    await sendOutboundText({
      companyId: conversation.companyId,
      branchId: conversation.branchId,
      conversationId: conversation.id,
      customerPhone: conversation.customerPhone,
      line,
      text,
    });
  }

  async function sendCatalogImage() {
    const catalogImage = await prisma.catalogImage.findUnique({ where: { branchId: conversation.branchId } });
    if (!catalogImage || !accessToken || !line?.phoneNumberId) return;
    try {
      const buffer = await readFile(resolveUploadPath(catalogImage.imageUrl));
      const { mediaId } = await uploadWhatsAppMedia({
        phoneNumberId: line.phoneNumberId,
        accessToken,
        buffer,
        mimeType: "image/png",
      });
      await sendWhatsAppImageMessage({
        phoneNumberId: line.phoneNumberId,
        accessToken,
        to: conversation.customerPhone,
        mediaId,
      });
      await prisma.message.create({
        data: {
          companyId: conversation.companyId,
          branchId: conversation.branchId,
          conversationId: conversation.id,
          direction: "OUTBOUND",
          messageType: "IMAGE",
          mediaUrl: catalogImage.imageUrl,
          processedAt: new Date(),
        },
      });
    } catch (error) {
      console.error("Error mandando la imagen del catálogo:", error);
    }
  }

  async function sendExtras(extras: OutboundExtra[]) {
    for (const extra of extras) {
      if (extra.kind === "text") await sendText(extra.text);
      else await sendCatalogImage();
    }
  }

  // 1. Horario (spec §3.3): determinístico, no invoca a la IA.
  const withinHours = await isWithinBusinessHours(conversation.branchId);
  if (!withinHours) {
    await sendText(await buildOutOfHoursMessage(conversation.branchId));
    return;
  }

  // 2. Comprobante de un pedido en curso: si hay un pedido "esperando
  // comprobante" y este mensaje es una imagen/documento, se adjunta directo
  // (spec §3.4) sin pasar por la IA.
  const message = await prisma.message.findUniqueOrThrow({ where: { id: params.messageId } });
  if (message.direction === "INBOUND" && (message.messageType === "IMAGE" || message.messageType === "DOCUMENT") && message.mediaUrl) {
    const waitingOrder = await prisma.order.findFirst({
      where: { branchId: conversation.branchId, customerPhone: conversation.customerPhone, status: "WAITING_RECEIPT", receiptUrl: null },
      orderBy: { createdAt: "desc" },
    });
    if (waitingOrder) {
      await prisma.order.update({
        where: { id: waitingOrder.id },
        data: { receiptUrl: message.mediaUrl, receiptReceivedAt: new Date() },
      });
      await sendText("¡Recibimos tu comprobante! Ya lo estamos verificando y en breve pasa a preparación.");
      return;
    }
  }

  // 3. Turno normal: arma el pedido con ayuda de la IA.
  const draft = draftOrderStateSchema.safeParse(conversation.draftOrder).success
    ? draftOrderStateSchema.parse(conversation.draftOrder)
    : EMPTY_DRAFT_ORDER;

  // El nombre de perfil de WhatsApp (Message/Conversation.customerName) es un
  // dato ya confiable que llega solo con el primer mensaje — no depende de
  // que la IA se lo pida al cliente y lo capture bien. Si todavía no hay un
  // nombre puesto para el pedido, se usa como default (el cliente puede
  // pedir otro nombre distinto para la entrega, la IA lo puede pisar).
  if (!draft.customerName && conversation.customerName) {
    draft.customerName = conversation.customerName;
  }

  const { system } = await buildEngineSystemPrompt({
    branchId: conversation.branchId,
    customerPhone: conversation.customerPhone,
    draft,
  });

  const history = await prisma.message.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LENGTH,
  });
  const llmMessages: LlmMessage[] = history
    .reverse()
    .map((m) => ({ role: m.direction === "INBOUND" ? "user" : "assistant", text: messageToHistoryText(m) }) as LlmMessage);

  let parsedResponse;
  try {
    const result = await runAiTask({
      purpose: "ORDER_CONVERSATION",
      companyId: conversation.companyId,
      branchId: conversation.branchId,
      conversationId: conversation.id,
      system,
      messages: llmMessages,
      maxTokens: 1000,
      jsonMode: true,
    });
    parsedResponse = llmTurnResponseSchema.parse(JSON.parse(extractJsonBlock(result.text)));
  } catch (error) {
    console.error("La IA no pudo interpretar el mensaje, derivando a atención humana:", error);
    await prisma.conversation.update({ where: { id: conversation.id }, data: { status: "REQUIRES_ATTENTION" } });
    await sendText(buildRequiresHumanMessage());
    return;
  }

  const { draft: updatedDraft, correctionNotes, extras, requiresHuman, orderCreated } = await applyActions({
    companyId: conversation.companyId,
    branchId: conversation.branchId,
    conversationId: conversation.id,
    customerPhone: conversation.customerPhone,
    draft,
    actions: parsedResponse.actions,
  });

  if (requiresHuman) {
    await prisma.conversation.update({ where: { id: conversation.id }, data: { status: "REQUIRES_ATTENTION" } });
    await sendText(correctionNotes.length > 0 ? correctionNotes.join("\n\n") : buildRequiresHumanMessage());
    return;
  }

  const replyText = correctionNotes.length > 0 ? correctionNotes.join("\n\n") : parsedResponse.reply;
  await sendText(replyText);
  await sendExtras(extras);

  const nextStep = orderCreated ? null : computeCurrentStep(updatedDraft);

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      draftOrder: orderCreated ? { items: [] } : (updatedDraft as unknown as object),
      currentStep: nextStep,
    },
  });

  // Spec §3.3: si el pedido quedó a mitad de armar, se programa un chequeo
  // de inactividad. El job es idempotente (relee lastMessageAt al disparar),
  // así que no hace falta cancelar el anterior en cada turno.
  if (nextStep) {
    await scheduleConversationExpiry({
      conversationId: conversation.id,
      expiryMinutes: conversation.branch.conversationExpiryMinutes,
      lastMessageAt: conversation.lastMessageAt,
    });
  }
}
