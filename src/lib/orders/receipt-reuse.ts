import { prisma } from "@/lib/prisma";

const RECENT_RECEIPT_WINDOW_MINUTES = 30;

// Busca un comprobante (imagen o PDF) que el cliente ya mandó por esta
// conversación recientemente, para el caso de que lo haya mandado ANTES de
// escribir la confirmación final en texto (ver el bug real en engine.ts:
// el archivo queda guardado en la conversación, pero en ese momento
// todavía no existe ningún pedido al que adjuntarlo).
//
// Nunca devuelve un archivo que ya sea el receiptUrl de OTRO pedido — esto
// es lo que evita que, si el cliente hace dos pedidos separados dentro de
// la misma ventana de 30 minutos y solo manda un comprobante para el
// primero, el segundo quede marcado como "ya pagado" sin que haya mandado
// nada nuevo para ESE pedido.
export async function findReusableReceiptMediaUrl(params: {
  conversationId: string;
  branchId: string;
}): Promise<string | null> {
  const recentReceiptMessage = await prisma.message.findFirst({
    where: {
      conversationId: params.conversationId,
      direction: "INBOUND",
      messageType: { in: ["IMAGE", "DOCUMENT"] },
      mediaUrl: { not: null },
      createdAt: { gte: new Date(Date.now() - RECENT_RECEIPT_WINDOW_MINUTES * 60_000) },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!recentReceiptMessage?.mediaUrl) return null;

  const alreadyUsedElsewhere = await prisma.order.findFirst({
    where: { branchId: params.branchId, receiptUrl: recentReceiptMessage.mediaUrl },
  });
  if (alreadyUsedElsewhere) return null;

  return recentReceiptMessage.mediaUrl;
}
