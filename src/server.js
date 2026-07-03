const http = require("node:http");
const { URL } = require("node:url");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

loadDotEnv();

const PORT = Number(process.env.PORT || 8787);
const DB_PATH = path.resolve(process.cwd(), process.env.DATABASE_PATH || "./data/proof-of-hype.sqlite");
const PUBLIC_DIR = path.resolve(__dirname, "../public");
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const X_CALLBACK_URL = process.env.X_CALLBACK_URL || `${PUBLIC_BASE_URL}/auth/x/callback`;
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const USE_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
const ALLOW_UNVERIFIED_WALLET_BINDING = String(process.env.ALLOW_UNVERIFIED_WALLET_BINDING || "true") === "true";
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";

let db = null;
if (!USE_SUPABASE) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  initDatabase();
}

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error(error);
    sendJson(res, status, {
      error: error.code || "internal_error",
      message: error.message,
      detail: error.detail
    });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Proof of Hype backend listening on ${PUBLIC_BASE_URL}`);
    console.log(USE_SUPABASE ? "Database: Supabase/Postgres" : `SQLite database: ${DB_PATH}`);
  });
}

module.exports = { server, db, scorePost, buildPayouts };

async function sbFetch(table, options = {}) {
  if (!USE_SUPABASE) throw new Error("supabase_not_enabled");
  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  for (const [key, value] of Object.entries(options.query || {})) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      prefer: options.prefer || "return=representation",
      ...(options.headers || {})
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw httpError(response.status, "supabase_error", payload || text);
  }
  return payload;
}

async function sbSelectOne(table, query) {
  const rows = await sbFetch(table, { query: { ...query, limit: "1" } });
  return rows?.[0] || null;
}

async function sbInsert(table, body) {
  const rows = await sbFetch(table, { method: "POST", body });
  return Array.isArray(rows) ? rows[0] : rows;
}

async function sbUpdate(table, query, body) {
  const rows = await sbFetch(table, { method: "PATCH", query, body });
  return Array.isArray(rows) ? rows[0] : rows;
}

async function sbDelete(table, query) {
  return sbFetch(table, { method: "DELETE", query, prefer: "return=minimal" });
}

function eq(value) {
  return `eq.${value}`;
}

function isNull() {
  return "is.null";
}

async function route(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, PUBLIC_BASE_URL);
  const routePath = url.pathname;

  if (req.method === "GET" && routePath === "/health") {
    sendJson(res, 200, {
      ok: true,
      service: "proof-of-hype",
      niche: "solana-meme-coins",
      version: "0.1.0",
      database: USE_SUPABASE ? "supabase" : "sqlite",
      supabaseConfigured: USE_SUPABASE,
      build: "supabase-adapter"
    });
    return;
  }

  if (req.method === "GET" && routePath === "/api/progress") {
    sendJson(res, 200, await getProgress());
    return;
  }

  if (req.method === "GET" && routePath === "/api/setup") {
    sendJson(res, 200, getSetupStatus());
    return;
  }

  if (req.method === "POST" && routePath === "/campaigns") {
    const creator = await requireSession(req);
    const body = await readJson(req);
    const campaign = await createCampaign(body, creator);
    sendJson(res, 201, campaign);
    return;
  }

  if (req.method === "GET" && routePath === "/me") {
    const creator = await requireSession(req);
    sendJson(res, 200, { creator });
    return;
  }

  if (req.method === "POST" && routePath === "/auth/wallet/challenge") {
    const body = await readJson(req);
    const challenge = await createAuthWalletChallenge(body.walletAddress);
    sendJson(res, 201, { challenge });
    return;
  }

  if (req.method === "POST" && routePath === "/auth/wallet/verify") {
    const body = await readJson(req);
    const result = await verifyWalletAuth(body);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "GET" && routePath === "/campaigns") {
    const campaigns = await listCampaigns();
    sendJson(res, 200, { campaigns });
    return;
  }

  const campaignMatch = routePath.match(/^\/campaigns\/([^/]+)$/);
  if (req.method === "GET" && campaignMatch) {
    const campaign = await getCampaign(campaignMatch[1]);
    sendJson(res, 200, { campaign });
    return;
  }

  if (req.method === "POST" && routePath === "/creators") {
    requireAdmin(req);
    const body = await readJson(req);
    const creator = await createCreator(body);
    sendJson(res, 201, { creator });
    return;
  }

  const walletChallengeMatch = routePath.match(/^\/creators\/([^/]+)\/wallet\/challenge$/);
  if (req.method === "POST" && walletChallengeMatch) {
    requireAdmin(req);
    const creatorId = walletChallengeMatch[1];
    const body = await readJson(req);
    const challenge = await createWalletChallenge(creatorId, body.walletAddress);
    sendJson(res, 201, { challenge });
    return;
  }

  const walletBindMatch = routePath.match(/^\/creators\/([^/]+)\/wallet\/bind$/);
  if (req.method === "POST" && walletBindMatch) {
    requireAdmin(req);
    const creatorId = walletBindMatch[1];
    const body = await readJson(req);
    const creator = await bindWallet(creatorId, body);
    sendJson(res, 200, { creator });
    return;
  }

  if (req.method === "GET" && routePath === "/auth/x/start") {
    const creatorId = Number(url.searchParams.get("creatorId"));
    const result = await startXOAuth(creatorId);
    if (result.missingConfig) {
      sendJson(res, 200, result);
      return;
    }
    res.writeHead(302, { Location: result.authUrl });
    res.end();
    return;
  }

  if (req.method === "GET" && routePath === "/auth/x/callback") {
    const result = await handleXCallback(url.searchParams);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && routePath === "/ingest/mock") {
    const body = await readJson(req);
    await requireCampaignAccess(req, body.campaignId);
    const result = await ingestMockPosts(body.campaignId);
    sendJson(res, 201, result);
    return;
  }

  if (req.method === "POST" && routePath === "/demo/seed") {
    requireAdmin(req);
    const campaign = await ensureDemoCampaign();
    const ingested = await ingestMockPosts(campaign.id);
    const scored = await runScoringWorker(campaign.id);
    sendJson(res, 201, { campaign, ingested, scored });
    return;
  }

  if (req.method === "POST" && routePath === "/ingest/x") {
    const body = await readJson(req);
    await requireCampaignAccess(req, body.campaignId);
    const result = await ingestXPosts(body.campaignId, Number(body.maxResults || 25));
    sendJson(res, 201, result);
    return;
  }

  if (req.method === "POST" && routePath === "/workers/score") {
    const body = await readJson(req);
    await requireCampaignAccess(req, body.campaignId);
    const result = await runScoringWorker(body.campaignId);
    sendJson(res, 200, result);
    return;
  }

  const leaderboardMatch = routePath.match(/^\/campaigns\/([^/]+)\/leaderboard$/);
  if (req.method === "GET" && leaderboardMatch) {
    const leaderboard = await getLeaderboard(leaderboardMatch[1]);
    sendJson(res, 200, { leaderboard });
    return;
  }

  const payoutsMatch = routePath.match(/^\/campaigns\/([^/]+)\/payouts$/);
  if (req.method === "GET" && payoutsMatch) {
    const payouts = await getPayouts(payoutsMatch[1]);
    sendJson(res, 200, { payouts });
    return;
  }

  const payoutsCsvMatch = routePath.match(/^\/campaigns\/([^/]+)\/payouts\.csv$/);
  if (req.method === "GET" && payoutsCsvMatch) {
    const csv = await payoutsCsv(payoutsCsvMatch[1]);
    sendText(res, 200, csv, "text/csv; charset=utf-8", {
      "content-disposition": "attachment; filename=proof-of-hype-payouts.csv"
    });
    return;
  }

  if (req.method === "GET" && serveStatic(routePath, res)) {
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}

async function getProgress() {
  const stats = USE_SUPABASE
    ? await getSupabaseCounts()
    : {
        campaigns: db.prepare("SELECT COUNT(*) AS count FROM campaigns").get().count,
        creators: db.prepare("SELECT COUNT(*) AS count FROM creators").get().count,
        posts: db.prepare("SELECT COUNT(*) AS count FROM posts").get().count,
        payouts: db.prepare("SELECT COUNT(*) AS count FROM payouts").get().count
      };

  return {
    product: "Proof of Hype",
    tagline: "Verified viral airdrops for Solana meme coin launches.",
    stage: "Production foundation",
    updatedAt: new Date().toISOString(),
    stats,
    milestones: [
      { title: "Campaign database", status: "done" },
      { title: "Creator wallet binding", status: "done" },
      { title: "X OAuth surface", status: "done" },
      { title: "Mock + X ingestion", status: "done" },
      { title: "Scoring worker", status: "done" },
      { title: "Payout export", status: "done" },
      { title: "Admin-protected operations", status: ADMIN_TOKEN ? "done" : "next" },
      { title: "Real Solana holder enrichment", status: HELIUS_API_KEY ? "done" : "next" }
    ]
  };
}

async function getSupabaseCounts() {
  const counts = {};
  for (const table of ["campaigns", "creators", "posts", "payouts"]) {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=id`, {
      method: "HEAD",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        prefer: "count=exact"
      }
    });
    if (!response.ok) throw httpError(response.status, "supabase_count_error", table);
    const range = response.headers.get("content-range") || "*/0";
    counts[table] = Number(range.split("/")[1] || 0);
  }
  return counts;
}

