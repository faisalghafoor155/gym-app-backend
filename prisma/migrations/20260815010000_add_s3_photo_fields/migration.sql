-- Migration to support S3 photo storage
-- Add photoKey to store S3 key and photoUrl to store public URL
-- Keep photo field for backward compatibility (will be migrated)

ALTER TABLE "Member" ADD COLUMN "photoKey" TEXT,
ADD COLUMN "photoUrl" TEXT;

-- Create index for faster queries
CREATE INDEX "Member_photoKey_idx" ON "Member"("photoKey");
