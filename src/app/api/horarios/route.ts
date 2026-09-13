import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireBranchContext } from "@/lib/branch-context";
import { businessHoursGridSchema } from "@/lib/validations/business-hours";

export async function GET() {
  const context = await requireBranchContext();
  if (!context) return NextResponse.json({ error: "No autorizado." }, { status: 401 });

  const slots = await prisma.businessHourSlot.findMany({
    where: { branchId: context.branchId },
    orderBy: [{ dayOfWeek: "asc" }, { startMinute: "asc" }],
  });
  return NextResponse.json({ slots });
}

// Reemplaza toda la grilla por la confirmada por el usuario (US3.2/US3.3):
// la operación se rige siempre por la última grilla confirmada, no por un
// historial acumulado de franjas.
export async function PUT(request: Request) {
  const context = await requireBranchContext();
  if (!context) return NextResponse.json({ error: "No autorizado." }, { status: 401 });

  const body = await request.json().catch(() => null);
  const parsed = businessHoursGridSchema.safeParse(body?.slots);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Grilla inválida." }, { status: 400 });
  }

  await prisma.$transaction([
    prisma.businessHourSlot.deleteMany({ where: { branchId: context.branchId } }),
    prisma.businessHourSlot.createMany({
      data: parsed.data.map((slot) => ({
        companyId: context.companyId,
        branchId: context.branchId,
        dayOfWeek: slot.dayOfWeek,
        startMinute: slot.startMinute,
        endMinute: slot.endMinute,
        isActive: slot.isActive,
      })),
    }),
  ]);

  const slots = await prisma.businessHourSlot.findMany({
    where: { branchId: context.branchId },
    orderBy: [{ dayOfWeek: "asc" }, { startMinute: "asc" }],
  });
  return NextResponse.json({ slots });
}
