import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireBranchContext } from "@/lib/branch-context";
import { sendMessageSchema } from "@/lib/validations/order-actions";
import { sendOutboundText } from "@/lib/whatsapp/outbound";

// Mensaje manual mandado por una persona desde la bandeja en vivo (Fase 4),
// no por la IA. No cambia el estado de la conversación por su cuenta: si
// alguien quiere tomar la conversación por completo, pausa la IA aparte.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await requireBranchContext();
  if (!context) return NextResponse.json({ error: "No autorizado." }, { status: 401 });

  const { id } = await params;
  const body = await request.json().catch(() => null);
  const parsed = sendMessageSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Datos inválidos." }, { status: 400 });
  }

  const conversation = await prisma.conversation.findFirst({
    where: { id, branchId: context.branchId },
    include: { branch: { include: { whatsappLine: true } } },
  });
  if (!conversation) return NextResponse.json({ error: "Conversación no encontrada." }, { status: 404 });

  const result = await sendOutboundText({
    companyId: conversation.companyId,
    branchId: conversation.branchId,
    conversationId: conversation.id,
    customerPhone: conversation.customerPhone,
    line: conversation.branch.whatsappLine,
    text: parsed.data.text,
    sentByUserId: context.userId,
  });

  if (!result.sent) {
    return NextResponse.json(
      { error: "El mensaje quedó guardado, pero no se pudo mandar por WhatsApp (revisá la línea vinculada)." },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true });
}
