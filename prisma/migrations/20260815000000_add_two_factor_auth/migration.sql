-- AddColumn for Two-Factor Authentication fields
ALTER TABLE "User" ADD COLUMN "twoFactorSecret" TEXT,
ADD COLUMN "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "twoFactorBackupCodes" TEXT,
ADD COLUMN "twoFactorTempSecret" TEXT,
ADD COLUMN "twoFactorTempSecretAt" TIMESTAMP(3);
