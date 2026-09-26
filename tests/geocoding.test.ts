import { describe, it, expect } from "vitest";
import { stripCrossStreetsForQuery } from "@/lib/geocoding";

// Regresión de un bug real: cuando la calle principal está mal escrita
// ("Guido de granc" en vez de "Cid Guidi de Franc"), Google a veces toma una
// de las calles del "entre X y Y" como si fuera la principal (devolvió
// "Vicente Barbieri 1510" en vez de intentar algo parecido a la calle real
// que el cliente quiso decir). Se manda a geocodificar sin la parte de
// entrecalles — el domicilio completo se sigue guardando y mostrando al
// cliente tal cual, esto solo afecta la búsqueda que se le manda a Google.
describe("stripCrossStreetsForQuery", () => {
  it("saca la frase 'entre X y Y'", () => {
    expect(stripCrossStreetsForQuery("Guido de granc 1510 entre baribieri y peron")).toBe("Guido de granc 1510");
    expect(stripCrossStreetsForQuery("Cid Guidi de Franc 1510, entre Perón y Barbieri")).toBe("Cid Guidi de Franc 1510");
    expect(stripCrossStreetsForQuery("Av. de Mayo 700, entre Perón y Bolívar")).toBe("Av. de Mayo 700");
  });

  it("saca la abreviatura 'e X y Y' pegada a la altura", () => {
    expect(stripCrossStreetsForQuery("Guido de franco 1510 e peron y barbieri")).toBe("Guido de franco 1510");
  });

  it("no toca direcciones sin entrecalles", () => {
    expect(stripCrossStreetsForQuery("Cid Guidi de Franc 1510")).toBe("Cid Guidi de Franc 1510");
    expect(stripCrossStreetsForQuery("guidi de franc y barbieri")).toBe("guidi de franc y barbieri");
  });
});
