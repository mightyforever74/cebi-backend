-- Takip portali (10.10.2026): token iptali DB'ye tasindi.
-- Revoke bugune kadar yalniz handler'lardaydi (DELETE /api/tasks/:id/public-link,
-- status handler'lari). SQL ile ya da baska bir yoldan kapali statuye gecen
-- gorevde token acik kaliyordu (TLP-26-00002, 00003: elle kapatildi).
-- Statu kapisi 404'u zaten veriyor; bu defans derinligi.
-- Kapali kume: completed, cancelled, withdrawn (tasks.status CHECK kumesinin
-- publicTrack.js'teki kapali alt kumesi ile ayni).

CREATE OR REPLACE FUNCTION public.revoke_tracking_tokens_on_close()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IN ('completed', 'cancelled', 'withdrawn')
     AND (OLD.status IS DISTINCT FROM NEW.status) THEN
    UPDATE public.public_tracking_tokens
       SET is_revoked = true
     WHERE task_id = NEW.id
       AND is_revoked = false;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_revoke_tracking_tokens_on_close ON public.tasks;

CREATE TRIGGER trg_revoke_tracking_tokens_on_close
AFTER UPDATE OF status ON public.tasks
FOR EACH ROW
EXECUTE FUNCTION public.revoke_tracking_tokens_on_close();
