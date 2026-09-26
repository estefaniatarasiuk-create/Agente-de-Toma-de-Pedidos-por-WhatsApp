// El servidor corre en UTC (ver business-hours.ts, que usa el mismo truco):
// leer los getters "locales" de un Date construido a partir de
// toLocaleString(tz) equivale a leerlo en esa zona horaria. Se usa acá para
// calcular límites de "día de calendario" en la zona de la sucursal sin
// depender de una librería de fechas.
function zonedNow(timezone: string, reference: Date): Date {
  return new Date(reference.toLocaleString("en-US", { timeZone: timezone }));
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

export type MetricsRangeKey = "hoy" | "semana" | "mes" | "personalizado";

export const METRICS_RANGE_LABEL: Record<MetricsRangeKey, string> = {
  hoy: "Hoy",
  semana: "Últimos 7 días",
  mes: "Últimos 30 días",
  personalizado: "Personalizado",
};

// Rango [from, to) — "to" es el límite superior EXCLUSIVO.
export type ResolvedDateRange = { from: Date; to: Date };

export function resolveDateRange(
  rangeKey: MetricsRangeKey,
  timezone: string,
  custom?: { from: string; to: string },
  reference: Date = new Date(),
): ResolvedDateRange {
  const todayStart = startOfDay(zonedNow(timezone, reference));
  const tomorrowStart = addDays(todayStart, 1);

  if (rangeKey === "semana") return { from: addDays(todayStart, -6), to: tomorrowStart };
  if (rangeKey === "mes") return { from: addDays(todayStart, -29), to: tomorrowStart };

  if (rangeKey === "personalizado" && custom?.from && custom?.to) {
    const from = parseCalendarDate(custom.from);
    const to = parseCalendarDate(custom.to);
    if (from && to) return { from, to: addDays(to, 1) };
  }

  return { from: todayStart, to: tomorrowStart };
}

// Un input type="date" ya entrega una fecha de calendario sin ambigüedad de
// zona horaria — se arma el Date directo desde año/mes/día, sin pasar por
// zonedNow (que es solo para convertir "ahora" a un día de calendario).
function parseCalendarDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  return new Date(Number(year), Number(month) - 1, Number(day));
}

// Etiqueta "YYYY-MM-DD" de calendario para un instante, en la zona horaria
// dada — para agrupar pedidos por día en la tendencia diaria. A diferencia
// de zonedNow, esto no asume que el servidor corre en UTC (usa
// Intl.DateTimeFormat con timeZone explícito), así que es seguro para
// cualquier entorno.
export function dateKeyInTimezone(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
