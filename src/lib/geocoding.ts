import { prisma } from "@/lib/prisma";

const COMMON_ABBREVIATIONS: Array<[RegExp, string]> = [
  [/\bAV\.?\b/g, "AVENIDA"],
  [/\bAVDA\.?\b/g, "AVENIDA"],
  [/\bBV\.?\b/g, "BOULEVARD"],
  [/\bBLVD\.?\b/g, "BOULEVARD"],
  [/\bGRAL\.?\b/g, "GENERAL"],
  [/\bDR\.?\b/g, "DOCTOR"],
  [/\bSTA\.?\b/g, "SANTA"],
  [/\bSTO\.?\b/g, "SANTO"],
  [/\bN°|\bNRO\.?\b|\bNUM\.?\b/g, "NUMERO"],
];

// Normaliza una dirección para usarla como clave de la base propia de
// direcciones validadas (spec §3.5: mayúsculas, sin tildes, abreviaturas
// expandidas, espacios colapsados).
export function normalizeAddress(rawAddress: string): string {
  let normalized = rawAddress
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // quita tildes/diacríticos
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();

  for (const [pattern, replacement] of COMMON_ABBREVIATIONS) {
    normalized = normalized.replace(pattern, replacement);
  }

  return normalized.replace(/\s+/g, " ").trim();
}

export type GeocodeResult = {
  latitude: number;
  longitude: number;
  formattedAddress: string;
  partialMatch: boolean;
  fromCache: boolean;
};

type GoogleGeocodeResponse = {
  status: string;
  results: Array<{
    formatted_address: string;
    partial_match?: boolean;
    geometry: { location: { lat: number; lng: number } };
  }>;
};

// Busca primero en la base propia (AddressCache); si no está, geocodifica
// con Google Maps y guarda el resultado para futuras consultas (optimiza
// costo y tiempo de respuesta, tal como pide la spec).
export async function geocodeAddress(rawAddress: string): Promise<GeocodeResult | null> {
  const normalizedAddress = normalizeAddress(rawAddress);

  const cached = await prisma.addressCache.findUnique({ where: { normalizedAddress } });
  if (cached) {
    return {
      latitude: cached.latitude,
      longitude: cached.longitude,
      formattedAddress: cached.formattedAddress ?? cached.rawAddress,
      partialMatch: false,
      fromCache: true,
    };
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) throw new Error("Falta GOOGLE_MAPS_API_KEY.");

  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", rawAddress);
  url.searchParams.set("region", "ar");
  url.searchParams.set("components", "country:AR");
  url.searchParams.set("key", apiKey);

  const response = await fetch(url.toString());
  const data = (await response.json()) as GoogleGeocodeResponse;

  if (data.status !== "OK" || data.results.length === 0) {
    return null;
  }

  const bestResult = data.results[0];
  const isAmbiguous = data.results.length > 1 || Boolean(bestResult.partial_match);

  await prisma.addressCache.create({
    data: {
      normalizedAddress,
      rawAddress,
      formattedAddress: bestResult.formatted_address,
      latitude: bestResult.geometry.location.lat,
      longitude: bestResult.geometry.location.lng,
      provider: "google",
    },
  });

  return {
    latitude: bestResult.geometry.location.lat,
    longitude: bestResult.geometry.location.lng,
    formattedAddress: bestResult.formatted_address,
    partialMatch: isAmbiguous,
    fromCache: false,
  };
}

// Distancia entre dos puntos (fórmula de Haversine), en kilómetros.
export function distanceKm(
  pointA: { latitude: number; longitude: number },
  pointB: { latitude: number; longitude: number },
): number {
  const EARTH_RADIUS_KM = 6371;
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

  const deltaLat = toRadians(pointB.latitude - pointA.latitude);
  const deltaLng = toRadians(pointB.longitude - pointA.longitude);

  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(pointA.latitude)) *
      Math.cos(toRadians(pointB.latitude)) *
      Math.sin(deltaLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS_KM * c;
}
