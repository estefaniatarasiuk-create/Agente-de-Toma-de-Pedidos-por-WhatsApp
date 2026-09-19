"use client";

import { useState } from "react";
import type { Order, OrderItem, OrderStatus } from "@prisma/client";
import { formatCentsAsArs } from "@/lib/money";
import { OrderDetailPanel } from "./order-detail-panel";

export type OrderWithItems = Order & { items: OrderItem[] };

const COLUMNS: { status: OrderStatus; label: string }[] = [
  { status: "WAITING_RECEIPT", label: "Esperando comprobante" },
  { status: "PENDING", label: "Pendiente" },
  { status: "PREPARING", label: "En preparación" },
  { status: "ON_THE_WAY", label: "En camino" },
  { status: "DELIVERED", label: "Entregado" },
  { status: "CANCELLED", label: "Cancelado" },
];

export function OrdersBoard({ initialOrders }: { initialOrders: OrderWithItems[] }) {
  const [orders, setOrders] = useState(initialOrders);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);

  async function refreshOrders() {
    const response = await fetch("/api/pedidos");
    const data = await response.json();
    setOrders(data.orders);
  }

  return (
    <div className="flex h-screen flex-col p-8">
      <div className="mb-4 shrink-0">
        <h1 className="text-2xl font-semibold text-gray-900">Pedidos</h1>
        <p className="mt-1 text-sm text-gray-500">
          Tablero en vivo de todos los pedidos de la sucursal, agrupados por estado.
        </p>
      </div>

      {orders.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">
          Todavía no llegó ningún pedido. Van a aparecer acá apenas un cliente confirme uno por WhatsApp.
        </div>
      ) : (
        <div className="flex flex-1 gap-4 overflow-x-auto pb-4">
          {COLUMNS.map((column) => {
            const columnOrders = orders.filter((order) => order.status === column.status);
            return (
              <div key={column.status} className="flex w-72 shrink-0 flex-col rounded-lg bg-gray-100">
                <div className="shrink-0 border-b border-gray-200 px-3 py-2">
                  <h2 className="text-sm font-semibold text-gray-700">
                    {column.label} <span className="text-gray-400">({columnOrders.length})</span>
                  </h2>
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
                      <div className="mt-1 text-gray-500">
                        {order.items.length} {order.items.length === 1 ? "producto" : "productos"} ·{" "}
                        {formatCentsAsArs(order.totalCents)}
                      </div>
                      <div className="mt-1 text-xs text-gray-400">
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
