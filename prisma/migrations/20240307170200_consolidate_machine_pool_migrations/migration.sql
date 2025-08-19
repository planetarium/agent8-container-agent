-- Create machine table
CREATE TABLE "machine" (
    "id" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "token" VARCHAR,
    "machine_id" VARCHAR,
    "deleted" BOOLEAN DEFAULT false,
    "ipv6" VARCHAR,
    CONSTRAINT "machine_pkey" PRIMARY KEY ("id")
);

-- Create new machine_pool table
CREATE TABLE "machine_pool" (
    "id" BIGINT GENERATED ALWAYS AS IDENTITY,
    "created_at" TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "machine_id" VARCHAR NOT NULL,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "ipv6" VARCHAR,
    "assigned_to" VARCHAR,
    "assigned_at" TIMESTAMP WITHOUT TIME ZONE,
    "is_available" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "machine_pool_pkey" PRIMARY KEY ("id")
);

-- Create unique constraint for machine_id
ALTER TABLE "machine_pool" ADD CONSTRAINT "machine_pool_machine_id_key" UNIQUE ("machine_id");

-- Create indexes for faster queries
CREATE INDEX "machine_pool_is_available_idx" ON "machine_pool" ("is_available");
CREATE INDEX "machine_pool_assigned_to_idx" ON "machine_pool" ("assigned_to");
CREATE INDEX "machine_pool_machine_id_idx" ON "machine_pool" ("machine_id");
