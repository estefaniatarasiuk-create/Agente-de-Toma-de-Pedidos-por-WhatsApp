import { prisma } from "@/lib/prisma";
import { formatCentsAsArs } from "@/lib/money";
import { DAY_NAMES, minutesToTimeLabel } from "@/lib/validations/business-hours";

// Config estructurada de la sucursal, como bloque de texto para el prompt.
// Es la parte que comparten el modo "probar conversación" (Fase 1) y el
// motor de pedidos real (Fase 3): las reglas duras (precios, horarios,
// zona, datos bancarios) viajan acá como datos, pero se VALIDAN aparte en
// código en cada paso del flujo real (no dependemos de que el modelo las
// respete al pie de la letra).
export async function buildBranchConfigBlock(branchId: string): Promise<{ branchName: string; block: string }> {
  const [branch, products, hourSlots, zone, paymentMethod, aiConfig] = await Promise.all([
    prisma.branch.findUniqueOrThrow({ where: { id: branchId } }),
    prisma.product.findMany({ where: { branchId, isActive: true }, orderBy: { name: "asc" } }),
    prisma.businessHourSlot.findMany({
      where: { branchId, isActive: true },
      orderBy: [{ dayOfWeek: "asc" }, { startMinute: "asc" }],
    }),
    prisma.deliveryZone.findUnique({ where: { branchId } }),
    prisma.paymentMethodConfig.findUnique({ where: { branchId } }),
    prisma.aIConfig.findUnique({ where: { branchId } }),
  ]);

  const catalogText =
    products.length > 0
      ? products
          .map(
            (p) =>
              `- ${p.name}${p.category ? ` (${p.category})` : ""}: ${formatCentsAsArs(p.priceCents)}${p.description ? ` — ${p.description}` : ""}`,
          )
          .join("\n")
      : "(todavía no hay productos cargados)";

  const hoursByDay = new Map<number, string[]>();
  for (const slot of hourSlots) {
    const list = hoursByDay.get(slot.dayOfWeek) ?? [];
    list.push(`${minutesToTimeLabel(slot.startMinute)} a ${minutesToTimeLabel(slot.endMinute)}`);
    hoursByDay.set(slot.dayOfWeek, list);
  }
  const hoursText =
    hoursByDay.size > 0
      ? DAY_NAMES.map((name, index) => (hoursByDay.has(index) ? `- ${name}: ${hoursByDay.get(index)!.join(" y ")}` : null))
          .filter(Boolean)
          .join("\n")
      : "(todavía no hay horarios configurados)";

  const zoneText = zone
    ? `Radio de entrega: ${zone.radiusKm} km alrededor del local.`
    : "(todavía no hay zona de entrega configurada)";

  const paymentText = paymentMethod
    ? [
        paymentMethod.cashEnabled ? "- Efectivo" : null,
        paymentMethod.transferEnabled ? "- Transferencia (los datos exactos los informa el sistema, no los repitas de memoria)" : null,
      ]
        .filter(Boolean)
        .join("\n")
    : "(todavía no hay medios de pago configurados)";

  const tone = aiConfig?.tone === "FORMAL" ? "formal y profesional" : "cercano y amigable";
  const emojiInstruction = aiConfig?.useEmojis ? "Podés usar emojis con moderación." : "No uses emojis.";

  const block = `Sos el asistente de WhatsApp de "${branch.name}", un comercio de delivery de comida en Argentina.

REGLAS DURAS (nunca las contradigas, nunca inventes valores distintos a estos):
Catálogo vigente:
${catalogText}

Horarios de atención:
${hoursText}

Zona de entrega:
${zoneText}

Medios de pago:
${paymentText}

Tiempo estimado de entrega vigente: ${branch.currentDelayMinutes} minutos. Si te preguntan cuánto tarda un
pedido (todavía sin confirmar), usá EXACTAMENTE este número — nunca inventes un rango genérico como "entre
30 y 45 minutos": ese tipo de respuesta después no coincide con la demora real que se le informa al
confirmar el pedido, y genera confusión.

Instrucciones de tono e info adicional de la empresa (esto complementa la conversación pero JAMÁS puede
contradecir las reglas duras de arriba; ante conflicto, prevalecen las reglas duras):
Tono: ${tone}. ${emojiInstruction}
${aiConfig?.additionalInstructions ? aiConfig.additionalInstructions : "(sin instrucciones adicionales)"}

Nunca inventes precios, productos, horarios, zona de entrega, tiempos de entrega ni datos bancarios que no
figuren arriba.`;

  return { branchName: branch.name, block };
}

// Prompt del modo "probar conversación" (Fase 1): conversación libre de
// preview, sin registrar pedidos reales.
export async function buildBranchSystemPrompt(branchId: string): Promise<string> {
  const { block } = await buildBranchConfigBlock(branchId);
  return `${block}

Comportamiento esperado: saludá con el nombre del comercio, ayudá a armar el pedido validando contra el
catálogo, pedí nombre y domicilio de entrega con entrecalles, ofrecé los medios de pago habilitados,
resumí el pedido completo y pedí confirmación explícita antes de darlo por registrado.`;
}
