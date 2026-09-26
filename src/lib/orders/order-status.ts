import type { OrderStatus } from "@prisma/client";

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  WAITING_RECEIPT: "Esperando comprobante",
  PENDING: "Pendiente",
  PREPARING: "En preparación",
  ON_THE_WAY: "En camino",
  DELIVERED: "Entregado",
  CANCELLED: "Cancelado",
};

// Un color distinto por estado — antes el tablero, el detalle de pedido y el
// historial mostraban TODOS los estados con la misma etiqueta gris, así que
// había que leer el texto para distinguirlos (pedido real del cliente: "los
// colores se parecen mucho"). Mismo criterio que ya se usaba en
// conversaciones/línea de WhatsApp: verde = resuelto, rojo = cancelado, y acá
// se agrega un color por etapa intermedia para que el flujo se lea de un
// vistazo en el tablero.
export const ORDER_STATUS_BADGE_CLASS: Record<OrderStatus, string> = {
  WAITING_RECEIPT: "bg-amber-100 text-amber-800",
  PENDING: "bg-blue-100 text-blue-800",
  PREPARING: "bg-violet-100 text-violet-800",
  ON_THE_WAY: "bg-sky-100 text-sky-800",
  DELIVERED: "bg-green-100 text-green-800",
  CANCELLED: "bg-red-100 text-red-800",
};

// Mismo color, como borde superior de columna en el tablero — para que se
// distingan las columnas por color sin tener que leer el título de cada una.
export const ORDER_STATUS_ACCENT_CLASS: Record<OrderStatus, string> = {
  WAITING_RECEIPT: "border-t-amber-400",
  PENDING: "border-t-blue-400",
  PREPARING: "border-t-violet-400",
  ON_THE_WAY: "border-t-sky-400",
  DELIVERED: "border-t-green-500",
  CANCELLED: "border-t-red-400",
};
