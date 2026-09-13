import { ImageResponse } from "next/og";
import { formatCentsAsArs } from "@/lib/money";
import type { Product } from "@prisma/client";

const IMAGE_WIDTH = 1080;
const IMAGE_HEIGHT = 1350;

// Agrupa productos activos por categoría (o "Productos" si no tienen) y
// renderiza un afiche de catálogo como PNG. Es una render determinística de
// los datos reales del catálogo, no una imagen generada por un modelo de IA:
// así garantizamos que los precios que ve el cliente por WhatsApp son
// siempre los vigentes.
export async function renderCatalogImage(branchName: string, products: Product[]): Promise<Buffer> {
  const groups = new Map<string, Product[]>();
  for (const product of products) {
    const category = product.category?.trim() || "Productos";
    const list = groups.get(category) ?? [];
    list.push(product);
    groups.set(category, list);
  }

  const image = new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          backgroundColor: "#ffffff",
          padding: "56px",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", marginBottom: "36px" }}>
          <div style={{ fontSize: 52, fontWeight: 700, color: "#111827" }}>{branchName}</div>
          <div style={{ fontSize: 28, color: "#16a34a", marginTop: "4px" }}>Nuestro catálogo</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
          {[...groups.entries()].map(([category, items]) => (
            <div key={category} style={{ display: "flex", flexDirection: "column", marginBottom: "28px" }}>
              <div
                style={{
                  fontSize: 32,
                  fontWeight: 700,
                  color: "#16a34a",
                  marginBottom: "12px",
                  borderBottom: "2px solid #16a34a",
                  paddingBottom: "6px",
                }}
              >
                {category}
              </div>
              {items.map((product) => (
                <div
                  key={product.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 26,
                    color: "#1f2937",
                    marginBottom: "8px",
                  }}
                >
                  <div style={{ display: "flex" }}>{product.name}</div>
                  <div style={{ display: "flex", fontWeight: 700 }}>{formatCentsAsArs(product.priceCents)}</div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    ),
    { width: IMAGE_WIDTH, height: IMAGE_HEIGHT },
  );

  return Buffer.from(await image.arrayBuffer());
}
