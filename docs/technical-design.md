# Nuôi Em (NurtureBaby) — Technical Design

Status: **Draft v2 — decisions confirmed (see §10). Nothing implemented yet.**
Source: Stitch project `17902991936775364404` ("Nuôi Em"), 5 mobile screens + design system.
Existing scaffold: NestJS 12, Mongoose 9 / MongoDB, class-validator, Swagger, Vitest, ESM (`"type": "module"`), `PORT` and `MONGODB_URI` env vars. The `items` module is a placeholder to be removed.

---

## 1. Product scope derived from the design

| Screen | Capabilities the backend must support |
|---|---|
| **Today Dashboard** | Per-baby daily summary: latest weight/height/BMI with WHO percentile, milk intake vs. daily target, sleep total (naps + night), last feed, diaper counts (wet/dirty), quick-log actions, today's feeding timeline, next-vaccine hint |
| **Milk & Feeding Tracker** | Feed logs (bottle formula, bottle expressed, nursing with left/right durations, solids), day/week/month analytics, daily volume bars split breast vs. formula, avg interval, night feeds, target-met days, filters, CSV/share export |
| **Growth & BMI Tracker** | Measurements (weight, height, head circumference), BMI computation, WHO percentile (weight-for-age, length-for-age, BMI-for-age, head-circ-for-age; boys/girls 0–24m), history with deltas, chart series with 3/15/50/85/97 bands |
| **Vaccination Tracker** | Vaccine schedule per baby (Vietnam EPI schedule), status (completed / due soon / upcoming / deferred), record a shot (lot, expiry, site, provider), book/remind, post-shot reaction log (temp, symptoms), family summary, digital vaccine pass (QR) and daycare PDF |
| **Baby Profiles & Spaces** | Multiple babies per family, switch active baby, profile (name, DOB, sex, blood type, pediatrician, avatar), **Care Circle** (owner/caregiver roles, invites, real-time sync), clinical PDF report |

Cross-cutting: multi-baby, multi-caregiver, offline-tolerant one-tap logging (mobile), push reminders, PDF export, unit preferences (ml/oz, kg/lb, cm/in, °C/°F).

### Open questions / inconsistencies found in the design
1. Baby Cacao DOB differs across screens (Apr 18 2024 vs Aug 14 2024; growth history dates are in 2023). Treated as mock data; `dateOfBirth` is the single source of truth.
2. Blood type is "O+" on one screen and "A Positive" on another — same mock-data issue.
3. Region: the design shows US artifacts ("CAIR2 State Registry", °F, AAP, "Dr. S. Jenkins"). **Decision: Vietnam first** — the vaccine schedule is the Vietnam EPI + recommended private schedule (§4.9), default locale `vi`, units metric (ml, kg, cm, °C), timezone `Asia/Ho_Chi_Minh`, AWS region `ap-southeast-1` (Singapore). The US registry/AAP/°F elements in the mockups should be replaced in the UI.
4. "Real-time sync" for the Care Circle: **Decision: SSE in v1** (§5.3). Offline writes are replayed via `clientId` idempotency; no CRDT.
5. Registry sync ("CAIR2 Synchronized") is **out of scope for v1**; no public Vietnam immunization-registry integration is assumed.

---

## 2. Architecture overview

```
 Mobile app (iOS/Android)
        │ HTTPS (JSON, JWT)
        ▼
   Route 53 ──► ALB (TLS, WAF) ──► ECS Fargate service  "nuoiem-api"  (NestJS, 2+ tasks, private subnets)
                                        │            │             │
                                        │            │             └─► SQS "nuoiem-jobs" ──► ECS Fargate service "nuoiem-worker"
                                        │            │                                        (PDF export, reminders, digests)
                                        │            └─► S3 (avatars, generated PDFs; presigned URLs)
                                        ▼
                                MongoDB (Atlas on PrivateLink, or self-managed — see §4.1)
                                ElastiCache Redis (rate limiting, refresh-token denylist, SSE pub/sub)  [required for SSE]
        Secrets Manager / SSM  ·  CloudWatch Logs/Alarms  ·  ECR  ·  SES (email)  ·  SNS/FCM+APNs (push)
```

