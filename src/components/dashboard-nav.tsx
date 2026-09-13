"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

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

  return (
    <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
      {NAV_ITEMS.map((item) => {
        const isActive = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              isActive
                ? "bg-green-50 text-green-700"
                : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
