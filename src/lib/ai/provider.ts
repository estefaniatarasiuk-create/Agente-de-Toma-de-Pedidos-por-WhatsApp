import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

export type LlmMessage =
  | { role: "user"; text: string; imageBase64?: string; imageMimeType?: string }
  | { role: "assistant"; text: string };

export type LlmUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
};

export type LlmResult = { text: string; usage: LlmUsage };

// Precios aproximados en USD por millón de tokens (input/output). Sirven para
// estimar el costo por pedido (regla obligatoria del proyecto); no reflejan
// necesariamente el precio exacto vigente del proveedor.
const PRICING_PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "claude-opus-5": { input: 15, output: 75 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
};

function estimateCostUsd(model: string, promptTokens: number, completionTokens: number): number {
  const pricing = PRICING_PER_MILLION_TOKENS[model];
  if (!pricing) return 0;
  return (promptTokens * pricing.input + completionTokens * pricing.output) / 1_000_000;
}

function getProvider(): "openai" | "anthropic" {
  const provider = process.env.AI_PROVIDER;
  if (provider !== "openai" && provider !== "anthropic") {
    throw new Error(
      `AI_PROVIDER inválido o no configurado ("${provider}"). Debe ser "openai" o "anthropic".`,
    );
  }
  return provider;
}

async function completeWithOpenAI(
  system: string | undefined,
  messages: LlmMessage[],
  maxTokens: number,
  jsonMode: boolean,
): Promise<LlmResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL;
  if (!apiKey) throw new Error("Falta OPENAI_API_KEY.");
  if (!model) throw new Error("Falta OPENAI_MODEL.");

  const client = new OpenAI({ apiKey });

  const openaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (system) openaiMessages.push({ role: "system", content: system });
  for (const message of messages) {
    if (message.role === "assistant") {
      openaiMessages.push({ role: "assistant", content: message.text });
      continue;
    }
    if (message.imageBase64) {
      openaiMessages.push({
        role: "user",
        content: [
          { type: "text", text: message.text },
          {
            type: "image_url",
            image_url: { url: `data:${message.imageMimeType ?? "image/jpeg"};base64,${message.imageBase64}` },
          },
        ],
      });
    } else {
      openaiMessages.push({ role: "user", content: message.text });
    }
  }

  const response = await client.chat.completions.create({
    model,
    messages: openaiMessages,
    max_completion_tokens: maxTokens,
    ...(jsonMode ? { response_format: { type: "json_object" as const } } : {}),
  });

  const text = response.choices[0]?.message?.content ?? "";
  const promptTokens = response.usage?.prompt_tokens ?? 0;
  const completionTokens = response.usage?.completion_tokens ?? 0;

  return {
    text,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      costUsd: estimateCostUsd(model, promptTokens, completionTokens),
    },
  };
}

async function completeWithAnthropic(
  system: string | undefined,
  messages: LlmMessage[],
  maxTokens: number,
  jsonMode: boolean,
): Promise<LlmResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL;
  if (!apiKey) throw new Error("Falta ANTHROPIC_API_KEY.");
  if (!model) throw new Error("Falta ANTHROPIC_MODEL.");

  const client = new Anthropic({ apiKey });

  const anthropicMessages: Anthropic.MessageParam[] = messages.map((message) => {
    if (message.role === "assistant") {
      return { role: "assistant", content: message.text };
    }
    if (message.imageBase64) {
      return {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: (message.imageMimeType ?? "image/jpeg") as "image/jpeg",
              data: message.imageBase64,
            },
          },
          { type: "text", text: message.text },
        ],
      };
    }
    return { role: "user", content: message.text };
  });

  // Claude no tiene un "modo JSON" nativo como OpenAI: se lo fuerza
  // "prellenando" el inicio de su propia respuesta con "{", así continúa
  // directo en JSON en vez de arrancar con una frase conversacional.
  if (jsonMode) anthropicMessages.push({ role: "assistant", content: "{" });

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: anthropicMessages,
  });

  const rawText = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const text = jsonMode ? `{${rawText}` : rawText;
  const promptTokens = response.usage.input_tokens;
  const completionTokens = response.usage.output_tokens;

  return {
    text,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      costUsd: estimateCostUsd(model, promptTokens, completionTokens),
    },
  };
}

// Llamada "cruda" al LLM configurado, sin loguear uso (usar runAiTask para eso).
export async function completeChat(params: {
  system?: string;
  messages: LlmMessage[];
  maxTokens?: number;
  // Fuerza que la respuesta sea JSON válido (usado por todo lo que parsea
  // la respuesta con extractJsonBlock/JSON.parse — el modo "probar
  // conversación" de la Fase 1 no lo necesita, ahí la respuesta es texto
  // libre para mostrar tal cual).
  jsonMode?: boolean;
}): Promise<LlmResult> {
  const maxTokens = params.maxTokens ?? 2000;
  const jsonMode = params.jsonMode ?? false;
  const provider = getProvider();
  if (provider === "openai") {
    return completeWithOpenAI(params.system, params.messages, maxTokens, jsonMode);
  }
  return completeWithAnthropic(params.system, params.messages, maxTokens, jsonMode);
}

export function getActiveModel(): string {
  const provider = getProvider();
  const model = provider === "openai" ? process.env.OPENAI_MODEL : process.env.ANTHROPIC_MODEL;
  if (!model) throw new Error(`Falta el modelo configurado para el proveedor "${provider}".`);
  return model;
}

export function getActiveProvider(): "openai" | "anthropic" {
  return getProvider();
}

// Extrae el primer bloque JSON de un texto (algunos modelos envuelven la
// respuesta en explicación o code fences aunque se les pida JSON puro).
export function extractJsonBlock(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const firstBrace = text.indexOf("{");
  const firstBracket = text.indexOf("[");
  const starts = [firstBrace, firstBracket].filter((index) => index !== -1);
  if (starts.length === 0) return text.trim();
  const start = Math.min(...starts);
  const lastBrace = text.lastIndexOf("}");
  const lastBracket = text.lastIndexOf("]");
  const end = Math.max(lastBrace, lastBracket);
  if (end === -1 || end < start) return text.trim();
  return text.slice(start, end + 1).trim();
}
