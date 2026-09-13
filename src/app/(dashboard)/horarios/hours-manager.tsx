"use client";

import { useState } from "react";
import type { BusinessHourSlot } from "@prisma/client";
import { DAY_NAMES, minutesToTimeLabel, timeLabelToMinutes } from "@/lib/validations/business-hours";

type EditableSlot = {
  key: string;
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
  isActive: boolean;
};

let keyCounter = 0;
function nextKey() {
  keyCounter += 1;
  return `slot-${keyCounter}`;
}

type SlotLike = { dayOfWeek: number; startMinute: number; endMinute: number; isActive: boolean };

function toEditable(slots: SlotLike[]): EditableSlot[] {
  return slots.map((slot) => ({
    key: nextKey(),
    dayOfWeek: slot.dayOfWeek,
    startMinute: slot.startMinute,
    endMinute: slot.endMinute,
    isActive: slot.isActive,
  }));
}

export function HoursManager({ initialSlots }: { initialSlots: BusinessHourSlot[] }) {
  const [slots, setSlots] = useState<EditableSlot[]>(() => toEditable(initialSlots));
  const [naturalLanguageText, setNaturalLanguageText] = useState("");
  const [isInterpreting, setIsInterpreting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  async function handleInterpret() {
    if (!naturalLanguageText.trim()) {
      setError("Escribí tus días y horarios de atención.");
      return;
    }
    setError(null);
    setIsInterpreting(true);
    try {
      const response = await fetch("/api/horarios/interpretar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: naturalLanguageText }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? "No pudimos interpretar el texto.");
        return;
      }
      setSlots(toEditable(data.slots as SlotLike[]));
    } catch {
      setError("Ocurrió un error inesperado.");
    } finally {
      setIsInterpreting(false);
    }
  }

  function addSlot(dayOfWeek: number) {
    setSlots((current) => [
      ...current,
      { key: nextKey(), dayOfWeek, startMinute: 11 * 60, endMinute: 14 * 60, isActive: true },
    ]);
  }

  function updateSlot(key: string, patch: Partial<EditableSlot>) {
    setSlots((current) => current.map((slot) => (slot.key === key ? { ...slot, ...patch } : slot)));
  }

  function removeSlot(key: string) {
    setSlots((current) => current.filter((slot) => slot.key !== key));
  }

  async function handleSave() {
    setError(null);

    for (const slot of slots) {
      if (slot.endMinute <= slot.startMinute) {
        setError(`Hay una franja de ${DAY_NAMES[slot.dayOfWeek]} con el cierre antes que la apertura.`);
        return;
      }
    }

    setIsSaving(true);
    try {
      const response = await fetch("/api/horarios", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slots: slots.map(({ dayOfWeek, startMinute, endMinute, isActive }) => ({
            dayOfWeek,
            startMinute,
            endMinute,
            isActive,
          })),
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? "No pudimos guardar la grilla.");
        return;
      }
      setSlots(toEditable(data.slots));
      setSavedAt(Date.now());
    } catch {
      setError("Ocurrió un error inesperado.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="p-8 max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Horarios de atención</h1>
        <p className="mt-1 text-sm text-gray-500">
          Fuera de estos horarios, el sistema responde automáticamente sin registrar pedidos.
        </p>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-6">
        <h2 className="text-sm font-semibold text-gray-900">Cargar en lenguaje natural</h2>
        <p className="mt-1 text-sm text-gray-500">
          Ej: &quot;de martes a domingo, de 11 a 14:30 y de 19 a 23&quot;
        </p>
        <textarea
          value={naturalLanguageText}
          onChange={(e) => setNaturalLanguageText(e.target.value)}
          rows={2}
          className="mt-3 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-green-600 focus:outline-none focus:ring-1 focus:ring-green-600"
        />
        <button
          onClick={handleInterpret}
          disabled={isInterpreting}
          className="mt-3 rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-60"
        >
          {isInterpreting ? "Interpretando..." : "Interpretar con IA"}
        </button>
        <p className="mt-2 text-xs text-gray-400">
          Esto reemplaza la grilla de abajo por lo que interprete la IA — revisala y confirmá antes de
          guardar.
        </p>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-6 space-y-4">
        <h2 className="text-sm font-semibold text-gray-900">Grilla de días y franjas</h2>
        {DAY_NAMES.map((dayName, dayOfWeek) => {
          const daySlots = slots.filter((slot) => slot.dayOfWeek === dayOfWeek);
          return (
            <div key={dayOfWeek} className="border-t border-gray-100 pt-3 first:border-t-0 first:pt-0">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-800">{dayName}</span>
                <button
                  onClick={() => addSlot(dayOfWeek)}
                  className="text-xs font-medium text-green-700 hover:underline"
                >
                  + Agregar franja
                </button>
              </div>
              {daySlots.length === 0 && <p className="mt-1 text-xs text-gray-400">Cerrado</p>}
              <div className="mt-2 space-y-2">
                {daySlots.map((slot) => (
                  <div key={slot.key} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={slot.isActive}
                      onChange={(e) => updateSlot(slot.key, { isActive: e.target.checked })}
                      title="Habilitada"
                      className="h-4 w-4 rounded border-gray-300 text-green-600 focus:ring-green-600"
                    />
                    <input
                      type="time"
                      value={minutesToTimeLabel(slot.startMinute)}
                      onChange={(e) => {
                        const minutes = timeLabelToMinutes(e.target.value);
                        if (minutes !== null) updateSlot(slot.key, { startMinute: minutes });
                      }}
                      className="rounded border border-gray-300 px-2 py-1 text-sm"
                    />
                    <span className="text-sm text-gray-400">a</span>
                    <input
                      type="time"
                      value={minutesToTimeLabel(slot.endMinute)}
                      onChange={(e) => {
                        const minutes = timeLabelToMinutes(e.target.value);
                        if (minutes !== null) updateSlot(slot.key, { endMinute: minutes });
                      }}
                      className="rounded border border-gray-300 px-2 py-1 text-sm"
                    />
                    <button onClick={() => removeSlot(slot.key)} className="text-xs text-red-600 hover:underline">
                      Quitar
                    </button>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {savedAt && <p className="text-sm text-green-700">Horarios guardados correctamente.</p>}

      <button
        onClick={handleSave}
        disabled={isSaving}
        className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-60"
      >
        {isSaving ? "Guardando..." : "Guardar horarios"}
      </button>
    </div>
  );
}
