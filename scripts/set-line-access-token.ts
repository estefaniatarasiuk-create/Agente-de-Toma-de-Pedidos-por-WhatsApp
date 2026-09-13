import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { encryptSecret } from "@/lib/crypto";

// Carga (cifrado, igual que el flujo normal de Embedded Signup) el access
// token de una línea de WhatsApp ya existente en la base. Pensado para
// pruebas locales con el número de prueba que da Meta (Meta App Dashboard →
// WhatsApp → Configuración básica → "Identificador de acceso" → "Generar
// identificador"), donde no se pasa por el flujo de vinculación real.
//
// Uso:
//   npx tsx scripts/set-line-access-token.ts --phoneNumberId 1217966778076054 --token EAAxxxxx...

function parseArgs() {
  const args = process.argv.slice(2);
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, "");
    const value = args[i + 1];
    if (key && value !== undefined) result[key] = value;
  }
  return result;
}

async function main() {
  const { phoneNumberId, token } = parseArgs();
  if (!phoneNumberId || !token) {
    console.error("Uso: npx tsx scripts/set-line-access-token.ts --phoneNumberId <id> --token <token>");
    process.exit(1);
  }

  const line = await prisma.whatsAppLine.findUnique({ where: { phoneNumberId } });
  if (!line) {
    console.error(`No hay ninguna WhatsAppLine con phoneNumberId=${phoneNumberId} en la base.`);
    process.exit(1);
  }

  await prisma.whatsAppLine.update({
    where: { id: line.id },
    data: { accessTokenEncrypted: encryptSecret(token), status: "ACTIVE" },
  });

  console.log(`Token guardado (cifrado) para la línea ${line.id} (${phoneNumberId}).`);
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
