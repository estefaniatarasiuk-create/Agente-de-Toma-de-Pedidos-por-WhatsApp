import { prisma } from "@/lib/prisma";
import { completeChat, getActiveModel, getActiveProvider, type LlmMessage, type LlmResult } from "@/lib/ai/provider";
import type { AIUsagePurpose } from "@prisma/client";

// Corre una tarea de IA y deja registro de tokens/costo (regla obligatoria
// del proyecto: log de uso de IA por pedido/sucursal desde el primer día).
export async function runAiTask(params: {
  purpose: AIUsagePurpose;
  branchId: string;
  companyId: string;
  orderId?: string;
  conversationId?: string;
  system?: string;
  messages: LlmMessage[];
  maxTokens?: number;
  jsonMode?: boolean;
}): Promise<LlmResult> {
  const result = await completeChat({
    system: params.system,
    messages: params.messages,
    maxTokens: params.maxTokens,
    jsonMode: params.jsonMode,
  });

  await prisma.aIUsageLog.create({
    data: {
      companyId: params.companyId,
      branchId: params.branchId,
      orderId: params.orderId,
      conversationId: params.conversationId,
      purpose: params.purpose,
      provider: getActiveProvider(),
      model: getActiveModel(),
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      totalTokens: result.usage.totalTokens,
      costUsd: result.usage.costUsd,
    },
  });

  return result;
}
