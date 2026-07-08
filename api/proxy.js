/**
 * Amazon広告API Proxy
 * Vercel Serverless Function（/api/proxy.js）
 * SP API v3対応 + レポートAPI対応版
 */

const https = require('https');
const zlib  = require('zlib');

const AMZ_CLIENT_ID     = (process.env.AMZ_CLIENT_ID     || '').trim();
const AMZ_CLIENT_SECRET = (process.env.AMZ_CLIENT_SECRET || '').trim();
const AMZ_REFRESH_TOKEN = (process.env.AMZ_REFRESH_TOKEN || '').trim();
const AMZ_PROFILE_ID    = (process.env.AMZ_PROFILE_ID    || '').trim();

const TOKEN_URL = 'api.amazon.co.jp';
const ADS_HOST  = 'advertising-api-fe.amazon.com';

// ── HTTP共通 ──────────────────────────────────────────
function httpsRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        // gzip対応
        const encoding = res.headers['content-encoding'];
        const decompress = encoding === 'gzip'
          ? cb => zlib.gunzip(buf, cb)
          : encoding === 'deflate'
          ? cb => zlib.inflate(buf, cb)
          : cb => cb(null, buf);

        decompress((err, data) => {
          if (err) return reject(err);
          const text = data.toString('utf-8');
          try { resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(text) }); }
          catch { resolve({ status: res.statusCode, headers: res.headers, data: text }); }
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Access Token ──────────────────────────────────────
async function getAccessToken() {
  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: AMZ_REFRESH_TOKEN,
    client_id:     AMZ_CLIENT_ID,
    client_secret: AMZ_CLIENT_SECRET,
  }).toString();

  const result = await httpsRequest({
    hostname: TOKEN_URL, path: '/auth/o2/token', method: 'POST',
    headers: {
      'Content-Type':   'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);

  if (!result.data.access_token) throw new Error('Token取得失敗: ' + JSON.stringify(result.data));
  return result.data.access_token.trim().replace(/[\r\n\s]/g, '');
}

// ── 共通ヘッダー ──────────────────────────────────────
async function baseHeaders(contentType = 'application/json', accept = 'application/json') {
  const token = await getAccessToken();
  return {
    'Amazon-Advertising-API-ClientId': AMZ_CLIENT_ID,
    'Amazon-Advertising-API-Scope':    AMZ_PROFILE_ID,
    'Authorization': `Bearer ${token}`,
    'Content-Type':  contentType,
    'Accept':        accept,
  };
}

// ── POSTリクエスト ────────────────────────────────────
async function adsPost(path, bodyObj, contentType, accept) {
  const body    = JSON.stringify(bodyObj);
  const headers = await baseHeaders(
    contentType || 'application/vnd.spCampaign.v3+json',
    accept      || 'application/vnd.spCampaign.v3+json'
  );
  headers['Content-Length'] = Buffer.byteLength(body);
  return httpsRequest({ hostname: ADS_HOST, path, method: 'POST', headers }, body);
}

// ── GETリクエスト ─────────────────────────────────────
async function adsGet(path, accept) {
  const headers = await baseHeaders('application/json', accept || 'application/json');
  return httpsRequest({ hostname: ADS_HOST, path, method: 'GET', headers });
}

// ── 外部URLからダウンロード（レポート用）────────────────
function downloadUrl(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   'GET',
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        zlib.gunzip(buf, (err, data) => {
          if (err) {
            // gzipでない場合はそのまま
            try { resolve(JSON.parse(buf.toString('utf-8'))); }
            catch { resolve(buf.toString('utf-8')); }
          } else {
            try { resolve(JSON.parse(data.toString('utf-8'))); }
            catch { resolve(data.toString('utf-8')); }
          }
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── sleep ─────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── レポート取得（リクエスト→ポーリング→ダウンロード）──
async function fetchCampaignReport() {
  // 1. レポートリクエスト
  const today = new Date();
  const endDate   = today.toISOString().slice(0, 10).replace(/-/g, '');
  const startDate = new Date(today - 30 * 86400000).toISOString().slice(0, 10).replace(/-/g, '');

  const reqResult = await adsPost(
    '/reporting/reports',
    {
      name:          'Campaign Performance Report',
      startDate,
      endDate,
      configuration: {
        adProduct:    'SPONSORED_PRODUCTS',
        groupBy:      ['campaign'],
        columns:      ['campaignId', 'campaignName', 'impressions', 'clicks', 'cost', 'purchases1d', 'purchases7d', 'purchases14d', 'purchases30d', 'sales1d', 'sales7d', 'sales14d', 'sales30d'],
        reportTypeId: 'spCampaigns',
        timeUnit:     'SUMMARY',
        format:       'GZIP_JSON',
      },
    },
    'application/vnd.createasyncreportrequest.v3+json',
    'application/vnd.createasyncreportrequest.v3+json'
  );

  if (!reqResult.data.reportId) {
    throw new Error('レポートリクエスト失敗: ' + JSON.stringify(reqResult.data));
  }

  const reportId = reqResult.data.reportId;

  // 2. ポーリング（最大60秒）
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    const statusResult = await adsGet(`/reporting/reports/${reportId}`);
    const status = statusResult.data.status;

    if (status === 'COMPLETED') {
      const downloadLink = statusResult.data.url;
      if (!downloadLink) throw new Error('ダウンロードURLなし');
      const reportData = await downloadUrl(downloadLink);
      return Array.isArray(reportData) ? reportData : [];
    }
    if (status === 'FAILED') {
      throw new Error('レポート生成失敗: ' + JSON.stringify(statusResult.data));
    }
    // PENDING/PROCESSING → 次のループへ
  }
  throw new Error('レポートタイムアウト（60秒）');
}

// ── メインハンドラ ────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { endpoint } = req.query;

  if (endpoint === 'health') {
    return res.status(200).json({ status: 'ok', time: new Date().toISOString() });
  }

  if (endpoint === 'debug') {
    try {
      const token = await getAccessToken();
      return res.status(200).json({
        status: 'ok', token_length: token.length,
        token_prefix: token.slice(0, 10) + '...',
        client_id_ok: AMZ_CLIENT_ID.startsWith('amzn1'),
        profile_id: AMZ_PROFILE_ID,
      });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  try {
    let result;

    if (endpoint === 'campaigns') {
      result = await adsPost('/sp/campaigns/list', {
        stateFilter: { include: ['ENABLED', 'PAUSED'] }, maxResults: 100,
      });
      return res.status(result.status).json(result.data);

    } else if (endpoint === 'keywords') {
      result = await adsPost('/sp/keywords/list', {
        stateFilter: { include: ['ENABLED', 'PAUSED'] }, maxResults: 200,
      });
      return res.status(result.status).json(result.data);

    } else if (endpoint === 'adgroups') {
      result = await adsPost('/sp/adGroups/list', {
        stateFilter: { include: ['ENABLED', 'PAUSED'] }, maxResults: 100,
      });
      return res.status(result.status).json(result.data);

    } else if (endpoint === 'targets') {
      result = await adsPost('/sp/targets/list', {
        stateFilter: { include: ['ENABLED', 'PAUSED'] }, maxResults: 200,
      });
      return res.status(result.status).json(result.data);

    } else if (endpoint === 'report') {
      // パフォーマンスレポート（非同期・最大60秒）
      const reportData = await fetchCampaignReport();
      return res.status(200).json({ report: reportData });

    } else {
      return res.status(400).json({
        error: `不明なendpoint: ${endpoint}`,
        valid: ['campaigns', 'keywords', 'adgroups', 'targets', 'report', 'health', 'debug'],
      });
    }
  } catch (e) {
    console.error('[proxy error]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
