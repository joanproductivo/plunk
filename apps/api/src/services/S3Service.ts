import {
  CreateBucketCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {slugify} from '@plunk/shared';
import crypto from 'crypto';
import signale from 'signale';

import {
  S3_ACCESS_KEY_ID,
  S3_ACCESS_KEY_SECRET,
  S3_BUCKET,
  S3_ENABLED,
  S3_ENDPOINT,
  S3_FORCE_PATH_STYLE,
  S3_PREFIX,
  S3_PUBLIC_URL,
} from '../app/constants.js';

const KEY_PREFIX = S3_PREFIX ? `${S3_PREFIX}/` : '';

/**
 * S3-compatible storage client for Minio
 */
let s3Client: S3Client | null = null;

if (S3_ENABLED) {
  s3Client = new S3Client({
    region: 'us-east-1', // Minio doesn't use regions, but AWS SDK requires this parameter
    endpoint: S3_ENDPOINT,
    credentials: {
      accessKeyId: S3_ACCESS_KEY_ID,
      secretAccessKey: S3_ACCESS_KEY_SECRET,
    },
    forcePathStyle: S3_FORCE_PATH_STYLE, // Required for Minio (uses path-style URLs)
  });
}

/**
 * Initialize the S3 bucket if it doesn't exist
 */
export async function initializeBucket(): Promise<void> {
  if (!s3Client) {
    throw new Error('S3 is not enabled');
  }

  let bucketExists = true;

  try {
    await s3Client.send(
      new HeadBucketCommand({
        Bucket: S3_BUCKET,
      }),
    );
  } catch (error: unknown) {
    const isNotFoundError =
      error &&
      typeof error === 'object' &&
      (('name' in error && error.name === 'NotFound') ||
        ('$metadata' in error &&
          error.$metadata &&
          typeof error.$metadata === 'object' &&
          'httpStatusCode' in error.$metadata &&
          error.$metadata.httpStatusCode === 404));
    if (isNotFoundError) {
      bucketExists = false;
      // Bucket doesn't exist, create it
      try {
        await s3Client.send(
          new CreateBucketCommand({
            Bucket: S3_BUCKET,
          }),
        );
        signale.info(`[S3] Created bucket: ${S3_BUCKET}`);
      } catch (createError) {
        signale.error('[S3] Failed to create bucket:', createError);
        throw createError;
      }
    } else {
      signale.error('[S3] Failed to check bucket:', error);
      throw error;
    }
  }

  // Set public read policy for the upload prefix (both for new and existing buckets)
  try {
    const bucketPolicy = {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'PublicReadGetObject',
          Effect: 'Allow',
          Principal: '*',
          Action: ['s3:GetObject'],
          Resource: [`arn:aws:s3:::${S3_BUCKET}/${KEY_PREFIX}*`],
        },
      ],
    };

    await s3Client.send(
      new PutBucketPolicyCommand({
        Bucket: S3_BUCKET,
        Policy: JSON.stringify(bucketPolicy),
      }),
    );

    if (!bucketExists) {
      signale.info(`[S3] Set public read policy for: ${S3_BUCKET}/${KEY_PREFIX}*`);
    }
  } catch (policyError) {
    signale.error('[S3] Failed to set bucket policy:', policyError);
    // Don't throw - bucket was created but policy failed
  }
}

/**
 * The extension an image is stored under, from its checked content type rather than the
 * name the browser sent, which can end in anything (`.JPG`, `.jfif`, no dot at all).
 */
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

interface UploadFileParams {
  file: Buffer;
  filename: string;
  contentType: string;
  projectId: string;
}

interface UploadFileResult {
  url: string;
  key: string;
}

/**
 * Upload a file to S3/Minio
 */
export async function uploadFile(params: UploadFileParams): Promise<UploadFileResult> {
  if (!s3Client) {
    throw new Error('S3 is not enabled');
  }

  const {file, filename, contentType, projectId} = params;
  const extension = IMAGE_EXTENSIONS[contentType];
  if (!extension) {
    throw new Error(`Unsupported image type: ${contentType}`);
  }

  // A unique key, readable in the image gallery: the original name (without its extension) as a slug
  const timestamp = Date.now();
  const randomString = crypto.randomBytes(8).toString('hex');
  const name = slugify(filename.replace(/\.[^.]*$/, ''));
  const key = `${KEY_PREFIX}${projectId}/${timestamp}-${randomString}${name ? `-${name}` : ''}.${extension}`;

  // Upload to S3/Minio
  await s3Client.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: file,
      ContentType: contentType,
    }),
  );

  // Construct public URL
  const url = `${S3_PUBLIC_URL}/${key}`;

  return {url, key};
}

/** The name an upload's key carries (see uploadFile), or null for keys from before names were kept. */
export function imageNameFromKey(key: string): string | null {
  const file = key.slice(key.lastIndexOf('/') + 1);
  return /^\d+-[0-9a-f]{16}-([a-z0-9-]+)\.\w+$/.exec(file)?.[1] ?? null;
}

export interface StoredImage {
  url: string;
  /** From the key (see imageNameFromKey); null for older uploads. */
  name: string | null;
  uploadedAt: string | null;
  size: number;
}

/** How many of a project's latest images are listed, and how many pages are read at most. */
const LISTED_IMAGES = 1000;
const MAX_LIST_PAGES = 50;

// Each path segment encoded: older keys took their extension from the file name, spaces and all
const publicUrl = (key: string) => `${S3_PUBLIC_URL}/${key.split('/').map(encodeURIComponent).join('/')}`;

/**
 * A project's uploaded images, latest first. Storage lists keys oldest first (they start with the
 * upload time), so every page is read, keeping the latest ones; each page of up to 1000 keys is one
 * billed list request. `truncated` when there were more than are returned.
 */
export async function listImages(projectId: string): Promise<{images: StoredImage[]; truncated: boolean}> {
  if (!s3Client) {
    throw new Error('S3 is not enabled');
  }

  let latest: {key: string; uploadedAt: Date | undefined; size: number}[] = [];
  let truncated = false;
  let token: string | undefined;

  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const result = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        Prefix: `${KEY_PREFIX}${projectId}/`,
        MaxKeys: 1000,
        ContinuationToken: token,
      }),
    );

    for (const object of result.Contents ?? []) {
      if (object.Key && !object.Key.endsWith('/')) {
        latest.push({key: object.Key, uploadedAt: object.LastModified, size: object.Size ?? 0});
      }
    }
    if (latest.length > LISTED_IMAGES) {
      latest.sort((a, b) => (a.key < b.key ? 1 : -1));
      latest = latest.slice(0, LISTED_IMAGES);
      truncated = true;
    }

    token = result.IsTruncated ? result.NextContinuationToken : undefined;
    if (!token) break;
    if (page === MAX_LIST_PAGES - 1) truncated = true;
  }

  latest.sort((a, b) => (a.key < b.key ? 1 : -1));
  return {
    images: latest.map(image => ({
      url: publicUrl(image.key),
      name: imageNameFromKey(image.key),
      uploadedAt: image.uploadedAt?.toISOString() ?? null,
      size: image.size,
    })),
    truncated,
  };
}

/**
 * Check if S3 is enabled and configured
 */
export function isS3Enabled(): boolean {
  return S3_ENABLED;
}
