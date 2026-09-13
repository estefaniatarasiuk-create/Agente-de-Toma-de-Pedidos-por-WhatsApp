import OpenAI from "openai";
import { toFile } from "openai/uploads";
import { prisma } from "@/lib/prisma";

// Regla obligatoria del proyecto: todo audio entrante se transcribe y entra
// al flujo como texto. Whisper es de OpenAI únicamente — se usa
// OPENAI_API_KEY para esto sin importar qué AI_PROVIDER esté configurado
// para la conversación (Anthropic no ofrece transcripción de audio).
export async function transcribeAudio(params: {
  buffer: Buffer;
  mimeType: string;
  companyId: string;
  branchId: string;
  conversationId: string;
}): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Falta OPENAI_API_KEY (necesaria para transcribir audio con Whisper).");
  }

  const client = new OpenAI({ apiKey });
  const model = process.env.OPENAI_WHISPER_MODEL || "whisper-1";
  const extension = params.mimeType.includes("ogg") ? "ogg" : "mp3";

  const response = await client.audio.transcriptions.create({
    model,
    file: await toFile(params.buffer, `audio.${extension}`, { type: params.mimeType }),
    language: "es",
  });

  await prisma.aIUsageLog.create({
    data: {
      companyId: params.companyId,
      branchId: params.branchId,
      conversationId: params.conversationId,
      purpose: "AUDIO_TRANSCRIPTION",
      provider: "openai",
      model,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      // Whisper cobra por minuto de audio, no por tokens; el costo se deja
      // en 0 acá (no tenemos la duración) en vez de estimar un valor falso.
      costUsd: 0,
    },
  });

  return response.text;
}
