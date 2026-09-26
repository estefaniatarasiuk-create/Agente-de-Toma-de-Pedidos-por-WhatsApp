import Link from "next/link";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const SETUP_STEPS = [
  { href: "/catalogo", label: "Cargar el catálogo de productos" },
  { href: "/horarios", label: "Definir los horarios de atención" },
  { href: "/zona-de-entrega", label: "Definir la zona de entrega" },
  { href: "/medios-de-pago", label: "Configurar los medios de pago" },
  { href: "/ia", label: "Configurar el tono e instrucciones de la IA" },
  { href: "/whatsapp", label: "Vincular la línea de WhatsApp" },
];

export default async function DashboardHomePage() {
  const session = await auth();
  const branch = await prisma.branch.findFirst({
    where: { companyId: session?.user.companyId },
    include: {
      whatsappLine: true,
      _count: { select: { products: true } },
      businessHourSlots: true,
      deliveryZone: true,
      paymentMethod: true,
      aiConfig: true,
    },
  });

  const stepStatus: Record<string, boolean> = {
    "/catalogo": (branch?._count.products ?? 0) > 0,
    "/horarios": (branch?.businessHourSlots.length ?? 0) > 0,
    "/zona-de-entrega": Boolean(branch?.deliveryZone),
    "/medios-de-pago": Boolean(branch?.paymentMethod),
    "/ia": Boolean(branch?.aiConfig),
    "/whatsapp": branch?.whatsappLine?.status === "ACTIVE",
  };

  return (
    <div className="p-8">
      <h1 className="text-2xl font-semibold text-gray-900">
        Hola, {session?.user.companyName}
      </h1>
      <p className="mt-1 text-sm text-gray-600">
        Sucursal: {branch?.name ?? "—"}
      </p>

      <div className="mt-8 rounded-lg border border-gray-200 bg-white p-6">
        <h2 className="text-sm font-semibold text-gray-900">
          Pasos para activar la toma de pedidos por IA
        </h2>
        <ul className="mt-4 space-y-3">
          {SETUP_STEPS.map((step) => {
            const isDone = stepStatus[step.href];
            return (
              <li key={step.href} className="flex items-center gap-3">
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs ${
                    isDone ? "bg-green-600 text-white" : "border border-gray-300 text-transparent"
                  }`}
                >
                  ✓
                </span>
                <Link
                  href={step.href}
                  className={`text-sm ${isDone ? "text-gray-600 line-through" : "text-gray-800 underline"}`}
                >
                  {step.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
