import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isValidWebhookSignature } from "@/lib/whatsapp/webhook-signature";
import { processWhatsAppWebhookPayload } from "@/lib/whatsapp/process-webhook";

// Handshake de verificación que hace Meta al configurar la URL del webhook.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN && challenge) {
    return new NextResponse(challenge, { status: 200 });
  }

  return NextResponse.json({ error: "Verificación de webhook inválida." }, { status: 403 });
}

// Todo mensaje entrante se persiste antes de procesarse (idempotencia ante
// reintentos de Meta): esta ruta no requiere sesión (Meta no manda cookies),
// está protegida por la verificación de firma HMAC en su lugar. Siempre
// responde 200 rápido — si no, Meta reintenta agresivamente y termina
// deshabilitando el webhook.
export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");

  if (!isValidWebhookSignature(rawBody, signature)) {
    return NextResponse.json({ error: "Firma inválida." }, { status: 401 });
  }

  const payload = JSON.parse(rawBody);
  const externalId = extractExternalId(payload) ?? rawBody;

  const webhookEvent = await prisma.webhookEvent.upsert({
    where: { externalId },
    create: { provider: "meta", externalId, payload },
    update: {},
  });

  // Ya lo habíamos procesado en un intento anterior (retry de Meta): no
  // repetimos el procesamiento, pero igual devolvemos 200.
  if (webhookEvent.processedAt) {
    return NextResponse.json({ ok: true });
  }

  try {
    await processWhatsAppWebhookPayload(payload);
    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: { status: "PROCESSED", processedAt: new Date() },
    });
  } catch (error) {
    console.error("Error procesando webhook de WhatsApp:", error);
    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: {
        status: "FAILED",
        errorMessage: error instanceof Error ? error.message : "Error desconocido.",
      },
    });
  }

  return NextResponse.json({ ok: true });
}

function extractExternalId(payload: unknown): string | null {
  const messageId = (payload as { entry?: Array<{ changes?: Array<{ value?: { messages?: Array<{ id?: string }> } }> }> })
    ?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.id;
  return messageId ?? null;
}
