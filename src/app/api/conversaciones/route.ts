import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireBranchContext } from "@/lib/branch-context";

export async function GET() {
  const context = await requireBranchContext();
  if (!context) return NextResponse.json({ error: "No autorizado." }, { status: 401 });

  const conversations = await prisma.conversation.findMany({
    where: { branchId: context.branchId },
    orderBy: { lastMessageAt: "desc" },
    take: 200,
    include: {
      messages: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });

  return NextResponse.json({ conversations });
}
