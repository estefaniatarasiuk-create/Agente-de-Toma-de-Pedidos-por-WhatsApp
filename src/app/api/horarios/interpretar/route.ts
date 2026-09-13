import { NextResponse } from "next/server";
import { z } from "zod";
import { requireBranchContext } from "@/lib/branch-context";
import { runAiTask } from "@/lib/ai/run-ai-task";
import { extractJsonBlock } from "@/lib/ai/provider";
import { timeLabelToMinutes } from "@/lib/validations/business-hours";

const SYSTEM_PROMPT = `Sos un asistente que interpreta horarios de atención de un comercio escritos en
lenguaje natural (en español rioplatense) y los convierte en una grilla estructurada.

Convención de días: 0=domingo, 1=lunes, 2=martes, 3=miércoles, 4=jueves, 5=viernes, 6=sábado.

Devolvé ÚNICAMENTE un JSON array (sin explicación, sin markdown) de objetos con estas claves:
- dayOfWeek: número de 0 a 6
- start: hora de apertura en formato "HH:MM" (24 hs)
- end: hora de cierre en formato "HH:MM" (24 hs)

Reglas:
- Si el texto dice un rango de días (ej: "de martes a domingo"), generá una entrada por cada día del rango.
- Si un día tiene turnos partidos (ej: "de 11 a 14:30 y de 19 a 23"), generá una entrada por cada franja.
- Si el texto no menciona un día, no lo incluyas en el resultado.
- No agregues días ni horarios que no estén mencionados o no se puedan inferir con claridad.`;

const InterpretedSlotSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  start: z.string(),
  end: z.string(),
});

export async function POST(request: Request) {
  const context = await requireBranchContext();
  if (!context) return NextResponse.json({ error: "No autorizado." }, { status: 401 });

  const body = await request.json().catch(() => null);
  const text: string | undefined = body?.text;
  if (!text?.trim()) {
    return NextResponse.json({ error: "Escribí tus días y horarios de atención." }, { status: 400 });
  }

  try {
    const result = await runAiTask({
      purpose: "HOURS_PARSING",
      companyId: context.companyId,
      branchId: context.branchId,
      system: SYSTEM_PROMPT,
      maxTokens: 1500,
      messages: [{ role: "user", text }],
    });

    const rawSlots = z.array(InterpretedSlotSchema).parse(JSON.parse(extractJsonBlock(result.text)));

    const slots = rawSlots
      .map((slot) => {
        const startMinute = timeLabelToMinutes(slot.start);
        const endMinute = timeLabelToMinutes(slot.end);
        if (startMinute === null || endMinute === null || endMinute <= startMinute) return null;
        return { dayOfWeek: slot.dayOfWeek, startMinute, endMinute, isActive: true };
      })
      .filter((slot): slot is NonNullable<typeof slot> => slot !== null);

    if (slots.length === 0) {
      return NextResponse.json(
        { error: "No pudimos interpretar horarios en ese texto. Probá de nuevo." },
        { status: 422 },
      );
    }

    return NextResponse.json({ slots, usage: result.usage });
  } catch (error) {
    console.error("Error interpretando horarios con IA:", error);
    return NextResponse.json({ error: "No pudimos procesar el texto con la IA. Probá de nuevo." }, { status: 502 });
  }
}
