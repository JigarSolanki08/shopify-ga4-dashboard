-- CreateTable
CREATE TABLE "Ga4Config" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "jsonKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "Ga4Config_shop_key" ON "Ga4Config"("shop");
