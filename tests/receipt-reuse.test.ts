import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { findReusableReceiptMediaUrl } from "@/lib/orders/receipt-reuse";
import { createTestCompanyAndBranch, cleanupCompany } from "./fixtures";

// Regresión de un bug real: si el cliente manda el comprobante ANTES de
// escribir la confirmación final en texto, el archivo quedaba en la
// conversación sin ningún pedido al que adjuntarse (todavía no existía), y
// el sistema se lo volvía a pedir. Pregunta válida del usuario al ver el
// arreglo: "¿y si el cliente hace dos pedidos en poco tiempo, no se
// confundiría el comprobante de uno con el del otro?" — estos tests
// prueban que no.
describe("findReusableReceiptMediaUrl", () => {
  const companiesToCleanup: string[] = [];

  afterAll(async () => {
    for (const companyId of companiesToCleanup) await cleanupCompany(companyId);
  });

  it("devuelve el mediaUrl de la última imagen/documento entrante si no está usado en otro pedido", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    const conversation = await prisma.conversation.create({
      data: { companyId: company.id, branchId: branch.id, customerPhone: "5491100000030" },
    });
    await prisma.message.create({
      data: {
        companyId: company.id,
        branchId: branch.id,
        conversationId: conversation.id,
        direction: "INBOUND",
        messageType: "IMAGE",
        mediaUrl: "whatsapp/comprobante-1.jpg",
      },
    });

    const result = await findReusableReceiptMediaUrl({ conversationId: conversation.id, branchId: branch.id });
    expect(result).toBe("whatsapp/comprobante-1.jpg");
  });

  it("no reutiliza un comprobante que ya está adjuntado a otro pedido (dos pedidos, un solo comprobante)", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    const conversation = await prisma.conversation.create({
      data: { companyId: company.id, branchId: branch.id, customerPhone: "5491100000031" },
    });
    await prisma.message.create({
      data: {
        companyId: company.id,
        branchId: branch.id,
        conversationId: conversation.id,
        direction: "INBOUND",
        messageType: "IMAGE",
        mediaUrl: "whatsapp/comprobante-pedido-1.jpg",
      },
    });
    // Ese comprobante ya quedó adjuntado a un primer pedido.
    await prisma.order.create({
      data: {
        companyId: company.id,
        branchId: branch.id,
        conversationId: conversation.id,
        customerPhone: "5491100000031",
        customerName: "Cliente Test",
        deliveryAddressRaw: "Calle Falsa 123",
        status: "WAITING_RECEIPT",
        paymentMethod: "TRANSFER",
        subtotalCents: 300000,
        totalCents: 300000,
        delayMinutesAtOrder: 40,
        estimatedDeliveryAt: new Date(Date.now() + 40 * 60_000),
        receiptUrl: "whatsapp/comprobante-pedido-1.jpg",
      },
    });

    // El cliente confirma un SEGUNDO pedido sin mandar un comprobante nuevo
    // — no tiene que heredar el del primero.
    const result = await findReusableReceiptMediaUrl({ conversationId: conversation.id, branchId: branch.id });
    expect(result).toBeNull();
  });

  it("no reutiliza un mensaje más viejo que la ventana de reutilización", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    const conversation = await prisma.conversation.create({
      data: { companyId: company.id, branchId: branch.id, customerPhone: "5491100000032" },
    });
    await prisma.message.create({
      data: {
        companyId: company.id,
        branchId: branch.id,
        conversationId: conversation.id,
        direction: "INBOUND",
        messageType: "IMAGE",
        mediaUrl: "whatsapp/comprobante-viejo.jpg",
        createdAt: new Date(Date.now() - 45 * 60_000),
      },
    });

    const result = await findReusableReceiptMediaUrl({ conversationId: conversation.id, branchId: branch.id });
    expect(result).toBeNull();
  });

  it("devuelve null si no hay ninguna imagen/documento entrante", async () => {
    const { company, branch } = await createTestCompanyAndBranch();
    companiesToCleanup.push(company.id);
    const conversation = await prisma.conversation.create({
      data: { companyId: company.id, branchId: branch.id, customerPhone: "5491100000033" },
    });
    await prisma.message.create({
      data: {
        companyId: company.id,
        branchId: branch.id,
        conversationId: conversation.id,
        direction: "INBOUND",
        messageType: "TEXT",
        textContent: "listo",
      },
    });

    const result = await findReusableReceiptMediaUrl({ conversationId: conversation.id, branchId: branch.id });
    expect(result).toBeNull();
  });
});
