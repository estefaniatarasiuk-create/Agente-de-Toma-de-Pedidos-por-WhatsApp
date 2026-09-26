"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { playAlertBeep } from "@/lib/notifications/beep";
import { ToastStack, type ToastItem } from "@/components/toast-stack";

type AlertsContextValue = {
  requiresAttentionCount: number;
  newOrdersCount: number;
  notificationsEnabled: boolean;
  notificationsSupported: boolean;
  requestNotificationPermission: () => void;
};

const AlertsContext = createContext<AlertsContextValue>({
  requiresAttentionCount: 0,
  newOrdersCount: 0,
  notificationsEnabled: false,
  notificationsSupported: false,
  requestNotificationPermission: () => {},
});

export function useOperationsAlerts(): AlertsContextValue {
  return useContext(AlertsContext);
}

const POLL_INTERVAL_MS = 8000;

type NotificacionesResponse = { requiresAttentionIds: string[]; newOrderIds: string[] };

// Sondea /api/notificaciones mientras el panel está abierto y avisa (sonido
// + notificación del navegador, sin bloquear nada de la interfaz) apenas
// aparece una conversación nueva que necesita atención humana, o un
// pedido nuevo — pedido explícito del usuario tras probar la Fase 4.
// La primera consulta al abrir el panel solo establece la base: no avisa
// de cosas que ya estaban ahí antes de abrirlo.
export function OperationsAlertsProvider({ children }: { children: React.ReactNode }) {
  const [requiresAttentionCount, setRequiresAttentionCount] = useState(0);
  const [newOrdersCount, setNewOrdersCount] = useState(0);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const notificationsSupported = typeof window !== "undefined" && "Notification" in window;
  const seenAttentionIds = useRef<Set<string> | null>(null);
  const seenOrderIds = useRef<Set<string> | null>(null);

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  useEffect(() => {
    if (notificationsSupported && Notification.permission === "granted") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- refleja el permiso ya otorgado por el navegador al montar
      setNotificationsEnabled(true);
    }
  }, [notificationsSupported]);

  const requestNotificationPermission = useCallback(() => {
    if (!notificationsSupported) return;
    Notification.requestPermission().then((permission) => setNotificationsEnabled(permission === "granted"));
  }, [notificationsSupported]);

  const notify = useCallback(
    (title: string, body: string) => {
      playAlertBeep();
      if (notificationsSupported && Notification.permission === "granted") {
        new Notification(title, { body });
      }
      // Flotante en pantalla además del sonido y la notificación del
      // navegador (pedido explícito del usuario): se ve aunque el navegador
      // no tenga permiso de notificaciones concedido, o esté en otra pestaña.
      setToasts((current) => [...current, { id: `${Date.now()}-${Math.random()}`, title, body }]);
    },
    [notificationsSupported],
  );

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const response = await fetch("/api/notificaciones");
        if (!response.ok || cancelled) return;
        const data: NotificacionesResponse = await response.json();
        if (cancelled) return;

        if (seenAttentionIds.current) {
          const newOnes = data.requiresAttentionIds.filter((id) => !seenAttentionIds.current!.has(id));
          if (newOnes.length > 0) {
            notify(
              "Atención requerida",
              newOnes.length === 1
                ? "Una conversación necesita atención humana."
                : `${newOnes.length} conversaciones necesitan atención humana.`,
            );
          }
        }
        if (seenOrderIds.current) {
          const newOnes = data.newOrderIds.filter((id) => !seenOrderIds.current!.has(id));
          if (newOnes.length > 0) {
            notify("Nuevo pedido", newOnes.length === 1 ? "Llegó un pedido nuevo." : `Llegaron ${newOnes.length} pedidos nuevos.`);
          }
        }

        seenAttentionIds.current = new Set(data.requiresAttentionIds);
        seenOrderIds.current = new Set(data.newOrderIds);
        setRequiresAttentionCount(data.requiresAttentionIds.length);
        setNewOrdersCount(data.newOrderIds.length);
      } catch {
        // Sondeo puntual fallido (red, deploy en curso): se reintenta solo.
      }
    }

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [notify]);

  return (
    <AlertsContext.Provider
      value={{ requiresAttentionCount, newOrdersCount, notificationsEnabled, notificationsSupported, requestNotificationPermission }}
    >
      {children}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </AlertsContext.Provider>
  );
}