- **Modular monolith** (single NestJS codebase, one Docker image) run in two ECS services: `api` (HTTP) and `worker` (SQS consumer; same image, different command). Splitting into microservices is not justified at this scale.
- Stateless API tasks; all state in MongoDB / S3 / Redis.
- URI-versioned REST: `/v1/...`. Swagger at `/docs` (disabled in prod or behind auth).

### NestJS module layout
```
src/
  main.ts, app.module.ts
  config/            # typed config + env validation (fail fast)
  common/            # guards, decorators, filters, interceptors, pipes, pagination, units
  auth/              # register/login/refresh/logout, JWT strategy, OAuth (Google/Apple)
  users/
  babies/            # baby profiles
  care-circle/       # memberships + invitations
  feeds/
  sleep/
  diapers/
  growth/            # measurements + WHO percentile engine
  vaccines/          # schedule templates + records + reactions
  dashboard/         # read-only aggregation for Today screen
  analytics/         # feeding analytics
  reports/           # PDF export (worker)
  notifications/     # device tokens, reminders
  health/            # /health/live, /health/ready
```

---

## 3. Authentication & authorization strategy

### 3.1 Authentication
- **Identity**: email + password (argon2id) **and** social sign-in (Google, Apple — Apple is mandatory on iOS if any social login is offered). Social login = mobile app sends provider ID token → backend verifies against provider JWKS → issues own tokens.
- **Tokens** (self-issued, `@nestjs/jwt`):
  - **Access token**: JWT, RS256/EdDSA (key in Secrets Manager, `kid` header for rotation), **15 min** TTL. Claims: `sub` (userId), `sid` (session id), `iat/exp`. No role claims — roles are per-baby and checked from DB (avoids stale permissions when the Care Circle changes).
  - **Refresh token**: opaque 256-bit random, **30 days**, stored **hashed (SHA-256)** in `sessions` collection, **rotated on every use** with reuse detection (a replayed old token revokes the whole session family).
  - Sessions are per-device: users can list/revoke devices.
- **Why not Cognito?** Cognito is a fair alternative (less code, managed MFA/social). Chosen self-managed because Care Circle invites, per-baby authz and a single Mongo-backed user store are simpler without a second identity system. *Revisit if MFA/SSO requirements appear.*
- **Password rules**: min 10 chars, breached-password check (HIBP k-anonymity) optional; login throttling (5 failures / 15 min / account+IP); generic error messages; email verification and password reset via single-use, 1h-expiry hashed tokens delivered by SES.
- Transport: TLS only; `helmet`, strict CORS allow-list (web admin/PDF viewer only; native app is unaffected).

### 3.2 Authorization (RBAC scoped to a baby)
Membership document links `user ↔ baby` with a role. Guard chain: `JwtAuthGuard` → `BabyAccessGuard` (loads membership for `:babyId`) → `@Roles()` / permission check.

| Permission | Owner | Caregiver |
|---|:-:|:-:|
| Read all baby data | ✓ | ✓ |
| Log feed / diaper / sleep | ✓ | ✓ |
| Add growth measurement | ✓ | ✓ |
| Record vaccine / reaction | ✓ | ✓ (configurable) |
| Edit baby profile | ✓ | – |
| Invite / remove members, change roles | ✓ | – |
| Delete baby / export clinical PDF | ✓ | export only |

v1 has two roles only (**Owner, Caregiver**), as in the design. A read-only Viewer role is deferred; the `role` enum can be extended later.

The design shows "Owner — Full Admin • All Children" and "Caregiver — Can log feeds, diaper & sleep" plus a scoped nanny ("Feeding logger • Weekday shifts"). To support this, a membership carries optional `permissions[]` overrides (e.g. `["feed:write"]`) and optional `schedule` (informational in v1, enforced later).

A caregiver may be a member of **some** of a family's babies and not others; access is always evaluated per baby, never per "family".

### 3.3 Invitations
`POST /v1/babies/:babyId/invitations` → creates invitation (email, role, 7-day expiry, hashed single-use token) → email with deep link. Accepting requires being authenticated (register if new) and the token. Owner can revoke pending invites.

### 3.4 Other security controls
- Data is children's health data → treat as sensitive PII (GDPR-style; HIPAA not assumed — confirm with legal): encryption in transit and at rest (KMS), least-privilege IAM, no PII in logs (redaction in pino), audit log for membership changes / exports / deletions.
- Account deletion and baby data export endpoints (data-subject rights); soft-delete then hard-delete after 30 days via worker.
- Rate limiting: `@nestjs/throttler` (global 100 req/min/user; stricter on auth). Redis store (shared across tasks), plus WAF rate rules at the ALB.
- Input validation: existing global `ValidationPipe({ whitelist: true, transform: true })`; add `forbidNonWhitelisted: true`.
- Idempotency (see §5.3) to prevent duplicate logs from flaky mobile networks.

