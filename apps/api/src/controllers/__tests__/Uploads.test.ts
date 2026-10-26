import type {Request, Response} from 'express';
import signale from 'signale';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {HttpException} from '../../exceptions/index.js';
import * as S3Service from '../../services/S3Service.js';
import {Uploads} from '../Uploads.js';

vi.mock('../../services/S3Service.js', () => ({
  isS3Enabled: vi.fn(() => true),
  listImages: vi.fn(async () => ({images: [], truncated: false})),
  uploadFile: vi.fn(),
}));

/**
 * Calls the listing handler as Express would. `CatchAsync` does not return its promise, so the
 * outcome is awaited from whichever of the response or `next` it reaches first.
 */
async function listImages(auth: Record<string, unknown>) {
  let status = 200;
  let body: unknown;
  let error: unknown;

  await new Promise<void>(resolve => {
    const res = {
      locals: {auth},
      status(code: number) {
        status = code;
        return this;
      },
      json(value: unknown) {
        body = value;
        resolve();
        return this;
      },
    } as unknown as Response;
    new Uploads().listImages({} as Request, res, (thrown?: unknown) => {
      error = thrown;
      resolve();
    });
  });

  return {status, body, error};
}

describe('GET /uploads/images', () => {
  beforeEach(() => {
    vi.mocked(S3Service.isS3Enabled).mockReturnValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("lists the session project's images, and only those", async () => {
    const {status, body} = await listImages({type: 'jwt', userId: 'user-1', projectId: 'project-1'});

    expect(status).toBe(200);
    expect(body).toEqual({images: [], truncated: false});
    expect(S3Service.listImages).toHaveBeenCalledWith('project-1');
  });

  it('refuses API keys: listing is a billed request only the dashboard needs', async () => {
    const {error} = await listImages({type: 'apiKey', projectId: 'project-1'});

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).code).toBe(403);
    expect(S3Service.listImages).not.toHaveBeenCalled();
  });

  it('says so when storage is not configured', async () => {
    vi.mocked(S3Service.isS3Enabled).mockReturnValue(false);

    const {error} = await listImages({type: 'jwt', userId: 'user-1', projectId: 'project-1'});

    expect((error as HttpException).code).toBe(503);
  });

  it('keeps the storage error out of the response', async () => {
    const logged = vi.spyOn(signale, 'error').mockImplementation(() => undefined);
    vi.mocked(S3Service.listImages).mockRejectedValueOnce(
      new Error('AccessDenied at https://account-id.r2.cloudflarestorage.com'),
    );

    const {error} = await listImages({type: 'jwt', userId: 'user-1', projectId: 'project-1'});

    expect((error as HttpException).code).toBe(502);
    expect((error as HttpException).message).not.toContain('r2.cloudflarestorage.com');
    // The detail stays in the server log
    expect(logged).toHaveBeenCalled();
  });
});
