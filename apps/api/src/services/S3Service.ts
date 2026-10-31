import {
  CreateBucketCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {LINKED_FILE_TYPES, type LinkedFileExtension, slugify} from '@plunk/shared';
import type {UploadedObject, UploadKind} from '@plunk/types';
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

interface UploadType {
  kind: UploadKind;
  /** The extension it is stored under, rather than the one in the name the browser sent (`.JPG`, `.jfif`, none). */
  extension: string;
  /** How its contents start: a file is taken only if it starts with one of these. */
  signatures: Buffer[];
  /** How far into the file the signature may start, for types whose readers skip leading bytes. */
  signatureWithin?: number;
}

// PDF readers look for the header within the first 1024 bytes; some writers put a line or a BOM before it
const PDF_HEADER_WITHIN = 1024;

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

// Office documents are ZIP files (see hasContentsOf)
const FILE_SIGNATURES: Record<LinkedFileExtension, Buffer[]> = {
  pdf: [Buffer.from('%PDF-')],
  docx: [ZIP],
  xlsx: [ZIP],
  pptx: [ZIP],
};

function linkedFileTypes(): Record<string, UploadType> {
  return Object.fromEntries(
    (Object.entries(LINKED_FILE_TYPES) as [LinkedFileExtension, string][]).map(([extension, contentType]) => [
      contentType,
      {
        kind: 'file',
        extension,
        signatures: FILE_SIGNATURES[extension],
        ...(extension === 'pdf' ? {signatureWithin: PDF_HEADER_WITHIN} : {}),
      },
    ]),
  );
}

/**
 * What can be uploaded, by the content type it is stored with. Never add a type a browser runs
 * (HTML, SVG, XML, JavaScript): uploads are served from a domain on the dashboard's site, which
 * the session cookie is sent to.
 */
const UPLOAD_TYPES: Record<string, UploadType> = {
  'image/jpeg': {kind: 'image', extension: 'jpg', signatures: [Buffer.from([0xff, 0xd8, 0xff])]},
  'image/jpg': {kind: 'image', extension: 'jpg', signatures: [Buffer.from([0xff, 0xd8, 0xff])]},
  'image/png': {kind: 'image', extension: 'png', signatures: [Buffer.from([0x89, 0x50, 0x4e, 0x47])]},
  'image/gif': {kind: 'image', extension: 'gif', signatures: [Buffer.from('GIF87a'), Buffer.from('GIF89a')]},
  'image/webp': {kind: 'image', extension: 'webp', signatures: [Buffer.from('RIFF')]},
  ...linkedFileTypes(),
};

const uploadType = (contentType: string) =>
  Object.hasOwn(UPLOAD_TYPES, contentType) ? UPLOAD_TYPES[contentType] : undefined;

/** Whether images of this content type can be uploaded. */
export const isImageType = (contentType: string) => uploadType(contentType)?.kind === 'image';

// What browsers send for a document they have no type for: Office documents without Office installed
const UNTYPED = new Set(['application/octet-stream', 'application/zip']);

/**
 * The content type a file to link is stored with, from its name's extension, or null when it is
 * not one that can be uploaded. The type the browser sent only has to agree with it, or be none.
 */
export function linkedFileType(filename: string, sentType: string): string | null {
  const extension = /\.([^.]+)$/.exec(filename)?.[1]?.toLowerCase();
  const match = Object.entries(UPLOAD_TYPES).find(([, type]) => type.kind === 'file' && type.extension === extension);
  if (!match) return null;
  const [contentType] = match;
  return sentType === contentType || UNTYPED.has(sentType) ? contentType : null;
}

/** Whether a file's contents are what its content type says. */
export function hasContentsOf(file: Buffer, contentType: string): boolean {
  const type = uploadType(contentType);
  const startsAsItShould = (signature: Buffer) =>
    type?.signatureWithin
      ? file.subarray(0, type.signatureWithin).includes(signature)
      : file.subarray(0, signature.length).equals(signature);
  if (!type?.signatures.some(startsAsItShould)) {
    return false;
  }
  // Office documents are ZIP files. A document lists its parts in [Content_Types].xml; a
  // macro-enabled one carries vbaProject.bin. Entry names are stored uncompressed.
  if (type.signatures.includes(ZIP)) {
    return file.includes('[Content_Types].xml') && !file.includes('vbaProject.bin');
  }
  return true;
}

// Each path segment encoded: older keys took their extension from the file name, spaces and all
const publicUrl = (key: string) => `${S3_PUBLIC_URL}/${key.split('/').map(encodeURIComponent).join('/')}`;

// Files have a folder of their own, out of the image gallery's: project ids are uuids, never `files`
const folder = (kind: UploadKind, projectId: string) =>
  kind === 'image' ? `${KEY_PREFIX}${projectId}/` : `${KEY_PREFIX}files/${projectId}/`;

const MAX_SAVED_NAME = 150;

/**
 * Opens a file in the browser, and names it when saved after the name it was uploaded with
 * (RFC 6266): `filename` for old clients, ASCII only, and `filename*` in UTF-8.
 */
function inlineDisposition(uploaded: string): string {
  // Long names are cut, keeping their extension, so the header stays well within storage's limits.
  // Cut by characters: a cut through an emoji's surrogate pair would make encodeURIComponent throw.
  const characters = Array.from(uploaded);
  const extension = /\.[^.]{1,10}$/.exec(uploaded)?.[0] ?? '';
  const filename =
    characters.length > MAX_SAVED_NAME
      ? characters.slice(0, MAX_SAVED_NAME - Array.from(extension).length).join('') + extension
      : uploaded;
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/gu, '_');
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

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
 * Upload an image or a file to the project's storage
 */
export async function uploadFile(params: UploadFileParams): Promise<UploadFileResult> {
  if (!s3Client) {
    throw new Error('S3 is not enabled');
  }

  const {file, filename, contentType, projectId} = params;
  const type = uploadType(contentType);
  if (!type) {
    throw new Error(`Unsupported upload type: ${contentType}`);
  }

  // A unique key, readable in the galleries: the original name (without its extension) as a slug
  const timestamp = Date.now();
  const randomString = crypto.randomBytes(8).toString('hex');
  const name = slugify(filename.replace(/\.[^.]*$/, ''));
  const key = `${folder(type.kind, projectId)}${timestamp}-${randomString}${name ? `-${name}` : ''}.${type.extension}`;

  await s3Client.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: file,
      ContentType: contentType,
      ...(type.kind === 'file' ? {ContentDisposition: inlineDisposition(filename)} : {}),
    }),
  );

  return {url: publicUrl(key), key};
}

