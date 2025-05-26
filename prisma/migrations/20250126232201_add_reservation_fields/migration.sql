-- Add reservation fields to machine_pool table
ALTER TABLE "machine_pool" ADD COLUMN "status" VARCHAR NOT NULL DEFAULT 'active';
ALTER TABLE "machine_pool" ADD COLUMN "reservation_id" VARCHAR;
ALTER TABLE "machine_pool" ADD COLUMN "reservation_type" VARCHAR;
ALTER TABLE "machine_pool" ADD COLUMN "expires_at" TIMESTAMP;

-- Create indexes for better query performance
CREATE INDEX "machine_pool_status_idx" ON "machine_pool" ("status");
CREATE INDEX "machine_pool_reservation_id_idx" ON "machine_pool" ("reservation_id");
CREATE INDEX "machine_pool_expires_at_idx" ON "machine_pool" ("expires_at");

-- Add unique constraint on machine_id if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'machine_pool_machine_id_unique'
    ) THEN
        ALTER TABLE "machine_pool" ADD CONSTRAINT "machine_pool_machine_id_unique" UNIQUE ("machine_id");
    END IF;
END $$;
