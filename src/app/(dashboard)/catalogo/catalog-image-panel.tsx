"use client";

import { useRef, useState } from "react";
import type { CatalogImage } from "@prisma/client";

export function CatalogImagePanel({
  initialCatalogImage,
}: {
  initialCatalogImage: CatalogImage | null;
}) {
  const [catalogImage, setCatalogImage] = useState(initialCatalogImage);
  const [error, setError] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleGenerate() {
    setError(null);
    setIsGenerating(true);
    try {
      const response = await fetch("/api/catalogo/imagen", { method: "POST" });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? "No pudimos generar la imagen.");
        return;
      }
      setCatalogImage(data.catalogImage);
    } catch {
      setError("Ocurrió un error inesperado.");
    } finally {
      setIsGenerating(false);
    }
  }

  async function handleUpload(file: File) {
    setError(null);
    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.set("file", file);
      const response = await fetch("/api/catalogo/imagen", { method: "PUT", body: formData });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? "No pudimos subir la imagen.");
        return;
      }
      setCatalogImage(data.catalogImage);
    } catch {
      setError("Ocurrió un error inesperado.");
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6">
      <h3 className="text-sm font-semibold text-gray-900">Imagen del catálogo</h3>
      <p className="mt-1 text-sm text-gray-600">
        La IA la comparte por WhatsApp cuando el cliente pide ver el catálogo completo o la lista de
        precios.
      </p>

      <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-start">
        {catalogImage && (
          <img
            src={`/api/uploads/${catalogImage.imageUrl}`}
            alt="Catálogo"
            className="w-48 rounded-md border border-gray-200"
          />
        )}
        <div className="flex-1 space-y-2">
          {catalogImage && (
            <p className="text-xs text-gray-600">
              {catalogImage.source === "GENERATED"
                ? "Generada automáticamente a partir de tu catálogo."
                : "Imagen propia subida por vos."}
            </p>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={handleGenerate}
              disabled={isGenerating}
              className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-60"
            >
              {isGenerating ? "Generando..." : "Generar automáticamente"}
            </button>
            <label className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 cursor-pointer">
              {isUploading ? "Subiendo..." : "Subir imagen propia"}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleUpload(file);
                }}
                className="hidden"
              />
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}