/** The name an upload's key carries (see uploadFile), or null for keys from before names were kept. */
export function uploadNameFromKey(key: string): string | null {
  const file = key.slice(key.lastIndexOf('/') + 1);
  return /^\d+-[0-9a-f]{16}-([a-z0-9-]+)\.\w+$/.exec(file)?.[1] ?? null;
}

/** How many of the latest uploads are listed, how many keys a list page holds, and how many pages are read at most. */
const LISTED_UPLOADS = 1000;
const PAGE_SIZE = 1000;
const MAX_LIST_PAGES = 50;

interface ListedObject {
  key: string;
  uploadedAt: Date | undefined;
  size: number;
}

// Keys start with the upload time, so the latest sort first
const newestFirst = (a: ListedObject, b: ListedObject) => (a.key < b.key ? 1 : -1);

/**
 * A project's uploaded images or files, latest first. Storage lists keys oldest first (they start
 * with the upload time), so every page is read, keeping the latest ones; each page of up to 1000
 * keys is one billed list request. `truncated` when there were more than are returned.
 */
export async function listUploads(
  kind: UploadKind,
  projectId: string,
): Promise<{uploads: UploadedObject[]; truncated: boolean}> {
  if (!s3Client) {
    throw new Error('S3 is not enabled');
  }

  let latest: ListedObject[] = [];
  let truncated = false;
  let token: string | undefined;

  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const result = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        Prefix: folder(kind, projectId),
        MaxKeys: PAGE_SIZE,
        ContinuationToken: token,
      }),
    );

    for (const object of result.Contents ?? []) {
      if (object.Key && !object.Key.endsWith('/')) {
        latest.push({key: object.Key, uploadedAt: object.LastModified, size: object.Size ?? 0});
      }
    }
    if (latest.length > LISTED_UPLOADS) {
      latest.sort(newestFirst);
      latest = latest.slice(0, LISTED_UPLOADS);
      truncated = true;
    }

    token = result.IsTruncated ? result.NextContinuationToken : undefined;
    if (!token) break;
    if (page === MAX_LIST_PAGES - 1) truncated = true;
  }

  latest.sort(newestFirst);
  return {
    uploads: latest.map(upload => ({
      url: publicUrl(upload.key),
      name: uploadNameFromKey(upload.key),
      uploadedAt: upload.uploadedAt?.toISOString() ?? null,
      size: upload.size,
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
