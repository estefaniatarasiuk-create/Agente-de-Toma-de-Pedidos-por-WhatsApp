"use client";

import { useEffect, useState } from "react";

export type ToastItem = { id: string; title: string; body: string };

const AUTO_DISMISS_MS = 10000;
const FADE_MS = 300;

// Notificaciones flotantes (pedido explícito del usuario): aparecen en una
// esquina donde no tapan nada de la interfaz, y se desvanecen solas a los 10
// segundos si nadie las cierra a mano.
export function ToastStack({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: string) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} onDismiss={() => onDismiss(toast.id)} />
      ))}
    </div>
  );
}

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss: () => void }) {
  const [visible, setVisible] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    // Arranca en opacidad 0 y un frame después sube a 1 — si empezara ya
    // visible, no habría transición de entrada que animar.
    const raf = requestAnimationFrame(() => setVisible(true));
    const dismissTimer = setTimeout(() => setLeaving(true), AUTO_DISMISS_MS);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(dismissTimer);
    };
  }, []);

  useEffect(() => {
    if (!leaving) return;
    const removeTimer = setTimeout(onDismiss, FADE_MS);
    return () => clearTimeout(removeTimer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaving]);

  return (
    <div
      role="status"
      className={`pointer-events-auto rounded-lg border border-gray-200 bg-white p-3 shadow-lg transition-all duration-300 ${
        visible && !leaving ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-gray-900">{toast.title}</p>
          <p className="mt-0.5 text-sm text-gray-600">{toast.body}</p>
        </div>
        <button
          onClick={() => setLeaving(true)}
          className="shrink-0 text-gray-500 hover:text-gray-700"
          aria-label="Cerrar notificación"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