---

## 4. Database design (MongoDB)

### 4.1 Engine choice
Keep **MongoDB** (already scaffolded with Mongoose 9, `mongo:7` in docker-compose). For production use **MongoDB Atlas on AWS** (M10+ replica set, same region as ECS, PrivateLink, PITR backups). *Amazon DocumentDB is not recommended*: it is Mongo-API-compatible only up to a subset, and lacks features such as full time-series collections and some aggregation operators this design uses.

### 4.2 Conventions
- `_id: ObjectId`; timestamps `createdAt/updatedAt` (Mongoose `timestamps: true`); soft delete via `deletedAt` where noted.
- All instants stored as UTC `Date`. Each baby has a `timezone` (IANA) used to compute "today"/day buckets server-side.
- Canonical units stored in SI-ish: **ml**, **kg**, **cm**, **°C**. Display units are per-user preference (`oz`, `lb`, `in`, `°F` converted at the API edge via a `units` query/header or user setting). This avoids the dual-unit data drift visible in the design (160 ml / 5.4 oz).
- Every baby-scoped document has `babyId` and **every query includes it** (tenant isolation point). Compound indexes lead with `babyId`.

### 4.3 `users`
```ts
{
  _id, email (unique, lowercased), emailVerifiedAt?, passwordHash?,   // null for social-only
  displayName, avatarKey?, locale, unitPrefs: { volume:'ml'|'oz', weight:'kg'|'lb', length:'cm'|'in', temp:'C'|'F' },
  providers: [{ provider:'google'|'apple', providerUserId }],
  activeBabyId?,                       // "Active Space" in the design (also client-side cached)
  status: 'active'|'deleted', deletedAt?, createdAt, updatedAt
}
// indexes: {email:1} unique; {'providers.provider':1,'providers.providerUserId':1} unique sparse
```

### 4.4 `sessions` (refresh tokens)
```ts
{ _id, userId, familyId /* rotation chain */, tokenHash, deviceName, platform, pushToken?, ip, userAgent,
  expiresAt, revokedAt?, replacedBy?, lastUsedAt }
// indexes: {tokenHash:1} unique; {userId:1}; {expiresAt:1} TTL (expireAfterSeconds: 0)
```

### 4.5 `babies`
```ts
{
  _id, name, nickname?, dateOfBirth, sex:'male'|'female', timezone,
  bloodType?: 'A+'|'A-'|'B+'|'B-'|'AB+'|'AB-'|'O+'|'O-',
  pediatrician?: { name, phone?, clinic? },
  avatarKey?, birthWeightKg?, birthLengthCm?, gestationalAgeWeeks?,     // prematurity matters for WHO age correction
  dailyMilkTargetMl: number (default 850),
  registryId?, ownerUserId, deletedAt?, createdAt, updatedAt
}
// index: {ownerUserId:1}
```

### 4.6 `babyMembers` (Care Circle)
```ts
{ _id, babyId, userId, role:'owner'|'caregiver', permissions?: string[], note?: 'Nanny • Weekday shifts',
  invitedBy, createdAt }
// indexes: {babyId:1,userId:1} unique; {userId:1}
```
### 4.7 `invitations`
```ts
{ _id, babyId, email, role, permissions?, tokenHash, invitedBy, expiresAt, acceptedAt?, revokedAt? }
// indexes: {tokenHash:1} unique; {babyId:1,email:1}; {expiresAt:1} TTL
```

### 4.8 Tracking logs
All log collections share: `_id, babyId, loggedBy(userId), occurredAt (Date, UTC), notes?, clientId (uuid, unique with babyId → idempotency), deletedAt?, createdAt, updatedAt`.

