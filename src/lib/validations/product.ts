import { z } from "zod";

export const productSchema = z.object({
  name: z.string().trim().min(1, "El nombre es obligatorio.").max(200),
  description: z.string().trim().max(1000).optional().or(z.literal("")),
  priceCents: z.number().int().nonnegative("El precio no puede ser negativo."),
  category: z.string().trim().max(100).optional().or(z.literal("")),
});

export type ProductInput = z.infer<typeof productSchema>;

// Producto tal como lo devuelve la IA (o una fila de Excel) antes de
// confirmarse: precio en pesos (no en centavos) para que sea legible al
// revisar/editar en pantalla.
export const draftProductSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().optional().default(""),
  price: z.number().nonnegative(),
  category: z.string().trim().optional().default(""),
});

export const draftCatalogSchema = z.array(draftProductSchema).max(500);

export type DraftProduct = z.infer<typeof draftProductSchema>;

// Precio en pesos con coma decimal (ej: "1234,50" o "1234.50") -> centavos.
export function parsePriceToCents(rawPrice: string | number): number | null {
  if (typeof rawPrice === "number") {
    if (!Number.isFinite(rawPrice) || rawPrice < 0) return null;
    return Math.round(rawPrice * 100);
  }
  const normalized = rawPrice.trim().replace(/\./g, "").replace(",", ".");
  const value = Number(normalized);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}
