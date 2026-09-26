import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireBranchContext } from "@/lib/branch-context";
import { buildHistorialWhere } from "@/lib/orders/historial-filters";

const PAGE_SIZE = 25;

export async function GET(request: Request) {
  const context = await requireBranchContext();
  if (!context) return NextResponse.json({ error: "No autorizado." }, { status: 401 });

  const url = new URL(request.url);
  const where = buildHistorialWhere(context.branchId, {
    from: url.searchParams.get("from"),
    to: url.searchParams.get("to"),
    cliente: url.searchParams.get("cliente"),
    estado: url.searchParams.get("estado"),
  });

  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { items: true },
    }),
    prisma.order.count({ where }),
  ]);

  return NextResponse.json({ orders, total, page, pageSize: PAGE_SIZE });
}
