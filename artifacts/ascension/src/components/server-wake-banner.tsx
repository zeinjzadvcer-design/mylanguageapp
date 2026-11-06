import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/lib/i18n';

/**
 * Wakes the API and tells the user when it is slow to answer.
 *
 * The free API host sleeps after ~15 minutes without traffic and takes 30–60 s
 * to boot on the next request. Pinging /api/healthz on page load starts that
 * boot while the user is still reading the first screen, and a notice appears
 * only if the ping has not come back within SHOW_AFTER_MS — so a warm server
 * shows nothing at all.
 *
 * Returning to a tab that has been hidden long enough for the server to fall
 * asleep pings again. Once the server answers after a slow start, queries are
 * refetched in case any gave up while it was booting.
 */

const HEALTH_URL = '/api/healthz';
const SHOW_AFTER_MS = 2500;
const RETRY_EVERY_MS = 3000;
const GIVE_UP_AFTER_MS = 120_000;
const REPING_AFTER_HIDDEN_MS = 10 * 60 * 1000;

type Status = 'idle' | 'waking' | 'failed';

export function ServerWakeBanner() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<Status>('idle');
  const { t } = useI18n();
  const runId = useRef(0);

  const wake = useCallback(async () => {
    const id = ++runId.current;
    const startedAt = Date.now();
    let shown = false;
    const showTimer = setTimeout(() => {
      if (runId.current === id) {
        shown = true;
        setStatus('waking');
      }
    }, SHOW_AFTER_MS);

    while (runId.current === id) {
      try {
        const res = await fetch(HEALTH_URL, { cache: 'no-store' });
        if (res.ok) break;
      } catch {
        // Network error or proxy timeout while the server boots — keep trying.
      }
      if (Date.now() - startedAt > GIVE_UP_AFTER_MS) {
        clearTimeout(showTimer);
        if (runId.current === id) setStatus('failed');
        return;
      }
      await new Promise((r) => setTimeout(r, RETRY_EVERY_MS));
    }

    clearTimeout(showTimer);
    if (runId.current !== id) return;
    setStatus('idle');
    if (shown) void queryClient.invalidateQueries();
  }, [queryClient]);

  useEffect(() => {
    void wake();

    let hiddenAt: number | null = null;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
      } else if (hiddenAt !== null && Date.now() - hiddenAt > REPING_AFTER_HIDDEN_MS) {
        hiddenAt = null;
        void wake();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      runId.current++;
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [wake]);

  if (status === 'idle') return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 left-1/2 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-lg border bg-background px-4 py-3 text-sm shadow-lg"
    >
      {status === 'waking' ? (
        <>
          <Spinner />
          <span>{t.common.serverWaking}</span>
        </>
      ) : (
        <>
          <span>{t.common.serverDown}</span>
          <button
            type="button"
            onClick={() => void wake()}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            {t.common.retry}
          </button>
        </>
      )}
    </div>
  );
}
