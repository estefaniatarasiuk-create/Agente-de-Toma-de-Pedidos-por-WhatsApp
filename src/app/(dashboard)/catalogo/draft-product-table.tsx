"use client";

import type { DraftProduct } from "@/lib/validations/product";

export function DraftProductTable({
  rows,
  onChange,
}: {
  rows: DraftProduct[];
  onChange: (rows: DraftProduct[]) => void;
}) {
  function updateRow(index: number, patch: Partial<DraftProduct>) {
    const next = rows.slice();
    next[index] = { ...next[index], ...patch };
    onChange(next);
  }

  function removeRow(index: number) {
    onChange(rows.filter((_, i) => i !== index));
  }

  return (
    <div className="overflow-x-auto rounded-md border border-gray-200">
      <table className="min-w-full divide-y divide-gray-200 text-sm">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-3 py-2 text-left font-medium text-gray-600">Nombre</th>
            <th className="px-3 py-2 text-left font-medium text-gray-600">Categoría</th>
            <th className="px-3 py-2 text-right font-medium text-gray-600">Precio</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((row, index) => (
            <tr key={index}>
              <td className="px-3 py-1.5">
                <input
                  value={row.name}
                  onChange={(e) => updateRow(index, { name: e.target.value })}
                  className="w-full rounded border border-gray-200 px-2 py-1"
                />
              </td>
              <td className="px-3 py-1.5">
                <input
                  value={row.category}
                  onChange={(e) => updateRow(index, { category: e.target.value })}
                  className="w-full rounded border border-gray-200 px-2 py-1"
                />
              </td>
              <td className="px-3 py-1.5">
                <input
                  type="number"
                  step="0.01"
                  value={row.price}
                  onChange={(e) => updateRow(index, { price: Number(e.target.value) })}
                  className="w-24 rounded border border-gray-200 px-2 py-1 text-right"
                />
              </td>
              <td className="px-3 py-1.5 text-right">
                <button onClick={() => removeRow(index)} className="text-red-600 hover:underline">
                  Quitar
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
