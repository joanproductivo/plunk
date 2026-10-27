import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {redis} from '../../database/redis';
import {FailureAlertService} from '../FailureAlertService';
import {checkRedisMemory} from '../RedisMemoryCheck';

/** Plunk Lite: every project hears when Redis nears its maxmemory, past which it refuses writes */
describe('checkRedisMemory', () => {
  const memory = (used: number, max: number) =>
    `# Memory\r\nused_memory:${used}\r\nused_memory_human:x\r\nmaxmemory:${max}\r\nmaxmemory_policy:noeviction\r\n`;

  beforeEach(() => {
    vi.spyOn(FailureAlertService, 'recordForAll').mockResolvedValue();
    vi.spyOn(FailureAlertService, 'resolve').mockResolvedValue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('warns every project, disabled ones included, at 80% of maxmemory', async () => {
    vi.spyOn(redis, 'info').mockResolvedValue(memory(850, 1000));

    await checkRedisMemory();

    expect(FailureAlertService.recordForAll).toHaveBeenCalledWith(
      expect.objectContaining({sourceKey: 'redis:memory'}),
      {includeDisabled: true},
    );
  });

  it('clears the warning below 70%, and leaves it between the two', async () => {
    vi.spyOn(redis, 'info').mockResolvedValueOnce(memory(600, 1000)).mockResolvedValueOnce(memory(750, 1000));

    await checkRedisMemory();
    await checkRedisMemory();

    expect(FailureAlertService.resolve).toHaveBeenCalledTimes(1);
    expect(FailureAlertService.recordForAll).not.toHaveBeenCalled();
  });

  it('says nothing without a maxmemory', async () => {
    vi.spyOn(redis, 'info').mockResolvedValue(memory(10_000_000, 0));

    await checkRedisMemory();

    expect(FailureAlertService.recordForAll).not.toHaveBeenCalled();
    expect(FailureAlertService.resolve).not.toHaveBeenCalled();
  });
});
