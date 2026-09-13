import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireBranchContext } from "@/lib/branch-context";
import { paymentMethodSchema } from "@/lib/validations/payment-method";

export async function GET() {
  const context = await requireBranchContext();
  if (!context) return NextResponse.json({ error: "No autorizado." }, { status: 401 });

  const config = await prisma.paymentMethodConfig.findUnique({ where: { branchId: context.branchId } });
  return NextResponse.json({ config });
}

export async function PUT(request: Request) {
  const context = await requireBranchContext();
  if (!context) return NextResponse.json({ error: "No autorizado." }, { status: 401 });

  const body = await request.json().catch(() => null);
  const parsed = paymentMethodSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Datos inválidos." }, { status: 400 });
  }

  const data = parsed.data;
  const config = await prisma.paymentMethodConfig.upsert({
    where: { branchId: context.branchId },
    create: {
      companyId: context.companyId,
      branchId: context.branchId,
      cashEnabled: data.cashEnabled,
      transferEnabled: data.transferEnabled,
      transferAlias: data.transferAlias || null,
      transferCbu: data.transferCbu || null,
      transferHolder: data.transferHolder || null,
      transferCuit: data.transferCuit || null,
    },
    update: {
      cashEnabled: data.cashEnabled,
      transferEnabled: data.transferEnabled,
      transferAlias: data.transferAlias || null,
      transferCbu: data.transferCbu || null,
      transferHolder: data.transferHolder || null,
      transferCuit: data.transferCuit || null,
    },
  });

  return NextResponse.json({ config });
}
