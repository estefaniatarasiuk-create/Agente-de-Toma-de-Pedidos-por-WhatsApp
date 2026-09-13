import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Cifra en reposo los tokens de larga vida de Meta (access token de la línea
// de WhatsApp, PIN de verificación en dos pasos) con AES-256-GCM.
// TOKEN_ENCRYPTION_KEY tiene que ser 32 bytes en hex (openssl rand -hex 32).
function getKey(): Buffer {
  const hex = process.env.TOKEN_ENCRYPTION_KEY;
  if (!hex) throw new Error("Falta TOKEN_ENCRYPTION_KEY.");
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY debe ser una cadena hex de 32 bytes (64 caracteres).");
  }
  return key;
}

// Formato guardado: iv(12) + authTag(16) + ciphertext, todo en base64.
export function encryptSecret(plainText: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

export function decryptSecret(encoded: string): string {
  const key = getKey();
  const raw = Buffer.from(encoded, "base64");
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
