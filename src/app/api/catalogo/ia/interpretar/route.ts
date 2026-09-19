import { NextResponse } from "next/server";
import { requireBranchContext } from "@/lib/branch-context";
import { runAiTask } from "@/lib/ai/run-ai-task";
import { extractJsonBlock } from "@/lib/ai/provider";
import { draftCatalogSchema } from "@/lib/validations/product";

const SYSTEM_PROMPT = `Sos un asistente que extrae el listado de productos de un menú o catálogo de
comida a partir de texto o de una foto del menú.

Devolvé ÚNICAMENTE un JSON array (sin explicación, sin markdown) de objetos con estas claves:
- name: nombre del producto (string)
- description: descripción breve si existe, si no ""
- price: precio en pesos argentinos como número (ej: 4500.50), sin símbolo $ ni separador de miles
- category: categoría o sección del menú si existe, si no ""

Reglas:
- No inventes productos que no estén en el texto o la imagen.
- Si el precio de un producto no se puede leer con claridad, omitilo del array (no inventes precios).
- Si hay productos repetidos, incluilos una sola vez.`;

export async function POST(request: Request) {
  const context = await requireBranchContext();
  if (!context) return NextResponse.json({ error: "No autorizado." }, { status: 401 });

  const body = await request.json().catch(() => null);
  const text: string | undefined = body?.text;
  const imageBase64: string | undefined = body?.imageBase64;
  const imageMimeType: string | undefined = body?.imageMimeType;

  if (!text && !imageBase64) {
    return NextResponse.json({ error: "Pegá el texto del menú o subí una foto." }, { status: 400 });
  }

  try {
    const result = await runAiTask({
      purpose: "CATALOG_IMPORT",
      companyId: context.companyId,
      branchId: context.branchId,
      system: SYSTEM_PROMPT,
      maxTokens: 4000,
      jsonMode: true,
      messages: [
        {
          role: "user",
          text: text || "Extraé los productos de la imagen del menú adjunta.",
          imageBase64,
          imageMimeType,
        },
      ],
    });

    const parsed = draftCatalogSchema.safeParse(JSON.parse(extractJsonBlock(result.text)));
    if (!parsed.success || parsed.data.length === 0) {
      return NextResponse.json(
        { error: "No pudimos interpretar productos en ese texto/imagen. Probá con otro." },
        { status: 422 },
      );
    }

    return NextResponse.json({ products: parsed.data, usage: result.usage });
  } catch (error) {
    console.error("Error interpretando catálogo con IA:", error);
    return NextResponse.json({ error: "No pudimos procesar el pedido con la IA. Probá de nuevo." }, { status: 502 });
  }
}
