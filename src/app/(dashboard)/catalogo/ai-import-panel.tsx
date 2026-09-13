"use client";

import { useRef, useState } from "react";
import type { DraftProduct } from "@/lib/validations/product";
import { DraftProductTable } from "./draft-product-table";

async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function AiImportPanel({ onImported }: { onImported: () => void }) {
  const [menuText, setMenuText] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [draft, setDraft] = useState<DraftProduct[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isInterpreting, setIsInterpreting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleInterpret() {
    setError(null);
    if (!menuText.trim() && !imageFile) {
      setError("Pegá el texto del menú o subí una foto.");
      return;
    }

    setIsInterpreting(true);
    try {
      const payload: { text?: string; imageBase64?: string; imageMimeType?: string } = {};
      if (menuText.trim()) payload.text = menuText.trim();
      if (imageFile) {
        payload.imageBase64 = await fileToBase64(imageFile);
        payload.imageMimeType = imageFile.type;
      }

      const response = await fetch("/api/catalogo/ia/interpretar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? "No pudimos interpretar el menú.");
        return;
      }
      setDraft(data.products);
    } catch {
      setError("Ocurrió un error inesperado.");
    } finally {
      setIsInterpreting(false);
    }
  }

  async function handleConfirm() {
    if (!draft) return;
    setIsSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/catalogo/importar/confirmar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ products: draft }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? "No pudimos guardar los productos.");
        return;
      }
      setDraft(null);
      setMenuText("");
      setImageFile(null);
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
      <h3 className="text-sm font-semibold text-gray-900">Cargar productos con ayuda de IA</h3>
      <p className="mt-1 text-sm text-gray-500">
        Pegá el texto de tu menú o subí una foto. La IA propone el listado estructurado y vos lo revisás
        antes de confirmarlo — nada se guarda sin tu aprobación.
      </p>

      {!draft && (
        <div className="mt-4 space-y-3">
          <textarea
            value={menuText}
            onChange={(e) => setMenuText(e.target.value)}
            rows={4}
            placeholder={"Ej:\nPizza muzzarella $4500\nEmpanada de carne $600 c/u"}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-green-600 focus:outline-none focus:ring-1 focus:ring-green-600"
          />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => setImageFile(e.target.files?.[0] ?? null)}
            className="text-sm"
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            onClick={handleInterpret}
            disabled={isInterpreting}
            className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-60"
          >
            {isInterpreting ? "Interpretando..." : "Interpretar con IA"}
          </button>
        </div>
      )}

      {draft && (
        <div className="mt-4 space-y-3">
          <p className="text-sm text-gray-700">
            La IA encontró <strong>{draft.length}</strong> productos. Revisá y editá lo que haga falta antes
            de confirmar.
          </p>
          <DraftProductTable rows={draft} onChange={setDraft} />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex gap-2">
            <button
              onClick={handleConfirm}
              disabled={isSaving}
              className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-60"
            >
              {isSaving ? "Guardando..." : `Confirmar e importar (${draft.length})`}
            </button>
            <button
              onClick={() => setDraft(null)}
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
