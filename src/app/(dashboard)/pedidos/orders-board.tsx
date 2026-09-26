"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Order, OrderItem, OrderStatus } from "@prisma/client";
import { formatCentsAsArs } from "@/lib/money";
import { ORDER_STATUS_LABEL, ORDER_STATUS_BADGE_CLASS, ORDER_STATUS_ACCENT_CLASS } from "@/lib/orders/order-status";
import { OrderDetailPanel } from "./order-detail-panel";

export type OrderWithItems = Order & { items: OrderItem[] };

const COLUMNS: OrderStatus[] = ["WAITING_RECEIPT", "PENDING", "PREPARING", "ON_THE_WAY", "DELIVERED", "CANCELLED"];

const POLL_INTERVAL_MS = 8000;

export function OrdersBoard({ initialOrders }: { initialOrders: OrderWithItems[] }) {
  const [orders, setOrders] = useState(initialOrders);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);

  async function refreshOrders() {
    const response = await fetch("/api/pedidos");
    const data = await response.json();
    setOrders(data.orders);
  }

  // Actualización en vivo del tablero: sin esto, un pedido nuevo o un
  // cambio de estado solo se veía al recargar la página a mano.
  useEffect(() => {
    const interval = setInterval(refreshOrders, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex h-screen flex-col p-8">
      <div className="mb-4 flex shrink-0 items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Pedidos</h1>
          <p className="mt-1 text-sm text-gray-600">
            Tablero en vivo de todos los pedidos de la sucursal, agrupados por estado.
          </p>
        </div>
        <Link href="/pedidos/historial" className="text-sm font-medium text-green-700 underline">
          Ver historial y exportar →
        </Link>
      </div>

      {orders.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-600">
          Todavía no llegó ningún pedido. Van a aparecer acá apenas un cliente confirme uno por WhatsApp.
        </div>
      ) : (
        <div className="flex flex-1 gap-4 overflow-x-auto pb-4">
          {COLUMNS.map((status) => {
            const columnOrders = orders.filter((order) => order.status === status);
            return (
              <div
                key={status}
                className={`flex w-72 shrink-0 flex-col rounded-lg border-t-4 bg-gray-100 ${ORDER_STATUS_ACCENT_CLASS[status]}`}
              >
                <div className="shrink-0 border-b border-gray-200 px-3 py-2">
                  <span
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${ORDER_STATUS_BADGE_CLASS[status]}`}
                  >
                    {ORDER_STATUS_LABEL[status]}
                    <span className="opacity-70">({columnOrders.length})</span>
                  </span>
                </div>
                <div className="flex-1 space-y-2 overflow-y-auto p-2">
                  {columnOrders.map((order) => (
                    <button
                      key={order.id}
                      onClick={() => setSelectedOrderId(order.id)}
                      className="w-full rounded-md border border-gray-200 bg-white p-3 text-left text-sm shadow-sm hover:border-green-400"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-gray-900">{order.customerName}</span>
                        {order.isDelayed && (
                          <span className="rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700">
                            Demorado
                          </span>
                        )}
                      </div>
                      <div className="mt-1 text-gray-600">
                        {order.items.length} {order.items.length === 1 ? "producto" : "productos"} ·{" "}
                        {formatCentsAsArs(order.totalCents)}
                      </div>
                      <div className="mt-1 text-xs text-gray-500">
                        {order.paymentMethod === "CASH" ? "Efectivo" : "Transferencia"} ·{" "}
                        {new Date(order.createdAt).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {selectedOrderId && (
        <OrderDetailPanel
          orderId={selectedOrderId}
          onClose={() => setSelectedOrderId(null)}
          onChanged={() => {
            refreshOrders();
          }}
        />
      )}
    </div>
  );
}
