CREATE TABLE "farm_journal_entries" (
  "id" TEXT NOT NULL,
  "farm_id" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "notes" TEXT NOT NULL DEFAULT '',
  "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "due_at" TIMESTAMP(3),
  "amount_vnd" INTEGER,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "farm_journal_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "farm_journal_entries_farm_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "farm_journal_entries_farm_id_occurred_at_idx" ON "farm_journal_entries"("farm_id", "occurred_at");
CREATE INDEX "farm_journal_entries_farm_id_category_due_at_idx" ON "farm_journal_entries"("farm_id", "category", "due_at");
