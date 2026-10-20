import { createHash } from 'node:crypto';
import { badRequest } from './errors.js';

export const MAX_CERTIFICATE_BYTES = 3 * 1024 * 1024;

export interface UploadedFile {
  fileName: string;
  contentType: 'application/pdf' | 'image/jpeg' | 'image/png';
  data: Buffer;
  sha256: Buffer;
}

/** The type is decided by the file's first bytes, never by its name or the browser's claim. */
function sniff(data: Buffer): UploadedFile['contentType'] | null {
  if (data.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

/** A name safe to show and to send back in Content-Disposition. */
export function safeFileName(name: string, type: UploadedFile['contentType']): string {
  const ext = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png' }[type];
  const base = (name.split(/[\\/]/).pop() ?? '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} ._()-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.(pdf|jpe?g|png)$/i, '')
    .slice(0, 150);
  return `${base || 'certificate'}${ext}`;
}

/** Reads a certificate from a multipart field: PDF, JPEG or PNG, up to 3 MB. */
export async function readCertificate(value: unknown): Promise<UploadedFile | null> {
  if (value === undefined || value === null || value === '') return null;
  if (!(value instanceof File)) throw badRequest('invalid_file', 'Attach the certificate as a file');
  if (value.size === 0) return null;
  if (value.size > MAX_CERTIFICATE_BYTES) throw badRequest('file_too_large', 'The certificate must be 3 MB or smaller');
  const data = Buffer.from(await value.arrayBuffer());
  const contentType = sniff(data);
  if (!contentType) throw badRequest('invalid_file_type', 'The certificate must be a PDF, JPEG or PNG file');
  return { fileName: safeFileName(value.name, contentType), contentType, data, sha256: createHash('sha256').update(data).digest() };
}

/** RFC 6266: plain ASCII fallback plus the exact UTF-8 name. */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
