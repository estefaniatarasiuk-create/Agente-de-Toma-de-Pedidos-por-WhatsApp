import { prisma } from "@/lib/prisma";
import { geocodeAddress, distanceKm } from "@/lib/geocoding";

export type AddressValidationResult =
  | { status: "ok"; latitude: number; longitude: number; formattedAddress: string }
  | { status: "out_of_zone"; distanceKm: number; radiusKm: number }
  | { status: "ambiguous" }
  | { status: "zone_not_configured" };

// Valida un domicilio contra la zona de entrega de la sucursal (spec §3.5):
// primero geocodifica (con cache propia, ver lib/geocoding.ts) y después
// mide la distancia real contra el radio configurado. Determinístico, no
// depende de que la IA "opine" si algo está lejos o cerca.
export async function validateDeliveryAddress(
  branchId: string,
  rawAddress: string,
): Promise<AddressValidationResult> {
  const zone = await prisma.deliveryZone.findUnique({ where: { branchId } });
  if (!zone) return { status: "zone_not_configured" };

  const geocoded = await geocodeAddress(rawAddress);
  if (!geocoded) return { status: "ambiguous" };

  const distance = distanceKm(
    { latitude: zone.centerLatitude, longitude: zone.centerLongitude },
    { latitude: geocoded.latitude, longitude: geocoded.longitude },
  );

  if (distance > zone.radiusKm) {
    return { status: "out_of_zone", distanceKm: distance, radiusKm: zone.radiusKm };
  }

  return {
    status: "ok",
    latitude: geocoded.latitude,
    longitude: geocoded.longitude,
    formattedAddress: geocoded.formattedAddress,
  };
}
