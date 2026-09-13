"use client";

import { useState } from "react";
import type { CatalogImage, Product } from "@prisma/client";
import { ProductTable } from "./product-table";
import { ProductForm } from "./product-form";
import { AiImportPanel } from "./ai-import-panel";
import { ExcelImportPanel } from "./excel-import-panel";
import { CatalogImagePanel } from "./catalog-image-panel";

export function CatalogManager({
  initialProducts,
  initialCatalogImage,
}: {
  initialProducts: Product[];
  initialCatalogImage: CatalogImage | null;
}) {
  const [products, setProducts] = useState(initialProducts);
  const [showForm, setShowForm] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [showImportTools, setShowImportTools] = useState(false);

  async function refreshProducts() {
    const response = await fetch("/api/catalogo/productos");
    const data = await response.json();
    setProducts(data.products);
  }

  async function handleTogglePause(product: Product) {
    await fetch(`/api/catalogo/productos/${product.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !product.isActive }),
    });
    refreshProducts();
  }

  async function handleDelete(product: Product) {
    if (!confirm(`¿Eliminar "${product.name}"? Esta acción no se puede deshacer.`)) return;
    await fetch(`/api/catalogo/productos/${product.id}`, { method: "DELETE" });
    refreshProducts();
  }

  return (
    <div className="p-8 space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Catálogo de productos</h1>
        <p className="mt-1 text-sm text-gray-500">
          La IA solo toma pedidos de productos activos con los precios que ves acá.
        </p>
      </div>

      <CatalogImagePanel initialCatalogImage={initialCatalogImage} />

      <div>
        <button
          onClick={() => setShowImportTools((value) => !value)}
          className="text-sm font-medium text-green-700 hover:underline"
        >
          {showImportTools ? "Ocultar herramientas de carga masiva" : "Cargar varios productos a la vez (IA o Excel)"}
        </button>
        {showImportTools && (
          <div className="mt-4 space-y-6">
            <AiImportPanel onImported={refreshProducts} />
            <ExcelImportPanel onImported={refreshProducts} />
          </div>
        )}
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium text-gray-900">Productos ({products.length})</h2>
          {!showForm && (
            <button
              onClick={() => {
                setEditingProduct(null);
                setShowForm(true);
              }}
              className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700"
            >
              Nuevo producto
            </button>
          )}
        </div>

        {showForm && (
          <ProductForm
            product={editingProduct}
            onSaved={() => {
              setShowForm(false);
              setEditingProduct(null);
              refreshProducts();
            }}
            onCancel={() => {
              setShowForm(false);
              setEditingProduct(null);
            }}
          />
        )}

        <ProductTable
          products={products}
          onEdit={(product) => {
            setEditingProduct(product);
            setShowForm(true);
          }}
          onTogglePause={handleTogglePause}
          onDelete={handleDelete}
        />
      </div>
    </div>
  );
}
