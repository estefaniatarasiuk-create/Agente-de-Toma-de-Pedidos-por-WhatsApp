import "dotenv/config";
import { createHmac, randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";

// Meta solo entrega webhooks de mensajes REALES a apps ya publicadas — en
// desarrollo, únicamente manda los payloads de prueba que uno mismo dispara
// desde el botón "Test" del dashboard (spec de la plataforma, no un bug
// nuestro). Este script arma un payload con la misma forma y lo manda
// directo a nuestro propio webhook, firmado igual que lo firmaría Meta, para
// poder probar el motor de pedidos de punta a punta sin esa restricción. El
// envío de la respuesta SÍ es real (Graph API), así que la contestación de
// la IA llega de verdad al WhatsApp de `--from`.
//
// Uso:
//   npx tsx scripts/simulate-inbound-whatsapp.ts --from 5491122334455 --text "Hola"
//   npx tsx scripts/simulate-inbound-whatsapp.ts --from 5491122334455 --text "prueba" --url http://localhost:3000

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
  const { from, text, url } = parseArgs();
  if (!from || !text) {
    console.error('Uso: npx tsx scripts/simulate-inbound-whatsapp.ts --from <telefono> --text "<mensaje>" [--url http://localhost:3000]');
    process.exit(1);
  }

  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) throw new Error("Falta META_APP_SECRET en el .env.");

  const line = await prisma.whatsAppLine.findFirst({ where: { status: "ACTIVE" } });
  if (!line?.phoneNumberId) {
    throw new Error("No hay ninguna línea de WhatsApp ACTIVA en la base. Vinculá una desde /whatsapp primero.");
  }

  const payload = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: line.wabaId ?? "0",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: from, phone_number_id: line.phoneNumberId },
              contacts: [{ profile: { name: "Cliente de prueba" }, wa_id: from }],
              messages: [
                {
                  id: `simulado-${randomUUID()}`,
                  from,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  };

  const rawBody = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex")}`;
  const baseUrl = url ?? "http://localhost:3000";

  console.log(`Mandando mensaje simulado de ${from} a phone_number_id ${line.phoneNumberId}...`);

  const response = await fetch(`${baseUrl}/api/webhooks/whatsapp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signature },
    body: rawBody,
  });

  console.log("Respuesta del webhook:", response.status, await response.text());
  console.log("Si todo salió bien, la respuesta de la IA debería llegarte por WhatsApp en unos segundos.");

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
