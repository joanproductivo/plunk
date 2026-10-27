/**
 * Documents that can be uploaded to link to from an email, by extension, with the content type they
 * are stored and served with. The API also checks their contents; the dashboard offers only these.
 */
export const LINKED_FILE_TYPES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
} as const;

export type LinkedFileExtension = keyof typeof LINKED_FILE_TYPES;

/** The largest image or file the API takes. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
