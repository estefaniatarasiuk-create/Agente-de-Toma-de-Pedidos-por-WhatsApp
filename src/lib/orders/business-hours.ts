import { prisma } from "@/lib/prisma";
import { DAY_NAMES, minutesToTimeLabel } from "@/lib/validations/business-hours";

// Chequea si "ahora" (en la zona horaria de la sucursal) cae dentro de
// alguna franja activa. Es 100% determinístico: no depende de la IA
// (spec §3.3 — fuera de horario no requiere invocar al modelo).
export async function isWithinBusinessHours(branchId: string, now: Date = new Date()): Promise<boolean> {
  const branch = await prisma.branch.findUniqueOrThrow({ where: { id: branchId } });
  const zoned = new Date(now.toLocaleString("en-US", { timeZone: branch.timezone }));
  const dayOfWeek = zoned.getDay();
  const minutesNow = zoned.getHours() * 60 + zoned.getMinutes();

  const slot = await prisma.businessHourSlot.findFirst({
    where: {
      branchId,
      dayOfWeek,
      isActive: true,
      startMinute: { lte: minutesNow },
      endMinute: { gt: minutesNow },
    },
  });

  return slot !== null;
}

export async function buildOutOfHoursMessage(branchId: string): Promise<string> {
  const slots = await prisma.businessHourSlot.findMany({
    where: { branchId, isActive: true },
    orderBy: [{ dayOfWeek: "asc" }, { startMinute: "asc" }],
  });

  if (slots.length === 0) {
    return "En este momento no estamos atendiendo pedidos. Todavía no cargamos nuestros horarios de atención, ¡escribinos más tarde!";
  }

  const byDay = new Map<number, string[]>();
  for (const slot of slots) {
    const list = byDay.get(slot.dayOfWeek) ?? [];
    list.push(`${minutesToTimeLabel(slot.startMinute)} a ${minutesToTimeLabel(slot.endMinute)}`);
    byDay.set(slot.dayOfWeek, list);
  }

  const lines = DAY_NAMES.map((name, index) =>
    byDay.has(index) ? `${name}: ${byDay.get(index)!.join(" y ")}` : null,
  ).filter((line): line is string => line !== null);

  return `¡Gracias por escribirnos! En este momento estamos fuera de nuestro horario de atención.\n\nNuestros horarios son:\n${lines.join("\n")}\n\nEscribinos de nuevo en ese horario y con gusto te ayudamos.`;
}
