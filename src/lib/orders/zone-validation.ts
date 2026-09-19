import { prisma } from "@/lib/prisma";
import { geocodeAddress, distanceKm } from "@/lib/geocoding";

export type AddressValidationResult =
  | { status: "ok"; latitude: number; longitude: number; formattedAddress: string }
  | { status: "out_of_zone"; distanceKm: number; radiusKm: number }
  | { status: "ambiguous" }
  | { status: "zone_not_configured" }
  | { status: "geocoding_unavailable" };

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

  // No podemos permitir que un error acá (ej. falta la API key, corte de
  // red, la cuota de Google se agotó) tire abajo todo el procesamiento del
  // webhook en silencio — el cliente tiene que enterarse igual de que algo
  // pasó, así que esto nunca deja de responder por una excepción sin capturar.
  let geocoded;
  try {
    geocoded = await geocodeAddress(rawAddress, {
      latitude: zone.centerLatitude,
      longitude: zone.centerLongitude,
      radiusKm: zone.radiusKm,
    });
  } catch (error) {
    console.error("Error geocodificando domicilio:", error);
    return { status: "geocoding_unavailable" };
  }
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
