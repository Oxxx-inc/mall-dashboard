/**
 * Amazon広告API Proxy
 * Vercel Serverless Function（/api/proxy.js）
 * 
 * フロントエンドからのリクエストをAmazon広告APIに中継します
 * 環境変数はVercelのEnvironment Variablesで設定してください
 */

const https = require('https');

const {
  AMZ_CLIENT_ID,
  AMZ_CLIENT_SECRET,
  AMZ_REFRESH_TOKEN,
  AMZ_PROFILE_ID,
} = process.env;

const TOKEN_URL  = 'api.amazon.co.jp';
const ADS_HOST   = 'advertising-api-fe.amazon.com';

// ── Access Token キャッシュ ──────────────────────────
let cachedToken  = null;
let tokenExpiry  = 0;

function httpsPost(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams(body).toString();
    const req  = https.request({
      hostname, path, method: 'POST',
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data),
      },
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { reject(new Error('JSON parse error: ' + raw)); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpsGet(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET', headers }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch { reject(new Error('JSON parse error: ' + raw)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const res = await httpsPost(TOKEN_URL, '/auth/o2/token', {
    grant_type:    'refresh_token',
    refresh_token: AMZ_REFRESH_TOKEN,
    client_id:     AMZ_CLIENT_ID,
    client_secret: AMZ_CLIENT_SECRET,
  });
  if (!res.access_token) throw new Error('Token取得失敗: ' + JSON.stringify(res));
  cachedToken = res.access_token;
  tokenExpiry = Date.now() + (res.expires_in - 60) * 1000;
  return cachedToken;
}

async function adsGet(path) {
  const token = await getAccessToken();
  return httpsGet(ADS_HOST, path, {
    'Amazon-Advertising-API-ClientId': AMZ_CLIENT_ID,
    'Amazon-Advertising-API-Scope':    AMZ_PROFILE_ID,
    'Authorization': `Bearer ${token}`,
    'Content-Type':  'application/json',
  });
}

// ── メインハンドラ ──────────────────────────────────
module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { endpoint } = req.query;

  const routes = {
    campaigns: '/sp/campaigns?stateFilter=ENABLED,PAUSED&count=100',
    adgroups:  '/sp/adGroups?stateFilter=ENABLED,PAUSED&count=100',
    keywords:  '/sp/keywords?stateFilter=ENABLED,PAUSED&count=200',
    targets:   '/sp/targets?stateFilter=ENABLED,PAUSED&count=200',
    health:    null,
  };

  if (endpoint === 'health') {
    return res.status(200).json({ status: 'ok', time: new Date().toISOString() });
  }

  if (!routes[endpoint]) {
    return res.status(400).json({
      error: `不明なendpoint: ${endpoint}`,
      valid: Object.keys(routes),
    });
  }

  try {
    const result = await adsGet(routes[endpoint]);
    return res.status(result.status).json(result.data);
  } catch (e) {
    console.error('[proxy error]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
