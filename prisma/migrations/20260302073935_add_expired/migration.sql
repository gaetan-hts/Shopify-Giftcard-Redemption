-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_OglobaTransaction" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "discountCode" TEXT NOT NULL,
    "discountId" TEXT,
    "referenceNumber" TEXT NOT NULL,
    "cardNumber" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_OglobaTransaction" ("amount", "cardNumber", "createdAt", "discountCode", "discountId", "id", "referenceNumber", "status") SELECT "amount", "cardNumber", "createdAt", "discountCode", "discountId", "id", "referenceNumber", "status" FROM "OglobaTransaction";
DROP TABLE "OglobaTransaction";
ALTER TABLE "new_OglobaTransaction" RENAME TO "OglobaTransaction";
CREATE UNIQUE INDEX "OglobaTransaction_discountCode_key" ON "OglobaTransaction"("discountCode");
CREATE UNIQUE INDEX "OglobaTransaction_referenceNumber_key" ON "OglobaTransaction"("referenceNumber");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
