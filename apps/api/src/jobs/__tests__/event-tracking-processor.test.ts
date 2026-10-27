import {describe, expect, it} from 'vitest';

import {createEventTrackingWorker} from '../event-tracking-processor';

describe('createEventTrackingWorker', () => {
  it('fails a job whose worker died mid-run instead of running it again', async () => {
    const worker = createEventTrackingWorker();
    try {
      // Running it again could start the event's workflows, and send their emails, twice
      expect(worker.opts.maxStalledCount).toBe(0);
    } finally {
      await worker.close();
    }
  });
});
