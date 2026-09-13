"use client";

import { useRef, useState } from "react";
import type { ExcelPreviewRow } from "@/app/api/catalogo/excel/interpretar/route";

export function ExcelImportPanel({ onImported }: { onImported: () => void }) {
  const [rows, setRows] = useState<ExcelPreviewRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFileSelected(file: File) {
    setError(null);
    setIsAnalyzing(true);
    try {
      const formData = new FormData();
      formData.set("file", file);
      const response = await fetch("/api/catalogo/excel/interpretar", { method: "POST", body: formData });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? "No pudimos leer el archivo.");
        return;
      }
      setRows(data.rows);
    } catch {
      setError("Ocurrió un error inesperado.");
    } finally {
      setIsAnalyzing(false);
    }
  }

  const validRows = (rows ?? []).filter((row) => !row.error);

  async function handleConfirm() {
    setIsSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/catalogo/importar/confirmar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          products: validRows.map((row) => ({
            name: row.name,
            description: row.description,
            price: row.price,
            category: row.category,
          })),
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? "No pudimos guardar los productos.");
        return;
      }
      setRows(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      onImported();
    } catch {
      setError("Ocurrió un error inesperado.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6">
      <h3 className="text-sm font-semibold text-gray-900">Importar desde Excel</h3>
      <p className="mt-1 text-sm text-gray-500">
        El archivo tiene que tener columnas <strong>Nombre</strong> y <strong>Precio</strong> (Descripción y
        Categoría son opcionales).
      </p>

      {!rows && (
        <div className="mt-4 space-y-3">
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFileSelected(file);
            }}
            className="text-sm"
          />
          {isAnalyzing && <p className="text-sm text-gray-500">Analizando archivo...</p>}
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      )}

      {rows && (
        <div className="mt-4 space-y-3">
          <p className="text-sm text-gray-700">
            {validRows.length} de {rows.length} filas son válidas
            {rows.length !== validRows.length ? " (las filas con error no se van a importar)." : "."}
          </p>
          <div className="overflow-x-auto rounded-md border border-gray-200">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left font-medium text-gray-600">Fila</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-600">Nombre</th>
                  <th className="px-3 py-2 text-right font-medium text-gray-600">Precio</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-600">Estado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((row) => (
                  <tr key={row.rowNumber} className={row.error ? "bg-red-50" : ""}>
                    <td className="px-3 py-1.5">{row.rowNumber}</td>
                    <td className="px-3 py-1.5">{row.name || "—"}</td>
                    <td className="px-3 py-1.5 text-right">{row.price ?? "—"}</td>
                    <td className="px-3 py-1.5 text-red-700">{row.error ?? "OK"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex gap-2">
            <button
              onClick={handleConfirm}
              disabled={isSaving || validRows.length === 0}
              className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-60"
            >
              {isSaving ? "Guardando..." : `Confirmar e importar (${validRows.length})`}
            </button>
            <button
              onClick={() => setRows(null)}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Descartar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
