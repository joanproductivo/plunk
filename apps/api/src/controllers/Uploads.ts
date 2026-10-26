import {Controller, Get, Middleware, Post} from '@overnightjs/core';
import type {NextFunction, Request, Response} from 'express';
import multer from 'multer';
import signale from 'signale';
import {ErrorCode, HttpException} from '../exceptions/index.js';
import {requireAuth, requireEmailVerified} from '../middleware/auth.js';
import * as S3Service from '../services/S3Service.js';
import {CatchAsync} from '../utils/asyncHandler.js';

const MAGIC_BYTES: Record<string, Buffer[]> = {
  'image/jpeg': [Buffer.from([0xff, 0xd8, 0xff])],
  'image/jpg': [Buffer.from([0xff, 0xd8, 0xff])],
  'image/png': [Buffer.from([0x89, 0x50, 0x4e, 0x47])],
  'image/gif': [Buffer.from('GIF87a'), Buffer.from('GIF89a')],
  'image/webp': [Buffer.from('RIFF')],
};

function validateMagicBytes(buffer: Buffer, mimetype: string): boolean {
  const signatures = MAGIC_BYTES[mimetype];
  if (!signatures) return false;
  return signatures.some(sig => buffer.subarray(0, sig.length).equals(sig));
}

// Configure multer for file uploads (memory storage). multer 2.4 reads `defParamCharset`, which
// @types/multer 2.0 does not declare yet.
const uploadOptions: multer.Options & {defParamCharset: string} = {
  storage: multer.memoryStorage(),
  // Browsers send file names as UTF-8; the default would read "café.png" as "cafÃ©.png"
  defParamCharset: 'utf8',
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max file size
  },
  fileFilter: (_req, file, cb) => {
    if (S3Service.isImageType(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed (JPEG, PNG, GIF, WebP)'));
    }
  },
};
const upload = multer(uploadOptions);

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
    if (auth.type !== 'jwt') {
      throw new HttpException(403, 'Images can only be listed from the dashboard', ErrorCode.FORBIDDEN);
    }
    if (!S3Service.isS3Enabled()) {
      throw new HttpException(503, 'Image storage is not configured');
    }

    try {
      return res.status(200).json(await S3Service.listImages(auth.projectId!));
    } catch (error) {
      // The storage error names the endpoint, which carries the account id: it stays in the log
      signale.error('[UPLOADS] Failed to list images:', error);
      throw new HttpException(502, "Couldn't list your images in storage", ErrorCode.EXTERNAL_SERVICE_ERROR);
    }
  }

  /**
   * POST /uploads/image
   * Upload an image file to S3/Minio
   */
  @Post('image')
  @Middleware([requireAuth, requireEmailVerified, upload.single('image')])
  @CatchAsync
  public async uploadImage(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;

    try {
      if (!S3Service.isS3Enabled()) {
        return res.status(503).json({
          error: 'File uploads are not enabled. Please configure S3 storage.',
        });
      }

      if (!req.file) {
        return res.status(400).json({
          error: 'No image file provided',
        });
      }

      if (!validateMagicBytes(req.file.buffer, req.file.mimetype)) {
        return res.status(400).json({
          error: 'File contents do not match the declared image type',
        });
      }

      // Upload file to S3/Minio
      const result = await S3Service.uploadFile({
        file: req.file.buffer,
        filename: req.file.originalname,
        contentType: req.file.mimetype,
        projectId: auth.projectId!,
      });

      return res.status(200).json({
        url: result.url,
        key: result.key,
        filename: req.file.originalname,
        contentType: req.file.mimetype,
        size: req.file.size,
      });
    } catch (error) {
      signale.error('[UPLOADS] Failed to upload image:', error);
      return res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to upload image',
      });
    }
  }
}
