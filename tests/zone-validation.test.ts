import { describe, it, expect, afterAll, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { validateDeliveryAddress } from "@/lib/orders/zone-validation";
import { createTestCompanyAndBranch, cleanupCompany } from "./fixtures";

// Geocodificar de verdad requeriría GOOGLE_MAPS_API_KEY y red — se mockea
// solo la parte que llama a la API externa; la distancia (Haversine) y todo
// lo demás corren reales.
vi.mock("@/lib/geocoding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/geocoding")>();
  return { ...actual, geocodeAddress: vi.fn(), reverseGeocodeLocality: vi.fn() };
});

const { geocodeAddress } = await import("@/lib/geocoding");
const geocodeAddressMock = vi.mocked(geocodeAddress);

// Zona de entrega: centro en Plaza de Mayo (CABA), radio 5km.
const ZONE_CENTER = { latitude: -34.6083, longitude: -58.3712, radiusKm: 5 };

describe("validateDeliveryAddress", () => {
  const companiesToCleanup: string[] = [];

  afterAll(async () => {
    for (const companyId of companiesToCleanup) await cleanupCompany(companyId);
  });

  it("rechaza un domicilio fuera del radio configurado", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    await prisma.deliveryZone.create({
      data: {
        companyId: company.id,
        branchId: branch.id,
        centerLatitude: ZONE_CENTER.latitude,
        centerLongitude: ZONE_CENTER.longitude,
        radiusKm: ZONE_CENTER.radiusKm,
      },
    });

    // Córdoba capital: a ~650km de CABA, claramente fuera de cualquier radio de delivery.
    geocodeAddressMock.mockResolvedValueOnce({
      latitude: -31.4201,
      longitude: -64.1888,
      formattedAddress: "Córdoba, Argentina",
      partialMatch: false,
      isPreciseMatch: true,
      fromCache: false,
    });

    const result = await validateDeliveryAddress(branch.id, "San Martín 123, Córdoba");
    expect(result.status).toBe("out_of_zone");
    if (result.status === "out_of_zone") {
      expect(result.distanceKm).toBeGreaterThan(ZONE_CENTER.radiusKm);
    }
  });

  it("acepta un domicilio dentro del radio configurado", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    await prisma.deliveryZone.create({
      data: {
        companyId: company.id,
        branchId: branch.id,
        centerLatitude: ZONE_CENTER.latitude,
        centerLongitude: ZONE_CENTER.longitude,
        radiusKm: ZONE_CENTER.radiusKm,
      },
    });

    // A pocas cuadras del centro de la zona.
    geocodeAddressMock.mockResolvedValueOnce({
      latitude: -34.611,
      longitude: -58.3745,
      formattedAddress: "Av. de Mayo 700, CABA",
      partialMatch: false,
      isPreciseMatch: true,
      fromCache: false,
    });

    const result = await validateDeliveryAddress(branch.id, "Av. de Mayo 700");
    expect(result.status).toBe("ok");
  });

  it("devuelve zone_not_configured si la sucursal no tiene zona cargada", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);

    const result = await validateDeliveryAddress(branch.id, "Cualquier dirección 123");
    expect(result.status).toBe("zone_not_configured");
  });

  it("no sugiere una corrección si el reintento solo encuentra el centro de la localidad, no la calle puntual", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    await prisma.deliveryZone.create({
      data: {
        companyId: company.id,
        branchId: branch.id,
        centerLatitude: ZONE_CENTER.latitude,
        centerLongitude: ZONE_CENTER.longitude,
        radiusKm: ZONE_CENTER.radiusKm,
      },
    });
    const { reverseGeocodeLocality } = await import("@/lib/geocoding");
    const reverseGeocodeLocalityMock = vi.mocked(reverseGeocodeLocality);

    // Primera pasada: tampoco encuentra la calle puntual (Google ya cae a
    // un resultado de baja precisión desde acá, no recién en el reintento).
    geocodeAddressMock.mockResolvedValueOnce({
      latitude: -31.4201,
      longitude: -64.1888,
      formattedAddress: "Córdoba Province, Argentina",
      partialMatch: false,
      isPreciseMatch: false,
      fromCache: false,
    });
    reverseGeocodeLocalityMock.mockResolvedValueOnce("Villa Centenario");
    // Reintento restringido a la localidad: Google no encuentra la calle
    // puntual y devuelve el centro de TODA la localidad en su lugar — bug
    // real reportado: esto no es una sugerencia válida, aunque caiga dentro
    // del radio de entrega (el radio puede ser grande y cubrir la localidad
    // entera igual).
    geocodeAddressMock.mockResolvedValueOnce({
      latitude: -34.61,
      longitude: -58.3745,
      formattedAddress: "Villa Centenario, Buenos Aires Province, Argentina",
      partialMatch: false,
      isPreciseMatch: false,
      fromCache: false,
    });

    const result = await validateDeliveryAddress(branch.id, "guido de franco 1510");
    expect(result.status).toBe("ambiguous");
  });

  it("devuelve ambiguous si no se pudo geocodificar la dirección", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    await prisma.deliveryZone.create({
      data: {
        companyId: company.id,
        branchId: branch.id,
        centerLatitude: ZONE_CENTER.latitude,
        centerLongitude: ZONE_CENTER.longitude,
        radiusKm: ZONE_CENTER.radiusKm,
      },
    });

    geocodeAddressMock.mockResolvedValueOnce(null);

    const result = await validateDeliveryAddress(branch.id, "asdkjasdkj no existe");
    expect(result.status).toBe("ambiguous");
  });
});
