-- CreateTable
CREATE TABLE "order_receipts" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "mediaUrl" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_receipts_companyId_idx" ON "order_receipts"("companyId");

-- CreateIndex
CREATE INDEX "order_receipts_orderId_idx" ON "order_receipts"("orderId");

-- AddForeignKey
ALTER TABLE "order_receipts" ADD CONSTRAINT "order_receipts_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
