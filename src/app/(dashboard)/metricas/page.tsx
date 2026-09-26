import { prisma } from "@/lib/prisma";
import { requireBranchContext } from "@/lib/branch-context";
import { resolveDateRange, dateKeyInTimezone } from "@/lib/metrics/date-range";
import { MetricsDashboard, type MetricsData } from "./metrics-dashboard";

async function loadMetrics(branchId: string, timezone: string): Promise<MetricsData> {
  const { from, to } = resolveDateRange("hoy", timezone);

  const orders = await prisma.order.findMany({
    where: { branchId, status: { not: "CANCELLED" }, createdAt: { gte: from, lt: to } },
    select: { totalCents: true, paymentMethod: true, createdAt: true },
  });

  const totalOrders = orders.length;
  const totalRevenueCents = orders.reduce((sum, order) => sum + order.totalCents, 0);
  const averageOrderCents = totalOrders > 0 ? Math.round(totalRevenueCents / totalOrders) : 0;
  const cashOrders = orders.filter((order) => order.paymentMethod === "CASH");
  const transferOrders = orders.filter((order) => order.paymentMethod === "TRANSFER");

  const dailyMap = new Map<string, { orders: number; revenueCents: number }>();
  for (const order of orders) {
    const key = dateKeyInTimezone(order.createdAt, timezone);
    const entry = dailyMap.get(key) ?? { orders: 0, revenueCents: 0 };
    entry.orders += 1;
    entry.revenueCents += order.totalCents;
    dailyMap.set(key, entry);
  }

  return {
    range: { key: "hoy", from: from.toISOString(), to: to.toISOString() },
    totalOrders,
    totalRevenueCents,
    averageOrderCents,
    cash: { orders: cashOrders.length, revenueCents: cashOrders.reduce((sum, order) => sum + order.totalCents, 0) },
    transfer: {
      orders: transferOrders.length,
      revenueCents: transferOrders.reduce((sum, order) => sum + order.totalCents, 0),
    },
    daily: Array.from(dailyMap.entries())
      .map(([date, value]) => ({ date, ...value }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}

export default async function MetricasPage() {
  const context = await requireBranchContext();
  const initialData = context ? await loadMetrics(context.branchId, context.branch.timezone) : null;

  return <MetricsDashboard initialData={initialData} />;
}
