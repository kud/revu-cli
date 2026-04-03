# API Rate Limiting

## Problem

Without rate limiting, a single client can exhaust server resources by sending bursts of requests.
We've seen this happen in staging when load tests are run against the public endpoint without throttling.

## Proposed solution

Implement a sliding-window rate limiter backed by Redis. Each client is identified by their API key
(or IP address for unauthenticated routes). Limits are applied per route group:

| Route group     | Limit        | Window |
| --------------- | ------------ | ------ |
| `/api/public/*` | 60 requests  | 1 min  |
| `/api/auth/*`   | 10 requests  | 1 min  |
| `/api/admin/*`  | 300 requests | 1 min  |

## Implementation plan

1. Add `rate-limiter-flexible` as a dependency (supports Redis out of the box).
2. Create `src/middleware/rate-limit.ts` with a factory function per route group.
3. Mount the middleware in `src/routes/index.ts` before route handlers.
4. Return `429 Too Many Requests` with a `Retry-After` header when the limit is exceeded.
5. Add Prometheus metrics for `rate_limit_hits_total` and `rate_limit_remaining`.

## Rollout

- Deploy behind a feature flag so we can disable it instantly if it causes false positives.
- Monitor for 24 h before making it permanent.
- Communicate limits to API consumers via changelog and updated API docs.

## Risks

- Redis outage: fail open (allow requests) rather than fail closed (block everything).
- Key collisions if API keys are not sufficiently random — ensure at least 32 bytes of entropy.
