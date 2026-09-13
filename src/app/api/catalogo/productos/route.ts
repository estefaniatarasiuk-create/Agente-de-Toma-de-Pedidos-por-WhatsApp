import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireBranchContext } from "@/lib/branch-context";
import { productSchema } from "@/lib/validations/product";

export async function GET() {
  const context = await requireBranchContext();
  if (!context) return NextResponse.json({ error: "No autorizado." }, { status: 401 });

  const products = await prisma.product.findMany({
    where: { branchId: context.branchId },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  return NextResponse.json({ products });
}

export async function POST(request: Request) {
  const context = await requireBranchContext();
  if (!context) return NextResponse.json({ error: "No autorizado." }, { status: 401 });

  const body = await request.json().catch(() => null);
  const parsed = productSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Datos inválidos." }, { status: 400 });
  }

  const product = await prisma.product.create({
    data: {
      companyId: context.companyId,
      branchId: context.branchId,
      name: parsed.data.name,
      description: parsed.data.description || null,
      priceCents: parsed.data.priceCents,
      category: parsed.data.category || null,
    },
  });

  return NextResponse.json({ product }, { status: 201 });
}
