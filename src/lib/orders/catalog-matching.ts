import { prisma } from "@/lib/prisma";
import type { Product } from "@prisma/client";

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

// El prompt le pide a la IA que use el nombre EXACTO del catálogo, así que
// esto normalmente calza directo. Igual se valida acá (nunca se confía en
// que el producto "exista" solo porque el modelo lo mencionó) con un
// fallback por substring para variaciones menores de tipeo/mayúsculas.
export async function findProductMatch(branchId: string, query: string): Promise<Product | null> {
  const products = await prisma.product.findMany({ where: { branchId, isActive: true } });
  const normalizedQuery = normalize(query);

  const exact = products.find((product) => normalize(product.name) === normalizedQuery);
  if (exact) return exact;

  const partial = products.find(
    (product) => normalize(product.name).includes(normalizedQuery) || normalizedQuery.includes(normalize(product.name)),
  );
  return partial ?? null;
}

// Productos "parecidos" para ofrecer como alternativa cuando el pedido
// menciona algo que no está en el catálogo (US "Armado del pedido").
export async function findSimilarProducts(branchId: string, query: string, limit = 3): Promise<Product[]> {
  const products = await prisma.product.findMany({ where: { branchId, isActive: true } });
  const queryTokens = new Set(normalize(query).split(/\s+/).filter(Boolean));

  const scored = products
    .map((product) => {
      const nameTokens = new Set(normalize(product.name).split(/\s+/).filter(Boolean));
      let overlap = 0;
      for (const token of queryTokens) if (nameTokens.has(token)) overlap += 1;
      return { product, overlap };
    })
    .filter((entry) => entry.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap);

  return scored.slice(0, limit).map((entry) => entry.product);
}
