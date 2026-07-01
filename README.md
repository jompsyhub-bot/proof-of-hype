# Proof of Hype Backend MVP

Production-ready MVP base for a Solana meme coin viral airdrop tool.

It serves the public build-in-progress site, the demo app console, API docs, and the backend API from one Node service.

## What It Includes

- Campaign table for Solana meme launches.
- Creator table with X identity and Solana wallet binding.
- X OAuth 2.0 PKCE start/callback endpoints.
- X recent-search ingestion endpoint.
- Mock ingestion endpoint for local demos.
- Scoring worker with CA, holder, engagement, duplicate, and farm-risk signals.
- Leaderboard endpoint.
- SPL payout JSON and CSV export.
- Public progress page at `/`.
- Demo operator console at `/app`.
- API docs page at `/docs`.
- Docker and Render deployment files.

## Run

```bash
npm start
```

The server defaults to `http://localhost:8787`.

Node 24+ is required because the MVP uses the built-in `node:sqlite` module.

Public pages:

```text
GET /
GET /app
GET /docs
GET /api/progress
GET /api/setup
```

## Production Controls

Campaign creation is self-serve. When a user creates a campaign, the API returns a one-time `ownerToken`. The operator console stores it locally and sends it as `x-campaign-token` for campaign-level actions such as ingestion and scoring.

Set `ADMIN_TOKEN` in production for platform-level operations. The operator console sends it as `x-admin-token` for sample seeding and admin overrides.

Without `ADMIN_TOKEN`, production write routes return `admin_token_not_configured`.

## Useful Endpoints

```text
GET  /health
GET  /api/progress
POST /campaigns
GET  /campaigns
GET  /campaigns/:id
POST /creators
POST /creators/:id/wallet/challenge
POST /creators/:id/wallet/bind
GET  /auth/x/start?creatorId=:id
GET  /auth/x/callback
POST /ingest/mock
POST /ingest/x
POST /demo/seed
POST /workers/score
GET  /campaigns/:id/leaderboard
GET  /campaigns/:id/payouts
GET  /campaigns/:id/payouts.csv
```

## Quick Local Demo

Create a campaign:

```bash
curl -X POST http://localhost:8787/campaigns \
  -H "content-type: application/json" \
  -d "{\"name\":\"$WAGMI launch raid\",\"tag\":\"$WAGMI\",\"tokenMint\":\"WAGM1meme9xPumpExampleMintAddr7QFvR2\",\"launchVenue\":\"Pump.fun\",\"rewardPoolRaw\":420000000,\"ownerWallet\":\"SoLDeployerWalletExample\"}"
```

Seed mock posts:

```bash
curl -X POST http://localhost:8787/ingest/mock \
  -H "content-type: application/json" \
  -d "{\"campaignId\":1}"
```

Score and build payouts:

```bash
curl -X POST http://localhost:8787/workers/score \
  -H "content-type: application/json" \
  -d "{\"campaignId\":1}"
```

Export payout CSV:

```bash
curl http://localhost:8787/campaigns/1/payouts.csv
```

Or use the demo seed endpoint:

```bash
curl -X POST http://localhost:8787/demo/seed
```

## X Setup

Set these values before using real X OAuth and ingestion:

```text
X_CLIENT_ID=
X_CLIENT_SECRET=
X_CALLBACK_URL=http://localhost:8787/auth/x/callback
X_BEARER_TOKEN=
```

`/auth/x/start` redirects creators to X. `/auth/x/callback` stores the returned X user profile and token metadata.

`/ingest/x` searches recent posts for the campaign tag and token mint, then stores metrics for scoring.

## Wallet Binding

For production, submit a real Solana wallet signature to:

```text
POST /creators/:id/wallet/bind
```

The server supports Ed25519 verification for base58 Solana signatures where available in Node WebCrypto. During local MVP work, `ALLOW_UNVERIFIED_WALLET_BINDING=true` accepts the nonce challenge flow without a real wallet adapter.

## Deploy

The repo includes:

```text
Dockerfile
render.yaml
```

For a first public beta, deploy the Docker service and set:

```text
PUBLIC_BASE_URL=https://your-domain.example
ADMIN_TOKEN=generate-a-long-random-secret
X_CLIENT_ID=
X_CLIENT_SECRET=
X_CALLBACK_URL=https://your-domain.example/auth/x/callback
X_BEARER_TOKEN=
ALLOW_UNVERIFIED_WALLET_BINDING=false
HELIUS_API_KEY=
SOLANA_RPC_URL=
```

For real production traffic, move persistence from local SQLite to Postgres/Supabase or attach a persistent volume. SQLite is useful for the first visible base, but not the final multi-user production database.
