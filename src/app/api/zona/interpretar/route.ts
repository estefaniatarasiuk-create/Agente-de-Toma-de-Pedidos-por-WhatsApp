import { NextResponse } from "next/server";
import { z } from "zod";
import { requireBranchContext } from "@/lib/branch-context";
import { runAiTask } from "@/lib/ai/run-ai-task";
import { extractJsonBlock } from "@/lib/ai/provider";

const SYSTEM_PROMPT = `Sos un asistente que interpreta la descripción en lenguaje natural de una zona de
entrega de un comercio (en español rioplatense) y extrae el radio en kilómetros.

Devolvé ÚNICAMENTE un JSON de la forma {"radiusKm": <número>} (sin explicación, sin markdown).
Si el texto menciona metros, convertilos a kilómetros. Si no se puede inferir un radio numérico, devolvé
{"radiusKm": null}.`;

const ResultSchema = z.object({ radiusKm: z.number().positive().max(100).nullable() });

export async function POST(request: Request) {
  const context = await requireBranchContext();
  if (!context) return NextResponse.json({ error: "No autorizado." }, { status: 401 });

  const body = await request.json().catch(() => null);
  const text: string | undefined = body?.text;
  if (!text?.trim()) {
    return NextResponse.json({ error: "Describí tu zona de entrega." }, { status: 400 });
  }

  try {
    const result = await runAiTask({
      purpose: "ZONE_PARSING",
      companyId: context.companyId,
      branchId: context.branchId,
      system: SYSTEM_PROMPT,
      maxTokens: 200,
      jsonMode: true,
      messages: [{ role: "user", text }],
    });

    const parsed = ResultSchema.parse(JSON.parse(extractJsonBlock(result.text)));
    if (parsed.radiusKm === null) {
      return NextResponse.json(
        { error: "No pudimos interpretar un radio en ese texto. Probá algo como \"hasta 5 km\"." },
        { status: 422 },
      );
    }

    return NextResponse.json({ radiusKm: parsed.radiusKm, usage: result.usage });
  } catch (error) {
    console.error("Error interpretando zona con IA:", error);
    return NextResponse.json({ error: "No pudimos procesar el texto con la IA. Probá de nuevo." }, { status: 502 });
  }
}