**`feeds`**
```ts
{
  ...common,
  type: 'bottle_formula'|'bottle_expressed'|'nursing'|'solids',
  volumeMl?,                                  // bottle
  brand?,                                     // "Enfamil A+"
  durationMin?, nursing?: { leftMin, rightMin },   // nursing
  solids?: { food, stage?, amountG?, amountTbsp?, reaction?: 'loved'|'neutral'|'disliked'|'allergic_suspected' },
  status?: 'finished'|'partial'|'refused', mood?, tags?: string[]  // "Burped well"
}
// indexes: {babyId:1, occurredAt:-1}; {babyId:1, clientId:1} unique
```
Breast-vs-formula volume split in analytics: `bottle_expressed` + (nursing estimated volume, if provided) → "breast"; `bottle_formula` → "formula". Nursing volume is not measurable; the design shows "120 ml Nursing", so allow optional `estimatedVolumeMl` for nursing and include it only when present.

**`sleeps`**: `{ ...common(occurredAt = start), endedAt?, kind:'nap'|'night', durationMin (derived on end), quality? }` — index `{babyId:1, occurredAt:-1}`; an "awake since" is derived from the latest `endedAt`. Running timer = a sleep with no `endedAt` (at most one open per baby).

**`diapers`**: `{ ...common, kind:'wet'|'dirty'|'mixed', color?, consistency?, rash?:boolean }`.

**`growthMeasurements`**
```ts
{ ...common (occurredAt = measuredAt), weightKg?, heightCm?, headCircCm?,
  bmi (derived: kg / m²), ageDays (derived),
  percentiles: { weightForAge?, lengthForAge?, bmiForAge?, headCircForAge? },   // derived, WHO LMS, cached
  zScores: { ... }, source:'parent'|'clinic' }
// indexes: {babyId:1, occurredAt:-1}
```
Percentiles are computed on write (and recomputed if `dateOfBirth`/`sex` is edited) using the WHO LMS tables (§5.5). Deltas shown in history ("+0.6 kg") are computed at read time vs. the previous measurement.

### 4.9 Vaccines
- **`vaccineScheduleTemplates`** (seed data, versioned, region-specific). v1 ships `VN-EPI-2026`: the national Expanded Programme on Immunization (free vaccines, e.g. BCG, HepB birth dose, DPT-VGB-Hib, OPV/IPV, measles/MR, JE) plus the commonly recommended paid vaccines (6-in-1, rotavirus, pneumococcal, meningococcal, influenza, varicella, MMR, HepA). **Seed content must be verified against the current Ministry of Health (Bộ Y tế) schedule before launch — it has not been validated.** Names stored in `vi` and `en`. Shape: `{ code:'VN-EPI-2026', isFree, name:{vi,en}, items:[{ vaccineCode, name, doseNumber, series, minAgeDays, recommendedAgeDays, maxAgeDays?, intervalFromPreviousDays?, notes }] }`.
- **`babyVaccines`** (materialized per baby when created or when template is chosen):
```ts
{ _id, babyId, templateCode, vaccineCode, name, doseNumber, series, milestone:'birth-2m'|'4m'|'6m'|'9m-12m'|'travel',
  status:'upcoming'|'due_soon'|'due'|'completed'|'deferred'|'skipped',     // 'due_soon/due' derived at read time from dates; stored: upcoming|completed|deferred|skipped
  dueFrom: Date, dueBy: Date,
  administration?: { administeredAt, site:'left_thigh'|'right_thigh'|'left_arm'|'right_arm'|'oral', provider, lot, expiresAt?, manufacturer?, recordedBy },
  appointment?: { at, location?, reminderIds? }, isCustom: boolean, deferredUntil?, notes? }
// indexes: {babyId:1, dueBy:1}; {babyId:1, status:1}
```
- **`vaccineReactions`**: `{ _id, babyId, babyVaccineIds:[...], recordedAt, temperatureC?, symptoms:['fussiness','site_redness','mild_swelling','sleepy','low_appetite', ...], notes?, recordedBy }`.
- Overall "75% Protected / 9 of 12" = completed ÷ total in the *first-year* series; computed at read time.

### 4.10 Supporting collections
- `deviceTokens` (or embedded in `sessions`): `{ userId, platform, token, lastSeenAt }`.
- `reports`: `{ _id, babyId, type:'pediatric_pdf'|'vaccine_certificate'|'feeding_csv', params, status:'queued'|'done'|'failed', s3Key?, requestedBy, expiresAt }` (TTL cleanup of S3 objects via lifecycle rule).
- `auditLogs`: `{ actorId, babyId?, action, target, ip, at }` (90-day TTL, or longer per compliance).
- `idempotencyKeys`: only if we want header-level idempotency beyond `clientId` (TTL 24 h).
- Static reference data (WHO LMS tables) ships **in the codebase as JSON**, not in the DB.

