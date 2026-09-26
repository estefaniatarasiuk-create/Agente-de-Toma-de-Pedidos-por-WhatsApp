"use client";

import type { Product } from "@prisma/client";
import { formatCentsAsArs } from "@/lib/money";

export function ProductTable({
  products,
  onEdit,
  onTogglePause,
  onDelete,
}: {
  products: Product[];
  onEdit: (product: Product) => void;
  onTogglePause: (product: Product) => void;
  onDelete: (product: Product) => void;
}) {
  if (products.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-600">
        Todavía no cargaste productos.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table className="min-w-full divide-y divide-gray-200 text-sm">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-4 py-2 text-left font-medium text-gray-600">Producto</th>
            <th className="px-4 py-2 text-left font-medium text-gray-600">Categoría</th>
            <th className="px-4 py-2 text-right font-medium text-gray-600">Precio</th>
            <th className="px-4 py-2 text-left font-medium text-gray-600">Estado</th>
            <th className="px-4 py-2"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {products.map((product) => (
            <tr key={product.id} className={product.isActive ? "" : "bg-gray-50 text-gray-500"}>
              <td className="px-4 py-2">
                <div className="font-medium">{product.name}</div>
                {product.description && <div className="text-xs text-gray-600">{product.description}</div>}
              </td>
              <td className="px-4 py-2">{product.category || "—"}</td>
              <td className="px-4 py-2 text-right">{formatCentsAsArs(product.priceCents)}</td>
              <td className="px-4 py-2">
                {product.isActive ? (
                  <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700">Activo</span>
                ) : (
                  <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs text-gray-600">Pausado</span>
                )}
              </td>
              <td className="px-4 py-2 text-right whitespace-nowrap">
                <button onClick={() => onEdit(product)} className="text-green-700 underline mr-3">
                  Editar
                </button>
                <button onClick={() => onTogglePause(product)} className="text-gray-600 underline mr-3">
                  {product.isActive ? "Pausar" : "Reactivar"}
                </button>
                <button onClick={() => onDelete(product)} className="text-red-600 underline">
                  Eliminar
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
