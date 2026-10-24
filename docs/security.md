# Security

| Concern | Control |
| --- | --- |
| Password storage | Argon2id: 19 MiB memory, t=2, p=1 (OWASP baseline). Unknown users get an equal-time hash |
| Brute force | IP + email rate limiter on credential endpoints, plus an account lockout of 15 minutes after 8 failures |
| Session tokens | 15-minute JWT access token kept in memory only. Refresh token is 256-bit random, stored **hashed**, sent in an `HttpOnly; Secure; SameSite=Strict` cookie scoped to `/api/v1/auth` |
| Token theft | The refresh token rotates on every use. Replaying a rotated token outside a 15-second multi-tab grace window **revokes the whole session**. Access tokens check their session on every request, so revocation is immediate |
| CSRF | Cookie-authenticated endpoints (refresh, logout) need a double-submit `x-csrf-token` header. All other endpoints use a bearer header, which browsers do not attach automatically |
| Broken access control | Server-built tenant context, per-route permissions, project scoping, 404 for out-of-scope IDs, cross-reference validation, and a Mongoose plugin that rejects unscoped tenant queries |
| Mass assignment / NoSQL injection | Every body, query and param is parsed with a strict Zod schema that strips unknown keys, so `$`-operators never reach Mongo. Sort fields are allow-listed and regex input is escaped |
| XSS | React escapes output and there is no `dangerouslySetInnerHTML`. Nginx sends a strict CSP. Helmet sets API headers, including a `default-src 'none'` CSP |
| Secrets | Env vars are validated at boot. Production refuses placeholder JWT secrets and active dev-seed accounts. Logs redact authorization headers, cookies, passwords and tokens |
| Error leakage | The central error handler returns a consistent envelope plus a request ID. It never sends stack traces or database internals in production |
| Financial integrity | Integer paise, transactions, idempotency keys, optimistic guards, immutable journal entries, reversal-only corrections |
| PII minimisation | Only the last 4 digits of Aadhaar are stored. PAN is format-validated |
| Audit | Append-only audit log for auth events, bookings, payments, reversals, refunds, role and permission changes, membership changes and inventory status changes. Each record carries the actor, IP, user agent and request ID |
| File uploads | Multipart through the API (memory buffer, `MAX_UPLOAD_MB` cap → 413). Only PDF, PNG, JPEG, WebP, DOCX and XLSX are accepted, and the file's **magic bytes** must match the declared type. Storage keys are server-generated (`companyId/entity/random`), never derived from the filename. The local driver rejects path traversal |
| File downloads | Files are never public. `GET /documents/:id/url` re-checks tenant, permission and project/lead visibility, audits the access and returns a link valid for `FILE_URL_TTL_SECONDS` (default 300). Local links are HMAC-SHA256 tokens bound to the key, filename, type, disposition and expiry; S3 links are presigned GETs. The file route sends `nosniff`, a `sandbox` CSP, `no-store` and an RFC 6266 `Content-Disposition`. The storage key is `select:false` and never reaches the client |
| Ledger control accounts | Receivables, advances, refunds, vendor and broker payables can only be posted by their workflows. Manual vouchers are refused, so party balances always match their sub-ledgers |

## Production checklist

- [ ] Set `NODE_ENV=production` and a random `JWT_ACCESS_SECRET` of at least 48 bytes, kept in a secret manager.
- [ ] Serve over HTTPS on one origin (SPA plus `/api` reverse proxy), or adjust `CORS_ORIGINS` and the cookie settings deliberately.
- [ ] Set `TRUST_PROXY` to the number of proxies in front of the API so rate limiting sees real client IPs.
- [ ] Configure `SMTP_URL` for verification, reset and invitation emails.
- [ ] Use `STORAGE_DRIVER=s3` with a private bucket (block public access, SSE on, least-privilege keys limited to that bucket), or mount a backed-up volume for the local driver on a single server.
- [ ] Use MongoDB with authentication, TLS, a least-privilege application user and backups. Run `syncIndexes` during deploy, since `autoIndex` is off in production.
- [ ] Disable or delete the seed users. The API will not start otherwise.
- [ ] Ship logs (pino JSON) to your log platform and alert on 5xx responses and `auth.refresh_reuse_detected` audit events.
