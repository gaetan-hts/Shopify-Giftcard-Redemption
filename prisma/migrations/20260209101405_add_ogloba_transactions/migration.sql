-- CreateTable
CREATE TABLE "OglobaTransaction" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "discountCode" TEXT NOT NULL,
    "discountId" TEXT NOT NULL,
    "referenceNumber" TEXT NOT NULL,
    "cardNumber" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "OglobaTransaction_discountCode_key" ON "OglobaTransaction"("discountCode");

-- CreateIndex
CREATE UNIQUE INDEX "OglobaTransaction_referenceNumber_key" ON "OglobaTransaction"("referenceNumber");
