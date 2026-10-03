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
      hasStreetNumber: true,
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
      hasStreetNumber: true,
      fromCache: false,
    });

    const result = await validateDeliveryAddress(branch.id, "Av. de Mayo 700");
    expect(result.status).toBe("ok");
  });

  // Regresión de un bug real: un cruce de calles sin altura ("Namuncura y
  // Barbieri") geocodificaba como coincidencia precisa (la calle existe y
  // está en zona) y se aceptaba como domicilio válido, aunque no tuviera
  // ningún número de puerta con el que el repartidor pudiera entregar.
  it("pide la altura si la calle es precisa y está en zona, pero sin número de puerta (solo un cruce de calles)", async () => {
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

    geocodeAddressMock.mockResolvedValueOnce({
      latitude: -34.611,
      longitude: -58.3745,
      formattedAddress: "Vicente Barbieri & Ceferino Namuncurá, CABA, Argentina",
      partialMatch: false,
      isPreciseMatch: true,
      hasStreetNumber: false,
      fromCache: false,
    });

    // El texto incluye un número (ej. el cliente puso una referencia de
    // altura vaga) para llegar hasta la geocodificación y ejercitar el
    // chequeo basado en la respuesta de Google — el chequeo por texto (sin
    // NINGÚN dígito) se prueba aparte, más abajo.
    const result = await validateDeliveryAddress(branch.id, "namuncura y barbieri, cerca del 1500");
    expect(result.status).toBe("missing_house_number");
  });

  // El otro lado del mismo chequeo: si el cliente no escribió NI UN dígito,
  // se pide la altura sin siquiera llamar a geocodificar.
  it("pide la altura sin geocodificar si el texto del cliente no tiene ningún dígito", async () => {
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

    const result = await validateDeliveryAddress(branch.id, "namuncura y barbieri");
    expect(result.status).toBe("missing_house_number");
    expect(geocodeAddressMock).not.toHaveBeenCalled();
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
      hasStreetNumber: true,
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
      hasStreetNumber: true,
      fromCache: false,
    });

    const result = await validateDeliveryAddress(branch.id, "guido de franco 1510");
    expect(result.status).toBe("ambiguous");
  });

  it("no sugiere una corrección si el reintento encuentra la calle correcta pero sin altura", async () => {
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

    geocodeAddressMock.mockResolvedValueOnce({
      latitude: -31.4201,
      longitude: -64.1888,
      formattedAddress: "Barbieri, Córdoba, Argentina",
      partialMatch: false,
      isPreciseMatch: false,
      hasStreetNumber: false,
      fromCache: false,
    });
    reverseGeocodeLocalityMock.mockResolvedValueOnce("Villa Centenario");
    // El reintento restringido a la localidad encuentra la calle correcta,
    // dentro de zona, pero sin una altura puntual (solo el cruce de
    // calles) — no alcanza para proponerla como corrección completa.
    geocodeAddressMock.mockResolvedValueOnce({
      latitude: -34.61,
      longitude: -58.3745,
      formattedAddress: "Vicente Barbieri & Ceferino Namuncurá, Villa Centenario, Argentina",
      partialMatch: false,
      isPreciseMatch: true,
      hasStreetNumber: false,
      fromCache: false,
    });

    const result = await validateDeliveryAddress(branch.id, "barbieri, cerca del 1500");
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

    const result = await validateDeliveryAddress(branch.id, "asdkjasdkj 123 no existe");
    expect(result.status).toBe("ambiguous");
  });
});
