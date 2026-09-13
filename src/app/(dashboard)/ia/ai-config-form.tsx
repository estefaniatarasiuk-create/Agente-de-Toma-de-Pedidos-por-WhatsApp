"use client";

import { useState } from "react";
import type { AIConfig } from "@prisma/client";

export function AiConfigForm({ initialConfig }: { initialConfig: AIConfig | null }) {
  const [tone, setTone] = useState<"FORMAL" | "CERCANO">(initialConfig?.tone ?? "CERCANO");
  const [useEmojis, setUseEmojis] = useState(initialConfig?.useEmojis ?? true);
  const [additionalInstructions, setAdditionalInstructions] = useState(
    initialConfig?.additionalInstructions ?? "",
  );
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setWarnings([]);
    setIsSaving(true);
    try {
      const response = await fetch("/api/ia/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tone, useEmojis, additionalInstructions }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? "No pudimos guardar la configuración.");
        return;
      }
      setSavedAt(Date.now());
      setWarnings(data.warnings ?? []);
    } catch {
      setError("Ocurrió un error inesperado.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-lg border border-gray-200 bg-white p-6 space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700">Tono de comunicación</label>
        <div className="mt-2 flex gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="tone"
              checked={tone === "CERCANO"}
              onChange={() => setTone("CERCANO")}
              className="text-green-600 focus:ring-green-600"
            />
            Cercano
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="tone"
              checked={tone === "FORMAL"}
              onChange={() => setTone("FORMAL")}
              className="text-green-600 focus:ring-green-600"
            />
            Formal
          </label>
        </div>
      </div>

      <label className="flex items-center gap-3">
        <input
          type="checkbox"
          checked={useEmojis}
          onChange={(e) => setUseEmojis(e.target.checked)}
          className="h-4 w-4 rounded border-gray-300 text-green-600 focus:ring-green-600"
        />
        <span className="text-sm font-medium text-gray-800">Usar emojis en las respuestas</span>
      </label>

      <div>
        <label className="block text-sm font-medium text-gray-700">Información adicional para la IA</label>
        <p className="text-xs text-gray-500">
          Ej: costo de envío propio, promociones, aclaraciones como &quot;no entregamos en edificios sin
          portero&quot;. Nunca puede contradecir horarios, zona ni precios: eso siempre lo define la
          configuración estructurada.
        </p>
        <textarea
          value={additionalInstructions}
          onChange={(e) => setAdditionalInstructions(e.target.value)}
          rows={4}
          className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-green-600 focus:outline-none focus:ring-1 focus:ring-green-600"
        />
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {savedAt && warnings.length === 0 && <p className="text-sm text-green-700">Guardado correctamente.</p>}
      {warnings.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          <p className="font-medium">Guardado, pero encontramos posibles contradicciones:</p>
          <ul className="mt-1 list-disc pl-5">
            {warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
          <p className="mt-1 text-xs">
            Ante conflicto, siempre prevalece la configuración estructurada (horarios, zona, precios).
          </p>
        </div>
      )}

      <button
        type="submit"
        disabled={isSaving}
        className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-60"
      >
        {isSaving ? "Guardando..." : "Guardar"}
      </button>
    </form>
  );
}
