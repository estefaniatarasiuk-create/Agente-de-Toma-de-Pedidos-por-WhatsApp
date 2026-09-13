import { prisma } from "@/lib/prisma";
import { formatCentsAsArs } from "@/lib/money";
import { DAY_NAMES, minutesToTimeLabel } from "@/lib/validations/business-hours";

// Arma el prompt de sistema con la configuración vigente de la sucursal:
// catálogo, horarios, zona, medios de pago, tono e instrucciones libres.
// Esto es lo único que ve el modelo — las reglas duras (precios, horarios,
// zona, datos bancarios) están acá como datos, pero se VALIDAN aparte en
// código en cada paso del flujo real (no dependemos de que el modelo las
// respete al pie de la letra).
export async function buildBranchSystemPrompt(branchId: string): Promise<string> {
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
      ? products.map((p) => `- ${p.name}${p.category ? ` (${p.category})` : ""}: ${formatCentsAsArs(p.priceCents)}${p.description ? ` — ${p.description}` : ""}`).join("\n")
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
        paymentMethod.transferEnabled
          ? `- Transferencia: alias ${paymentMethod.transferAlias ?? "-"}, CBU ${paymentMethod.transferCbu ?? "-"}, titular ${paymentMethod.transferHolder ?? "-"}, CUIT ${paymentMethod.transferCuit ?? "-"}`
          : null,
      ]
        .filter(Boolean)
        .join("\n")
    : "(todavía no hay medios de pago configurados)";

  const tone = aiConfig?.tone === "FORMAL" ? "formal y profesional" : "cercano y amigable";
  const emojiInstruction = aiConfig?.useEmojis ? "Podés usar emojis con moderación." : "No uses emojis.";

  return `Sos el asistente de WhatsApp de "${branch.name}", un comercio de delivery de comida en Argentina.

REGLAS DURAS (nunca las contradigas, nunca inventes valores distintos a estos):
Catálogo vigente:
${catalogText}

Horarios de atención:
${hoursText}

Zona de entrega:
${zoneText}

Medios de pago:
${paymentText}

Instrucciones de tono e info adicional de la empresa (esto complementa la conversación pero JAMÁS puede
contradecir las reglas duras de arriba; ante conflicto, prevalecen las reglas duras):
Tono: ${tone}. ${emojiInstruction}
${aiConfig?.additionalInstructions ? aiConfig.additionalInstructions : "(sin instrucciones adicionales)"}

Comportamiento esperado: saludá con el nombre del comercio, ayudá a armar el pedido validando contra el
catálogo, pedí nombre y domicilio de entrega con entrecalles, ofrecé los medios de pago habilitados,
resumí el pedido completo y pedí confirmación explícita antes de darlo por registrado. Nunca inventes
precios, productos, horarios, zona de entrega ni datos bancarios que no figuren arriba.`;
}
