const GRAPH_API_VERSION = process.env.META_GRAPH_API_VERSION || "v21.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

export class GraphApiError extends Error {
  constructor(
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "GraphApiError";
  }
}

async function graphFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${GRAPH_API_BASE}${path}`, init);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = (data as { error?: { message?: string } })?.error?.message ?? `Error ${response.status}`;
    throw new GraphApiError(message, data);
  }
  return data as T;
}

function requireAppCredentials() {
  const appId = process.env.NEXT_PUBLIC_META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId) throw new Error("Falta NEXT_PUBLIC_META_APP_ID.");
  if (!appSecret) throw new Error("Falta META_APP_SECRET.");
  return { appId, appSecret };
}

// Intercambia el "code" que devuelve el Embedded Signup (FB.login) por un
// access token de la línea. El access token de este intercambio ya es de
// larga duración para tokens de Business Login del Embedded Signup.
export async function exchangeCodeForAccessToken(code: string): Promise<string> {
  const { appId, appSecret } = requireAppCredentials();
  const params = new URLSearchParams({
    client_id: appId,
    client_secret: appSecret,
    code,
  });
  const data = await graphFetch<{ access_token: string }>(`/oauth/access_token?${params.toString()}`);
  return data.access_token;
}

// Suscribe nuestra app a los webhooks de esa WhatsApp Business Account
// (si no, Meta no nos manda los mensajes entrantes de sus números).
export async function subscribeAppToWaba(wabaId: string, accessToken: string): Promise<void> {
  await graphFetch(`/${wabaId}/subscribed_apps`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

export async function getPhoneNumberDetails(
  phoneNumberId: string,
  accessToken: string,
): Promise<{ displayPhoneNumber: string; verifiedName: string }> {
  const data = await graphFetch<{ display_phone_number: string; verified_name: string }>(
    `/${phoneNumberId}?fields=display_phone_number,verified_name`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  return { displayPhoneNumber: data.display_phone_number, verifiedName: data.verified_name };
}

// Habilita el número para mandar/recibir mensajes por la Cloud API (paso
// obligatorio del Embedded Signup). El PIN es de 6 dígitos, lo generamos
// nosotros y lo guardamos cifrado por si Meta lo vuelve a pedir más adelante
// (recuperación de verificación en dos pasos del número).
export async function registerPhoneNumber(
  phoneNumberId: string,
  accessToken: string,
  pin: string,
): Promise<void> {
  await graphFetch(`/${phoneNumberId}/register`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messaging_product: "whatsapp", pin }),
  });
}

export function generateTwoStepPin(): string {
  const value = Math.floor(Math.random() * 1_000_000);
  return value.toString().padStart(6, "0");
}

// Descarga un archivo multimedia recibido por WhatsApp (imagen del
// comprobante, foto de menú, nota de voz): primero se pide la URL temporal
// con el media id, después se baja el archivo con el mismo access token.
export async function downloadWhatsAppMedia(
  mediaId: string,
  accessToken: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  const mediaInfo = await graphFetch<{ url: string; mime_type: string }>(`/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const fileResponse = await fetch(mediaInfo.url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!fileResponse.ok) {
    throw new GraphApiError(`No se pudo descargar el archivo multimedia (${fileResponse.status}).`);
  }

  const buffer = Buffer.from(await fileResponse.arrayBuffer());
  return { buffer, mimeType: mediaInfo.mime_type };
}
