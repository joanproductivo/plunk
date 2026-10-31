import net from 'node:net';

/**
 * Plunk Lite: how long a connection may take to one of a host's addresses before the next is tried,
 * for every socket of this process. Node's default is 250 ms: when the first address took longer and
 * the next failed at once (an IPv6 address on a server with no route for it), a request to a healthy
 * host failed in 300 ms with `fetch failed`, `AggregateError [ETIMEDOUT]`. The price is taking up to
 * 2 s, not 250 ms, to move on from a dead address.
 */
export const CONNECTION_ATTEMPT_TIMEOUT_MS = 2_000;

net.setDefaultAutoSelectFamilyAttemptTimeout(CONNECTION_ATTEMPT_TIMEOUT_MS);
