# Nuôi Em — server

NestJS 12 + MongoDB API for the Nuôi Em baby-tracking app. Design: [`docs/technical-design.md`](docs/technical-design.md).

## Local development
```bash
cp .env.example .env
docker compose up -d        # MongoDB single-node replica set on :27017
npm install
npm run start:dev           # http://localhost:3000 — Swagger at /docs, health at /health/live|ready
```

| Script | Purpose |
|---|---|
| `npm test` / `npm run test:e2e` | unit / e2e (Vitest) |
| `npm run lint` | oxlint |
| `npm run build` | compile to `dist/` |

Configuration is validated at startup (`src/config/env.validation.ts`); the app refuses to boot on invalid env.

## Docker
```bash
docker build -t nuoiem-server .
docker run -p 3000:3000 -e MONGODB_URI=... nuoiem-server
```

## Deployment (AWS ECS Fargate)
Infrastructure lives in `infra/` (AWS CDK). Staging: VPC, ECR, ECS cluster, ALB + Fargate service, Secrets Manager entry for `MONGODB_URI`.
```bash
cd infra && npm install
npx cdk bootstrap                     # once per account/region
npx cdk deploy -c certificateArn=<acm-arn> -c domainName=api-staging.example.com \
  -c githubRepo=<owner>/nuoiem-server -c githubOidcProviderArn=<arn>
aws secretsmanager put-secret-value --secret-id nuoiem/staging/MONGODB_URI --secret-string '<atlas uri>'
```
Then set the GitHub repo variables listed in `.github/workflows/deploy-staging.yml` (stack outputs provide the values). Every push to `main` builds the image, pushes to ECR and rolls the service.
