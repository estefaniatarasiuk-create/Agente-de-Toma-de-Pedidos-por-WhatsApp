-- AlterTable
ALTER TABLE "whatsapp_lines" ADD COLUMN "twoStepPinEncrypted" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_lines_phoneNumberId_key" ON "whatsapp_lines"("phoneNumberId");
