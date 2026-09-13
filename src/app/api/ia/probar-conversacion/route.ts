import { NextResponse } from "next/server";
import { requireBranchContext } from "@/lib/branch-context";
import { runAiTask } from "@/lib/ai/run-ai-task";
import { buildBranchSystemPrompt } from "@/lib/ai/branch-system-prompt";
import { testConversationSchema } from "@/lib/validations/ai-config";

// Modo "probar conversación" (US10.3): simula un chat con la configuración
// vigente de la sucursal, sin registrar pedidos ni persistir la conversación
// (es un preview para la empresa, no el flujo real de un cliente).
export async function POST(request: Request) {
  const context = await requireBranchContext();
  if (!context) return NextResponse.json({ error: "No autorizado." }, { status: 401 });

  const body = await request.json().catch(() => null);
  const parsed = testConversationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Mensaje inválido." }, { status: 400 });
  }

  try {
    const system = await buildBranchSystemPrompt(context.branchId);
    const result = await runAiTask({
      purpose: "TEST_CONVERSATION",
      companyId: context.companyId,
      branchId: context.branchId,
      system,
      maxTokens: 800,
      messages: parsed.data.messages,
    });

    return NextResponse.json({ reply: result.text, usage: result.usage });
  } catch (error) {
    console.error("Error en modo prueba de conversación:", error);
    return NextResponse.json({ error: "No pudimos generar la respuesta. Probá de nuevo." }, { status: 502 });
  }
}
