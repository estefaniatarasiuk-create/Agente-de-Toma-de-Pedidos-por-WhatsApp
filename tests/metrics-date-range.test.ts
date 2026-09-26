import { describe, it, expect } from "vitest";
import { resolveDateRange, dateKeyInTimezone } from "@/lib/metrics/date-range";

const TZ = "America/Argentina/Buenos_Aires";

describe("resolveDateRange", () => {
  it("'hoy' cubre desde la medianoche local hasta la medianoche del día siguiente", () => {
    // 26/9/2026 14:00 UTC = 11:00 en Buenos Aires (UTC-3) — mismo día de calendario.
    const reference = new Date("2026-09-26T14:00:00Z");
    const { from, to } = resolveDateRange("hoy", TZ, undefined, reference);
    expect(to.getTime() - from.getTime()).toBe(24 * 60 * 60 * 1000);
    expect(dateKeyInTimezone(from, TZ) < dateKeyInTimezone(to, TZ)).toBe(true);
  });

  it("'semana' cubre 7 días completos, incluido hoy", () => {
    const reference = new Date("2026-09-26T14:00:00Z");
    const { from, to } = resolveDateRange("semana", TZ, undefined, reference);
    expect((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000)).toBe(7);
  });

  it("'mes' cubre 30 días completos", () => {
    const reference = new Date("2026-09-26T14:00:00Z");
    const { from, to } = resolveDateRange("mes", TZ, undefined, reference);
    expect((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000)).toBe(30);
  });

  it("'personalizado' incluye el día 'hasta' completo (límite superior exclusivo al día siguiente)", () => {
    const { from, to } = resolveDateRange("personalizado", TZ, { from: "2026-09-01", to: "2026-09-05" });
    expect(from.getDate()).toBe(1);
    expect(to.getDate()).toBe(6);
    expect((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000)).toBe(5);
  });

  it("sin datos personalizados, cae de nuevo a 'hoy'", () => {
    const reference = new Date("2026-09-26T14:00:00Z");
    const { from, to } = resolveDateRange("personalizado", TZ, undefined, reference);
    expect(to.getTime() - from.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

describe("dateKeyInTimezone", () => {
  it("agrupa un instante por su día de calendario en la zona horaria indicada", () => {
    // 00:30 UTC del 26/9 es 21:30 del 25/9 en Buenos Aires (UTC-3) — día anterior.
    const instant = new Date("2026-09-26T00:30:00Z");
    expect(dateKeyInTimezone(instant, TZ)).toBe("2026-09-25");
  });
});
