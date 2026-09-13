"use client";

import { useState } from "react";
import type { PaymentMethodConfig } from "@prisma/client";

export function PaymentMethodForm({ initialConfig }: { initialConfig: PaymentMethodConfig | null }) {
  const [cashEnabled, setCashEnabled] = useState(initialConfig?.cashEnabled ?? true);
  const [transferEnabled, setTransferEnabled] = useState(initialConfig?.transferEnabled ?? false);
  const [transferAlias, setTransferAlias] = useState(initialConfig?.transferAlias ?? "");
  const [transferCbu, setTransferCbu] = useState(initialConfig?.transferCbu ?? "");
  const [transferHolder, setTransferHolder] = useState(initialConfig?.transferHolder ?? "");
  const [transferCuit, setTransferCuit] = useState(initialConfig?.transferCuit ?? "");

  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setIsSaving(true);

    try {
      const response = await fetch("/api/medios-de-pago", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cashEnabled,
          transferEnabled,
          transferAlias,
          transferCbu,
          transferHolder,
          transferCuit,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? "No pudimos guardar los medios de pago.");
        return;
      }
      setSavedAt(Date.now());
    } catch {
      setError("Ocurrió un error inesperado. Probá de nuevo.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="p-8 max-w-2xl">
      <h1 className="text-2xl font-semibold text-gray-900">Medios de pago</h1>
      <p className="mt-1 text-sm text-gray-500">
        Definí qué medios de pago acepta tu sucursal. La IA le va a informar al cliente exactamente estos
        datos, nunca inventa alias, CBU ni CUIT.
      </p>

      <form onSubmit={handleSubmit} className="mt-6 space-y-6 rounded-lg border border-gray-200 bg-white p-6">
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={cashEnabled}
            onChange={(e) => setCashEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-green-600 focus:ring-green-600"
          />
          <span className="text-sm font-medium text-gray-800">Efectivo</span>
        </label>

        <div>
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={transferEnabled}
              onChange={(e) => setTransferEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-green-600 focus:ring-green-600"
            />
            <span className="text-sm font-medium text-gray-800">Transferencia bancaria</span>
          </label>

          {transferEnabled && (
            <div className="mt-4 ml-7 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-sm font-medium text-gray-700">Alias</label>
                <input
                  type="text"
                  value={transferAlias}
                  onChange={(e) => setTransferAlias(e.target.value)}
                  placeholder="mi.negocio.mp"
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-green-600 focus:outline-none focus:ring-1 focus:ring-green-600"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">CBU</label>
                <input
                  type="text"
                  value={transferCbu}
                  onChange={(e) => setTransferCbu(e.target.value.replace(/\D/g, ""))}
                  placeholder="22 dígitos"
                  maxLength={22}
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-green-600 focus:outline-none focus:ring-1 focus:ring-green-600"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">Titular de la cuenta</label>
                <input
                  type="text"
                  value={transferHolder}
                  onChange={(e) => setTransferHolder(e.target.value)}
                  placeholder="Nombre y apellido / razón social"
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-green-600 focus:outline-none focus:ring-1 focus:ring-green-600"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">CUIT</label>
                <input
                  type="text"
                  value={transferCuit}
                  onChange={(e) => setTransferCuit(e.target.value)}
                  placeholder="20-12345678-9"
                  className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-green-600 focus:outline-none focus:ring-1 focus:ring-green-600"
                />
              </div>
            </div>
          )}
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}
        {savedAt && <p className="text-sm text-green-700">Guardado correctamente.</p>}

        <button
          type="submit"
          disabled={isSaving}
          className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-60"
        >
          {isSaving ? "Guardando..." : "Guardar"}
        </button>
      </form>
    </div>
  );
}
