import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireBranchContext } from "@/lib/branch-context";
import { encryptSecret } from "@/lib/crypto";
import { toSafeLine } from "@/lib/whatsapp/safe-line";
import {
  exchangeCodeForAccessToken,
  generateTwoStepPin,
  getPhoneNumberDetails,
  registerPhoneNumber,
  subscribeAppToWaba,
} from "@/lib/whatsapp/graph-api";

const bodySchema = z.object({
  code: z.string().min(1),
  phoneNumberId: z.string().min(1),
  wabaId: z.string().min(1),
  businessId: z.string().optional(),
});

// Completa el Embedded Signup: recibe el "code" de FB.login más los ids de
// número/WABA que llegaron por el evento WA_EMBEDDED_SIGNUP, y hace toda la
// cadena de llamadas a la Graph API para dejar la línea operativa.
export async function POST(request: Request) {
  const context = await requireBranchContext();
  if (!context) return NextResponse.json({ error: "No autorizado." }, { status: 401 });

  const body = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Datos de vinculación inválidos." }, { status: 400 });
  }
  const { code, phoneNumberId, wabaId, businessId } = parsed.data;

  // Otra sucursal ya usa este número: evita pisar una línea ajena.
  const existingWithPhone = await prisma.whatsAppLine.findFirst({
    where: { phoneNumberId, NOT: { branchId: context.branchId } },
  });
  if (existingWithPhone) {
    return NextResponse.json(
      { error: "Ese número de WhatsApp ya está vinculado a otra cuenta." },
      { status: 409 },
    );
  }

  try {
    const accessToken = await exchangeCodeForAccessToken(code);
    await subscribeAppToWaba(wabaId, accessToken);
    const { displayPhoneNumber, verifiedName } = await getPhoneNumberDetails(phoneNumberId, accessToken);

    const pin = generateTwoStepPin();
    await registerPhoneNumber(phoneNumberId, accessToken, pin);

    const line = await prisma.whatsAppLine.upsert({
      where: { branchId: context.branchId },
      create: {
        companyId: context.companyId,
        branchId: context.branchId,
        status: "ACTIVE",
        phoneNumberId,
        wabaId,
        businessAccountId: businessId ?? null,
        displayPhoneNumber,
        verifiedName,
        accessTokenEncrypted: encryptSecret(accessToken),
        twoStepPinEncrypted: encryptSecret(pin),
        connectedAt: new Date(),
        lastErrorMessage: null,
      },
      update: {
        status: "ACTIVE",
        phoneNumberId,
        wabaId,
        businessAccountId: businessId ?? null,
        displayPhoneNumber,
        verifiedName,
        accessTokenEncrypted: encryptSecret(accessToken),
        twoStepPinEncrypted: encryptSecret(pin),
        connectedAt: new Date(),
        lastErrorMessage: null,
      },
    });

    return NextResponse.json({ line: toSafeLine(line) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido vinculando la línea.";
    console.error("Error vinculando línea de WhatsApp:", error);

    await prisma.whatsAppLine.upsert({
      where: { branchId: context.branchId },
      create: {
        companyId: context.companyId,
        branchId: context.branchId,
        status: "ERROR",
        phoneNumberId,
        wabaId,
        lastErrorMessage: message,
      },
      update: { status: "ERROR", lastErrorMessage: message },
    });

    return NextResponse.json({ error: `No pudimos vincular la línea: ${message}` }, { status: 502 });
  }
}
