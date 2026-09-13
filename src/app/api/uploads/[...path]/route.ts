import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { auth } from "@/lib/auth";
import { guessContentType, resolveUploadPath } from "@/lib/uploads";

// Sirve archivos subidos (fotos de catálogo, comprobantes) detrás de sesión.
// No son públicos: solo un usuario logueado de la plataforma puede leerlos.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 });
  }

  const { path: segments } = await params;
  const relativePath = segments.join("/");
  const uploadsRoot = resolveUploadPath("");
  const absolutePath = path.resolve(resolveUploadPath(relativePath));

  if (!absolutePath.startsWith(path.resolve(uploadsRoot))) {
    return NextResponse.json({ error: "Ruta inválida." }, { status: 400 });
  }

  try {
    const fileBuffer = await readFile(absolutePath);
    return new NextResponse(new Uint8Array(fileBuffer), {
      headers: {
        "Content-Type": guessContentType(absolutePath),
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch {
    return NextResponse.json({ error: "Archivo no encontrado." }, { status: 404 });
  }
}
