import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireBranchContext } from "@/lib/branch-context";
import { renderCatalogImage } from "@/lib/catalog-image";
import { isSupportedUploadMimeType, saveUploadedFile } from "@/lib/uploads";

export async function GET() {
  const context = await requireBranchContext();
  if (!context) return NextResponse.json({ error: "No autorizado." }, { status: 401 });

  const catalogImage = await prisma.catalogImage.findUnique({ where: { branchId: context.branchId } });
  return NextResponse.json({ catalogImage });
}

// Genera automáticamente la imagen del catálogo a partir de los productos
// activos vigentes.
export async function POST() {
  const context = await requireBranchContext();
  if (!context) return NextResponse.json({ error: "No autorizado." }, { status: 401 });

  const products = await prisma.product.findMany({
    where: { branchId: context.branchId, isActive: true },
    orderBy: [{ category: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
  });

  if (products.length === 0) {
    return NextResponse.json({ error: "Cargá al menos un producto activo antes de generar la imagen." }, { status: 400 });
  }

  const imageBuffer = await renderCatalogImage(context.branch.name, products);
  const relativePath = await saveUploadedFile({
    subdir: "catalogo",
    buffer: imageBuffer,
    mimeType: "image/png",
  });

  const catalogImage = await prisma.catalogImage.upsert({
    where: { branchId: context.branchId },
    create: {
      companyId: context.companyId,
      branchId: context.branchId,
      imageUrl: relativePath,
      source: "GENERATED",
      generatedAt: new Date(),
    },
    update: { imageUrl: relativePath, source: "GENERATED", generatedAt: new Date() },
  });

  return NextResponse.json({ catalogImage });
}

// Subida manual de una foto/imagen propia del catálogo (reemplaza a la generada).
export async function PUT(request: Request) {
  const context = await requireBranchContext();
  if (!context) return NextResponse.json({ error: "No autorizado." }, { status: 401 });

  const formData = await request.formData().catch(() => null);
  const file = formData?.get("file");
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: "Subí una imagen." }, { status: 400 });
  }
  if (!isSupportedUploadMimeType(file.type)) {
    return NextResponse.json({ error: "Formato no soportado. Usá JPG, PNG o WEBP." }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const relativePath = await saveUploadedFile({ subdir: "catalogo", buffer, mimeType: file.type });

  const catalogImage = await prisma.catalogImage.upsert({
    where: { branchId: context.branchId },
    create: {
      companyId: context.companyId,
      branchId: context.branchId,
      imageUrl: relativePath,
      source: "UPLOADED",
      generatedAt: new Date(),
    },
    update: { imageUrl: relativePath, source: "UPLOADED", generatedAt: new Date() },
  });

  return NextResponse.json({ catalogImage });
}
