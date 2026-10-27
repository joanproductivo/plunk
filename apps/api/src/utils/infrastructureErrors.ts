import {Prisma} from '@plunk/db';

/** Network error codes of a dropped or refused connection, as Node and ioredis report them */
const CONNECTION_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']);

/**
 * Whether an error comes from the database or Redis being unreachable, rather than from the
 * data being worked on. Retrying the work later can fix the first kind and never the second.
 */
export function isInfrastructureError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientInitializationError || error instanceof Prisma.PrismaClientRustPanicError) {
    return true;
  }

  // P1xxx are connection and server errors; P2024 is a timeout waiting for a pool connection
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code.startsWith('P1') || error.code === 'P2024';
  }

  const code = (error as {code?: unknown} | null)?.code;
  if (typeof code === 'string' && CONNECTION_ERROR_CODES.has(code)) {
    return true;
  }

  // ioredis, once its connection is gone
  return error instanceof Error && /Connection is closed|MaxRetriesPerRequestError/.test(error.message);
}
