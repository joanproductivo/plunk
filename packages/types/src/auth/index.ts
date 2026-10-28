/**
 * Authentication and authorization types
 */

/**
 * Authentication response data attached to Express Response.locals
 * Contains authentication context for the current request
 */
export interface AuthResponse {
	/** Authentication method used (JWT cookie or API key) */
	type: 'jwt' | 'apiKey';

	/** User ID (only present for JWT authentication) */
	userId?: string;

	/** Project ID associated with this request */
	projectId: string;

	/** Plunk Lite: which API key authenticated it (only for `apiKey`) */
	key?: 'public' | 'secret';
}

/**
 * Type guard to check if auth is JWT-based
 */
export function isJwtAuth(auth: AuthResponse): auth is AuthResponse & {userId: string} {
	return auth.type === 'jwt' && !!auth.userId;
}

/**
 * Type guard to check if auth is API key-based
 */
export function isApiKeyAuth(auth: AuthResponse): auth is AuthResponse & {userId: undefined} {
	return auth.type === 'apiKey';
}