function getSetupStatus() {
  const checks = [
    {
      key: "adminToken",
      label: "Admin token",
      configured: Boolean(ADMIN_TOKEN),
      required: true,
      detail: "Protects campaign creation, ingestion, scoring, and sample data actions."
    },
    {
      key: "xOAuth",
      label: "X OAuth",
      configured: Boolean(process.env.X_CLIENT_ID && process.env.X_CLIENT_SECRET && X_CALLBACK_URL),
      required: true,
      detail: "Connects creator X accounts for identity and future authenticated features."
    },
    {
      key: "xBearer",
      label: "X ingestion bearer token",
      configured: Boolean(process.env.X_BEARER_TOKEN),
      required: true,
      detail: "Reads recent X posts for campaign tags, token mints, and launch links."
    },
    {
      key: "solanaProvider",
      label: "Solana enrichment provider",
      configured: Boolean(HELIUS_API_KEY || process.env.SOLANA_RPC_URL),
      required: true,
      detail: "Checks token mint, holder status, balances, and wallet signals."
    },
    {
      key: "walletStrictMode",
      label: "Strict wallet verification",
      configured: !ALLOW_UNVERIFIED_WALLET_BINDING,
      required: true,
      detail: "Rejects wallet binding unless a Solana signature verifies."
    },
    {
      key: "database",
      label: "Persistent database",
      configured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) || !IS_PRODUCTION || DB_PATH.includes("/data/") || DB_PATH.includes("\\data\\"),
      required: true,
      detail: "Use Supabase/Postgres for production, or attach a persistent disk while migrating."
    },
    {
      key: "supabase",
      label: "Supabase/Postgres",
      configured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
      required: false,
      detail: "Hosted database target for creator-owned campaigns and durable sessions."
    }
  ];

  return {
    environment: IS_PRODUCTION ? "production" : "development",
    publicBaseUrl: PUBLIC_BASE_URL,
    ready: checks.every((check) => !check.required || check.configured),
    checks
  };
}

function requireAdmin(req) {
  if (!ADMIN_TOKEN && !IS_PRODUCTION) return;
  if (!ADMIN_TOKEN && IS_PRODUCTION) throw httpError(503, "admin_token_not_configured");

  const provided = req.headers["x-admin-token"] || bearerToken(req.headers.authorization);
  if (provided !== ADMIN_TOKEN) throw httpError(401, "admin_token_required");
}

async function requireSession(req) {
  const creator = await getSessionCreator(req);
  if (!creator) throw httpError(401, "wallet_session_required");
  return creator;
}

async function getSessionCreator(req) {
  const token = bearerToken(req.headers.authorization);
  if (!token) return null;

  if (USE_SUPABASE) {
    const session = await sbSelectOne("sessions", {
      token_hash: eq(hashToken(token)),
      revoked_at: isNull(),
      select: "*"
    });
    if (!session || new Date(session.expires_at).getTime() <= Date.now()) return null;
    return await getCreator(session.creator_id);
  }

  const row = db.prepare(`
    SELECT c.*
    FROM sessions s
    JOIN creators c ON c.id = s.creator_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > CURRENT_TIMESTAMP
    LIMIT 1
  `).get(hashToken(token));

  return row ? formatCreator(row) : null;
}

