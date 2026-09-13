import { prisma } from "@/lib/prisma";
import { requireBranchContext } from "@/lib/branch-context";
import { PaymentMethodForm } from "./payment-method-form";

export default async function MediosDePagoPage() {
  const context = await requireBranchContext();
  const config = context
    ? await prisma.paymentMethodConfig.findUnique({ where: { branchId: context.branchId } })
    : null;

  return <PaymentMethodForm initialConfig={config} />;
}
