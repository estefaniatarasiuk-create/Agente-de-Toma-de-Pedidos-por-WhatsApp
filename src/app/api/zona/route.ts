import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireBranchContext } from "@/lib/branch-context";
import { deliveryZoneSchema } from "@/lib/validations/delivery-zone";

export async function GET() {
  const context = await requireBranchContext();
  if (!context) return NextResponse.json({ error: "No autorizado." }, { status: 401 });

  const zone = await prisma.deliveryZone.findUnique({ where: { branchId: context.branchId } });
  return NextResponse.json({ zone, branch: context.branch });
}

export async function PUT(request: Request) {
  const context = await requireBranchContext();
  if (!context) return NextResponse.json({ error: "No autorizado." }, { status: 401 });

  const body = await request.json().catch(() => null);
  const parsed = deliveryZoneSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Datos inválidos." }, { status: 400 });
  }

  const zone = await prisma.deliveryZone.upsert({
    where: { branchId: context.branchId },
    create: {
      companyId: context.companyId,
      branchId: context.branchId,
      centerLatitude: parsed.data.centerLatitude,
      centerLongitude: parsed.data.centerLongitude,
      radiusKm: parsed.data.radiusKm,
    },
    update: {
      centerLatitude: parsed.data.centerLatitude,
      centerLongitude: parsed.data.centerLongitude,
      radiusKm: parsed.data.radiusKm,
    },
  });

  return NextResponse.json({ zone });
}
