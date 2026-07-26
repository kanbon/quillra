const MEBIBYTE = 1024 * 1024;

export const PROJECT_UPLOAD_MAX_FILES = 8;
export const PROJECT_UPLOAD_MAX_FILE_BYTES = 5 * MEBIBYTE;
export const PROJECT_UPLOAD_MAX_CONTENT_FILE_BYTES = 1 * MEBIBYTE;
export const PROJECT_UPLOAD_MAX_AGGREGATE_BYTES = 20 * MEBIBYTE;
export const PROJECT_UPLOAD_MAX_OUTPUT_FILE_BYTES = 12 * MEBIBYTE;
export const PROJECT_UPLOAD_MAX_OUTPUT_AGGREGATE_BYTES = 24 * MEBIBYTE;
export const PROJECT_IMAGE_MAX_INPUT_PIXELS = 25_000_000;

// Multipart boundaries, field names, and filenames count toward the HTTP body
// but not toward the aggregate file-byte limit above.
export const PROJECT_UPLOAD_BODY_MAX_BYTES = PROJECT_UPLOAD_MAX_AGGREGATE_BYTES + MEBIBYTE;

export const PROJECT_LOGO_MAX_FILE_BYTES = 5 * MEBIBYTE;
export const PROJECT_LOGO_MAX_OUTPUT_BYTES = 512 * 1024;
export const PROJECT_LOGO_BODY_MAX_BYTES = PROJECT_LOGO_MAX_FILE_BYTES + MEBIBYTE;

// Defense in depth for every API route. Project upload routes retain their
// tighter limits; this small margin only covers multipart framing overhead.
export const API_BODY_MAX_BYTES = PROJECT_UPLOAD_BODY_MAX_BYTES + MEBIBYTE;
