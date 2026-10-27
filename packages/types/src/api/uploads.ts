/**
 * Uploaded image and file types
 */

/** Images for the editor's image blocks; files (documents) to link to from a button or a text. */
export type UploadKind = 'image' | 'file';

/**
 * An image or a file uploaded to the project's storage, as the galleries list it
 */
export interface UploadedObject {
  url: string;
  /** From the stored key; null for uploads from before names were kept. */
  name: string | null;
  uploadedAt: string | null;
  size: number;
}

/**
 * The project's uploaded images, latest first
 */
export interface UploadedImagesResponse {
  images: UploadedObject[];
  /** Whether the project has more images than are listed. */
  truncated: boolean;
}

/**
 * The project's uploaded files (documents to link to), latest first
 */
export interface UploadedFilesResponse {
  files: UploadedObject[];
  /** Whether the project has more files than are listed. */
  truncated: boolean;
}
