import type { WhatsAppLine } from "@prisma/client";

export type SafeWhatsAppLine = Omit<WhatsAppLine, "accessTokenEncrypted" | "twoStepPinEncrypted">;

// Nunca mandamos los secretos cifrados de la línea al cliente.
export function toSafeLine(line: WhatsAppLine): SafeWhatsAppLine {
  const { accessTokenEncrypted, twoStepPinEncrypted, ...safeLine } = line;
  void accessTokenEncrypted;
  void twoStepPinEncrypted;
  return safeLine;
}