async function requireCampaignAccess(req, campaignId) {
  if (!campaignId) throw httpError(400, "campaign_id_required");

  const adminProvided = req.headers["x-admin-token"] || bearerToken(req.headers.authorization);
  if (ADMIN_TOKEN && adminProvided === ADMIN_TOKEN) return;

  const sessionCreator = await getSessionCreator(req);
  if (sessionCreator) {
    const row = USE_SUPABASE
      ? await sbSelectOne("campaigns", { id: eq(campaignId), select: "creator_id" })
      : db.prepare("SELECT creator_id FROM campaigns WHERE id = ?").get(campaignId);
    if (!row) throw httpError(404, "campaign_not_found");
    if (row.creator_id && row.creator_id === sessionCreator.id) return;
  }

  const campaignToken = req.headers["x-campaign-token"];
  if (!campaignToken) throw httpError(401, "campaign_token_required");

  const row = USE_SUPABASE
    ? await sbSelectOne("campaigns", { id: eq(campaignId), select: "owner_token_hash" })
    : db.prepare("SELECT owner_token_hash FROM campaigns WHERE id = ?").get(campaignId);
  if (!row) throw httpError(404, "campaign_not_found");
  if (!row.owner_token_hash) throw httpError(401, "campaign_token_not_available");
  if (!safeEqual(row.owner_token_hash, hashToken(campaignToken))) {
    throw httpError(401, "campaign_token_invalid");
  }
}

function bearerToken(header) {
  if (!header) return "";
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function addColumnIfMissing(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((item) => item.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}


async function ensureDemoCampaign() {
  if (USE_SUPABASE) {
    const existing = await sbSelectOne("campaigns", { tag: "eq.$WAGMI", select: "*", order: "created_at.desc" });
    if (existing) return formatCampaign(existing);
  } else {
    const existing = db.prepare("SELECT * FROM campaigns WHERE tag = ? ORDER BY id DESC LIMIT 1").get("$WAGMI");
    if (existing) return formatCampaign(existing);
  }

  const result = await createCampaign({
    name: "$WAGMI launch raid",
    tag: "$WAGMI",
    tokenMint: "WAGM1meme9xPumpExampleMintAddr7QFvR2",
    launchVenue: "Pump.fun",
    rewardPoolRaw: 420000000,
    ownerWallet: "SoLDeployerWalletExample",
    status: "live"
  }, { id: null, walletAddress: "SoLDeployerWalletExample" });
  return result.campaign;
}

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      creator_id INTEGER REFERENCES creators(id) ON DELETE SET NULL,
      owner_wallet TEXT NOT NULL,
      owner_token_hash TEXT,
      name TEXT NOT NULL,
      tag TEXT NOT NULL,
      token_mint TEXT NOT NULL,
      launch_venue TEXT NOT NULL DEFAULT 'Pump.fun',
      dex_pool_address TEXT,
      reward_pool_raw INTEGER NOT NULL,
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS creators (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      x_user_id TEXT UNIQUE,
      x_handle TEXT,
      x_display_name TEXT,
      x_verified INTEGER NOT NULL DEFAULT 0,
      x_access_token TEXT,
      x_refresh_token TEXT,
      wallet_address TEXT UNIQUE,
      wallet_provider TEXT,
      wallet_verified_at TEXT,
      holds_campaign_token INTEGER NOT NULL DEFAULT 0,
      trust_score INTEGER NOT NULL DEFAULT 50,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS wallet_challenges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      creator_id INTEGER NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
      wallet_address TEXT NOT NULL,
      nonce TEXT NOT NULL UNIQUE,
      message TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS wallet_auth_challenges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_address TEXT NOT NULL,
      nonce TEXT NOT NULL UNIQUE,
      message TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      creator_id INTEGER NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS x_oauth_states (
      state TEXT PRIMARY KEY,
      creator_id INTEGER NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
      code_verifier TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      creator_id INTEGER REFERENCES creators(id) ON DELETE SET NULL,
      platform TEXT NOT NULL DEFAULT 'x',
      platform_post_id TEXT NOT NULL,
      author_id TEXT,
      author_handle TEXT,
      post_url TEXT,
      text TEXT NOT NULL,
      text_hash TEXT NOT NULL,
      contains_token_mint INTEGER NOT NULL DEFAULT 0,
      contains_launch_link INTEGER NOT NULL DEFAULT 0,
      views INTEGER NOT NULL DEFAULT 0,
      likes INTEGER NOT NULL DEFAULT 0,
      reposts INTEGER NOT NULL DEFAULT 0,
      replies INTEGER NOT NULL DEFAULT 0,
      quotes INTEGER NOT NULL DEFAULT 0,
      score INTEGER NOT NULL DEFAULT 0,
      risk_level TEXT NOT NULL DEFAULT 'low',
      risk_reasons TEXT NOT NULL DEFAULT '[]',
      captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(campaign_id, platform, platform_post_id)
    );

    CREATE TABLE IF NOT EXISTS scoring_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      post_count INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS payouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      creator_id INTEGER,
      wallet_address TEXT,
      author_handle TEXT NOT NULL,
      rank INTEGER NOT NULL,
      score INTEGER NOT NULL,
      amount_raw INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(campaign_id, author_handle)
    );
  `);

  addColumnIfMissing("campaigns", "owner_token_hash", "TEXT");
  addColumnIfMissing("campaigns", "creator_id", "INTEGER REFERENCES creators(id) ON DELETE SET NULL");
}

async function createCampaign(body, creator = null) {
  const now = new Date();
  const startAt = body.startAt || now.toISOString();
  const endAt = body.endAt || new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const ownerToken = crypto.randomBytes(32).toString("base64url");
  const ownerTokenHash = hashToken(ownerToken);

  requireFields(body, ["name", "tag", "tokenMint", "rewardPoolRaw"]);
  const ownerWallet = creator?.walletAddress || body.ownerWallet;
  if (!ownerWallet) throw httpError(400, "owner_wallet_required");

  if (USE_SUPABASE) {
    const row = await sbInsert("campaigns", {
      creator_id: creator?.id || null,
      owner_wallet: ownerWallet,
      owner_token_hash: ownerTokenHash,
      name: body.name,
      tag: normalizeTag(body.tag),
      token_mint: body.tokenMint,
      launch_venue: body.launchVenue || "Pump.fun",
      dex_pool_address: body.dexPoolAddress || null,
      reward_pool_raw: Number(body.rewardPoolRaw),
      start_at: startAt,
      end_at: endAt,
      status: body.status || "live"
    });
    return { campaign: formatCampaign(row), ownerToken };
  }

  const result = db.prepare(`
    INSERT INTO campaigns (creator_id, owner_wallet, owner_token_hash, name, tag, token_mint, launch_venue, dex_pool_address, reward_pool_raw, start_at, end_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    creator?.id || null,
    ownerWallet,
    ownerTokenHash,
    body.name,
    normalizeTag(body.tag),
    body.tokenMint,
    body.launchVenue || "Pump.fun",
    body.dexPoolAddress || null,
    Number(body.rewardPoolRaw),
    startAt,
    endAt,
    body.status || "live"
  );

  return {
    campaign: await getCampaign(result.lastInsertRowid),
    ownerToken
  };
}

async function listCampaigns() {
  if (USE_SUPABASE) {
    const rows = await sbFetch("campaigns", {
      query: { select: "*", order: "created_at.desc" }
    });
    return rows.map(formatCampaign);
  }
  return db.prepare("SELECT * FROM campaigns ORDER BY created_at DESC").all().map(formatCampaign);
}

async function getCampaign(id) {
  if (USE_SUPABASE) {
    const row = await sbSelectOne("campaigns", { id: eq(id), select: "*" });
    if (!row) throw httpError(404, "campaign_not_found");
    return formatCampaign(row);
  }
  const row = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id);
  if (!row) throw httpError(404, "campaign_not_found");
  return formatCampaign(row);
}

