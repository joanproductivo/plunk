import {createHash} from 'node:crypto';

/**
 * A name-based UUID (version 5, RFC 9562 section 5.5): the same namespace and name always give
 * the same UUID. Used where a row's id has to be known before it is created, so that creating it
 * twice is a unique-key violation instead of a second row.
 */
export function uuidv5(name: string, namespace: string): string {
  const hash = createHash('sha1')
    .update(Buffer.from(namespace.replace(/-/g, ''), 'hex'))
    .update(name, 'utf8')
    .digest();

  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC variant

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
