// Cada mensaje entrante de WhatsApp llega como un POST de webhook aparte —
// si el cliente manda dos mensajes seguidos muy rápido (algo común: "una
// torta de ricota" y, un segundo después, "hay?" como mensaje aparte), Next
// puede llegar a procesar los dos webhooks en paralelo. Sin este lock, el
// segundo turno podía leer el borrador ANTES de que el primero terminara de
// guardar el suyo, actuando sobre un estado desactualizado — bug real
// reportado: un producto recién agregado (activo en el catálogo) el
// segundo mensaje lo daba por "no disponible", una respuesta inventada de
// la IA sin ninguna razón real detrás.
//
// Esto serializa el procesamiento por conversación DENTRO de este proceso
// de Node — alcanza para el despliegue actual (un solo contenedor "app").
// Si en el futuro se corre más de una instancia de la app en simultáneo,
// esto habría que reemplazarlo por un lock a nivel base de datos (ej.
// advisory lock de Postgres).
const queues = new Map<string, Promise<unknown>>();

export function withConversationLock<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(conversationId) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  queues.set(conversationId, run.catch(() => {}));
  return run;
}
