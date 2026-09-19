import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireBranchContext } from "@/lib/branch-context";

export async function GET() {
  const context = await requireBranchContext();
  if (!context) return NextResponse.json({ error: "No autorizado." }, { status: 401 });

  const orders = await prisma.order.findMany({
    where: { branchId: context.branchId },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { items: true },
  });

  return NextResponse.json({ orders });
}
