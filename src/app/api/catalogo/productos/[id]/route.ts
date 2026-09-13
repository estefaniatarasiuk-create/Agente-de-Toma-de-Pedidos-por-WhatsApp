import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireBranchContext } from "@/lib/branch-context";
import { productSchema } from "@/lib/validations/product";

async function findOwnedProduct(branchId: string, productId: string) {
  return prisma.product.findFirst({ where: { id: productId, branchId } });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await requireBranchContext();
  if (!context) return NextResponse.json({ error: "No autorizado." }, { status: 401 });

  const { id } = await params;
  const existing = await findOwnedProduct(context.branchId, id);
  if (!existing) return NextResponse.json({ error: "Producto no encontrado." }, { status: 404 });

  const body = await request.json().catch(() => null);

  // Pausar/reactivar (US2.2) no manda el resto de los campos: se acepta solo isActive.
  if (body && typeof body.isActive === "boolean" && Object.keys(body).length === 1) {
    const product = await prisma.product.update({ where: { id }, data: { isActive: body.isActive } });
    return NextResponse.json({ product });
  }

  const parsed = productSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Datos inválidos." }, { status: 400 });
  }

  const product = await prisma.product.update({
    where: { id },
    data: {
      name: parsed.data.name,
      description: parsed.data.description || null,
      priceCents: parsed.data.priceCents,
      category: parsed.data.category || null,
    },
  });

  return NextResponse.json({ product });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await requireBranchContext();
  if (!context) return NextResponse.json({ error: "No autorizado." }, { status: 401 });

  const { id } = await params;
  const existing = await findOwnedProduct(context.branchId, id);
  if (!existing) return NextResponse.json({ error: "Producto no encontrado." }, { status: 404 });

  await prisma.product.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
