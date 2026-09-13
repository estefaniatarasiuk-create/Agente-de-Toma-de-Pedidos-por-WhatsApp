import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/lib/crypto";
import { sendWhatsAppTextMessage } from "@/lib/whatsapp/graph-api";

type OutboundLine = { accessTokenEncrypted: string | null; phoneNumberId: string | null } | null | undefined;

// Único punto que manda un mensaje de texto saliente por WhatsApp: lo
// persiste primero (mismo criterio de trazabilidad que los entrantes) y
// recién después llama a la API de Meta. Lo usan tanto el motor de
// conversación (Fase 3) como los jobs de BullMQ (recordatorio, cancelación
// automática, vencimiento de conversación), que corren en el worker sin
// pasar por engine.ts.
export async function sendOutboundText(params: {
  companyId: string;
  branchId: string;
  conversationId: string;
  customerPhone: string;
  line: OutboundLine;
  text: string;
}): Promise<void> {
  await prisma.message.create({
    data: {
      companyId: params.companyId,
      branchId: params.branchId,
      conversationId: params.conversationId,
      direction: "OUTBOUND",
      messageType: "TEXT",
      textContent: params.text,
      processedAt: new Date(),
    },
  });

  const accessToken = params.line?.accessTokenEncrypted ? decryptSecret(params.line.accessTokenEncrypted) : null;
  if (accessToken && params.line?.phoneNumberId) {
    try {
      await sendWhatsAppTextMessage({
        phoneNumberId: params.line.phoneNumberId,
        accessToken,
        to: params.customerPhone,
        text: params.text,
      });
    } catch (error) {
      console.error("Error enviando mensaje de WhatsApp:", error);
    }
  } else {
    console.warn(`Línea sin token de acceso: no se pudo enviar el mensaje a ${params.customerPhone}`);
  }
}
