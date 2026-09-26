// Los adjuntos que subimos solo pueden ser los tipos de src/lib/uploads.ts
// (imágenes jpg/png/webp, o PDF) — esto decide del lado del cliente si hay
// que mostrar una vista previa <img> o un enlace "Ver documento", sin
// depender de guardar el mime type aparte.
export function isImageFileUrl(url: string): boolean {
  return /\.(jpe?g|png|webp)$/i.test(url);
}
