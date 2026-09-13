import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireBranchContext } from "@/lib/branch-context";
import { branchAddressSchema } from "@/lib/validations/delivery-zone";
import { geocodeAddress } from "@/lib/geocoding";

// Geocodifica la dirección del local y la guarda en la sucursal: es el
// centro sobre el que después se dibuja el radio de entrega.
export async function POST(request: Request) {
  const context = await requireBranchContext();
  if (!context) return NextResponse.json({ error: "No autorizado." }, { status: 401 });

  const body = await request.json().catch(() => null);
  const parsed = branchAddressSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Dirección inválida." }, { status: 400 });
  }

  try {
    const geocoded = await geocodeAddress(parsed.data.address);
    if (!geocoded) {
      return NextResponse.json(
        { error: "No pudimos encontrar esa dirección. Probá agregando barrio o ciudad." },
        { status: 422 },
      );
    }

    const branch = await prisma.branch.update({
      where: { id: context.branchId },
      data: { address: parsed.data.address, latitude: geocoded.latitude, longitude: geocoded.longitude },
    });

    return NextResponse.json({ branch, geocoded });
  } catch (error) {
    console.error("Error geocodificando dirección del local:", error);
    return NextResponse.json({ error: "No pudimos geocodificar la dirección. Probá de nuevo." }, { status: 502 });
  }
}
