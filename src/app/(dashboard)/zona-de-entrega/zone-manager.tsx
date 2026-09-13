"use client";

import { useCallback, useState } from "react";
import { GoogleMap, Marker, Circle, useJsApiLoader } from "@react-google-maps/api";
import type { Branch, DeliveryZone } from "@prisma/client";

const DEFAULT_CENTER = { lat: -34.6037, lng: -58.3816 }; // Buenos Aires, si no hay local geocodificado
const MAP_CONTAINER_STYLE = { width: "100%", height: "420px", borderRadius: "8px" };

export function ZoneManager({
  initialBranch,
  initialZone,
}: {
  initialBranch: Branch;
  initialZone: DeliveryZone | null;
}) {
  const { isLoaded } = useJsApiLoader({
    googleMapsApiKey: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "",
  });

  const [address, setAddress] = useState(initialBranch.address ?? "");
  const [center, setCenter] = useState(
    initialBranch.latitude && initialBranch.longitude
      ? { lat: initialBranch.latitude, lng: initialBranch.longitude }
      : DEFAULT_CENTER,
  );
  const [radiusKm, setRadiusKm] = useState(initialZone?.radiusKm ?? 3);
  const [naturalLanguageText, setNaturalLanguageText] = useState("");

  const [isGeocoding, setIsGeocoding] = useState(false);
  const [isInterpreting, setIsInterpreting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  async function handleGeocodeAddress() {
    setError(null);
    setIsGeocoding(true);
    try {
      const response = await fetch("/api/zona/geocodificar-local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? "No pudimos encontrar esa dirección.");
        return;
      }
      setCenter({ lat: data.geocoded.latitude, lng: data.geocoded.longitude });
    } catch {
      setError("Ocurrió un error inesperado.");
    } finally {
      setIsGeocoding(false);
    }
  }

  async function handleInterpretRadius() {
    if (!naturalLanguageText.trim()) {
      setError("Describí tu zona de entrega.");
      return;
    }
    setError(null);
    setIsInterpreting(true);
    try {
      const response = await fetch("/api/zona/interpretar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: naturalLanguageText }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? "No pudimos interpretar el texto.");
        return;
      }
      setRadiusKm(data.radiusKm);
    } catch {
      setError("Ocurrió un error inesperado.");
    } finally {
      setIsInterpreting(false);
    }
  }

  async function handleSave() {
    setError(null);
    setIsSaving(true);
    try {
      const response = await fetch("/api/zona", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ centerLatitude: center.lat, centerLongitude: center.lng, radiusKm }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? "No pudimos guardar la zona.");
        return;
      }
      setSavedAt(Date.now());
    } catch {
      setError("Ocurrió un error inesperado.");
    } finally {
      setIsSaving(false);
    }
  }

  const handleMarkerDragEnd = useCallback((event: google.maps.MapMouseEvent) => {
    if (!event.latLng) return;
    setCenter({ lat: event.latLng.lat(), lng: event.latLng.lng() });
  }, []);

  return (
    <div className="p-8 max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Zona de entrega</h1>
        <p className="mt-1 text-sm text-gray-500">
          La IA no toma pedidos con domicilios fuera de este radio.
        </p>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-6 space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700">Dirección de tu local</label>
          <div className="mt-1 flex gap-2">
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Ej: Av. Corrientes 1234, CABA"
              className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-green-600 focus:outline-none focus:ring-1 focus:ring-green-600"
            />
            <button
              onClick={handleGeocodeAddress}
              disabled={isGeocoding}
              className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-60"
            >
              {isGeocoding ? "Buscando..." : "Buscar"}
            </button>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700">Describir la zona en lenguaje natural</label>
          <div className="mt-1 flex gap-2">
            <input
              type="text"
              value={naturalLanguageText}
              onChange={(e) => setNaturalLanguageText(e.target.value)}
              placeholder="Ej: entregamos hasta 5 km del local"
              className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-green-600 focus:outline-none focus:ring-1 focus:ring-green-600"
            />
            <button
              onClick={handleInterpretRadius}
              disabled={isInterpreting}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
            >
              {isInterpreting ? "Interpretando..." : "Interpretar"}
            </button>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700">Radio de entrega (km)</label>
          <input
            type="number"
            step="0.5"
            min="0.5"
            max="100"
            value={radiusKm}
            onChange={(e) => setRadiusKm(Number(e.target.value))}
            className="mt-1 w-32 rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-green-600 focus:outline-none focus:ring-1 focus:ring-green-600"
          />
        </div>

        {isLoaded ? (
          <GoogleMap mapContainerStyle={MAP_CONTAINER_STYLE} center={center} zoom={13}>
            <Marker position={center} draggable onDragEnd={handleMarkerDragEnd} />
            <Circle
              center={center}
              radius={radiusKm * 1000}
              options={{ fillColor: "#16a34a", fillOpacity: 0.15, strokeColor: "#16a34a", strokeWeight: 2 }}
            />
          </GoogleMap>
        ) : (
          <div className="flex h-[420px] items-center justify-center rounded-lg border border-dashed border-gray-300 text-sm text-gray-400">
            {process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
              ? "Cargando mapa..."
              : "Falta configurar NEXT_PUBLIC_GOOGLE_MAPS_API_KEY para ver el mapa."}
          </div>
        )}
        <p className="text-xs text-gray-400">
          Podés arrastrar el marcador para ajustar el centro exacto del local.
        </p>

        {error && <p className="text-sm text-red-600">{error}</p>}
        {savedAt && <p className="text-sm text-green-700">Zona guardada correctamente.</p>}

        <button
          onClick={handleSave}
          disabled={isSaving}
          className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-60"
        >
          {isSaving ? "Guardando..." : "Guardar zona"}
        </button>
      </div>
    </div>
  );
}
