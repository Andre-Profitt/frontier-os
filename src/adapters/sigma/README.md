# Sigma Adapter

Thin read-only wrapper around [Sigma Computing's v2 REST API](https://help.sigmacomputing.com/reference/get-started-sigma-api).

## Commands

| Command            | Endpoint                            | Args                         |
| ------------------ | ----------------------------------- | ---------------------------- |
| `whoami`           | `GET /v2/members/me`                | —                            |
| `list-workbooks`   | `GET /v2/workbooks?limit=N`         | `limit?` (1–500, default 25) |
| `inspect-workbook` | `GET /v2/workbooks/{id}` + `/pages` | `workbookId` (required)      |
| `list-members`     | `GET /v2/members?limit=N`           | `limit?` (1–500, default 25) |
| `list-datasets`    | `GET /v2/datasets?limit=N`          | `limit?` (1–500, default 25) |

All commands are `mode=read`, `sideEffectClass=none`, and never mutate Sigma state.

## Authentication

OAuth2 client credentials grant:

```
POST {SIGMA_BASE_URL}/v2/auth/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&client_id=...&client_secret=...
```

Response: `{ access_token: <JWT>, expires_in: <seconds>, ... }`.

The access token is cached **inside the factory closure** (per `createSigmaAdapter()` instance, not module-global). It is refreshed 60s before the reported `expires_in` to absorb clock skew, and on any `401` the token is cleared and the request retried once. A second `401` becomes a `failed` AdapterResult with a clear hint about revoked creds or missing scope.

## Credentials

Resolved in this order (first hit wins, per key):

1. `FRONTIER_SIGMA_BASE_URL`, `FRONTIER_SIGMA_CLIENT_ID`, `FRONTIER_SIGMA_CLIENT_SECRET`, `FRONTIER_SIGMA_ORG_ID`, `FRONTIER_SIGMA_ACCOUNT_EMAIL` env vars.
2. `SIGMA_*` keys parsed from `/Users/test/code/apps/sigma-gtm-poc/.env` (a tiny key=value reader, no shell interpolation).

If any required key is missing from both sources, the adapter returns `status=failed` with a `hint` in `observedState` telling the operator exactly which keys are missing and where to put them. It never throws into the dispatcher.

Required keys: `SIGMA_BASE_URL`, `SIGMA_CLIENT_ID`, `SIGMA_CLIENT_SECRET`, `SIGMA_ORG_ID`, `SIGMA_ACCOUNT_EMAIL`.

## Gotchas

- **Regional base URLs matter.** Sigma has per-region hosts (`aws-api.sigmacomputing.com`, `api.sigmacomputing.com`, `api.us-a.sigmacomputing.com`, etc.). Match the URL to the org's region or every call 404s.
- **List endpoints wrap entries.** `list-workbooks`/`list-members`/`list-datasets` return `{ entries: [...], total, hasMore, nextPage }`. The count in `summary` reflects `entries.length` in the current page, not the org total.
- **Client-credentials scopes are limited.** Some endpoints (e.g. embed URL minting, member creation) require a human account or admin-scoped service account. This adapter intentionally sticks to read paths that work with the GTM-POC client creds in `~/code/apps/sigma-gtm-poc/.env`.
- **Trailing slashes in `SIGMA_BASE_URL` are stripped** by `loadSigmaConfig()` to prevent double-slash 404s.
- **No retries on 5xx/429 yet.** If that matters for your workload, add a retry policy; today we surface the status code unchanged.
