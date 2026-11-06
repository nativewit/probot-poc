-- CreateTable
CREATE TABLE "pings" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pings_pkey" PRIMARY KEY ("id")
);
