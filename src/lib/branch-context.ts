import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// El producto opera con una sola sucursal por cuenta: helper para obtener,
// en cualquier ruta autenticada, la sucursal de la empresa de la sesión.
export async function requireBranchContext() {
  const session = await auth();
  if (!session?.user) return null;

  const branch = await prisma.branch.findFirst({
    where: { companyId: session.user.companyId },
  });
  if (!branch) return null;

  return {
    userId: session.user.id,
    companyId: session.user.companyId,
    branch,
    branchId: branch.id,
  };
}
