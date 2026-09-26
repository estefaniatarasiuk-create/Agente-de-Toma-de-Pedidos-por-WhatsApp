"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { OrderStatus } from "@prisma/client";
import { formatCentsAsArs } from "@/lib/money";
import { ORDER_STATUS_LABEL, ORDER_STATUS_BADGE_CLASS } from "@/lib/orders/order-status";
import type { OrderWithItems } from "../orders-board";

const STATUS_OPTIONS: OrderStatus[] = [
  "WAITING_RECEIPT",
  "PENDING",
  "PREPARING",
  "ON_THE_WAY",
  "DELIVERED",
  "CANCELLED",
];

export function HistorialTable({
  initialOrders,
  initialTotal,
  pageSize,
}: {
  initialOrders: OrderWithItems[];
  initialTotal: number;
  pageSize: number;
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [clienteInput, setClienteInput] = useState("");
  const [cliente, setCliente] = useState("");
  const [estado, setEstado] = useState("");
  const [page, setPage] = useState(1);

  const [orders, setOrders] = useState(initialOrders);
  const [total, setTotal] = useState(initialTotal);
  const [loading, setLoading] = useState(false);

  // Debounce del texto de búsqueda por cliente: sin esto, cada tecla
  // dispararía un pedido al servidor.
  useEffect(() => {
    const timeout = setTimeout(() => setCliente(clienteInput), 400);
    return () => clearTimeout(timeout);
  }, [clienteInput]);

  // Cualquier cambio de filtro vuelve a la página 1 — si no, se podría
  // quedar en una página que ya no existe para el nuevo filtro.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- volver a la página 1 cuando cambia cualquier filtro, no hay forma de evitar el setState acá
    setPage(1);
  }, [from, to, cliente, estado]);

  useEffect(() => {
    const isDefaultView = !from && !to && !cliente && !estado && page === 1;
    if (isDefaultView) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- vuelve a mostrar los datos iniciales del server al limpiar los filtros, no hay forma de evitar el setState acá
      setOrders(initialOrders);
      setTotal(initialTotal);
      return;
    }

    let cancelled = false;
    setLoading(true);
    const params = buildParams({ from, to, cliente, estado, page });
    fetch(`/api/pedidos/historial?${params.toString()}`)
      .then((response) => response.json())
      .then((data) => {
        if (cancelled) return;
        setOrders(data.orders);
        setTotal(data.total);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, cliente, estado, page]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const exportHref = `/api/pedidos/historial/exportar?${buildParams({ from, to, cliente, estado }).toString()}`;

  return (
    <div className="flex h-screen flex-col p-8">
      <div className="mb-4 flex shrink-0 items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Historial de pedidos</h1>
          <p className="mt-1 text-sm text-gray-600">Buscá, filtrá y exportá todos los pedidos de la sucursal.</p>
        </div>
        <Link href="/pedidos" className="text-sm font-medium text-green-700 underline">
          ← Volver al tablero
        </Link>
      </div>

      <div className="mb-4 flex shrink-0 flex-wrap items-end gap-3">
        <label className="flex flex-col text-xs font-medium text-gray-600">
          Desde
          <input
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            className="mt-1 rounded-md border border-gray-300 px-2 py-1.5 text-sm text-gray-900"
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-gray-600">
          Hasta
          <input
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            className="mt-1 rounded-md border border-gray-300 px-2 py-1.5 text-sm text-gray-900"
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-gray-600">
          Cliente (nombre o teléfono)
          <input
            type="text"
            value={clienteInput}
            onChange={(event) => setClienteInput(event.target.value)}
            placeholder="Buscar..."
            className="mt-1 w-48 rounded-md border border-gray-300 px-2 py-1.5 text-sm text-gray-900"
          />
        </label>
        <label className="flex flex-col text-xs font-medium text-gray-600">
          Estado
          <select
            value={estado}
            onChange={(event) => setEstado(event.target.value)}
            className="mt-1 rounded-md border border-gray-300 px-2 py-1.5 text-sm text-gray-900"
          >
            <option value="">Todos</option>
            {STATUS_OPTIONS.map((status) => (
              <option key={status} value={status}>
                {ORDER_STATUS_LABEL[status]}
              </option>
            ))}
          </select>
        </label>
        {(from || to || cliente || estado) && (
          <button
            onClick={() => {
              setFrom("");
              setTo("");
              setClienteInput("");
              setEstado("");
            }}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100"
          >
            Limpiar filtros
          </button>
        )}
        <a
          href={exportHref}
          className="ml-auto rounded-md bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-700"
        >
          Exportar CSV
        </a>
      </div>

      <div className={`flex-1 overflow-auto rounded-lg border border-gray-200 bg-white ${loading ? "opacity-60" : ""}`}>
        {orders.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-600">No hay pedidos que coincidan con estos filtros.</div>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-gray-50 text-xs font-medium uppercase text-gray-600">
              <tr>
                <th className="px-3 py-2">Fecha</th>
                <th className="px-3 py-2">Cliente</th>
                <th className="px-3 py-2">Productos</th>
                <th className="px-3 py-2">Medio de pago</th>
                <th className="px-3 py-2">Total</th>
                <th className="px-3 py-2">Estado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {orders.map((order) => (
                <tr key={order.id}>
                  <td className="whitespace-nowrap px-3 py-2 text-gray-600">
                    {new Date(order.createdAt).toLocaleString("es-AR", {
                      day: "2-digit",
                      month: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium text-gray-900">{order.customerName}</div>
                    <div className="text-xs text-gray-500">{order.customerPhone}</div>
                  </td>
                  <td className="px-3 py-2 text-gray-600">
                    {order.items.map((item) => `${item.quantity}x ${item.productName}`).join(", ")}
                  </td>
                  <td className="px-3 py-2 text-gray-600">{order.paymentMethod === "CASH" ? "Efectivo" : "Transferencia"}</td>
                  <td className="px-3 py-2 font-medium text-gray-900">{formatCentsAsArs(order.totalCents)}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${ORDER_STATUS_BADGE_CLASS[order.status]}`}
                    >
                      {ORDER_STATUS_LABEL[order.status]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="mt-3 flex shrink-0 items-center justify-between text-sm text-gray-600">
        <span>{total.toLocaleString("es-AR")} pedidos en total</span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            disabled={page <= 1}
            className="rounded-md border border-gray-300 px-3 py-1 disabled:opacity-40"
          >
            Anterior
          </button>
          <span>
            Página {page} de {totalPages}
          </span>
          <button
            onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
            disabled={page >= totalPages}
            className="rounded-md border border-gray-300 px-3 py-1 disabled:opacity-40"
          >
            Siguiente
          </button>
        </div>
      </div>
    </div>
  );
}

function buildParams(filters: { from?: string; to?: string; cliente?: string; estado?: string; page?: number }) {
  const params = new URLSearchParams();
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.cliente) params.set("cliente", filters.cliente);
  if (filters.estado) params.set("estado", filters.estado);
  if (filters.page) params.set("page", String(filters.page));
  return params;
}
