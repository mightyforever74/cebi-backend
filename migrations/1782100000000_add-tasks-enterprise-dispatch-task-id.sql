-- ADR-0004 v3 §6.2: Bridge traceability column on public.tasks
-- Links a driver-app task back to its source enterprise.dispatch_tasks row
-- (one-way push per ADR-0009 §4.4). Nullable: legacy/non-dispatcher tasks have none.

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS enterprise_dispatch_task_id uuid NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tasks_enterprise_dispatch_task_id_fkey'
  ) THEN
    ALTER TABLE public.tasks
      ADD CONSTRAINT tasks_enterprise_dispatch_task_id_fkey
        FOREIGN KEY (enterprise_dispatch_task_id)
        REFERENCES enterprise.dispatch_tasks(id) ON DELETE SET NULL;
  END IF;
END$$;