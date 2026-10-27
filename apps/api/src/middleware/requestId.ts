import {randomUUID} from 'node:crypto';
import type {NextFunction, Request, Response} from 'express';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Middleware to add a unique request ID to each request
 * The request ID is used for error tracking and debugging
 */
export const requestIdMiddleware = (req: Request, res: Response, next: NextFunction) => {
  // Check if request ID already exists (e.g., from load balancer)
  const existingRequestId = req.headers['x-request-id'] as string | undefined;

  // Generate new ID if not provided. Plunk Lite: or if it is not a UUID -- it is the primary key of
  // api_requests, so a client must not choose any string as one
  const requestId = existingRequestId && UUID.test(existingRequestId) ? existingRequestId : randomUUID();

  // Store in request object for use in handlers
  res.locals.requestId = requestId;

  // Send back in response headers for client-side tracking
  res.setHeader('X-Request-ID', requestId);

  next();
};
