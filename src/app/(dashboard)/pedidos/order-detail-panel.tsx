"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { ConversationStatus, Order, OrderItem, OrderStatus, OrderStatusEvent, Product } from "@prisma/client";
import { formatCentsAsArs } from "@/lib/money";
import { ORDER_STATUS_LABEL, ORDER_STATUS_BADGE_CLASS } from "@/lib/orders/order-status";

type OrderDetail = Order & {
  items: OrderItem[];
  statusEvents: (OrderStatusEvent & { changedByUser: { name: string } | null })[];
  conversation: { id: string; status: ConversationStatus; draftOrder: unknown } | null;
};

type StagedItem = { productId: string; productName: string; unitPriceCents: number; quantity: number };

const ADVANCE_LABEL: Partial<Record<OrderStatus, string>> = {
  PENDING: "Pasar a preparación",
  PREPARING: "Marcar en camino",
  ON_THE_WAY: "Marcar entregado",
};

const EDITABLE_STATUSES: OrderStatus[] = ["WAITING_RECEIPT", "PENDING", "PREPARING", "ON_THE_WAY"];

// El borrador de la conversación (JSON) puede traer productos que el
// cliente pidió por WhatsApp mientras este pedido seguía activo — ver el
// chequeo en apply-actions.ts, que a propósito NO limpia el borrador en ese
// caso puntual para que el panel pueda mostrarlo acá.
function getPendingDraftItems(order: OrderDetail): Array<{ productId: string; productName: string; quantity: number }> {
  if (order.conversation?.status !== "REQUIRES_ATTENTION") return [];
  const draft = order.conversation.draftOrder as { items?: Array<{ productId: string; productName: string; quantity: number }> } | null;
  return draft?.items ?? [];
}

