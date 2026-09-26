import { prisma } from "@/lib/prisma";
import { requireBranchContext } from "@/lib/branch-context";
import { AiConfigForm } from "./ai-config-form";
import { TestChatWidget } from "./test-chat-widget";

export default async function ConfiguracionIaPage() {
  const context = await requireBranchContext();
  const config = context
    ? await prisma.aIConfig.findUnique({ where: { branchId: context.branchId } })
    : null;

  return (
    <div className="p-8 max-w-5xl">
      <h1 className="text-2xl font-semibold text-gray-900">Configuración de la IA</h1>
      <p className="mt-1 text-sm text-gray-600">
        La IA nunca inventa precios ni horarios: solo conversa y estructura, siempre valida contra tu
        catálogo, zona y horarios configurados.
      </p>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <AiConfigForm initialConfig={config} />
        <TestChatWidget />
      </div>
    </div>
  );
}
