"use client";

import { useEffect, useRef, useState } from "react";
import type { Conversation, ConversationStatus, Message, Order } from "@prisma/client";
import { isImageFileUrl } from "@/lib/media-url";

type MessageWithSender = Message & { sentByUser: { name: string } | null };
type ConversationDetail = Conversation & { messages: MessageWithSender[]; orders: Order[] };

const STATUS_BADGE: Record<ConversationStatus, { label: string; className: string }> = {
  ACTIVE: { label: "IA activa", className: "bg-green-100 text-green-700" },
  REQUIRES_ATTENTION: { label: "Necesita atención", className: "bg-red-100 text-red-700" },
  AI_PAUSED: { label: "IA pausada", className: "bg-yellow-100 text-yellow-700" },
  CLOSED: { label: "Cerrada", className: "bg-gray-100 text-gray-600" },
};

const CHAT_POLL_INTERVAL_MS = 4000;

function messageLabel(message: MessageWithSender): string {
  if (message.textContent) return message.textContent;
  if (message.transcription) return `🎤 ${message.transcription}`;
  if (message.messageType === "IMAGE") return "[imagen]";
  if (message.messageType === "DOCUMENT") return "[documento]";
  return `[${message.messageType.toLowerCase()}]`;
}

// Bug real reportado: una imagen o PDF que mandaba el cliente (ej. un
// comprobante reenviado a pedido del local) se mostraba en el chat como el
// texto "[imagen]"/"[documento]", sin ninguna forma de abrirlo — no había
// cómo verlo. Se muestra la vista previa (imagen) o un enlace para abrirlo
// (PDF) en vez del placeholder de texto.
function MessageAttachment({ mediaUrl, isOutbound }: { mediaUrl: string; isOutbound: boolean }) {
  if (isImageFileUrl(mediaUrl)) {
    return (
      <a href={`/api/uploads/${mediaUrl}`} target="_blank" rel="noopener noreferrer">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`/api/uploads/${mediaUrl}`} alt="Adjunto" className="max-h-48 rounded-md" />
      </a>
    );
  }
  return (
    <a
      href={`/api/uploads/${mediaUrl}`}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-block underline ${isOutbound ? "text-white" : "text-green-700"}`}
    >
      Ver documento (PDF)
    </a>
  );
}

export function ConversationPanel({ conversationId, onChanged }: { conversationId: string; onChanged: () => void }) {
  const [conversation, setConversation] = useState<ConversationDetail | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  async function load() {
    const response = await fetch(`/api/conversaciones/${conversationId}`);
    const data = await response.json();
    if (response.ok) setConversation(data.conversation);
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- carga inicial por id, no hay forma de evitar el setState acá
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  // Sondeo del chat abierto: si el cliente escribe mientras estás mirando
  // esta conversación, tiene que aparecer solo, sin recargar la página.
  useEffect(() => {
    const interval = setInterval(load, CHAT_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [conversation?.messages.length]);

  async function setStatus(status: ConversationStatus) {
    await fetch(`/api/conversaciones/${conversationId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    await load();
    onChanged();
  }

  async function handleSend() {
    if (!draft.trim()) return;
    setSending(true);
    setError(null);
    const response = await fetch(`/api/conversaciones/${conversationId}/mensajes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: draft.trim() }),
    });
    const data = await response.json();
    setSending(false);
    if (!response.ok) {
      setError(data.error ?? "No se pudo mandar el mensaje.");
      return;
    }
    setDraft("");
    await load();
    onChanged();
  }

  if (!conversation) {
    return <div className="p-6 text-sm text-gray-600">Cargando...</div>;
  }

  const badge = STATUS_BADGE[conversation.status];
  const activeOrder = conversation.orders.find((order) =>
    ["WAITING_RECEIPT", "PENDING", "PREPARING", "ON_THE_WAY"].includes(order.status),
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-gray-200 p-4">
        <div>
          <h2 className="text-base font-semibold text-gray-900">
            {conversation.customerName || conversation.customerPhone}
          </h2>
          <p className="text-xs text-gray-600">{conversation.customerPhone}</p>
          {activeOrder && <p className="text-xs text-gray-600">Pedido activo: {activeOrder.id.slice(-6)}</p>}
        </div>
        <div className="flex items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}>{badge.label}</span>
          {conversation.status === "REQUIRES_ATTENTION" && (
            <button
              onClick={() => setStatus("ACTIVE")}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
            >
              Marcar resuelta (devolver a la IA)
            </button>
          )}
          {conversation.status === "ACTIVE" && (
            <button
              onClick={() => setStatus("AI_PAUSED")}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
            >
              Pausar IA
            </button>
          )}
          {conversation.status === "AI_PAUSED" && (
            <button
              onClick={() => setStatus("ACTIVE")}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
            >
              Reactivar IA
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto bg-gray-50 p-4">
        {conversation.messages.map((message) => {
          const isOutbound = message.direction === "OUTBOUND";
          const mediaUrl = message.mediaUrl;
          const showsAttachment = Boolean(mediaUrl) && (message.messageType === "IMAGE" || message.messageType === "DOCUMENT");
          return (
            <div key={message.id} className={`flex ${isOutbound ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[70%] rounded-lg px-3 py-2 text-sm ${
                  isOutbound ? "bg-green-600 text-white" : "bg-white text-gray-800 shadow-sm"
                }`}
              >
                {showsAttachment && mediaUrl && <MessageAttachment mediaUrl={mediaUrl} isOutbound={isOutbound} />}
                {message.textContent ? (
                  <p className={`whitespace-pre-wrap ${showsAttachment ? "mt-1" : ""}`}>{message.textContent}</p>
                ) : !showsAttachment ? (
                  <p className="whitespace-pre-wrap">{messageLabel(message)}</p>
                ) : null}
                <p className={`mt-1 text-[10px] ${isOutbound ? "text-green-100" : "text-gray-500"}`}>
                  {new Date(message.createdAt).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}
                  {message.sentByUser ? ` · ${message.sentByUser.name}` : isOutbound ? " · IA" : ""}
                </p>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <div className="shrink-0 border-t border-gray-200 p-3">
        {error && <p className="mb-2 text-xs text-red-600">{error}</p>}
        <div className="flex gap-2">
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                handleSend();
              }
            }}
            placeholder="Escribí un mensaje como si fueras el local..."
            className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-green-500 focus:outline-none"
          />
          <button
            onClick={handleSend}
            disabled={sending || !draft.trim()}
            className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
          >
            Mandar
          </button>
        </div>
      </div>
    </div>
  );
}
