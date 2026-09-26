import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireBranchContext } from "@/lib/branch-context";
import { resolveDateRange, dateKeyInTimezone, type MetricsRangeKey } from "@/lib/metrics/date-range";

const VALID_RANGES = new Set<MetricsRangeKey>(["hoy", "semana", "mes", "personalizado"]);

export async function GET(request: Request) {
  const context = await requireBranchContext();
  if (!context) return NextResponse.json({ error: "No autorizado." }, { status: 401 });

  const url = new URL(request.url);
  const rangeParam = url.searchParams.get("range");
  const rangeKey: MetricsRangeKey = VALID_RANGES.has(rangeParam as MetricsRangeKey)
    ? (rangeParam as MetricsRangeKey)
    : "hoy";
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");

  const { from, to } = resolveDateRange(
    rangeKey,
    context.branch.timezone,
    rangeKey === "personalizado" && fromParam && toParam ? { from: fromParam, to: toParam } : undefined,
  );

  // "Ventas" (Fase 5, alcance confirmado): pedidos y facturación, ticket
  // promedio, efectivo vs. transferencia. Se excluyen los cancelados — no
  // representan una venta real. WAITING_RECEIPT sí cuenta: el pedido ya fue
  // confirmado por el cliente, solo falta que se valide el comprobante.
  const orders = await prisma.order.findMany({
    where: {
      branchId: context.branchId,
      status: { not: "CANCELLED" },
      createdAt: { gte: from, lt: to },
    },
    select: { totalCents: true, paymentMethod: true, createdAt: true },
  });

  const totalOrders = orders.length;
  const totalRevenueCents = orders.reduce((sum, order) => sum + order.totalCents, 0);
  const averageOrderCents = totalOrders > 0 ? Math.round(totalRevenueCents / totalOrders) : 0;

  const cashOrders = orders.filter((order) => order.paymentMethod === "CASH");
  const transferOrders = orders.filter((order) => order.paymentMethod === "TRANSFER");

  const dailyMap = new Map<string, { orders: number; revenueCents: number }>();
  for (const order of orders) {
    const key = dateKeyInTimezone(order.createdAt, context.branch.timezone);
    const entry = dailyMap.get(key) ?? { orders: 0, revenueCents: 0 };
    entry.orders += 1;
    entry.revenueCents += order.totalCents;
    dailyMap.set(key, entry);
  }
  const daily = Array.from(dailyMap.entries())
    .map(([date, value]) => ({ date, ...value }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return NextResponse.json({
    range: { key: rangeKey, from: from.toISOString(), to: to.toISOString() },
    totalOrders,
    totalRevenueCents,
    averageOrderCents,
    cash: {
      orders: cashOrders.length,
      revenueCents: cashOrders.reduce((sum, order) => sum + order.totalCents, 0),
    },
    transfer: {
      orders: transferOrders.length,
      revenueCents: transferOrders.reduce((sum, order) => sum + order.totalCents, 0),
    },
    daily,
  });
}
