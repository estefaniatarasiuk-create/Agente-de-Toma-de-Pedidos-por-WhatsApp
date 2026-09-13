import { prisma } from "@/lib/prisma";
import { requireBranchContext } from "@/lib/branch-context";
import { CatalogManager } from "./catalog-manager";

export default async function CatalogoPage() {
  const context = await requireBranchContext();

  const [products, catalogImage] = context
    ? await Promise.all([
        prisma.product.findMany({
          where: { branchId: context.branchId },
          orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        }),
        prisma.catalogImage.findUnique({ where: { branchId: context.branchId } }),
      ])
    : [[], null];

  return <CatalogManager initialProducts={products} initialCatalogImage={catalogImage} />;
}
