import express from 'express';
import type {NextFunction, Request, Response} from 'express';
import signale from 'signale';
import request from 'supertest';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {HttpException} from '../../exceptions/index.js';
import * as S3Service from '../../services/S3Service.js';
import {dashboardOnly, receiveFile, Uploads} from '../Uploads.js';

vi.mock('../../services/S3Service.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../services/S3Service.js')>();
  return {
    ...actual,
    isS3Enabled: vi.fn(() => true),
    listUploads: vi.fn(async () => ({uploads: [], truncated: false})),
    uploadFile: vi.fn(async () => ({url: 'https://cdn.example.com/files/project-1/guide.pdf', key: 'files/x.pdf'})),
  };
});

const dashboard = {type: 'jwt', userId: 'user-1', projectId: 'project-1'};
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Calls a handler as Express would. `CatchAsync` does not return its promise, so the outcome is
 * awaited from whichever of the response or `next` it reaches first.
 */
async function call(
  handler: 'listImages' | 'listFiles' | 'uploadImage' | 'uploadLinkedFile',
  auth: Record<string, unknown>,
  file?: Partial<Express.Multer.File>,
) {
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
    new Uploads()[handler]({file} as Request, res, (thrown?: unknown) => {
      error = thrown;
      resolve();
    });
  });

  return {status, body, error};
}

const codeOf = (error: unknown) => (error as HttpException).code;

describe('GET /uploads/images and /uploads/files', () => {
  beforeEach(() => {
    vi.mocked(S3Service.isS3Enabled).mockReturnValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("lists the session project's images, and only those", async () => {
    const {status, body} = await call('listImages', dashboard);

    expect(status).toBe(200);
    expect(body).toEqual({images: [], truncated: false});
    expect(S3Service.listUploads).toHaveBeenCalledWith('image', 'project-1');
  });

  it("lists the session project's files apart", async () => {
    const {status, body} = await call('listFiles', dashboard);

    expect(status).toBe(200);
    expect(body).toEqual({files: [], truncated: false});
    expect(S3Service.listUploads).toHaveBeenCalledWith('file', 'project-1');
  });

  it('refuses API keys: listing is a billed request only the dashboard needs', async () => {
    for (const handler of ['listImages', 'listFiles'] as const) {
      const {error} = await call(handler, {type: 'apiKey', projectId: 'project-1'});

      expect(codeOf(error)).toBe(403);
    }
    expect(S3Service.listUploads).not.toHaveBeenCalled();
  });

  it('says so when storage is not configured', async () => {
    vi.mocked(S3Service.isS3Enabled).mockReturnValue(false);

    const {error} = await call('listImages', dashboard);

    expect(codeOf(error)).toBe(503);
  });

  it('keeps the storage error out of the response', async () => {
    const logged = vi.spyOn(signale, 'error').mockImplementation(() => undefined);
    vi.mocked(S3Service.listUploads).mockRejectedValueOnce(
      new Error('AccessDenied at https://account-id.r2.cloudflarestorage.com'),
    );

    const {error} = await call('listImages', dashboard);

    expect(codeOf(error)).toBe(502);
    expect((error as HttpException).message).not.toContain('r2.cloudflarestorage.com');
    // The detail stays in the server log
    expect(logged).toHaveBeenCalled();
  });
});

describe('POST /uploads/image and /uploads/file', () => {
  const file = (originalname: string, mimetype: string, contents: string | Buffer) => {
    const buffer = Buffer.from(contents);
    return {originalname, mimetype, buffer, size: buffer.length};
  };
  const officeFile = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('[Content_Types].xml')]);

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('answers an image whose contents are not an image as a client error', async () => {
    const {error} = await call('uploadImage', dashboard, file('photo.png', 'image/png', '<svg/>'));

    expect(codeOf(error)).toBe(400);
    expect((error as HttpException).message).toBe('File contents do not match the declared image type');
    expect(S3Service.uploadFile).not.toHaveBeenCalled();
  });

  it('stores a PDF with its own type', async () => {
    const {status, body} = await call('uploadLinkedFile', dashboard, file('Guide.pdf', 'application/pdf', '%PDF-1.7'));

    expect(status).toBe(200);
    expect(body).toMatchObject({
      url: 'https://cdn.example.com/files/project-1/guide.pdf',
      contentType: 'application/pdf',
    });
    expect(S3Service.uploadFile).toHaveBeenCalledWith(expect.objectContaining({contentType: 'application/pdf'}));
  });

  it('stores an Office document the browser sent untyped with the type of its extension', async () => {
    const {status} = await call(
      'uploadLinkedFile',
      dashboard,
      file('notes.docx', 'application/octet-stream', officeFile),
    );

    expect(status).toBe(200);
    expect(S3Service.uploadFile).toHaveBeenCalledWith(expect.objectContaining({contentType: DOCX}));
  });

  it('refuses a file whose contents are not what its name says', async () => {
    const {error} = await call('uploadLinkedFile', dashboard, file('guide.pdf', 'application/pdf', '<html>'));

    expect(codeOf(error)).toBe(400);
    expect(S3Service.uploadFile).not.toHaveBeenCalled();
  });

  it('keeps the storage error out of the response', async () => {
    vi.spyOn(signale, 'error').mockImplementation(() => undefined);
    vi.mocked(S3Service.uploadFile).mockRejectedValueOnce(new Error('AccessDenied at https://account-id.r2.example'));

    const {error} = await call('uploadLinkedFile', dashboard, file('guide.pdf', 'application/pdf', '%PDF-1.7'));

    expect(codeOf(error)).toBe(502);
    expect((error as HttpException).message).not.toContain('account-id');
  });
});

