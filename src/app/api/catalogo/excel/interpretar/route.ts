import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { requireBranchContext } from "@/lib/branch-context";
import { parsePriceToCents } from "@/lib/validations/product";

const COLUMN_ALIASES: Record<"name" | "description" | "price" | "category", string[]> = {
  name: ["nombre", "producto", "item", "articulo", "artículo"],
  description: ["descripcion", "descripción", "detalle"],
  price: ["precio", "valor"],
  category: ["categoria", "categoría", "seccion", "sección", "rubro"],
};

function normalizeHeader(header: unknown): string {
  return String(header ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
}

function findColumnIndex(headers: string[], aliases: string[]): number {
  return headers.findIndex((header) => aliases.includes(header));
}

export type ExcelPreviewRow = {
  rowNumber: number;
  name: string;
  description: string;
  price: number | null;
  category: string;
  error: string | null;
};

export async function POST(request: Request) {
  const context = await requireBranchContext();
  if (!context) return NextResponse.json({ error: "No autorizado." }, { status: 401 });

  const formData = await request.formData().catch(() => null);
  const file = formData?.get("file");
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: "Subí un archivo Excel (.xlsx)." }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    return NextResponse.json({ error: "El archivo no tiene hojas con datos." }, { status: 400 });
  }

  const rawRows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[firstSheetName], {
    header: 1,
    defval: "",
  });

  if (rawRows.length < 2) {
    return NextResponse.json({ error: "El archivo no tiene filas de productos." }, { status: 400 });
  }

  const headers = (rawRows[0] as unknown[]).map(normalizeHeader);
  const columnIndex = {
    name: findColumnIndex(headers, COLUMN_ALIASES.name),
    description: findColumnIndex(headers, COLUMN_ALIASES.description),
    price: findColumnIndex(headers, COLUMN_ALIASES.price),
    category: findColumnIndex(headers, COLUMN_ALIASES.category),
  };

  if (columnIndex.name === -1 || columnIndex.price === -1) {
    return NextResponse.json(
      { error: "El archivo tiene que tener al menos las columnas 'Nombre' y 'Precio'." },
      { status: 400 },
    );
  }

  const rows: ExcelPreviewRow[] = [];
  for (let i = 1; i < rawRows.length; i++) {
    const row = rawRows[i] as unknown[];
    const isEmptyRow = row.every((cell) => String(cell ?? "").trim() === "");
    if (isEmptyRow) continue;

    const name = String(row[columnIndex.name] ?? "").trim();
    const rawPrice = row[columnIndex.price];
    const priceCents =
      rawPrice === "" || rawPrice === undefined ? null : parsePriceToCents(rawPrice as string | number);

    let error: string | null = null;
    if (!name) error = "Falta el nombre.";
    else if (priceCents === null) error = "Precio inválido o vacío.";

    rows.push({
      rowNumber: i + 1,
      name,
      description: columnIndex.description === -1 ? "" : String(row[columnIndex.description] ?? "").trim(),
      price: priceCents === null ? null : priceCents / 100,
      category: columnIndex.category === -1 ? "" : String(row[columnIndex.category] ?? "").trim(),
      error,
    });
  }

  return NextResponse.json({ rows });
}
