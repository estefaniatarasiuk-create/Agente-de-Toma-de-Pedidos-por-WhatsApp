"use client";

import { useEffect, useState } from "react";
import type { Order, OrderItem, OrderStatus, OrderStatusEvent } from "@prisma/client";
import { formatCentsAsArs } from "@/lib/money";
import { ORDER_STATUS_LABEL, ORDER_STATUS_BADGE_CLASS } from "@/lib/orders/order-status";

type OrderDetail = Order & {
  items: OrderItem[];
  statusEvents: (OrderStatusEvent & { changedByUser: { name: string } | null })[];
};

const ADVANCE_LABEL: Partial<Record<OrderStatus, string>> = {
  PENDING: "Pasar a preparación",
  PREPARING: "Marcar en camino",
  ON_THE_WAY: "Marcar entregado",
};

export function OrderDetailPanel({
  orderId,
  onClose,
  onChanged,
}: {
  orderId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const response = await fetch(`/api/pedidos/${orderId}`);
    const data = await response.json();
    if (response.ok) setOrder(data.order);
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- carga inicial por id, no hay forma de evitar el setState acá
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId]);

  async function runAction(body: object) {
    setLoading(true);
    setError(null);
    const response = await fetch(`/api/pedidos/${orderId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    setLoading(false);
    if (!response.ok) {
      setError(data.error ?? "No se pudo aplicar el cambio.");
      return;
    }
    await load();
    onChanged();
  }

  function handleCancel() {
    const reason = prompt("¿Por qué se cancela este pedido? El cliente va a recibir este motivo por WhatsApp.");
    if (!reason || !reason.trim()) return;
    runAction({ action: "cancel", reason: reason.trim() });
  }

  return (
    <div className="fixed inset-0 z-20 flex justify-end bg-black/30" onClick={onClose}>
      <div className="h-full w-full max-w-md overflow-y-auto bg-white shadow-xl" onClick={(event) => event.stopPropagation()}>
        {!order ? (
          <div className="p-6 text-sm text-gray-600">Cargando...</div>
        ) : (
          <div className="flex h-full flex-col">
            <div className="flex items-start justify-between border-b border-gray-200 p-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">{order.customerName}</h2>
                <p className="text-sm text-gray-600">{order.customerPhone}</p>
              </div>
              <button onClick={onClose} className="text-gray-500 hover:text-gray-600">
                ✕
              </button>
            </div>

            <div className="flex-1 space-y-5 p-4">
              <div>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${ORDER_STATUS_BADGE_CLASS[order.status]}`}>
                  {ORDER_STATUS_LABEL[order.status]}
                </span>
                {order.isDelayed && (
                  <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                    Demorado
                  </span>
                )}
              </div>

              <div>
                <h3 className="text-xs font-semibold uppercase text-gray-600">Productos</h3>
                <ul className="mt-1 space-y-1 text-sm">
                  {order.items.map((item) => (
                    <li key={item.id} className="flex justify-between">
                      <span>
                        {item.quantity}x {item.productName}
                      </span>
                      <span>{formatCentsAsArs(item.subtotalCents)}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-2 flex justify-between border-t border-gray-100 pt-2 text-sm font-semibold">
                  <span>Total</span>
                  <span>{formatCentsAsArs(order.totalCents)}</span>
                </div>
              </div>

              <div>
                <h3 className="text-xs font-semibold uppercase text-gray-600">Entrega</h3>
                <p className="mt-1 text-sm text-gray-800">{order.deliveryAddressRaw}</p>
                {order.deliveryAddressNormalized && (
                  <p className="text-xs text-gray-600">{order.deliveryAddressNormalized}</p>
                )}
                {order.deliveryNotes && <p className="text-xs text-gray-600">Notas: {order.deliveryNotes}</p>}
              </div>

              <div>
                <h3 className="text-xs font-semibold uppercase text-gray-600">Pago</h3>
                <p className="mt-1 text-sm text-gray-800">
                  {order.paymentMethod === "CASH" ? "Efectivo" : "Transferencia"}
                  {order.paymentMethod === "CASH" && order.changeAmountCents !== null && order.changeAmountCents > 0
                    ? ` (vuelto: ${formatCentsAsArs(order.changeAmountCents)})`
                    : ""}
                </p>
                {order.receiptUrl && (
                  <div className="mt-2">
                    <p className="text-xs text-gray-600">Comprobante recibido:</p>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/uploads/${order.receiptUrl}`}
                      alt="Comprobante de transferencia"
                      className="mt-1 max-h-64 rounded-md border border-gray-200"
                    />
                    {order.paymentValidated && (
                      <p className="mt-1 text-xs font-medium text-green-700">✓ Comprobante validado</p>
                    )}
                  </div>
                )}
              </div>

              <div>
                <h3 className="text-xs font-semibold uppercase text-gray-600">Historial</h3>
                <ul className="mt-1 space-y-1 text-xs text-gray-600">
                  {order.statusEvents.map((event) => (
                    <li key={event.id}>
                      {new Date(event.createdAt).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}
                      {" — "}
                      {ORDER_STATUS_LABEL[event.toStatus]}
                      {event.changedByUser ? ` (${event.changedByUser.name})` : event.changedByAI ? " (IA)" : ""}
                      {event.reason ? `: ${event.reason}` : ""}
                    </li>
                  ))}
                </ul>
              </div>

              {error && <p className="text-sm text-red-600">{error}</p>}
            </div>

            <div className="shrink-0 space-y-2 border-t border-gray-200 p-4">
              {order.status === "WAITING_RECEIPT" && order.receiptUrl && !order.paymentValidated && (
                <button
                  disabled={loading}
                  onClick={() => runAction({ action: "validate_payment" })}
                  className="w-full rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
                >
                  Validar comprobante y pasar a preparación
                </button>
              )}
              {order.status === "WAITING_RECEIPT" && !order.receiptUrl && (
                <p className="text-center text-xs text-gray-600">Esperando que el cliente mande el comprobante.</p>
              )}
              {ADVANCE_LABEL[order.status] && (
                <button
                  disabled={loading}
                  onClick={() => runAction({ action: "advance_status" })}
                  className="w-full rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
                >
                  {ADVANCE_LABEL[order.status]}
                </button>
              )}
              {order.status !== "DELIVERED" && order.status !== "CANCELLED" && (
                <button
                  disabled={loading}
                  onClick={handleCancel}
                  className="w-full rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                >
                  Cancelar pedido
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
