import { describe, it, expect } from "vitest";
import { ORDER_STATUS_LABEL, ORDER_STATUS_BADGE_CLASS, ORDER_STATUS_ACCENT_CLASS } from "@/lib/orders/order-status";

const ALL_STATUSES = ["WAITING_RECEIPT", "PENDING", "PREPARING", "ON_THE_WAY", "DELIVERED", "CANCELLED"] as const;

// Regresión de un bug real reportado: el tablero, el detalle de pedido y el
// historial mostraban TODOS los estados con la misma etiqueta gris — un
// futuro estado que se agregue al enum de Prisma sin actualizar estos mapas
// volvería a caer en el mismo problema (perdería su color/label). Este test
// no evita que se olviden de actualizar el enum, pero si alguien agrega un
// estado acá sin llenar los tres mapas, esto lo detecta.
describe("order-status", () => {
  it("cada estado tiene una etiqueta y un color de badge distintos", () => {
    for (const status of ALL_STATUSES) {
      expect(ORDER_STATUS_LABEL[status]).toBeTruthy();
      expect(ORDER_STATUS_BADGE_CLASS[status]).toBeTruthy();
      expect(ORDER_STATUS_ACCENT_CLASS[status]).toBeTruthy();
    }
  });

  it("no repite el mismo color de badge entre dos estados distintos", () => {
    const badgeClasses = ALL_STATUSES.map((status) => ORDER_STATUS_BADGE_CLASS[status]);
    expect(new Set(badgeClasses).size).toBe(ALL_STATUSES.length);
  });
});
