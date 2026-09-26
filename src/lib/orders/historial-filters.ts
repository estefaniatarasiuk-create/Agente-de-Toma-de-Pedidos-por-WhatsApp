import type { Prisma, OrderStatus } from "@prisma/client";

export { ORDER_STATUS_LABEL, ORDER_STATUS_BADGE_CLASS } from "./order-status";

const VALID_STATUSES = new Set<OrderStatus>([
  "WAITING_RECEIPT",
  "PENDING",
  "PREPARING",
  "ON_THE_WAY",
  "DELIVERED",
  "CANCELLED",
]);

export type HistorialFilterParams = {
  from: string | null; // "YYYY-MM-DD"
  to: string | null; // "YYYY-MM-DD"
  cliente: string | null;
  estado: string | null;
};

function parseCalendarDate(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

// Compartido entre /api/pedidos/historial (lista paginada) y su endpoint de
// exportación a CSV — ambos deben aplicar exactamente los mismos filtros
// para que lo que se descarga coincida con lo que se ve en pantalla.
export function buildHistorialWhere(branchId: string, params: HistorialFilterParams): Prisma.OrderWhereInput {
  const where: Prisma.OrderWhereInput = { branchId };

  if (params.from || params.to) {
    const createdAt: Prisma.DateTimeFilter = {};
    if (params.from) {
      const parsed = parseCalendarDate(params.from);
      if (parsed) createdAt.gte = new Date(parsed.year, parsed.month - 1, parsed.day);
    }
    if (params.to) {
      const parsed = parseCalendarDate(params.to);
      if (parsed) createdAt.lt = new Date(parsed.year, parsed.month - 1, parsed.day + 1);
    }
    if (Object.keys(createdAt).length > 0) where.createdAt = createdAt;
  }

  if (params.cliente) {
    where.OR = [
      { customerName: { contains: params.cliente, mode: "insensitive" } },
      { customerPhone: { contains: params.cliente } },
    ];
  }

  if (params.estado && VALID_STATUSES.has(params.estado as OrderStatus)) {
    where.status = params.estado as OrderStatus;
  }

  return where;
}
