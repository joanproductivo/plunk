/**
 * Express.js type augmentation for Plunk platform
 * Extends Express Response.locals to include typed auth property
 */

import type {AuthResponse} from './index.js';

declare global {
	namespace Express {
		interface Locals {
			/**
			 * Authentication context for the current request
			 * Set by auth middleware (requireAuth, requireSecretKey, requirePublicKey, requireTrackKey)
			 */
			auth: AuthResponse;
		}
	}
}
