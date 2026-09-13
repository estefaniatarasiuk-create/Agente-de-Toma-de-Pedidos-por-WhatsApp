import { prisma } from "@/lib/prisma";
import { requireBranchContext } from "@/lib/branch-context";
import { toSafeLine } from "@/lib/whatsapp/safe-line";
import { WhatsAppConnection } from "./whatsapp-connection";

export default async function WhatsAppPage() {
  const context = await requireBranchContext();
  const line = context
    ? await prisma.whatsAppLine.findUnique({ where: { branchId: context.branchId } })
    : null;

  return <WhatsAppConnection initialLine={line ? toSafeLine(line) : null} />;
}
