"use client";

import { useEffect, useRef, useState } from "react";
import Script from "next/script";
import type { SafeWhatsAppLine } from "@/lib/whatsapp/safe-line";

declare global {
  interface Window {
    FB?: {
      init: (params: { appId: string; version: string; xfbml?: boolean }) => void;
      login: (
        callback: (response: { authResponse?: { code?: string } }) => void,
        params: {
          config_id: string;
          response_type: string;
          override_default_response_type: boolean;
          extras?: Record<string, unknown>;
        },
      ) => void;
    };
  }
}

const STATUS_LABEL: Record<string, { text: string; className: string }> = {
  ACTIVE: { text: "Activa", className: "bg-green-100 text-green-700" },
  PENDING: { text: "Pendiente", className: "bg-amber-100 text-amber-700" },
  ERROR: { text: "Con error", className: "bg-red-100 text-red-700" },
};

export function WhatsAppConnection({ initialLine }: { initialLine: SafeWhatsAppLine | null }) {
  const [line, setLine] = useState(initialLine);
  const [isSdkReady, setIsSdkReady] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingSignupData = useRef<{ phoneNumberId: string; wabaId: string; businessId?: string } | null>(null);

  const appId = process.env.NEXT_PUBLIC_META_APP_ID;
  const configId = process.env.NEXT_PUBLIC_META_WHATSAPP_CONFIG_ID;

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.origin !== "https://www.facebook.com" && event.origin !== "https://web.facebook.com") return;
      try {
        const data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        if (data.type !== "WA_EMBEDDED_SIGNUP") return;
        if (data.event === "FINISH" || data.event === "FINISH_ONLY_WABA") {
          pendingSignupData.current = {
            phoneNumberId: data.data.phone_number_id,
            wabaId: data.data.waba_id,
            businessId: data.data.business_id,
          };
        }
      } catch {
        // mensajes de otro origin/formato que no nos interesan
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  async function refreshLine() {
    const response = await fetch("/api/whatsapp/linea");
    const data = await response.json();
    setLine(data.line);
  }

  function handleConnectClick() {
    setError(null);

    if (!window.FB || !appId || !configId) {
      setError("Falta configurar las variables de Meta (NEXT_PUBLIC_META_APP_ID / NEXT_PUBLIC_META_WHATSAPP_CONFIG_ID).");
      return;
    }

    pendingSignupData.current = null;
    setIsConnecting(true);

    window.FB.login(
      async (response) => {
        const code = response.authResponse?.code;
        if (!code) {
          setError("No se completó la vinculación con Meta.");
          setIsConnecting(false);
          return;
        }

        // El evento WA_EMBEDDED_SIGNUP con los ids del número puede llegar
        // un instante después del callback de FB.login: esperamos un poco.
        for (let attempt = 0; attempt < 20 && !pendingSignupData.current; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }

        if (!pendingSignupData.current) {
          setError("No recibimos los datos del número de WhatsApp. Probá de nuevo.");
          setIsConnecting(false);
          return;
        }

        try {
          const submitResponse = await fetch("/api/whatsapp/conectar", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code, ...pendingSignupData.current }),
          });
          const data = await submitResponse.json();
          if (!submitResponse.ok) {
            setError(data.error ?? "No pudimos vincular la línea.");
            return;
          }
          await refreshLine();
        } catch {
          setError("Ocurrió un error inesperado.");
        } finally {
          setIsConnecting(false);
        }
      },
      {
        config_id: configId,
        response_type: "code",
        override_default_response_type: true,
        extras: { setup: {}, sessionInfoVersion: "3" },
      },
    );
  }

  const statusInfo = line ? STATUS_LABEL[line.status] : null;

  return (
    <div className="p-8 max-w-2xl">
      <Script
        src="https://connect.facebook.net/es_LA/sdk.js"
        strategy="afterInteractive"
        onReady={() => {
          window.FB?.init({ appId: appId ?? "", version: "v21.0" });
          setIsSdkReady(true);
        }}
      />

      <h1 className="text-2xl font-semibold text-gray-900">Línea de WhatsApp</h1>
      <p className="mt-1 text-sm text-gray-600">
        Vinculá el número de WhatsApp de tu sucursal para que la IA lo use en la toma de pedidos.
      </p>

      <div className="mt-6 rounded-lg border border-gray-200 bg-white p-6 space-y-4">
        {line ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-gray-800">Estado:</span>
              {statusInfo && (
                <span className={`rounded-full px-2 py-0.5 text-xs ${statusInfo.className}`}>
                  {statusInfo.text}
                </span>
              )}
            </div>
            {line.displayPhoneNumber && (
              <p className="text-sm text-gray-600">Número: {line.displayPhoneNumber}</p>
            )}
            {line.verifiedName && <p className="text-sm text-gray-600">Nombre verificado: {line.verifiedName}</p>}
            {line.connectedAt && (
              <p className="text-xs text-gray-500">
                Conectada el {new Date(line.connectedAt).toLocaleString("es-AR")}
              </p>
            )}
            {line.status === "ERROR" && line.lastErrorMessage && (
              <p className="text-sm text-red-600">Último error: {line.lastErrorMessage}</p>
            )}
          </div>
        ) : (
          <p className="text-sm text-gray-600">Todavía no vinculaste ninguna línea.</p>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button
          onClick={handleConnectClick}
          disabled={!isSdkReady || isConnecting}
          className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-60"
        >
          {isConnecting ? "Vinculando..." : line ? "Reconectar línea" : "Conectar línea de WhatsApp"}
        </button>

        {(!appId || !configId) && (
          <p className="text-xs text-amber-600">
            Para usar esta pantalla necesitás configurar `NEXT_PUBLIC_META_APP_ID` y
            `NEXT_PUBLIC_META_WHATSAPP_CONFIG_ID` (ver README).
          </p>
        )}
      </div>
    </div>
  );
}
