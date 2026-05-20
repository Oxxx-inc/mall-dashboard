/**
 * Amazon広告API Proxy Server
 * ------------------------------------
 * チーム共有ダッシュボード用のProxyサーバー
 * 環境変数は .env（ローカル）または Railway の Variables から読み込む
 */

require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const path    = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// ── ダッシュボードHTMLを配信 ──────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── 環境変数 ──────────────────────────────────────────────
const {
  CLIENT_ID,
  CLIENT_SECRET,
  REFRESH_TOKEN,
  PROFILE_ID,
  TEAM_TOKEN,   // チームアクセス制限用（任意）
} = process.env;

const AMZ_TOKEN_URL = 'https://api.amazon.co.jp/auth/o2/token';
const AMZ_ADS_URL   = 'https://advertising-api-fe.amazon.com';

// ── Access Token 自動更新 ──────────────────────────────────
let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const res = await axios.post(AMZ_TOKEN_URL, new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: REFRESH_TOKEN,
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
  }), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });

  cachedToken = res.data.access_token;
  tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  console.log('[Token] Access Token を更新しました');
  return cachedToken;
}

// ── 共通ヘッダー生成 ──────────────────────────────────────
async function adsHeaders() {
  const token = await getAccessToken();
  return {
    'Amazon-Advertising-API-ClientId': CLIENT_ID,
    'Amazon-Advertising-API-Scope':    PROFILE_ID,
    'Authorization': `Bearer ${token}`,
    'Content-Type':  'application/json',
  };
}

// ── チームアクセス認証（TEAM_TOKEN が設定されている場合のみ有効）──
function teamAuth(req, res, next) {
  if (!TEAM_TOKEN) return next(); // 未設定なら認証スキップ
  const token = req.headers['x-team-token'];
  if (token !== TEAM_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized: x-team-token ヘッダーが必要です' });
  }
  next();
}

app.use('/api', teamAuth);

// ── エンドポイント ─────────────────────────────────────────

/** ヘルスチェック */
app.get('/health', (_, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

/** キャンペーン一覧 */
app.get('/api/campaigns', async (req, res) => {
  try {
    const r = await axios.get(`${AMZ_ADS_URL}/v2/sp/campaigns`, {
      params: { stateFilter: 'enabled,paused,archived', count: 100 },
      headers: await adsHeaders(),
    });
    res.json(r.data);
  } catch (e) {
    console.error('[campaigns]', e.response?.data || e.message);
    res.status(e.response?.status || 500).json({ error: e.message });
  }
});

/** 広告グループ一覧 */
app.get('/api/adgroups', async (req, res) => {
  try {
    const r = await axios.get(`${AMZ_ADS_URL}/v2/sp/adGroups`, {
      params: { stateFilter: 'enabled,paused', count: 100 },
      headers: await adsHeaders(),
    });
    res.json(r.data);
  } catch (e) {
    console.error('[adgroups]', e.response?.data || e.message);
    res.status(e.response?.status || 500).json({ error: e.message });
  }
});

/** キーワード一覧 */
app.get('/api/keywords', async (req, res) => {
  try {
    const r = await axios.get(`${AMZ_ADS_URL}/v2/sp/keywords`, {
      params: { stateFilter: 'enabled,paused', count: 200 },
      headers: await adsHeaders(),
    });
    res.json(r.data);
  } catch (e) {
    console.error('[keywords]', e.response?.data || e.message);
    res.status(e.response?.status || 500).json({ error: e.message });
  }
});

/** ターゲティング（商品・カテゴリ） */
app.get('/api/targets', async (req, res) => {
  try {
    const r = await axios.get(`${AMZ_ADS_URL}/v2/sp/targets`, {
      params: { stateFilter: 'enabled,paused', count: 200 },
      headers: await adsHeaders(),
    });
    res.json(r.data);
  } catch (e) {
    console.error('[targets]', e.response?.data || e.message);
    res.status(e.response?.status || 500).json({ error: e.message });
  }
});

/** パフォーマンスレポートのリクエスト送信 */
app.post('/api/reports', async (req, res) => {
  try {
    const r = await axios.post(
      `${AMZ_ADS_URL}/v2/sp/campaigns/report`,
      req.body,
      { headers: await adsHeaders() }
    );
    res.json(r.data);
  } catch (e) {
    console.error('[reports/post]', e.response?.data || e.message);
    res.status(e.response?.status || 500).json({ error: e.message });
  }
});

/** パフォーマンスレポートのダウンロード（非同期ポーリング用） */
app.get('/api/reports/:reportId', async (req, res) => {
  try {
    const r = await axios.get(
      `${AMZ_ADS_URL}/v2/reports/${req.params.reportId}/download`,
      { headers: await adsHeaders(), responseType: 'arraybuffer' }
    );
    const json = JSON.parse(Buffer.from(r.data).toString('utf-8'));
    res.json(json);
  } catch (e) {
    console.error('[reports/get]', e.response?.data || e.message);
    res.status(e.response?.status || 500).json({ error: e.message });
  }
});

// ── サーバー起動 ───────────────────────────────────────────
const PORT = process.env.PORT || 3001;

function logStartup(port) {
  console.log(`✅ Proxy Server 起動: http://localhost:${port}`);
  console.log(`   ダッシュボード: http://localhost:${port}`);
  console.log(`   ヘルスチェック: http://localhost:${port}/health`);
  if (!CLIENT_ID) console.warn('⚠️  CLIENT_ID が未設定です (.env を確認してください)');
}

if (require.main === module) {
  app.listen(PORT, () => logStartup(PORT));
}

module.exports = app;