### 4.11 Aggregation / performance
- Dashboard and analytics use aggregation pipelines over `{babyId, occurredAt}` ranges (small data per baby: ~10 feeds/day ≈ 3.6k/yr), so on-the-fly aggregation with the compound index is sufficient. No pre-aggregation in v1.
- Day boundaries use baby timezone: `$dateTrunc`/`$dateToString` with `timezone`.
- If volume grows, promote `feeds` to a Mongo time-series collection or add a `dailyStats` rollup collection maintained by the worker.

### 4.12 Transactions & consistency
Single-document writes are the norm. Multi-document operations (accept invite → create member + mark invite; delete baby cascade) use Mongo transactions (requires replica set — Atlas, and `docker-compose` should be changed to run Mongo with `--replSet rs0` for local dev).

---

## 5. API design

### 5.1 Conventions
- Base: `https://api.<domain>/v1`. JSON only. `Authorization: Bearer <access-token>`.
- Baby-scoped resources are nested: `/v1/babies/:babyId/...`.
- Pagination: cursor-based — `?limit=20&cursor=<opaque>`; response `{ data: [...], nextCursor }`.
- Filtering by time: `?from=2026-10-01T00:00:00Z&to=...` or `?date=2026-10-22` (interpreted in baby's timezone).
- Units: responses are canonical metric plus a `display` object when the user prefers other units, e.g. `{ "volumeMl": 160, "display": { "volume": 5.4, "unit": "oz" } }`.
- Errors (RFC 7807-style): `{ "type": "...", "title": "...", "status": 422, "code": "VALIDATION_ERROR", "errors": [{ "field": "volumeMl", "message": "..." }], "requestId": "..." }`.
- Idempotency: every create accepts `clientId` (UUID, generated by the app); a duplicate returns the original resource with `200` instead of creating again.
- Optimistic concurrency on edit: `If-Match: <version>` (Mongoose `__v`) → `412` on mismatch (only for profile/ vaccine edits; logs are last-write-wins).
- Standard codes: 200/201/204, 400, 401, 403, 404, 409, 412, 422, 429.

### 5.2 Endpoint catalogue

**Auth** (`/v1/auth`)
| Method | Path | Notes |
|---|---|---|
| POST | `/register` | `{email,password,displayName}` → `{user, accessToken, refreshToken}` |
| POST | `/login` | email + password |
| POST | `/social/google`, `/social/apple` | `{idToken}` |
| POST | `/refresh` | `{refreshToken}` → rotated pair |
| POST | `/logout` | revoke current session |
| POST | `/logout-all` | revoke all sessions |
| POST | `/verify-email`, `/forgot-password`, `/reset-password` | single-use tokens |
| GET | `/sessions` / DELETE `/sessions/:id` | device management |

**Me** (`/v1/me`): `GET`, `PATCH` (name, locale, unitPrefs, activeBabyId), `DELETE` (account deletion), `PUT /devices` (push token), `GET /export` (data export).

**Babies & Care Circle**
| Method | Path | Description |
|---|---|---|
| GET | `/babies` | All babies the user can access, with role + mini daily pulse (milk today, weight, BMI) — powers the "Family Nursery" screen |
| POST | `/babies` | Create baby (+ owner membership + vaccine schedule materialization) |
| GET / PATCH / DELETE | `/babies/:babyId` | Profile |
| POST | `/babies/:babyId/avatar-upload` | Returns presigned S3 PUT URL; client then PATCHes `avatarKey` |
| GET | `/babies/:babyId/members` | Care Circle list |
| PATCH / DELETE | `/babies/:babyId/members/:userId` | Change role/permissions; remove (owner), or leave (self) |
| POST | `/babies/:babyId/invitations` | Invite by email |
| DELETE | `/babies/:babyId/invitations/:id` | Revoke |
| POST | `/invitations/accept` | `{token}` |

**Dashboard** — `GET /babies/:babyId/dashboard?date=` → single aggregated payload for the Today screen:
```jsonc
{
  "baby": { "id": "...", "name": "Cacao", "ageLabel": "6 mos 12 days" },
  "growth": { "weightKg": 7.8, "weightPercentile": 54, "heightCm": 67.5, "heightPercentile": 60, "bmi": 17.1, "bmiCategory": "optimal" },
  "milk": { "totalMl": 720, "targetMl": 850, "progress": 0.85, "feedCount": 5, "lastFeed": { "at": "...", "volumeMl": 160, "type": "bottle_formula", "durationMin": 15 } },
  "sleep": { "totalMin": 690, "naps": 2, "nightMin": 480, "awakeSince": "...", "targetMet": true },
  "diapers": { "total": 7, "wet": 5, "dirty": 2 },
  "feedTimeline": [ /* last N feeds */ ],
  "vaccines": { "next": { "name": "...", "dueBy": "...", "daysLeft": 90 } },
  "tip": null
}
```

**Feeds** — `POST/GET /babies/:babyId/feeds` (filters: `from,to,type,date`), `GET/PATCH/DELETE .../feeds/:id`.
**Feeding analytics** — `GET /babies/:babyId/feeds/analytics?range=day|week|month&anchor=2026-10-22` →
```jsonc
{
  "totals": { "volumeMl": 5480, "feeds": 38, "avgDailyMl": 782, "avgFeedMl": 145, "deltaPct": 5 },
  "daily": [ { "date": "...", "breastMl": 430, "formulaMl": 290, "totalMl": 720, "targetMl": 800 } ],
  "distribution": { "breastMl": 3310, "formulaMl": 2170, "breastPct": 60.4, "formulaPct": 39.6 },
  "avgIntervalMin": 195, "nightFeedsPerNight": 1.2, "daysTargetMet": 5, "daysInRange": 7
}
```
**Sleep** — `POST /babies/:id/sleeps` (start), `PATCH .../sleeps/:id` (end/edit), `GET` list, `DELETE`.
**Diapers** — standard CRUD list/create/delete.
**Growth**
| Method | Path |
|---|---|
| POST | `/babies/:id/growth` — returns record with BMI + percentiles ("Save & Recalculate BMI") |
| GET | `/babies/:id/growth` — history with deltas |
| PATCH / DELETE | `/babies/:id/growth/:mid` |
| GET | `/babies/:id/growth/chart?metric=weight\|height\|bmi\|headCirc` — baby points + WHO curve (3/15/50/85/97) for the baby's sex, 0–24 m |

**Vaccines**
| Method | Path | Description |
|---|---|---|
| GET | `/babies/:id/vaccines?milestone=&status=` | List with computed status + summary `{completed, dueSoon, upcoming, protectedPct}` |
| POST | `/babies/:id/vaccines` | Add custom/booster/travel vaccine |
| POST | `/babies/:id/vaccines/:vid/administer` | "Record Shot" |
| POST | `/babies/:id/vaccines/:vid/defer` | `{until, reason}` |
| PUT | `/babies/:id/vaccines/:vid/appointment` | Book (stores appt + schedules reminder) |
| PUT / DELETE | `/babies/:id/vaccines/:vid/reminder` | "Remind" |
| POST / GET | `/babies/:id/vaccine-reactions` | Post-shot log |
| GET | `/babies/:id/vaccine-pass` | Pass payload + signed QR token (short-lived, verifiable URL) |
| GET | `/family/vaccine-summary` | Cross-baby summary card |

**Reports / Export** (async)
`POST /babies/:id/reports` `{type:'pediatric_pdf', rangeMonths:6}` → `202 {reportId}` → `GET /reports/:id` (`status`, presigned download URL, 15-min expiry). Also `GET /babies/:id/feeds/export.csv` (small, sync).

**Ops**: `GET /health/live`, `GET /health/ready` (Mongo ping), `GET /version`. Not behind auth, not routed publicly except ALB health check.

### 5.3 Real-time / sync for the Care Circle
**SSE in v1.** `GET /v1/babies/:babyId/events` (`text/event-stream`, bearer-authenticated; native clients can set headers) streams small events — `feed.created`, `sleep.updated`, `growth.created`, `vaccine.administered`, `member.changed` — each `{id, type, babyId, resourceId, actorId, at}`; clients refetch the resource. `Last-Event-ID` replay from a short Redis stream (~5 min / 200 events) so reconnects don't miss logs.
- **Redis (ElastiCache) is required in v1** for cross-task fan-out (pub/sub + streams); otherwise a log written on task A would not reach a subscriber on task B.
- ALB idle timeout 120 s; server sends `: keepalive` every 25 s; client reconnects with backoff. Per-user connection cap (e.g. 5); server closes the stream at access-token expiry and the client reconnects with a fresh token.
- Push notifications (FCM/APNs) remain for background delivery (vaccine reminders, optional "caregiver logged a feed"). Offline mobile writes are replayed using `clientId` idempotency.

### 5.4 Reminders & jobs (worker)
SQS + EventBridge Scheduler: vaccine due-soon reminders (T-14d, T-3d, day-of), unread-appointment reminders, "daily digest", report generation, soft-delete purge, session cleanup (TTL handles most).

### 5.5 WHO percentile engine
Bundle WHO Child Growth Standards LMS tables (weight-, length-, BMI-, head-circumference-for-age, boys/girls 0–24 m; daily or monthly granularity). `z = ((x/M)^L − 1)/(L·S)` (L≠0), `percentile = Φ(z)·100`. Pure functions in `growth/who/`, unit-tested against published values. Use corrected age for premature babies (<37 weeks) until 24 months.

---

## 6. Configuration & environments

| Env | Purpose | Notes |
|---|---|---|
| `local` | docker-compose (Mongo replica set), `.env` | |
| `staging` | Mirrors prod at 1 task, Atlas M10 | auto-deploy from `main` |
| `prod` | 2+ tasks across 2 AZs | manual approval gate |

Env vars (validated with Joi/zod in `ConfigModule` at startup): `NODE_ENV, PORT, REDIS_URL, DEFAULT_LOCALE=vi, DEFAULT_TZ=Asia/Ho_Chi_Minh, MONGODB_URI (secret), JWT_PRIVATE_KEY/JWT_PUBLIC_KEY (secrets), JWT_ACCESS_TTL, REFRESH_TTL_DAYS, S3_BUCKET, AWS_REGION, SQS_QUEUE_URL, SES_FROM, GOOGLE_CLIENT_IDS, APPLE_CLIENT_ID, APP_BASE_URL, LOG_LEVEL`.
Secrets via **AWS Secrets Manager** injected into the task definition (`secrets:` block), plain config via SSM Parameter Store/env.

---

## 7. Deployment to AWS ECS (Fargate)

### 7.1 Infrastructure (IaC: Terraform or AWS CDK — recommend **CDK (TypeScript)** to match the codebase)
- **Network**: VPC, 2 AZs, public subnets (ALB, NAT), private subnets (tasks). VPC endpoints for S3, ECR, CloudWatch Logs, Secrets Manager, SQS to cut NAT cost. Atlas PrivateLink (or VPC peering) to MongoDB.
- **ECR**: repo `nuoiem-server`, scan-on-push, lifecycle policy (keep last 20 images).
- **ECS cluster** (Fargate), two services:
  - `nuoiem-api`: 0.5 vCPU / 1 GB to start, desired 2, autoscale 2→6 on CPU 60% / ALB `RequestCountPerTarget`; `healthCheckGracePeriod 30s`; deployment circuit breaker with rollback; min healthy 100 / max 200%.
  - `nuoiem-worker`: 0.25 vCPU / 512 MB (PDF rendering may need 1 GB — Puppeteer/Chromium vs. `pdfkit`; prefer **pdfkit** to avoid headless Chrome), desired 1, scale on SQS queue depth.
- **ALB**: HTTPS 443 (ACM cert), HTTP→HTTPS redirect, target group health check `GET /health/live`, deregistration delay 30 s, **AWS WAF** (managed common rules + rate-based rule for `/v1/auth/*`).
- **Route 53** `api.<domain>` → ALB alias.
- **IAM**: separate *task execution role* (pull image, read secrets, write logs) and *task roles* (api: S3 bucket prefix, SQS send, SES send; worker: S3, SQS receive/delete). Least privilege, no wildcards.
- **Data**: S3 bucket (private, SSE-KMS, block public access, lifecycle expiry for `reports/` after 7 d), SQS queue + DLQ, Redis (ElastiCache, SSE + throttling), SES verified domain.
- **Observability**: CloudWatch Logs (JSON via `pino`, 30-day retention), Container Insights, alarms → SNS: 5xx rate, p95 latency, unhealthy hosts, task restarts, SQS DLQ depth, Mongo connection errors; X-Ray/OpenTelemetry optional; request-id middleware propagated to logs and error responses.

### 7.2 Container image
Multi-stage Dockerfile, Node 24 LTS (matches `@types/node ^24`), ESM build.
```dockerfile
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache tini && addgroup -S app && adduser -S app -G app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3000/health/live || exit 1
ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","dist/main.js"]          # worker overrides: ["node","dist/worker.js"]
```
Required app changes before deploy: `app.enableShutdownHooks()` (graceful SIGTERM — ECS gives 30 s), `app.set('trust proxy', 1)` behind ALB, bind `0.0.0.0`, add `.dockerignore`, health module.

### 7.3 CI/CD (GitHub Actions)
1. **PR**: `npm ci` → `lint` (oxlint) → `test` → `test:e2e` (Mongo service container) → `build` → `docker build` + Trivy scan.
2. **Merge to `main`**: build image tagged with git SHA → push to ECR (GitHub **OIDC** role, no long-lived AWS keys) → render ECS task definition with new image → deploy to **staging** → smoke test (`/health/ready`, auth round-trip).
3. **Release tag / manual approval**: deploy to **prod** (rolling update via ECS deployment controller with circuit breaker; blue/green with CodeDeploy is an option if zero-downtime canary is needed).
4. Database migrations: Mongo is schemaless, but index creation and data backfills are run by a one-off **ECS task** (`node dist/migrate.js`, e.g. `migrate-mongo`) as a pipeline step *before* the service update; `autoIndex` disabled in prod.

### 7.4 Backup / DR / cost notes
- Atlas continuous backup with PITR (≥7 days); S3 versioning on report/avatar bucket optional.
- RPO ≤ 5 min, RTO ≤ 1 h target. Multi-AZ by default (ALB, ECS, Atlas replica set).
- Rough starting cost (single env, `ap-southeast-1`): 2×Fargate 0.5/1 GB (~$30), worker (~$10), ALB (~$20), NAT (~$35, avoidable with endpoints/public-subnet tasks in staging), Atlas M10 (~$60), ElastiCache t4g.micro (~$12), misc (~$10) → **~$160–215/mo prod**, staging ~$80 if scaled down.

---

## 8. Testing & quality
- Unit: WHO percentile functions, unit conversions, status derivation (due_soon), analytics aggregations (pure logic extracted from pipelines).
- Integration/e2e (Vitest + supertest + `mongodb-memory-server` replica set or compose Mongo): auth flows incl. refresh-reuse detection, authorization matrix per role, idempotent create.
- Contract: OpenAPI generated by `@nestjs/swagger` committed/published as an artifact so the mobile client can generate types.
- Load sanity (k6) on dashboard endpoint before launch.

## 9. Delivery plan (suggested milestones)
1. **Foundation**: config validation, health, logging, error format, Dockerfile, CDK stack + CI to staging, remove `items` module.
2. **Auth & users**: register/login/refresh/logout, sessions, email flows, social login.
3. **Babies & Care Circle**: profiles, memberships, invitations, authz guards.
4. **Feeds, sleep, diapers** + **Dashboard** + **Feeding analytics**.
5. **Growth** + WHO engine + chart endpoint.
6. **Vaccines** + reminders (worker) + reactions + pass.
7. **Reports (PDF)**, notifications, data export/deletion, hardening (WAF, alarms, load test).

## 10. Decisions (confirmed)
| # | Question | Decision |
|---|---|---|
| 1 | Market | **Vietnam first** → VN EPI schedule, `vi` locale (+`en`), metric units, `Asia/Ho_Chi_Minh`, region `ap-southeast-1` |
| 2 | Auth | **Self-managed JWT** (email/password; Google + Apple sign-in) |
| 3 | MongoDB hosting | No preference → **Atlas** (default, §4.1) |
| 4 | Real-time | **SSE** in v1 (adds Redis, §5.3) |
| 5 | Compliance | Not now. Note: health data of minors is sensitive personal data under Vietnam's PDPD (Decree 13/2023) — revisit before public launch (consent, data residency, breach notice) |
| 6 | IaC / accounts | Not now → default **CDK**, single AWS account with separate staging/prod stacks |
| 7 | Roles | Interpreted as **Owner + Caregiver only, no Viewer** (as in the design). Tell me if you meant Owner-only with no caregivers. |

Remaining open items: vaccine schedule seed content must be verified against the current MoH schedule; the mockups need Vietnam adaptation (language, °C, no CAIR2).
