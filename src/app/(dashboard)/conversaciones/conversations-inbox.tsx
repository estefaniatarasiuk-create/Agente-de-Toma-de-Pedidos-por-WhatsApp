"use client";

import { useEffect, useState } from "react";
import type { Conversation, ConversationStatus, Message } from "@prisma/client";
import { ConversationPanel } from "./conversation-panel";

export type ConversationWithPreview = Conversation & { messages: Message[] };

const STATUS_BADGE: Record<ConversationStatus, { label: string; className: string }> = {
  ACTIVE: { label: "IA activa", className: "bg-green-100 text-green-700" },
  REQUIRES_ATTENTION: { label: "Necesita atención", className: "bg-red-100 text-red-700" },
  AI_PAUSED: { label: "IA pausada", className: "bg-yellow-100 text-yellow-700" },
  CLOSED: { label: "Cerrada", className: "bg-gray-100 text-gray-500" },
};

const POLL_INTERVAL_MS = 8000;

export function ConversationsInbox({ initialConversations }: { initialConversations: ConversationWithPreview[] }) {
  const [conversations, setConversations] = useState(initialConversations);
  const [selectedId, setSelectedId] = useState<string | null>(initialConversations[0]?.id ?? null);

  async function refresh() {
    const response = await fetch("/api/conversaciones");
    const data = await response.json();
    setConversations(data.conversations);
  }

  // Actualización en vivo de la lista (previews y estados), no solo del
  // chat abierto — para ver llegar una conversación nueva sin recargar.
  useEffect(() => {
    const interval = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  // Las que necesitan atención van primero, después el resto por actividad reciente.
  const sorted = [...conversations].sort((a, b) => {
    if (a.status === "REQUIRES_ATTENTION" && b.status !== "REQUIRES_ATTENTION") return -1;
    if (b.status === "REQUIRES_ATTENTION" && a.status !== "REQUIRES_ATTENTION") return 1;
    return new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime();
  });

  return (
    <div className="flex h-screen">
      <div className="flex w-80 shrink-0 flex-col border-r border-gray-200 bg-white">
        <div className="shrink-0 border-b border-gray-200 p-4">
          <h1 className="text-lg font-semibold text-gray-900">Conversaciones</h1>
        </div>
        <div className="flex-1 overflow-y-auto">
          {sorted.length === 0 ? (
            <p className="p-4 text-sm text-gray-500">Todavía no hay conversaciones.</p>
          ) : (
            sorted.map((conversation) => {
              const badge = STATUS_BADGE[conversation.status];
              const lastMessage = conversation.messages[0];
              return (
                <button
                  key={conversation.id}
                  onClick={() => setSelectedId(conversation.id)}
                  className={`w-full border-b border-gray-100 p-3 text-left hover:bg-gray-50 ${
                    selectedId === conversation.id ? "bg-green-50" : ""
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-900">
                      {conversation.customerName || conversation.customerPhone}
                    </span>
                    <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${badge.className}`}>
                      {badge.label}
                    </span>
                  </div>
                  {lastMessage && (
                    <p className="mt-1 truncate text-xs text-gray-500">
                      {lastMessage.textContent || lastMessage.transcription || `[${lastMessage.messageType.toLowerCase()}]`}
                    </p>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>

      <div className="flex-1">
        {selectedId ? (
          <ConversationPanel key={selectedId} conversationId={selectedId} onChanged={refresh} />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-gray-400">
            Elegí una conversación de la lista.
          </div>
        )}
      </div>
    </div>
  );
}