describe('receiveFile', () => {
  // An app with only the middleware, answering errors as the API's error handler does
  function app(auth: Record<string, unknown> = dashboard) {
    const server = express();
    server.use((_req: Request, res: Response, next: NextFunction) => {
      res.locals.auth = auth;
      next();
    });
    server.post('/uploads/file', dashboardOnly, receiveFile, (req: Request, res: Response) => {
      res.json({received: req.file?.originalname});
    });
    server.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (error instanceof HttpException) {
        res.status(error.code).json({message: error.message});
      } else {
        res.status(500).json({message: 'unexpected'});
      }
    });
    return server;
  }

  it('takes a document', async () => {
    const response = await request(app())
      .post('/uploads/file')
      .attach('file', Buffer.from('%PDF-1.7'), {filename: 'guide.pdf', contentType: 'application/pdf'});

    expect(response.status).toBe(200);
    expect(response.body.received).toBe('guide.pdf');
  });

  it('refuses a type it does not take as a client error, not a server error', async () => {
    const response = await request(app())
      .post('/uploads/file')
      .attach('file', Buffer.from('<html>'), {filename: 'page.html', contentType: 'text/html'});

    expect(response.status).toBe(400);
    expect(response.body.message).toContain('Only PDF, Word, Excel and PowerPoint files');
  });

  it('refuses a file over 10 MB as a client error', async () => {
    const response = await request(app())
      .post('/uploads/file')
      .attach('file', Buffer.alloc(10 * 1024 * 1024 + 1), {filename: 'big.pdf', contentType: 'application/pdf'});

    expect(response.status).toBe(400);
    expect(response.body.message).toBe('The file is larger than 10 MB');
  });

  it('turns away an API key before the upload is read', async () => {
    const response = await request(app({type: 'apiKey', projectId: 'project-1'}))
      .post('/uploads/file')
      .attach('file', Buffer.from('%PDF-1.7'), {filename: 'guide.pdf', contentType: 'application/pdf'});

    expect(response.status).toBe(403);
    expect(response.body.received).toBeUndefined();
  });
});
