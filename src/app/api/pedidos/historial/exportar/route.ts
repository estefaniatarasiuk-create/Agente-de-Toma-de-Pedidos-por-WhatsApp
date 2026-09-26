import { prisma } from "@/lib/prisma";
import { requireBranchContext } from "@/lib/branch-context";
import { buildHistorialWhere, ORDER_STATUS_LABEL } from "@/lib/orders/historial-filters";
import { formatCentsAsArs } from "@/lib/money";

// Una coma, comilla o salto de línea en un valor (ej. una dirección con
// "Casa 2, timbre B") rompería el CSV si no se lo entrecomilla.
function csvField(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export async function GET(request: Request) {
  const context = await requireBranchContext();
  if (!context) return new Response("No autorizado.", { status: 401 });

  const url = new URL(request.url);
  const where = buildHistorialWhere(context.branchId, {
    from: url.searchParams.get("from"),
    to: url.searchParams.get("to"),
    cliente: url.searchParams.get("cliente"),
    estado: url.searchParams.get("estado"),
  });

  const orders = await prisma.order.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: { items: true },
  });

  // El servidor corre en UTC — a diferencia de los componentes de cliente
  // (que ya formatean en el navegador del usuario), acá hay que pasar la
  // zona horaria de la sucursal explícitamente o las horas del CSV
  // quedarían en UTC en vez de en hora argentina.
  const timezone = context.branch.timezone;
  const header = ["Fecha", "Hora", "Cliente", "Teléfono", "Domicilio", "Productos", "Medio de pago", "Total", "Estado"];
  const rows = orders.map((order) => {
    const productos = order.items.map((item) => `${item.quantity}x ${item.productName}`).join("; ");
    return [
      order.createdAt.toLocaleDateString("es-AR", { timeZone: timezone }),
      order.createdAt.toLocaleTimeString("es-AR", { timeZone: timezone, hour: "2-digit", minute: "2-digit" }),
      order.customerName,
      order.customerPhone,
      order.deliveryAddressNormalized ?? order.deliveryAddressRaw,
      productos,
      order.paymentMethod === "CASH" ? "Efectivo" : "Transferencia",
      formatCentsAsArs(order.totalCents),
      ORDER_STATUS_LABEL[order.status],
    ]
      .map(csvField)
      .join(",");
  });

  // BOM al inicio para que Excel en Windows detecte UTF-8 y no rompa tildes/ñ.
  const csv = "﻿" + [header.join(","), ...rows].join("\r\n");

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="pedidos_${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
