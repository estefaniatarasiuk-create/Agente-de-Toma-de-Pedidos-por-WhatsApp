import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireBranchContext } from "@/lib/branch-context";
import { toSafeLine } from "@/lib/whatsapp/safe-line";

export async function GET() {
  const context = await requireBranchContext();
  if (!context) return NextResponse.json({ error: "No autorizado." }, { status: 401 });

  const line = await prisma.whatsAppLine.findUnique({ where: { branchId: context.branchId } });
  return NextResponse.json({ line: line ? toSafeLine(line) : null });
}
