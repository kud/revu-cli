# Auth Module Refactor

## Overview

Refactor the authentication module to support OAuth 2.0 alongside the existing session-based flow.
The goal is to keep the existing session logic intact while introducing token-based access for API clients.

## Changes

### New files

- `src/auth/oauth.ts` — OAuth 2.0 provider integration (GitHub, Google)
- `src/auth/token.ts` — JWT generation and validation helpers
- `src/auth/middleware.ts` — unified auth middleware for both flows

### Modified files

- `src/auth/session.ts` — extracted shared logic into `src/auth/shared.ts`
- `src/routes/api.ts` — replaced inline session checks with the new middleware
- `src/config.ts` — added `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, `JWT_SECRET` env vars

## Migration notes

Existing session cookies remain valid. No database schema changes are required.
The new `Authorization: Bearer <token>` header is opt-in and does not break existing clients.

## Open questions

- Should token expiry be configurable per-client, or a global setting?
- Do we want refresh tokens in v1, or ship without them and add later?
- Rate-limiting strategy for the token endpoint — Redis or in-memory?
