-- CreateTable
model MerchantConfig {
  id                String   @id @default(uuid())
  shop              String   @unique
  oglobaMerchantId  String
  oglobaApiKey      String
  oglobaApiSecret   String
  redemptionEnabled Boolean  @default(true)
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
}

