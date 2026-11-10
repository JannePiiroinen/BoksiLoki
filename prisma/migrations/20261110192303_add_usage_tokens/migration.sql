-- AlterTable
ALTER TABLE "UsageEvent" ADD COLUMN     "costUsd" DECIMAL(10,6),
ADD COLUMN     "inputTokens" INTEGER,
ADD COLUMN     "latencyMs" INTEGER,
ADD COLUMN     "model" TEXT,
ADD COLUMN     "outputTokens" INTEGER,
ADD COLUMN     "refunded" BOOLEAN NOT NULL DEFAULT false;
