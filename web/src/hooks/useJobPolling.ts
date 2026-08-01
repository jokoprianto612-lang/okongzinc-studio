/**
 * Polls a job until it reaches a terminal state.
 *
 * Polling (rather than websockets) keeps the server stateless and survives the
 * dev-server reloads and sleeping laptops this app actually runs on.
 */

import { useEffect, useRef, useState } from 'react';
import { fetchJob } from '../lib/api';
import { isTerminal, type Job } from '../lib/types';

const POLL_INTERVAL_MS = 2000;

export function useJobPolling(
  initial: Job | null,
  onFinished?: (job: Job) => void,
): { job: Job | null; setJob: (job: Job | null) => void } {
  const [job, setJob] = useState<Job | null>(initial);
  // Held in a ref so changing the callback identity does not restart polling.
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;

  useEffect(() => {
    if (!job || isTerminal(job.status)) return;

    let cancelled = false;
    const id = job.id;

    const timer = setInterval(async () => {
      try {
        const { job: fresh } = await fetchJob(id);
        if (cancelled) return;
        setJob(fresh);
        if (isTerminal(fresh.status)) {
          clearInterval(timer);
          finishedRef.current?.(fresh);
        }
      } catch {
        // Transient network failure: keep polling rather than dropping the job.
      }
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [job?.id, job?.status]);

  return { job, setJob };
}
