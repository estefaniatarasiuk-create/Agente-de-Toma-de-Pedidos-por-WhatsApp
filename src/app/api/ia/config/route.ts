import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireBranchContext } from "@/lib/branch-context";
import { aiConfigSchema } from "@/lib/validations/ai-config";
import { runAiTask } from "@/lib/ai/run-ai-task";
import { extractJsonBlock } from "@/lib/ai/provider";
import { z } from "zod";

export async function GET() {
  const context = await requireBranchContext();
  if (!context) return NextResponse.json({ error: "No autorizado." }, { status: 401 });

  const config = await prisma.aIConfig.findUnique({ where: { branchId: context.branchId } });
  return NextResponse.json({ config });
}

const WarningsSchema = z.object({ warnings: z.array(z.string()) });

// Chequea si el texto libre contradice la configuración estructurada
// (horarios, zona, medios de pago). No bloquea el guardado: solo avisa
// (US10.4) — la config estructurada siempre prevalece en la operación real.
async function checkContradictions(params: {
  branchId: string;
  companyId: string;
  additionalInstructions: string;
}): Promise<string[]> {
  if (!params.additionalInstructions.trim()) return [];

  const [hourSlots, zone] = await Promise.all([
    prisma.businessHourSlot.findMany({ where: { branchId: params.branchId, isActive: true } }),
    prisma.deliveryZone.findUnique({ where: { branchId: params.branchId } }),
  ]);

  const structuredSummary = [
    `Horarios configurados: ${hourSlots.length > 0 ? `${hourSlots.length} franjas cargadas` : "sin configurar"}.`,
    `Zona de entrega: ${zone ? `radio de ${zone.radiusKm} km` : "sin configurar"}.`,
  ].join("\n");

  try {
    const result = await runAiTask({
      purpose: "CONTRADICTION_CHECK",
      companyId: params.companyId,
      branchId: params.branchId,
      maxTokens: 500,
      jsonMode: true,
      system: `Comparás instrucciones en texto libre de un comercio contra su configuración estructurada
(horarios y zona de entrega) y detectás contradicciones explícitas (ej: el texto libre menciona horarios
o una zona distinta a la configurada). Devolvé ÚNICAMENTE JSON: {"warnings": ["..."]} (array vacío si no
hay contradicciones). Cada warning debe explicar en una frase corta qué dice el texto libre y qué
prevalece (siempre la configuración estructurada).`,
      messages: [
        {
          role: "user",
          text: `Configuración estructurada:\n${structuredSummary}\n\nTexto libre a revisar:\n${params.additionalInstructions}`,
        },
      ],
    });
    const parsed = WarningsSchema.safeParse(JSON.parse(extractJsonBlock(result.text)));
    return parsed.success ? parsed.data.warnings : [];
  } catch (error) {
    console.error("Error chequeando contradicciones de IA:", error);
    return [];
  }
}

export async function PUT(request: Request) {
  const context = await requireBranchContext();
  if (!context) return NextResponse.json({ error: "No autorizado." }, { status: 401 });

  const body = await request.json().catch(() => null);
  const parsed = aiConfigSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Datos inválidos." }, { status: 400 });
  }

  const config = await prisma.aIConfig.upsert({
    where: { branchId: context.branchId },
    create: {
      companyId: context.companyId,
      branchId: context.branchId,
      tone: parsed.data.tone,
      useEmojis: parsed.data.useEmojis,
      additionalInstructions: parsed.data.additionalInstructions || null,
    },
    update: {
      tone: parsed.data.tone,
      useEmojis: parsed.data.useEmojis,
      additionalInstructions: parsed.data.additionalInstructions || null,
    },
  });

  const warnings = await checkContradictions({
    branchId: context.branchId,
    companyId: context.companyId,
    additionalInstructions: parsed.data.additionalInstructions || "",
  });

  return NextResponse.json({ config, warnings });
}