function formatCampaign(row) {
  return {
    id: row.id,
    creatorId: row.creator_id,
    ownerWallet: row.owner_wallet,
    name: row.name,
    tag: row.tag,
    tokenMint: row.token_mint,
    launchVenue: row.launch_venue,
    dexPoolAddress: row.dex_pool_address,
    rewardPoolRaw: row.reward_pool_raw,
    startAt: row.start_at,
    endAt: row.end_at,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function createCreator(body) {
  if (USE_SUPABASE) {
    const row = await sbInsert("creators", {
      x_user_id: body.xUserId || null,
      x_handle: cleanHandle(body.xHandle || null),
      x_display_name: body.xDisplayName || null,
      x_verified: Boolean(body.xVerified),
      trust_score: Number(body.trustScore || 50)
    });
    return formatCreator(row);
  }

  const result = db.prepare(`
    INSERT INTO creators (x_user_id, x_handle, x_display_name, x_verified, trust_score)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    body.xUserId || null,
    cleanHandle(body.xHandle || null),
    body.xDisplayName || null,
    body.xVerified ? 1 : 0,
    Number(body.trustScore || 50)
  );
  return await getCreator(result.lastInsertRowid);
}

async function createAuthWalletChallenge(walletAddress) {
  if (!walletAddress) throw httpError(400, "wallet_address_required");

  const nonce = crypto.randomBytes(20).toString("hex");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const message = [
    "Proof of Hype wallet sign-in",
    `Wallet: ${walletAddress}`,
    `Nonce: ${nonce}`,
    `Expires: ${expiresAt}`
  ].join("\n");

  if (USE_SUPABASE) {
    await sbInsert("wallet_auth_challenges", {
      wallet_address: walletAddress,
      nonce,
      message,
      expires_at: expiresAt
    });
    return { walletAddress, nonce, message, expiresAt };
  }

  db.prepare(`
    INSERT INTO wallet_auth_challenges (wallet_address, nonce, message, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(walletAddress, nonce, message, expiresAt);

  return { walletAddress, nonce, message, expiresAt };
}

async function verifyWalletAuth(body) {
  requireFields(body, ["walletAddress", "message"]);

  const challenge = USE_SUPABASE
    ? await sbSelectOne("wallet_auth_challenges", {
        wallet_address: eq(body.walletAddress),
        message: eq(body.message),
        used_at: isNull(),
        select: "*",
        order: "created_at.desc"
      })
    : db.prepare(`
        SELECT * FROM wallet_auth_challenges
        WHERE wallet_address = ? AND message = ? AND used_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1
      `).get(body.walletAddress, body.message);

  if (!challenge) throw httpError(400, "wallet_auth_challenge_not_found");
  if (new Date(challenge.expires_at).getTime() < Date.now()) throw httpError(400, "wallet_auth_challenge_expired");

  let verified = false;
  if (body.signature) {
    verified = await verifySolanaSignature(body.walletAddress, body.message, body.signature, body.signatureEncoding || "base58");
  } else if (ALLOW_UNVERIFIED_WALLET_BINDING) {
    verified = true;
  }

  if (!verified) throw httpError(400, "wallet_signature_invalid");

  if (USE_SUPABASE) {
    await sbUpdate("wallet_auth_challenges", { id: eq(challenge.id) }, { used_at: new Date().toISOString() });
  } else {
    db.prepare("UPDATE wallet_auth_challenges SET used_at = CURRENT_TIMESTAMP WHERE id = ?").run(challenge.id);
  }
  const creator = await upsertCreatorByWallet(body.walletAddress, body.walletProvider || "phantom");
  const session = await createSession(creator.id);

  return { creator, session };
}

async function upsertCreatorByWallet(walletAddress, walletProvider) {
  if (USE_SUPABASE) {
    const existing = await sbSelectOne("creators", { wallet_address: eq(walletAddress), select: "*" });
    if (existing) {
      const row = await sbUpdate("creators", { id: eq(existing.id) }, {
        wallet_provider: walletProvider,
        wallet_verified_at: existing.wallet_verified_at || new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
      return formatCreator(row || existing);
    }
    const row = await sbInsert("creators", {
      wallet_address: walletAddress,
      wallet_provider: walletProvider,
      wallet_verified_at: new Date().toISOString(),
      trust_score: 50
    });
    return formatCreator(row);
  }

  const existing = db.prepare("SELECT * FROM creators WHERE wallet_address = ?").get(walletAddress);
  if (existing) {
    db.prepare(`
      UPDATE creators
      SET wallet_provider = ?, wallet_verified_at = COALESCE(wallet_verified_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(walletProvider, existing.id);
    return await getCreator(existing.id);
  }

  const result = db.prepare(`
    INSERT INTO creators (wallet_address, wallet_provider, wallet_verified_at, trust_score)
    VALUES (?, ?, CURRENT_TIMESTAMP, 50)
  `).run(walletAddress, walletProvider);

  return await getCreator(result.lastInsertRowid);
}

async function createSession(creatorId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  if (USE_SUPABASE) {
    await sbInsert("sessions", {
      creator_id: creatorId,
      token_hash: tokenHash,
      expires_at: expiresAt
    });
    return { token, expiresAt };
  }

  db.prepare(`
    INSERT INTO sessions (creator_id, token_hash, expires_at)
    VALUES (?, ?, ?)
  `).run(creatorId, tokenHash, expiresAt);

  return { token, expiresAt };
}

async function getCreator(id) {
  if (USE_SUPABASE) {
    const row = await sbSelectOne("creators", { id: eq(id), select: "*" });
    if (!row) throw httpError(404, "creator_not_found");
    return formatCreator(row);
  }
  const row = db.prepare("SELECT * FROM creators WHERE id = ?").get(id);
  if (!row) throw httpError(404, "creator_not_found");
  return formatCreator(row);
}

async function findCreatorByHandle(handle) {
  if (!handle) return null;
  if (USE_SUPABASE) {
    const row = await sbSelectOne("creators", { x_handle: eq(handle), select: "*" });
    return row ? formatCreator(row) : null;
  }
  return db.prepare("SELECT * FROM creators WHERE lower(x_handle) = lower(?)").get(handle);
}

function formatCreator(row) {
  return {
    id: row.id,
    xUserId: row.x_user_id,
    xHandle: row.x_handle,
    xDisplayName: row.x_display_name,
    xVerified: Boolean(row.x_verified),
    walletAddress: row.wallet_address,
    walletProvider: row.wallet_provider,
    walletVerifiedAt: row.wallet_verified_at,
    holdsCampaignToken: Boolean(row.holds_campaign_token),
    trustScore: row.trust_score,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function createWalletChallenge(creatorId, walletAddress) {
  await getCreator(creatorId);
  if (!walletAddress) throw httpError(400, "wallet_address_required");

  const nonce = crypto.randomBytes(20).toString("hex");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const message = [
    "Proof of Hype wallet binding",
    `Creator ID: ${creatorId}`,
    `Wallet: ${walletAddress}`,
    `Nonce: ${nonce}`,
    `Expires: ${expiresAt}`
  ].join("\n");

  db.prepare(`
    INSERT INTO wallet_challenges (creator_id, wallet_address, nonce, message, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(creatorId, walletAddress, nonce, message, expiresAt);

  return { creatorId, walletAddress, nonce, message, expiresAt };
}

async function bindWallet(creatorId, body) {
  await getCreator(creatorId);
  requireFields(body, ["walletAddress", "message"]);

  const challenge = db.prepare(`
    SELECT * FROM wallet_challenges
    WHERE creator_id = ? AND wallet_address = ? AND message = ? AND used_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1
  `).get(creatorId, body.walletAddress, body.message);

  if (!challenge) throw httpError(400, "wallet_challenge_not_found");
  if (new Date(challenge.expires_at).getTime() < Date.now()) throw httpError(400, "wallet_challenge_expired");

  let verified = false;
  if (body.signature) {
    verified = await verifySolanaSignature(body.walletAddress, body.message, body.signature, body.signatureEncoding || "base58");
  } else if (ALLOW_UNVERIFIED_WALLET_BINDING) {
    verified = true;
  }

  if (!verified) throw httpError(400, "wallet_signature_invalid");

  db.prepare("UPDATE wallet_challenges SET used_at = CURRENT_TIMESTAMP WHERE id = ?").run(challenge.id);
  db.prepare(`
    UPDATE creators
    SET wallet_address = ?, wallet_provider = ?, wallet_verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(body.walletAddress, body.walletProvider || "phantom", creatorId);

  return await getCreator(creatorId);
}

async function startXOAuth(creatorId) {
  if (!creatorId) throw httpError(400, "creator_id_required");
  await getCreator(creatorId);

  const state = crypto.randomBytes(24).toString("base64url");
  const codeVerifier = crypto.randomBytes(48).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  db.prepare(`
    INSERT INTO x_oauth_states (state, creator_id, code_verifier, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(state, creatorId, codeVerifier, expiresAt);

  const authUrl = new URL("https://twitter.com/i/oauth2/authorize");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", process.env.X_CLIENT_ID || "missing-client-id");
  authUrl.searchParams.set("redirect_uri", X_CALLBACK_URL);
  authUrl.searchParams.set("scope", "tweet.read users.read offline.access");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  return {
    authUrl: authUrl.toString(),
    state,
    missingConfig: !process.env.X_CLIENT_ID || !process.env.X_CLIENT_SECRET
  };
}

async function handleXCallback(searchParams) {
  const state = searchParams.get("state");
  const code = searchParams.get("code");
  if (!state || !code) throw httpError(400, "oauth_code_and_state_required");

  const oauthState = db.prepare("SELECT * FROM x_oauth_states WHERE state = ? AND used_at IS NULL").get(state);
  if (!oauthState) throw httpError(400, "oauth_state_not_found");
  if (new Date(oauthState.expires_at).getTime() < Date.now()) throw httpError(400, "oauth_state_expired");
  if (!process.env.X_CLIENT_ID || !process.env.X_CLIENT_SECRET) throw httpError(400, "x_oauth_not_configured");

  const tokenResponse = await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${process.env.X_CLIENT_ID}:${process.env.X_CLIENT_SECRET}`).toString("base64")}`
    },
    body: new URLSearchParams({
      code,
      grant_type: "authorization_code",
      client_id: process.env.X_CLIENT_ID,
      redirect_uri: X_CALLBACK_URL,
      code_verifier: oauthState.code_verifier
    })
  });

  if (!tokenResponse.ok) throw httpError(502, "x_token_exchange_failed", await tokenResponse.text());
  const token = await tokenResponse.json();

  const profileResponse = await fetch("https://api.x.com/2/users/me?user.fields=verified,public_metrics", {
    headers: { authorization: `Bearer ${token.access_token}` }
  });

  if (!profileResponse.ok) throw httpError(502, "x_profile_fetch_failed", await profileResponse.text());
  const profile = await profileResponse.json();
  const user = profile.data;

  db.prepare(`
    UPDATE creators
    SET x_user_id = ?, x_handle = ?, x_display_name = ?, x_verified = ?, x_access_token = ?, x_refresh_token = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    user.id,
    cleanHandle(user.username),
    user.name || null,
    user.verified ? 1 : 0,
    token.access_token,
    token.refresh_token || null,
    oauthState.creator_id
  );

  db.prepare("UPDATE x_oauth_states SET used_at = CURRENT_TIMESTAMP WHERE state = ?").run(state);
  return { creator: await getCreator(oauthState.creator_id), xUser: user };
}

async function ingestMockPosts(campaignId) {
  const campaign = await getCampaign(campaignId);
  const samples = [
    ["solraid", `This ${campaign.tag} chart is pure Solana chaos. CA ${campaign.tokenMint}`, 982000, 28000, 8200, 3100, 1800],
    ["pumpsignal", `${campaign.tag} just hit the timeline like a proper Pump.fun send. ${campaign.tokenMint}`, 741000, 21000, 6400, 1900, 1200],
    ["degendesk", `Watching ${campaign.tag} liquidity and holders move. Not financial advice, just degen radar.`, 621000, 17000, 5200, 2200, 940],
    ["mintangle", `${campaign.tag} ${campaign.tag} ${campaign.tag} CA ${campaign.tokenMint}`, 519000, 15100, 7100, 600, 400],
    ["holderbloom", `Still holding ${campaign.tag}. Community is loud and the CA is clean: ${campaign.tokenMint}`, 486000, 12900, 3300, 1400, 720],
    ["raydiumrun", `${campaign.tag} pool is live. Tracking volume, holders, and timeline heat.`, 351000, 8800, 2400, 880, 410]
  ];

  let created = 0;
  for (const [handle, text, views, likes, reposts, replies, quotes] of samples) {
    const post = {
      campaignId,
      platformPostId: `mock-${campaignId}-${handle}`,
      authorHandle: handle,
      authorId: `mock-${handle}`,
      postUrl: `https://x.com/${handle}/status/mock-${campaignId}`,
      text,
      views,
      likes,
      reposts,
      replies,
      quotes
    };
    created += await upsertPost(campaign, post) ? 1 : 0;
  }

  return { campaignId, created, total: samples.length };
}

async function ingestXPosts(campaignId, maxResults) {
  const campaign = await getCampaign(campaignId);
  if (!process.env.X_BEARER_TOKEN) throw httpError(400, "x_bearer_token_required");

  const query = `(${campaign.tag} OR "${campaign.tokenMint}") -is:retweet lang:en`;
  const searchUrl = new URL("https://api.x.com/2/tweets/search/recent");
  searchUrl.searchParams.set("query", query);
  searchUrl.searchParams.set("max_results", String(Math.min(Math.max(maxResults, 10), 100)));
  searchUrl.searchParams.set("tweet.fields", "author_id,created_at,public_metrics");
  searchUrl.searchParams.set("expansions", "author_id");
  searchUrl.searchParams.set("user.fields", "username,name,verified,public_metrics");

  const response = await fetch(searchUrl, {
    headers: { authorization: `Bearer ${process.env.X_BEARER_TOKEN}` }
  });

  if (!response.ok) throw httpError(502, "x_recent_search_failed", await response.text());
  const payload = await response.json();
  const usersById = new Map((payload.includes?.users || []).map((user) => [user.id, user]));

  let created = 0;
  for (const tweet of payload.data || []) {
    const user = usersById.get(tweet.author_id);
    const metrics = tweet.public_metrics || {};
    const post = {
      campaignId,
      platformPostId: tweet.id,
      authorHandle: cleanHandle(user?.username || tweet.author_id),
      authorId: tweet.author_id,
      postUrl: user?.username ? `https://x.com/${user.username}/status/${tweet.id}` : null,
      text: tweet.text,
      views: Number(metrics.impression_count || 0),
      likes: Number(metrics.like_count || 0),
      reposts: Number(metrics.retweet_count || 0),
      replies: Number(metrics.reply_count || 0),
      quotes: Number(metrics.quote_count || 0)
    };
    created += await upsertPost(campaign, post) ? 1 : 0;
  }

  return { campaignId, query, fetched: payload.data?.length || 0, created };
}

async function upsertPost(campaign, post) {
  const textHash = crypto.createHash("sha256").update(normalizeText(post.text)).digest("hex");
  const containsTokenMint = post.text.includes(campaign.tokenMint);
  const containsLaunchLink = /pump\.fun|raydium|meteora|dexscreener/i.test(post.text);
  const creator = post.authorHandle ? await findCreatorByHandle(cleanHandle(post.authorHandle)) : null;

  if (USE_SUPABASE) {
    const rows = await sbFetch("posts", {
      method: "POST",
      query: { on_conflict: "campaign_id,platform,platform_post_id" },
      prefer: "resolution=merge-duplicates,return=representation",
      body: {
        campaign_id: campaign.id,
        creator_id: creator?.id || null,
        platform: "x",
        platform_post_id: post.platformPostId,
        author_id: post.authorId || null,
        author_handle: cleanHandle(post.authorHandle),
        post_url: post.postUrl || null,
        text: post.text,
        text_hash: textHash,
        contains_token_mint: containsTokenMint,
        contains_launch_link: containsLaunchLink,
        views: Number(post.views || 0),
        likes: Number(post.likes || 0),
        reposts: Number(post.reposts || 0),
        replies: Number(post.replies || 0),
        quotes: Number(post.quotes || 0),
        captured_at: new Date().toISOString()
      }
    });
    return Boolean(rows?.length);
  }

  const result = db.prepare(`
    INSERT INTO posts (
      campaign_id, creator_id, platform_post_id, author_id, author_handle, post_url, text, text_hash,
      contains_token_mint, contains_launch_link, views, likes, reposts, replies, quotes
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(campaign_id, platform, platform_post_id) DO UPDATE SET
      views = excluded.views,
      likes = excluded.likes,
      reposts = excluded.reposts,
      replies = excluded.replies,
      quotes = excluded.quotes,
      captured_at = CURRENT_TIMESTAMP
  `).run(
    campaign.id,
    creator?.id || null,
    post.platformPostId,
    post.authorId || null,
    cleanHandle(post.authorHandle),
    post.postUrl || null,
    post.text,
    textHash,
    containsTokenMint ? 1 : 0,
    containsLaunchLink ? 1 : 0,
    Number(post.views || 0),
    Number(post.likes || 0),
    Number(post.reposts || 0),
    Number(post.replies || 0),
    Number(post.quotes || 0)
  );

  return result.changes > 0;
}

async function runScoringWorker(campaignId) {
  const campaign = await getCampaign(campaignId);
  const posts = await getPostsForCampaign(campaignId);
  const duplicateCounts = countBy(posts, "text_hash");

  for (const post of posts) {
    const creator = post.creator_id ? await getCreator(post.creator_id) : null;
    const scored = scorePost(post, creator, duplicateCounts.get(post.text_hash) || 1);
    await updatePostScore(post.id, scored);
  }

  const updatedPosts = await getPostsForCampaign(campaignId, true);
  const payouts = await buildPayouts(campaign, updatedPosts);
  await replacePayouts(campaignId, payouts);
  if (!USE_SUPABASE) db.prepare("INSERT INTO scoring_runs (campaign_id, post_count) VALUES (?, ?)").run(campaignId, posts.length);

  return { campaignId, scoredPosts: posts.length, payouts: payouts.length };
}

async function getPostsForCampaign(campaignId, sorted = false) {
  if (USE_SUPABASE) {
    const rows = await sbFetch("posts", {
      query: {
        campaign_id: eq(campaignId),
        select: "*",
        order: sorted ? "score.desc" : "captured_at.asc"
      }
    });
    return rows;
  }
  const sql = sorted
    ? "SELECT * FROM posts WHERE campaign_id = ? ORDER BY score DESC"
    : "SELECT * FROM posts WHERE campaign_id = ?";
  return db.prepare(sql).all(campaignId);
}

async function updatePostScore(postId, scored) {
  if (USE_SUPABASE) {
    await sbUpdate("posts", { id: eq(postId) }, {
      score: scored.score,
      risk_level: scored.riskLevel,
      risk_reasons: scored.riskReasons
    });
    return;
  }
  db.prepare(`
    UPDATE posts
    SET score = ?, risk_level = ?, risk_reasons = ?
    WHERE id = ?
  `).run(scored.score, scored.riskLevel, JSON.stringify(scored.riskReasons), postId);
}

function scorePost(post, creator, duplicateCount) {
  const riskReasons = [];
  const engagementTotal = post.likes + post.reposts + post.replies + post.quotes;
  const engagementRatio = post.views > 0 ? engagementTotal / post.views : 0;
  const repostRatio = post.views > 0 ? post.reposts / post.views : 0;

  let score = 0;
  score += post.views * 0.02;
  score += post.likes * 1;
  score += post.reposts * 3;
  score += post.replies * 2;
  score += post.quotes * 4;
  score += post.contains_token_mint ? 750 : 0;
  score += post.contains_launch_link ? 350 : 0;
  score += creator?.wallet_verified_at ? 1000 : 0;
  score += creator?.holds_campaign_token ? 500 : 0;
  score += creator?.trust_score ? creator.trust_score * 8 : 0;

  if (!post.contains_token_mint) {
    score -= 400;
    riskReasons.push("missing_token_mint");
  }

  if (duplicateCount > 1) {
    score -= duplicateCount * 650;
    riskReasons.push("duplicate_text");
  }

  if (engagementRatio > 0.25 && post.views > 50000) {
    score -= 1800;
    riskReasons.push("abnormal_engagement_ratio");
  }

  if (repostRatio > 0.08 && post.views > 50000) {
    score -= 1200;
    riskReasons.push("repost_velocity_risk");
  }

  if (!creator?.wallet_verified_at) {
    score -= 300;
    riskReasons.push("wallet_not_bound");
  }

  let riskLevel = "low";
  if (riskReasons.length >= 2) riskLevel = "medium";
  if (riskReasons.length >= 3 || riskReasons.includes("duplicate_text")) riskLevel = "high";

  return {
    score: Math.max(0, Math.round(score)),
    riskLevel,
    riskReasons
  };
}

async function buildPayouts(campaign, posts) {
  const bestByAuthor = new Map();
  for (const post of posts) {
    const author = post.author_handle || `unknown-${post.id}`;
    const current = bestByAuthor.get(author);
    if (!current || post.score > current.score) bestByAuthor.set(author, post);
  }

  const ranked = Array.from(bestByAuthor.values())
    .filter((post) => post.score > 0)
    .sort((a, b) => b.score - a.score);

  const totalScore = ranked.reduce((sum, post) => sum + post.score, 0) || 1;
  const payouts = [];
  for (const [index, post] of ranked.entries()) {
    const creator = post.creator_id ? await getCreator(post.creator_id) : null;
    payouts.push({
      rank: index + 1,
      creatorId: post.creator_id,
      walletAddress: creator?.wallet_address || creator?.walletAddress || null,
      authorHandle: post.author_handle,
      score: post.score,
      amountRaw: Math.floor((post.score / totalScore) * Number(campaign.rewardPoolRaw))
    });
  }
  return payouts;
}

async function replacePayouts(campaignId, payouts) {
  if (USE_SUPABASE) {
    await sbDelete("payouts", { campaign_id: eq(campaignId) });
    if (!payouts.length) return;
    await sbFetch("payouts", {
      method: "POST",
      body: payouts.map((payout) => ({
        campaign_id: campaignId,
        creator_id: payout.creatorId || null,
        wallet_address: payout.walletAddress || null,
        author_handle: payout.authorHandle,
        rank: payout.rank,
        score: payout.score,
        amount_raw: payout.amountRaw,
        status: "pending"
      }))
    });
    return;
  }

  db.prepare("DELETE FROM payouts WHERE campaign_id = ?").run(campaignId);
  for (const payout of payouts) {
    db.prepare(`
      INSERT INTO payouts (campaign_id, creator_id, wallet_address, author_handle, rank, score, amount_raw, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      campaignId,
      payout.creatorId,
      payout.walletAddress,
      payout.authorHandle,
      payout.rank,
      payout.score,
      payout.amountRaw
    );
  }
}

async function getLeaderboard(campaignId) {
  await getCampaign(campaignId);
  if (USE_SUPABASE) {
    const posts = await getPostsForCampaign(campaignId, true);
    const rows = [];
    for (const post of posts) {
      const creator = post.creator_id ? await getCreator(post.creator_id) : null;
      rows.push({
        authorHandle: post.author_handle,
        postUrl: post.post_url,
        views: post.views,
        likes: post.likes,
        reposts: post.reposts,
        replies: post.replies,
        quotes: post.quotes,
        score: post.score,
        riskLevel: post.risk_level,
        riskReasons: Array.isArray(post.risk_reasons) ? post.risk_reasons : [],
        walletAddress: creator?.walletAddress || null,
        walletVerifiedAt: creator?.walletVerifiedAt || null
      });
    }
    return rows.map((row, index) => ({
      rank: index + 1,
      ...row,
      walletVerified: Boolean(row.walletVerifiedAt)
    }));
  }

  return db.prepare(`
    SELECT
      p.author_handle AS authorHandle,
      p.post_url AS postUrl,
      p.views,
      p.likes,
      p.reposts,
      p.replies,
      p.quotes,
      p.score,
      p.risk_level AS riskLevel,
      p.risk_reasons AS riskReasons,
      c.wallet_address AS walletAddress,
      c.wallet_verified_at AS walletVerifiedAt
    FROM posts p
    LEFT JOIN creators c ON c.id = p.creator_id
    WHERE p.campaign_id = ?
    ORDER BY p.score DESC
  `).all(campaignId).map((row, index) => ({
    rank: index + 1,
    ...row,
    riskReasons: JSON.parse(row.riskReasons || "[]"),
    walletVerified: Boolean(row.walletVerifiedAt)
  }));
}

async function getPayouts(campaignId) {
  await getCampaign(campaignId);
  if (USE_SUPABASE) {
    const rows = await sbFetch("payouts", {
      query: {
        campaign_id: eq(campaignId),
        select: "rank,author_handle,wallet_address,score,amount_raw,status",
        order: "rank.asc"
      }
    });
    return rows.map((row) => ({
      rank: row.rank,
      authorHandle: row.author_handle,
      walletAddress: row.wallet_address,
      score: row.score,
      amountRaw: row.amount_raw,
      status: row.status
    }));
  }

  return db.prepare(`
    SELECT rank, author_handle AS authorHandle, wallet_address AS walletAddress, score, amount_raw AS amountRaw, status
    FROM payouts
    WHERE campaign_id = ?
    ORDER BY rank ASC
  `).all(campaignId);
}

async function payoutsCsv(campaignId) {
  const rows = await getPayouts(campaignId);
  const header = ["rank", "author_handle", "wallet_address", "score", "amount_raw", "status"];
  const lines = rows.map((row) => [
    row.rank,
    row.authorHandle,
    row.walletAddress || "",
    row.score,
    row.amountRaw,
    row.status
  ].map(csvCell).join(","));
  return [header.join(","), ...lines].join("\n");
}

async function verifySolanaSignature(walletAddress, message, signature, encoding) {
  const publicKeyBytes = base58Decode(walletAddress);
  const signatureBytes = encoding === "base64" ? Buffer.from(signature, "base64") : base58Decode(signature);
  const key = await crypto.webcrypto.subtle.importKey(
    "raw",
    publicKeyBytes,
    { name: "Ed25519" },
    false,
    ["verify"]
  );
  return crypto.webcrypto.subtle.verify(
    { name: "Ed25519" },
    key,
    signatureBytes,
    new TextEncoder().encode(message)
  );
}

function base58Decode(value) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const bytes = [0];

  for (const char of value) {
    const index = alphabet.indexOf(char);
    if (index === -1) throw httpError(400, "invalid_base58");

    let carry = index;
    for (let i = 0; i < bytes.length; i += 1) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  for (const char of value) {
    if (char === "1") bytes.push(0);
    else break;
  }

  return Uint8Array.from(bytes.reverse());
}

function requireFields(body, fields) {
  for (const field of fields) {
    if (body[field] === undefined || body[field] === null || body[field] === "") {
      throw httpError(400, `${field}_required`);
    }
  }
}

function normalizeTag(tag) {
  return String(tag).trim().startsWith("$") ? String(tag).trim() : `$${String(tag).trim()}`;
}

function cleanHandle(handle) {
  if (!handle) return null;
  return String(handle).trim().replace(/^@/, "").toLowerCase();
}

function normalizeText(text) {
  return String(text).toLowerCase().replace(/\s+/g, " ").trim();
}

function countBy(rows, key) {
  const counts = new Map();
  for (const row of rows) counts.set(row[key], (counts.get(row[key]) || 0) + 1);
  return counts;
}

function csvCell(value) {
  const text = String(value ?? "");
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, "\"\"")}"`;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(httpError(413, "payload_too_large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(httpError(400, "invalid_json"));
      }
    });
  });
}

function sendJson(res, status, payload) {
  sendText(res, status, JSON.stringify(payload, null, 2), "application/json; charset=utf-8");
}

function sendText(res, status, text, contentType, headers = {}) {
  res.writeHead(status, {
    "content-type": contentType,
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    ...headers
  });
  res.end(text);
}

function setCors(res) {
  res.setHeader("access-control-allow-origin", corsOrigin());
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type,authorization,x-admin-token,x-campaign-token");
}

function corsOrigin() {
  if (!IS_PRODUCTION) return "*";
  try {
    return new URL(PUBLIC_BASE_URL).origin;
  } catch {
    return "null";
  }
}

function serveStatic(routePath, res) {
  const fileMap = new Map([
    ["/", "index.html"],
    ["/app", "app.html"],
    ["/app.html", "app.html"],
    ["/docs", "docs.html"],
    ["/docs.html", "docs.html"]
  ]);

  const mapped = fileMap.get(routePath);
  if (!mapped) return false;

  const target = path.resolve(PUBLIC_DIR, mapped);
  if (!target.startsWith(PUBLIC_DIR) || !fs.existsSync(target)) return false;

  const ext = path.extname(target);
  const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8"
  };

  sendText(res, 200, fs.readFileSync(target, "utf8"), contentTypes[ext] || "text/plain; charset=utf-8");
  return true;
}

function httpError(status, code, detail) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  error.detail = detail;
  return error;
}

function loadDotEnv() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^"(.*)"$/, "$1");
    if (!process.env[key]) process.env[key] = value;
  }
}
