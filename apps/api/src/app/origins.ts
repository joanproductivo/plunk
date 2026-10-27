import {DASHBOARD_URI, LANDING_URI, NODE_ENV, WIKI_URI} from './constants.js';

/**
 * The origins the dashboard and Plunk's own sites call the API from. CORS lets them read its
 * answers, and only they may use the dashboard session on requests that change something.
 */
export const allowedOrigins: (string | RegExp)[] =
  NODE_ENV === 'development'
    ? [/.*\.localhost:1000/, 'http://localhost:3000', 'http://localhost:4000']
    : [DASHBOARD_URI, LANDING_URI, WIKI_URI];

/**
 * Whether a request's Origin header is one of the allowed origins
 * @param origin The Origin header
 */
export function isAllowedOrigin(origin: string): boolean {
  return allowedOrigins.some(allowed => (allowed instanceof RegExp ? allowed.test(origin) : allowed === origin));
}
