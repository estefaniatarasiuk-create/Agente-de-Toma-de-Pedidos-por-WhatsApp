"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useOperationsAlerts } from "@/components/operations-alerts-provider";

const NAV_ITEMS = [
  { href: "/", label: "Inicio" },
  { href: "/pedidos", label: "Pedidos" },
  { href: "/conversaciones", label: "Conversaciones" },
  { href: "/catalogo", label: "Catálogo" },
  { href: "/horarios", label: "Horarios" },
  { href: "/zona-de-entrega", label: "Zona de entrega" },
  { href: "/medios-de-pago", label: "Medios de pago" },
  { href: "/ia", label: "Configuración de IA" },
  { href: "/whatsapp", label: "Línea de WhatsApp" },
  { href: "/metricas", label: "Métricas" },
];

export function DashboardNav() {
  const pathname = usePathname();
  const { requiresAttentionCount, newOrdersCount, notificationsEnabled, notificationsSupported, requestNotificationPermission } =
    useOperationsAlerts();

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <nav className="flex flex-col gap-1 p-3">
        {NAV_ITEMS.map((item) => {
          const isActive = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center justify-between rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                isActive ? "bg-green-50 text-green-700" : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
              }`}
            >
              <span>{item.label}</span>
              {item.href === "/conversaciones" && requiresAttentionCount > 0 && (
                <span className="rounded-full bg-red-600 px-2 py-0.5 text-xs font-semibold text-white">
                  {requiresAttentionCount}
                </span>
              )}
              {item.href === "/pedidos" && newOrdersCount > 0 && (
                <span className="rounded-full bg-green-600 px-2 py-0.5 text-xs font-semibold text-white">
                  {newOrdersCount}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      {notificationsSupported && !notificationsEnabled && (
        <div className="mx-3 mt-2 rounded-md border border-gray-200 bg-gray-50 p-3 text-xs text-gray-600">
          <p>Activá las notificaciones para enterarte al instante de nuevos pedidos y chats que necesitan atención.</p>
          <button
            onClick={requestNotificationPermission}
            className="mt-2 rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700"
          >
            Activar notificaciones
          </button>
        </div>
      )}
    </div>
  );
}
