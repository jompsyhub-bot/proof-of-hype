# Deploy Proof of Hype

## Current Repo Target

```text
https://github.com/jompsyhub/proof-of-hype
```

The local Git remote is already set to:

```bash
git remote -v
```

## GitHub

Create a new GitHub repository:

```text
Owner: jompsyhub
Repository name: proof-of-hype
Visibility: public or private
Initialize with README: no
```

Then push:

```bash
git push -u origin main
```

## Render

Create a new Render Web Service from the GitHub repo:

```text
Runtime: Docker
Branch: main
Dockerfile path: ./Dockerfile
Health check path: /health
```

Environment variables:

```text
PORT=8787
PUBLIC_BASE_URL=https://your-render-url
ADMIN_TOKEN=generate-a-long-random-secret
X_CLIENT_ID=
X_CLIENT_SECRET=
X_CALLBACK_URL=https://your-render-url/auth/x/callback
X_BEARER_TOKEN=
ALLOW_UNVERIFIED_WALLET_BINDING=false
HELIUS_API_KEY=
SOLANA_RPC_URL=
```

In the hosted `/app` console, normal users can create campaigns without the platform admin token. After creation, the app shows a Campaign Owner Token. Save it because it is needed for campaign-level actions like ingestion and scoring.

Paste `ADMIN_TOKEN` only for platform-level actions such as sample seeding or admin overrides.

## First Public Smoke Test

After deployment, open:

```text
https://your-render-url/
https://your-render-url/app
https://your-render-url/docs
https://your-render-url/health
```

Then seed demo data:

```bash
curl -X POST https://your-render-url/demo/seed
```

Download payouts:

```text
https://your-render-url/campaigns/1/payouts.csv
```

## Production Note

This base uses SQLite. It is okay for a public MVP demo, but real multi-user production should use Postgres/Supabase or a persistent Render disk.
