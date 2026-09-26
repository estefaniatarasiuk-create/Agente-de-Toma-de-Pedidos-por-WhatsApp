import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireBranchContext } from "@/lib/branch-context";
import { conversationStatusSchema } from "@/lib/validations/order-actions";

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

  // Al resolver una conversación que necesitaba atención, se limpia
  // cualquier borrador que hubiera quedado (normalmente ya está vacío —
  // engine.ts lo limpia al escalar — salvo en el caso de un pedido
  // adicional pendiente de sumar a mano, ver apply-actions.ts: ahí SÍ se
  // preserva a propósito para que el panel lo muestre). Si no se limpiara
  // acá, esos ítems ya sumados a mano podrían resucitar solos en el
  // próximo pedido que arme la IA.
  const isResolving = conversation.status === "REQUIRES_ATTENTION" && parsed.data.status === "ACTIVE";

  const updated = await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      status: parsed.data.status,
      ...(isResolving ? { draftOrder: { items: [] }, currentStep: null } : {}),
    },
  });

  return NextResponse.json({ conversation: updated });
}