export function OrderDetailPanel({
  orderId,
  onClose,
  onChanged,
}: {
  orderId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const router = useRouter();
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [editingItems, setEditingItems] = useState(false);
  const [stagedItems, setStagedItems] = useState<StagedItem[]>([]);
  const [products, setProducts] = useState<Product[] | null>(null);
  const [addProductId, setAddProductId] = useState("");
  const [savingItems, setSavingItems] = useState(false);
  const [itemsError, setItemsError] = useState<string | null>(null);

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

  // Deriva la conversación a atención humana (pausando la IA) y te lleva
  // directo al chat — pedido explícito del usuario: poder tomar la
  // conversación manual desde el pedido, sin tener que buscarla a mano.
  async function handleTalkToCustomer() {
    if (!order?.conversationId) return;
    await fetch(`/api/conversaciones/${order.conversationId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "AI_PAUSED" }),
    });
    router.push(`/conversaciones?conversacion=${order.conversationId}`);
  }

  async function loadProducts() {
    if (products) return;
    const response = await fetch("/api/catalogo/productos");
    const data = await response.json();
    if (response.ok) setProducts(data.products);
  }

  function startEditingItems(initialItems?: StagedItem[]) {
    if (!order) return;
    setStagedItems(
      initialItems ??
        // Un ítem sin productId (el producto se borró del catálogo después)
        // no se puede volver a guardar tal cual — se excluye del editor en
        // vez de bloquear la edición de todo el pedido por eso.
        order.items
          .filter((item) => item.productId !== null)
          .map((item) => ({
            productId: item.productId as string,
            productName: item.productName,
            unitPriceCents: item.unitPriceCents,
            quantity: item.quantity,
          })),
    );
    setItemsError(null);
    setEditingItems(true);
    loadProducts();
  }

  function handleAddPendingDraftItems() {
    if (!order) return;
    const pending = getPendingDraftItems(order);
    const merged: StagedItem[] = order.items
      .filter((item) => item.productId !== null)
      .map((item) => ({
        productId: item.productId as string,
        productName: item.productName,
        unitPriceCents: item.unitPriceCents,
        quantity: item.quantity,
      }));
    for (const pendingItem of pending) {
      const existing = merged.find((item) => item.productId === pendingItem.productId);
      if (existing) existing.quantity += pendingItem.quantity;
      else {
        const product = products?.find((p) => p.id === pendingItem.productId);
        merged.push({
          productId: pendingItem.productId,
          productName: pendingItem.productName,
          unitPriceCents: product?.priceCents ?? 0,
          quantity: pendingItem.quantity,
        });
      }
    }
    startEditingItems(merged);
  }

  function handleAddProduct() {
    const product = products?.find((p) => p.id === addProductId);
    if (!product) return;
    setStagedItems((current) => {
      const existing = current.find((item) => item.productId === product.id);
      if (existing) {
        return current.map((item) => (item.productId === product.id ? { ...item, quantity: item.quantity + 1 } : item));
      }
      return [...current, { productId: product.id, productName: product.name, unitPriceCents: product.priceCents, quantity: 1 }];
    });
    setAddProductId("");
  }

  function updateStagedQuantity(productId: string, quantity: number) {
    setStagedItems((current) =>
      current.map((item) => (item.productId === productId ? { ...item, quantity: Math.max(1, quantity) } : item)),
    );
  }

  function removeStagedItem(productId: string) {
    setStagedItems((current) => current.filter((item) => item.productId !== productId));
  }

  async function saveItems() {
    if (stagedItems.length === 0) {
      setItemsError("El pedido necesita al menos un producto.");
      return;
    }
    setSavingItems(true);
    setItemsError(null);
    const response = await fetch(`/api/pedidos/${orderId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "update_items",
        items: stagedItems.map((item) => ({ productId: item.productId, quantity: item.quantity })),
      }),
    });
    const data = await response.json();
    setSavingItems(false);
    if (!response.ok) {
      setItemsError(data.error ?? "No se pudo actualizar el pedido.");
      return;
    }
    setEditingItems(false);
    await load();
    onChanged();
  }

  const pendingDraftItems = order ? getPendingDraftItems(order) : [];

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
                {order.conversationId && (
                  <button onClick={handleTalkToCustomer} className="mt-1 text-xs font-medium text-green-700 underline">
                    Hablar con el cliente
                  </button>
                )}
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

              {pendingDraftItems.length > 0 && (
                <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                  <p className="font-medium">Este cliente pidió más por WhatsApp mientras este pedido seguía en curso:</p>
                  <ul className="mt-1 list-disc pl-4">
                    {pendingDraftItems.map((item, index) => (
                      <li key={`${item.productId}-${index}`}>
                        {item.quantity}x {item.productName}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      onClick={handleAddPendingDraftItems}
                      className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700"
                    >
                      Sumarlos al pedido
                    </button>
                    <button
                      onClick={handleTalkToCustomer}
                      className="rounded-md border border-amber-400 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100"
                    >
                      Hablar con el cliente
                    </button>
                  </div>
                </div>
              )}

              <div>
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold uppercase text-gray-600">Productos</h3>
                  {!editingItems && EDITABLE_STATUSES.includes(order.status) && (
                    <button onClick={() => startEditingItems()} className="text-xs font-medium text-green-700 underline">
                      Editar productos
                    </button>
                  )}
                </div>

                {!editingItems ? (
                  <>
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
                  </>
                ) : (
                  <div className="mt-2 space-y-2">
                    {stagedItems.map((item) => (
                      <div key={item.productId} className="flex items-center gap-2 text-sm">
                        <span className="flex-1">{item.productName}</span>
                        <input
                          type="number"
                          min={1}
                          value={item.quantity}
                          onChange={(event) => updateStagedQuantity(item.productId, Number(event.target.value))}
                          className="w-14 rounded border border-gray-300 px-1 py-0.5 text-right"
                        />
                        <span className="w-20 shrink-0 text-right text-gray-600">
                          {formatCentsAsArs(item.unitPriceCents * item.quantity)}
                        </span>
                        <button
                          onClick={() => removeStagedItem(item.productId)}
                          className="shrink-0 text-xs text-red-600 underline"
                        >
                          Quitar
                        </button>
                      </div>
                    ))}

                    <div className="flex items-center gap-2 pt-1">
                      <select
                        value={addProductId}
                        onChange={(event) => setAddProductId(event.target.value)}
                        className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm"
                      >
                        <option value="">Agregar producto...</option>
                        {(products ?? [])
                          .filter((product) => product.isActive)
                          .map((product) => (
                            <option key={product.id} value={product.id}>
                              {product.name} — {formatCentsAsArs(product.priceCents)}
                            </option>
                          ))}
                      </select>
                      <button
                        onClick={handleAddProduct}
                        disabled={!addProductId}
                        className="shrink-0 rounded-md bg-gray-100 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-200 disabled:opacity-50"
                      >
                        Agregar
                      </button>
                    </div>

                    <div className="flex justify-between border-t border-gray-100 pt-2 text-sm font-semibold">
                      <span>Nuevo total</span>
                      <span>{formatCentsAsArs(stagedItems.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0))}</span>
                    </div>

                    {itemsError && <p className="text-xs text-red-600">{itemsError}</p>}

                    <div className="flex gap-2">
                      <button
                        onClick={saveItems}
                        disabled={savingItems}
                        className="flex-1 rounded-md bg-green-600 px-3 py-2 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
                      >
                        {savingItems ? "Guardando..." : "Guardar cambios"}
                      </button>
                      <button
                        onClick={() => setEditingItems(false)}
                        disabled={savingItems}
                        className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50"
                      >
                        Cancelar
                      </button>
                    </div>
                    <p className="text-xs text-gray-500">El cliente recibe un WhatsApp avisando el cambio y el nuevo total.</p>
                  </div>
                )}
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
                    {/* Un comprobante puede llegar como PDF (muy común: el
                        home banking o Mercado Pago lo exportan así) — un
                        <img> no puede mostrar un PDF, se ve como una imagen
                        rota y parece que "no se lee" el archivo. Se abre en
                        una pestaña aparte en vez de intentar incrustarlo. */}
                    {order.receiptUrl.toLowerCase().endsWith(".pdf") ? (
                      <a
                        href={`/api/uploads/${order.receiptUrl}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-1 inline-block rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-green-700 underline"
                      >
                        Ver comprobante (PDF)
                      </a>
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={`/api/uploads/${order.receiptUrl}`}
                        alt="Comprobante de transferencia"
                        className="mt-1 max-h-64 rounded-md border border-gray-200"
                      />
                    )}
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
