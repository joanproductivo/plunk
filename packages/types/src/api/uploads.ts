/**
 * Uploaded image types
 */

/**
 * An image uploaded to the project's storage, as the image gallery lists it
 */
export interface UploadedImage {
  url: string;
  /** From the stored key; null for images uploaded before names were kept. */
  name: string | null;
  uploadedAt: string | null;
  size: number;
}

/**
 * The project's uploaded images, latest first
 */
export interface UploadedImagesResponse {
  images: UploadedImage[];
  /** Whether the project has more images than are listed. */
  truncated: boolean;
}
