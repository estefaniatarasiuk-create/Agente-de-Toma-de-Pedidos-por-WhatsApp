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

// Frase de entrecalles ("entre X y Y", o la abreviatura "e X y Y" pegada a
// la altura) — bug real reportado: si la calle principal está mal escrita,
// Google a veces toma una de las calles del "entre" como si fuera la
// principal (mandó "1510 Guido de granc entre Barbieri y Perón" y devolvió
// "Vicente Barbieri 1510" en vez de intentar algo parecido a la calle real).
// Se le manda a geocodificar la dirección SIN esta parte — el domicilio
// completo con entrecalles se sigue guardando y mostrando al cliente tal
// cual, esto solo limpia la búsqueda que se le manda a Google.
const CROSS_STREETS_RE = /\bentre\s+.+?\s+y\s+.+?(?=,|$)|(?<=\d)\s+e\s+.+?\s+y\s+.+?(?=,|$)/i;

export function stripCrossStreetsForQuery(address: string): string {
  return address
    .replace(CROSS_STREETS_RE, "")
    .replace(/\s{2,}/g, " ")
    .replace(/,\s*$/, "")
    .trim();
}

export type GeocodeResult = {
  latitude: number;
  longitude: number;
  formattedAddress: string;
  partialMatch: boolean;
  fromCache: boolean;
  // false si el resultado es "a nivel de localidad" (Google no encontró la
  // calle puntual y devolvió el centro de toda la ciudad/partido en su
  // lugar) — pasa seguido cuando se restringe la búsqueda con "components"
  // a una localidad y la calle está mal escrita: Google, en vez de fallar,
  // devuelve la localidad entera como si fuera una coincidencia válida. Un
  // resultado así NUNCA debería aceptarse ni sugerirse como si fuera la
  // dirección puntual del cliente — ver el chequeo en zone-validation.ts.
  isPreciseMatch: boolean;
};

const PRECISE_RESULT_TYPES = new Set(["street_address", "premise", "subpremise", "route"]);

function isPreciseGeocodeResult(types: string[] | undefined): boolean {
  return (types ?? []).some((type) => PRECISE_RESULT_TYPES.has(type));
}

type GoogleGeocodeResponse = {
  status: string;
  results: Array<{
    formatted_address: string;
    partial_match?: boolean;
    types?: string[];
    geometry: { location: { lat: number; lng: number } };
  }>;
};

// Sesgo de ubicación opcional (centro de la zona de entrega + su radio):
// Argentina tiene muchísimas calles con el mismo nombre en localidades
// distintas, así que sin esto Google puede devolver una coincidencia
// "válida" pero en la ciudad equivocada — con el sesgo prioriza resultados
// cerca del local, que es lo que casi siempre corresponde para un pedido.
export type GeocodeBias = { latitude: number; longitude: number; radiusKm: number };

