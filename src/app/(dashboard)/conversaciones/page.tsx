import { prisma } from "@/lib/prisma";
import { requireBranchContext } from "@/lib/branch-context";
import { ConversationsInbox } from "./conversations-inbox";

export default async function ConversacionesPage() {
  const context = await requireBranchContext();

  const conversations = context
    ? await prisma.conversation.findMany({
        where: { branchId: context.branchId },
        orderBy: { lastMessageAt: "desc" },
        take: 200,
        include: { messages: { orderBy: { createdAt: "desc" }, take: 1 } },
      })
    : [];

  return <ConversationsInbox initialConversations={conversations} />;
}
