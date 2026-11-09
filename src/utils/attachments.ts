import { ApiError, ERROR_CODES } from '../types/errors.js';
import type {
  AttachmentContent,
  OutgoingAttachment,
  OutgoingAttachmentInput,
  ProviderAttachment
} from '../types/models.js';

export interface OutgoingAttachmentLimits {
  maxOutgoingAttachments: number;
  maxOutgoingAttachmentBytes: number;
}

export interface AttachmentReadLimits {
  maxAttachmentTextBytes: number;
  maxAttachmentBase64Bytes: number;
}

const MAX_FILENAME_LENGTH = 255;
// type/subtype with RFC 6838 token characters, optional parameters without CR/LF.
const CONTENT_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}(\s*;\s*[^\r\n;]+)*$/i;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
// eslint-disable-next-line no-control-regex
const UNSAFE_FILENAME_CHARS = /[\u0000-\u001f\u007f/\\]/;

const invalid = (message: string, details?: Record<string, unknown>): never => {
  throw new ApiError(ERROR_CODES.INVALID_INPUT, message, 400, details);
};

export const assertSafeFilename = (filename: string, index: number): string => {
  const value = filename.trim();
  if (!value) invalid(`attachments[${index}].filename is required`);
  if (value.length > MAX_FILENAME_LENGTH) {
    invalid(`attachments[${index}].filename exceeds ${MAX_FILENAME_LENGTH} characters`);
  }
  if (UNSAFE_FILENAME_CHARS.test(value)) {
    invalid(`attachments[${index}].filename must not contain path separators or control characters`);
  }
  if (value === '.' || value === '..') invalid(`attachments[${index}].filename is not a valid file name`);
  return value;
};

/**
 * Validates and normalizes outgoing attachments. Throws INVALID_INPUT before any
 * provider call so a rejected request never results in a partial send.
 */
export const validateOutgoingAttachments = (
  attachments: OutgoingAttachmentInput[] | undefined,
  limits: OutgoingAttachmentLimits
): OutgoingAttachment[] | undefined => {
  if (!attachments || attachments.length === 0) return undefined;
  if (attachments.length > limits.maxOutgoingAttachments) {
    invalid(`too many attachments: ${attachments.length} (max ${limits.maxOutgoingAttachments})`);
  }
  let total = 0;
  const normalized = attachments.map((attachment, index) => {
    const filename = assertSafeFilename(String(attachment.filename ?? ''), index);
    const contentType = String(attachment.contentType ?? '').trim().toLowerCase();
    if (!CONTENT_TYPE_PATTERN.test(contentType)) {
      invalid(`attachments[${index}].contentType must be a valid MIME type such as application/pdf`);
    }
    const contentBase64 = String(attachment.contentBase64 ?? '').replace(/\s+/g, '');
    if (!contentBase64 || contentBase64.length % 4 !== 0 || !BASE64_PATTERN.test(contentBase64)) {
      invalid(`attachments[${index}].contentBase64 must be non-empty standard base64`);
    }
    const size = Buffer.byteLength(contentBase64, 'base64');
    total += size;
    return { filename, contentType, contentBase64, size };
  });
  if (total > limits.maxOutgoingAttachmentBytes) {
    invalid(
      `attachments total ${total} bytes exceeds the limit of ${limits.maxOutgoingAttachmentBytes} bytes`,
      { totalBytes: total, maxBytes: limits.maxOutgoingAttachmentBytes }
    );
  }
  return normalized;
};

const TEXT_LIKE_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/csv',
  'application/x-csv',
  'application/yaml',
  'application/x-yaml',
  'application/x-ndjson',
  'application/javascript',
  'application/x-sh',
  'application/sql'
]);
const TEXT_LIKE_EXTENSIONS = new Set(['txt', 'csv', 'tsv', 'json', 'xml', 'md', 'yaml', 'yml', 'log', 'html', 'htm', 'ics', 'vcf']);

export const isTextLikeAttachment = (contentType: string, filename?: string): boolean => {
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  if (type.startsWith('text/')) return true;
  if (TEXT_LIKE_TYPES.has(type) || type.endsWith('+json') || type.endsWith('+xml')) return true;
  if ((type === 'application/octet-stream' || type === '') && filename) {
    const extension = filename.toLowerCase().split('.').pop() ?? '';
    return TEXT_LIKE_EXTENSIONS.has(extension);
  }
  return false;
};

const truncateUtf8 = (data: Buffer, maxBytes: number): { text: string; truncated: boolean } => {
  if (data.length <= maxBytes) return { text: data.toString('utf8'), truncated: false };
  // Drop a trailing partial multi-byte sequence instead of emitting U+FFFD.
  let end = maxBytes;
  while (end > 0 && (data[end]! & 0xc0) === 0x80) end -= 1;
  return { text: data.subarray(0, end).toString('utf8'), truncated: true };
};

const tooLarge = (size: number, max: number, filename: string): never => {
  throw new ApiError(
    ERROR_CODES.ATTACHMENT_TOO_LARGE,
    `attachment "${filename}" is too large to return (${size} bytes; limit ${max} bytes for non-text attachments)`,
    413,
    { size, maxBytes: max }
  );
};

/** Resolves attachment content within the configured limits. */
export const readAttachmentContent = async (
  handle: ProviderAttachment,
  limits: AttachmentReadLimits
): Promise<AttachmentContent> => {
  const textLike = isTextLikeAttachment(handle.contentType, handle.filename);
  if (!textLike && handle.size !== undefined && handle.size > limits.maxAttachmentBase64Bytes) {
    tooLarge(handle.size, limits.maxAttachmentBase64Bytes, handle.filename);
  }
  const data = await handle.load();
  const base = {
    id: handle.id,
    filename: handle.filename,
    contentType: handle.contentType,
    size: data.length
  };
  if (textLike) {
    const { text, truncated } = truncateUtf8(data, limits.maxAttachmentTextBytes);
    return { ...base, encoding: 'text', content: text, truncated };
  }
  if (data.length > limits.maxAttachmentBase64Bytes) {
    tooLarge(data.length, limits.maxAttachmentBase64Bytes, handle.filename);
  }
  return { ...base, encoding: 'base64', content: data.toString('base64'), truncated: false };
};

export const attachmentNotFound = (attachmentId: string): ApiError =>
  new ApiError(ERROR_CODES.ATTACHMENT_NOT_FOUND, `attachment ${attachmentId} not found on this message`, 404);

export const decodeBase64Url = (value: string): Buffer =>
  Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
