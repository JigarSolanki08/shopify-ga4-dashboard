-- CreateTable
CREATE TABLE "ShopAnalyticsConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "serviceJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopAnalyticsConfig_shop_key" ON "ShopAnalyticsConfig"("shop");
