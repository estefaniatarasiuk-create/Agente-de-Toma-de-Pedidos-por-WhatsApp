import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireBranchContext } from "@/lib/branch-context";
import { draftCatalogSchema, parsePriceToCents } from "@/lib/validations/product";

// Alta masiva de productos ya revisados/editados por el usuario. La escritura
// en el catálogo es siempre determinística: la IA solo propuso, el usuario
// confirmó, y acá se guarda tal cual sin pasar de nuevo por el modelo.
export async function POST(request: Request) {
  const context = await requireBranchContext();
  if (!context) return NextResponse.json({ error: "No autorizado." }, { status: 401 });

  const body = await request.json().catch(() => null);
  const parsed = draftCatalogSchema.safeParse(body?.products);
  if (!parsed.success) {
    return NextResponse.json({ error: "Datos de productos inválidos." }, { status: 400 });
  }

  const productsToCreate = parsed.data
    .map((product) => {
      const priceCents = parsePriceToCents(product.price);
      if (priceCents === null) return null;
      return {
        companyId: context.companyId,
        branchId: context.branchId,
        name: product.name,
        description: product.description || null,
        priceCents,
        category: product.category || null,
      };
    })
    .filter((product): product is NonNullable<typeof product> => product !== null);

  if (productsToCreate.length === 0) {
    return NextResponse.json({ error: "No hay productos válidos para guardar." }, { status: 400 });
  }

  const result = await prisma.product.createMany({ data: productsToCreate });
  return NextResponse.json({ created: result.count }, { status: 201 });
}