// Busca primero en la base propia (AddressCache); si no está, geocodifica
// con Google Maps y guarda el resultado para futuras consultas (optimiza
// costo y tiempo de respuesta, tal como pide la spec).
//
// "localityHint" restringe la búsqueda a una localidad puntual (Google
// Geocoding admite "locality" como filtro de "components", no solo como
// sesgo blando) — se usa para el reintento cuando la primera pasada da
// fuera de zona, ver zone-validation.ts. Se cachea aparte (con un sufijo en
// la clave) para no mezclar resultados de una búsqueda sin restringir con
// los de una restringida a una localidad puntual.
export async function geocodeAddress(
  rawAddress: string,
  bias?: GeocodeBias,
  localityHint?: string,
): Promise<GeocodeResult | null> {
  const normalizedAddress = localityHint
    ? `${normalizeAddress(rawAddress)}|LOC:${normalizeAddress(localityHint)}`
    : normalizeAddress(rawAddress);

  const cached = await prisma.addressCache.findUnique({ where: { normalizedAddress } });
  if (cached) {
    return {
      latitude: cached.latitude,
      longitude: cached.longitude,
      formattedAddress: cached.formattedAddress ?? cached.rawAddress,
      partialMatch: false,
      // Solo se cachean resultados precisos (ver más abajo), así que
      // cualquier entrada en la cache es, por construcción, precisa.
      isPreciseMatch: true,
      fromCache: true,
    };
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) throw new Error("Falta GOOGLE_MAPS_API_KEY.");

  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", stripCrossStreetsForQuery(rawAddress));
  url.searchParams.set("region", "ar");
  url.searchParams.set("components", localityHint ? `country:AR|locality:${localityHint}` : "country:AR");
  if (bias) {
    // El parámetro de sesgo de la Geocoding API es "bounds" (una caja,
    // no location+radius como en otras APIs de Maps): dos esquinas
    // lat/lng. 1° de latitud ≈ 111km; la longitud se ajusta por el coseno
    // de la latitud, ya que los meridianos se acercan hacia los polos.
    const latDelta = bias.radiusKm / 111;
    const lngDelta = bias.radiusKm / (111 * Math.cos((bias.latitude * Math.PI) / 180));
    const south = bias.latitude - latDelta;
    const west = bias.longitude - lngDelta;
    const north = bias.latitude + latDelta;
    const east = bias.longitude + lngDelta;
    url.searchParams.set("bounds", `${south},${west}|${north},${east}`);
  }
  url.searchParams.set("key", apiKey);

  const response = await fetch(url.toString());
  const data = (await response.json()) as GoogleGeocodeResponse;

  if (data.status !== "OK" || data.results.length === 0) {
    return null;
  }

  const bestResult = data.results[0];
  const isAmbiguous = data.results.length > 1 || Boolean(bestResult.partial_match);
  const isPreciseMatch = isPreciseGeocodeResult(bestResult.types);

  // No cachear resultados "a nivel de localidad" — son la respuesta de
  // Google cuando no encontró la calle puntual, y cachearlos haría que una
  // dirección mal escrita quede "pegada" para siempre a solo el centro de
  // la ciudad en vez de volver a intentar geocodificarla bien más adelante.
  if (isPreciseMatch) {
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
  }

  return {
    latitude: bestResult.geometry.location.lat,
    longitude: bestResult.geometry.location.lng,
    formattedAddress: bestResult.formatted_address,
    partialMatch: isAmbiguous,
    isPreciseMatch,
    fromCache: false,
  };
}

type GoogleReverseGeocodeResponse = {
  status: string;
  results: Array<{ address_components: Array<{ long_name: string; types: string[] }> }>;
};

// Geocodificación inversa del centro de una zona de entrega, para obtener
// el nombre de la localidad (ciudad/partido) donde está el local. Se usa
// para reintentar una dirección que dio "fuera de zona" restringiendo la
// búsqueda a esa localidad puntual — Argentina tiene muchas calles con el
// mismo nombre en localidades distintas, y sin restringir a la localidad
// correcta, Google puede preferir la coincidencia de otra ciudad aunque la
// dirección real del cliente sí exista (y esté en zona) en la localidad del
// local. Ver el reintento en zone-validation.ts.
export async function reverseGeocodeLocality(latitude: number, longitude: number): Promise<string | null> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return null;

  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("latlng", `${latitude},${longitude}`);
  url.searchParams.set("key", apiKey);

  const response = await fetch(url.toString());
  const data = (await response.json()) as GoogleReverseGeocodeResponse;
  if (data.status !== "OK") return null;

  for (const result of data.results) {
    const locality = result.address_components.find((component) => component.types.includes("locality"));
    if (locality) return locality.long_name;
  }
  for (const result of data.results) {
    const county = result.address_components.find((component) =>
      component.types.includes("administrative_area_level_2"),
    );
    if (county) return county.long_name;
  }
  return null;
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
