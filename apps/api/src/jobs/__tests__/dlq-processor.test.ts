import {afterEach, describe, expect, it, vi} from 'vitest';

import {DlqDrainService} from '../../services/DlqDrainService';
import {QueueService} from '../../services/QueueService';
import {processDlqDrain} from '../dlq-processor';

/** One drain of the dead-letter queue, and what comes after it */
describe('processDlqDrain', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const drained = (more: boolean) =>
    vi.spyOn(DlqDrainService, 'drain').mockResolvedValue({handled: 1, old: 0, retry: 0, invalid: 0, more});

  it('queues itself again while the queue may hold more', async () => {
    drained(true);
    const queued = vi.spyOn(QueueService, 'queueDlqDrain').mockResolvedValue({} as never);
    const checked = vi.spyOn(DlqDrainService, 'check').mockResolvedValue(false);

    await processDlqDrain(() => false);

    expect(queued).toHaveBeenCalledOnce();
    expect(checked).not.toHaveBeenCalled();
  });

  it('leaves the rest to the checks when the worker is closing', async () => {
    drained(true);
    const queued = vi.spyOn(QueueService, 'queueDlqDrain').mockResolvedValue({} as never);

    await processDlqDrain(() => true);

    expect(queued).not.toHaveBeenCalled();
  });

  it('counts the queue once it is done, which closes the alarm notice if it is empty', async () => {
    drained(false);
    const queued = vi.spyOn(QueueService, 'queueDlqDrain').mockResolvedValue({} as never);
    const checked = vi.spyOn(DlqDrainService, 'check').mockResolvedValue(false);

    await processDlqDrain(() => false);

    expect(checked).toHaveBeenCalledOnce();
    expect(queued).not.toHaveBeenCalled();
  });
});
