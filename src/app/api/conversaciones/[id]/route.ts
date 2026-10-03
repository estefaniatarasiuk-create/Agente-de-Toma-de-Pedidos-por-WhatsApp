import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireBranchContext } from "@/lib/branch-context";
import { conversationStatusSchema } from "@/lib/validations/order-actions";
import { shouldClearDraftOnHandoverToAI } from "@/lib/orders/draft-step";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await requireBranchContext();
  if (!context) return NextResponse.json({ error: "No autorizado." }, { status: 401 });

  const { id } = await params;
  const conversation = await prisma.conversation.findFirst({
    where: { id, branchId: context.branchId },
    include: {
      messages: { orderBy: { createdAt: "asc" }, include: { sentByUser: { select: { name: true } } } },
      orders: { orderBy: { createdAt: "desc" }, take: 5 },
    },
  });
  if (!conversation) return NextResponse.json({ error: "Conversación no encontrada." }, { status: 404 });

  return NextResponse.json({ conversation });
}

// Pausar/reactivar la IA, o marcar una conversación como resuelta (vuelve a
// ACTIVE) — el mecanismo de "devolverle el control a un humano" que hasta
// ahora solo existía tocando la base a mano (spec: IA vs. humano, §4.3).
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await requireBranchContext();
  if (!context) return NextResponse.json({ error: "No autorizado." }, { status: 401 });

  const { id } = await params;
  const body = await request.json().catch(() => null);
  const parsed = conversationStatusSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Datos inválidos." }, { status: 400 });
  }

  const conversation = await prisma.conversation.findFirst({ where: { id, branchId: context.branchId } });
  if (!conversation) return NextResponse.json({ error: "Conversación no encontrada." }, { status: 404 });

  // Al devolverle el control a la IA (desde "necesita atención" o desde
  // "pausada" — ej. alguien usó "Hablar con el cliente" y después
  // "Reactivar IA"), se limpia cualquier borrador que hubiera quedado.
  // Normalmente ya está vacío (engine.ts lo limpia al escalar), salvo en
  // el caso de un pedido adicional pendiente de sumar a mano (ver
  // apply-actions.ts: ahí SÍ se preserva a propósito para que el panel lo
  // muestre) — o, en "pausada", cualquier cosa que haya quedado mientras
  // una persona charlaba directo con el cliente, que la IA no puede saber
  // si sigue siendo válida. Bug real reportado: sin esto, un borrador
  // abandonado durante una pausa (AI_PAUSED → ACTIVE, que antes NO
  // limpiaba nada) resucitaba solo en el próximo pedido sin relación que
  // armara la IA, sumando productos que el cliente nunca pidió.
  const isResolving = shouldClearDraftOnHandoverToAI(conversation.status, parsed.data.status);

  const updated = await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      status: parsed.data.status,
      ...(isResolving ? { draftOrder: { items: [] }, currentStep: null } : {}),
    },
  });

  return NextResponse.json({ conversation: updated });
}
