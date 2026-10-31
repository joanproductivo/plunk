import {Controller, Get, Middleware, Post} from '@overnightjs/core';
import {MAX_UPLOAD_BYTES} from '@plunk/shared';
import type {UploadedFilesResponse, UploadedImagesResponse} from '@plunk/types';
import type {NextFunction, Request, RequestHandler, Response} from 'express';
import multer from 'multer';
import signale from 'signale';
import {BadRequest, ErrorCode, HttpException} from '../exceptions/index.js';
import {requireAuth, requireEmailVerified} from '../middleware/auth.js';
import * as S3Service from '../services/S3Service.js';
import {CatchAsync} from '../utils/asyncHandler.js';

// Uploads are held in memory. multer 2.4 reads `defParamCharset`, which @types/multer 2.0 does not
// declare yet. Browsers send file names as UTF-8; the default would read "café.png" as "cafÃ©.png".
// A refused file is a 400: an HttpException passed to the callback reaches the error handler as is.
const receive = (field: string, accepts: (file: Express.Multer.File) => boolean, refusal: string): RequestHandler => {
  const options: multer.Options & {defParamCharset: string} = {
    storage: multer.memoryStorage(),
    defParamCharset: 'utf8',
    limits: {fileSize: MAX_UPLOAD_BYTES},
    fileFilter: (_req, file, cb) => (accepts(file) ? cb(null, true) : cb(new BadRequest(refusal))),
  };
  const upload = multer(options).single(field);

  // multer's own refusals (a file too large) are a 400 as well, not the error handler's 500
  return (req, res, next) =>
    upload(req, res, (error?: unknown) => {
      if (error instanceof multer.MulterError) {
        return next(
          new BadRequest(
            error.code === 'LIMIT_FILE_SIZE'
              ? `The file is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`
              : error.message,
          ),
        );
      }
      next(error);
    });
};

const receiveImage = receive(
  'image',
  file => S3Service.isImageType(file.mimetype),
  'Only image files are allowed (JPEG, PNG, GIF, WebP)',
);
// Exported so tests can run it on an app of their own
export const receiveFile = receive(
  'file',
  file => S3Service.linkedFileType(file.originalname, file.mimetype) !== null,
  'Only PDF, Word, Excel and PowerPoint files are allowed (.pdf, .docx, .xlsx, .pptx)',
);

/** Listing is a billed storage request, and files are hosted under the project's domain: dashboard only. */
function requireDashboard(auth: {type: string}, action: string) {
  if (auth.type !== 'jwt') {
    throw new HttpException(403, `${action} only from the dashboard`, ErrorCode.FORBIDDEN);
  }
}

function requireStorage() {
  if (!S3Service.isS3Enabled()) {
    throw new HttpException(503, 'File storage is not configured');
  }
}

// The storage error names the endpoint, which carries the account id: it stays in the log
function storageFailure(action: string, error: unknown): HttpException {
  signale.error(`[UPLOADS] Failed to ${action}:`, error);
  return new HttpException(502, `Couldn't ${action} in storage`, ErrorCode.EXTERNAL_SERVICE_ERROR);
}

// Checked before the body is read, so a refused upload is never held in memory
const checkBeforeReading =
  (check: (res: Response) => void): RequestHandler =>
  (_req, res, next) => {
    try {
      check(res);
      next();
    } catch (error) {
      next(error);
    }
  };

const storageReady = checkBeforeReading(() => requireStorage());
// Exported so tests can run it on an app of their own
export const dashboardOnly = checkBeforeReading(res => requireDashboard(res.locals.auth, 'Files can be uploaded'));

@Controller('uploads')
export class Uploads {
  /**
   * GET /uploads/images
   * The project's uploaded images, latest first, for the image dialog's gallery. Only for
   * dashboard sessions: listing is a billed storage request, and no API key needs it.
   */
  @Get('images')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async listImages(_req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    requireDashboard(auth, 'Images can be listed');
    requireStorage();

    try {
      const {uploads, truncated} = await S3Service.listUploads('image', auth.projectId!);
      const body: UploadedImagesResponse = {images: uploads, truncated};
      return res.status(200).json(body);
    } catch (error) {
      throw storageFailure('list your images', error);
    }
  }

  /**
   * GET /uploads/files
   * The project's uploaded files, latest first, for the file dialog's gallery. Dashboard only.
   */
  @Get('files')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async listFiles(_req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    requireDashboard(auth, 'Files can be listed');
    requireStorage();

    try {
      const {uploads, truncated} = await S3Service.listUploads('file', auth.projectId!);
      const body: UploadedFilesResponse = {files: uploads, truncated};
      return res.status(200).json(body);
    } catch (error) {
      throw storageFailure('list your files', error);
    }
  }

  /**
   * POST /uploads/image
   * Upload an image to the project's storage
   */
  @Post('image')
  @Middleware([requireAuth, requireEmailVerified, storageReady, receiveImage])
  @CatchAsync
  public async uploadImage(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;

    if (!req.file) {
      throw new BadRequest('No image file provided');
    }
    if (!S3Service.hasContentsOf(req.file.buffer, req.file.mimetype)) {
      throw new BadRequest('File contents do not match the declared image type');
    }

    let stored: {url: string; key: string};
    try {
      stored = await S3Service.uploadFile({
        file: req.file.buffer,
        filename: req.file.originalname,
        contentType: req.file.mimetype,
        projectId: auth.projectId!,
      });
    } catch (error) {
      throw storageFailure('store the image', error);
    }

    return res.status(200).json({
      url: stored.url,
      key: stored.key,
      filename: req.file.originalname,
      contentType: req.file.mimetype,
      size: req.file.size,
    });
  }

  /**
   * POST /uploads/file
   * Upload a document (PDF, Word, Excel, PowerPoint) to link to from an email. Dashboard only: the
   * file is served from the project's storage domain to whoever has the link.
   */
  @Post('file')
  @Middleware([requireAuth, requireEmailVerified, dashboardOnly, storageReady, receiveFile])
  @CatchAsync
  public async uploadLinkedFile(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;

    if (!req.file) {
      throw new BadRequest('No file provided');
    }
    // Stored with the type its name says rather than the browser's, which is often none for Office files
    const contentType = S3Service.linkedFileType(req.file.originalname, req.file.mimetype);
    if (!contentType || !S3Service.hasContentsOf(req.file.buffer, contentType)) {
      throw new BadRequest('File contents do not match its type (macro-enabled Office files are not allowed)');
    }

    let stored: {url: string; key: string};
    try {
      stored = await S3Service.uploadFile({
        file: req.file.buffer,
        filename: req.file.originalname,
        contentType,
        projectId: auth.projectId!,
      });
    } catch (error) {
      throw storageFailure('store the file', error);
    }

    return res.status(200).json({
      url: stored.url,
      key: stored.key,
      filename: req.file.originalname,
      contentType,
      size: req.file.size,
    });
  }
}
