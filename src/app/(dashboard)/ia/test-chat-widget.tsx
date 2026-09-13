"use client";

import { useState } from "react";

type ChatMessage = { role: "user" | "assistant"; text: string };

export function TestChatWidget() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSend(event: React.FormEvent) {
    event.preventDefault();
    if (!draft.trim() || isSending) return;

    const nextMessages: ChatMessage[] = [...messages, { role: "user", text: draft.trim() }];
    setMessages(nextMessages);
    setDraft("");
    setError(null);
    setIsSending(true);

    try {
      const response = await fetch("/api/ia/probar-conversacion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: nextMessages }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? "No pudimos generar la respuesta.");
        return;
      }
      setMessages((current) => [...current, { role: "assistant", text: data.reply }]);
    } catch {
      setError("Ocurrió un error inesperado.");
    } finally {
      setIsSending(false);
    }
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6">
      <h3 className="text-sm font-semibold text-gray-900">Probar conversación</h3>
      <p className="mt-1 text-sm text-gray-500">
        Simulá un chat con tu configuración vigente. No se registra ningún pedido real.
      </p>

      <div className="mt-4 h-80 overflow-y-auto rounded-md border border-gray-100 bg-gray-50 p-3 space-y-2">
        {messages.length === 0 && (
          <p className="text-sm text-gray-400">Escribí un mensaje como si fueras un cliente por WhatsApp.</p>
        )}
        {messages.map((message, index) => (
          <div key={index} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                message.role === "user" ? "bg-green-600 text-white" : "bg-white border border-gray-200 text-gray-800"
              }`}
            >
              {message.text}
            </div>
          </div>
        ))}
      </div>

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      <form onSubmit={handleSend} className="mt-3 flex gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Hola, quería hacer un pedido..."
          className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-green-600 focus:outline-none focus:ring-1 focus:ring-green-600"
        />
        <button
          type="submit"
          disabled={isSending}
          className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-60"
        >
          {isSending ? "..." : "Enviar"}
        </button>
      </form>
    </div>
  );
}
