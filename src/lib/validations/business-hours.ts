import { z } from "zod";

export const businessHourSlotSchema = z
  .object({
    dayOfWeek: z.number().int().min(0).max(6),
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(1).max(1440),
    isActive: z.boolean().default(true),
  })
  .refine((slot) => slot.endMinute > slot.startMinute, {
    message: "El horario de cierre debe ser posterior al de apertura.",
    path: ["endMinute"],
  });

export const businessHoursGridSchema = z.array(businessHourSlotSchema).max(100);

export type BusinessHourSlotInput = z.infer<typeof businessHourSlotSchema>;

export const DAY_NAMES = [
  "Domingo",
  "Lunes",
  "Martes",
  "Miércoles",
  "Jueves",
  "Viernes",
  "Sábado",
] as const;

export function minutesToTimeLabel(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
}

export function timeLabelToMinutes(label: string): number | null {
  const match = label.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 24 || minutes > 59) return null;
  return hours * 60 + minutes;
}
