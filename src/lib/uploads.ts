import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// Los archivos subidos (fotos de menú, catálogo, comprobantes) se guardan en
// disco bajo UPLOADS_DIR, que en docker-compose es un volumen dedicado (no
// vive dentro de /app/public: eso se hornea en la imagen y no persiste).
const UPLOADS_DIR = process.env.UPLOADS_DIR ?? path.join(process.cwd(), "uploads");

const EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

export function isSupportedUploadMimeType(mimeType: string): boolean {
  return mimeType in EXTENSION_BY_MIME_TYPE;
}

// Guarda un archivo subido dentro de una subcarpeta (ej: "catalogo",
// "comprobantes") y devuelve la ruta relativa a servir vía /api/uploads/.
export async function saveUploadedFile(params: {
  subdir: string;
  buffer: Buffer;
  mimeType: string;
}): Promise<string> {
  const extension = EXTENSION_BY_MIME_TYPE[params.mimeType];
  if (!extension) {
    throw new Error(`Tipo de archivo no soportado: ${params.mimeType}`);
  }

  // UPLOADS_DIR es un volumen en runtime, no una carpeta del código fuente:
  // se ignora a propósito del tracing de Next.js (si no, empaqueta todo el
  // proyecto en el build por no poder resolver la ruta de forma estática).
  const dir = path.join(/* turbopackIgnore: true */ UPLOADS_DIR, params.subdir);
  await mkdir(dir, { recursive: true });

  const fileName = `${randomUUID()}.${extension}`;
  await writeFile(path.join(/* turbopackIgnore: true */ dir, fileName), params.buffer);

  return `${params.subdir}/${fileName}`;
}

export function resolveUploadPath(relativePath: string): string {
  return path.join(/* turbopackIgnore: true */ UPLOADS_DIR, relativePath);
}

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  pdf: "application/pdf",
};

export function guessContentType(filePath: string): string {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  return CONTENT_TYPE_BY_EXTENSION[extension] ?? "application/octet-stream";
}
