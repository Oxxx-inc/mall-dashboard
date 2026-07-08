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

function httpsRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const enc = res.headers['content-encoding'];
        const decomp = enc === 'gzip' ? cb => zlib.gunzip(buf, cb)
                     : enc === 'deflate' ? cb => zlib.inflate(buf, cb)
                     : cb => cb(null, buf);
        decomp((err, data) => {
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

async function getAccessToken() {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: AMZ_REFRESH_TOKEN,
    client_id: AMZ_CLIENT_ID,
    client_secret: AMZ_CLIENT_SECRET,
  }).toString();
  const result = await httpsRequest({
    hostname: TOKEN_URL, path: '/auth/o2/token', method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
  }, body);
  if (!result.data.access_token) throw new Error('Token取得失敗: ' + JSON.stringify(result.data));
  return result.data.access_token.trim().replace(/[\r\n\s]/g, '');
}

async function adsPost(path, bodyObj, contentType, accept) {
  const token = await getAccessToken();
  const body  = JSON.stringify(bodyObj);
  const ct    = contentType || 'application/json';
  const ac    = accept      || 'application/json';
  return httpsRequest({
    hostname: ADS_HOST, path, method: 'POST',
    headers: {
      'Amazon-Advertising-API-ClientId': AMZ_CLIENT_ID,
      'Amazon-Advertising-API-Scope':    AMZ_PROFILE_ID,
      'Authorization':  `Bearer ${token}`,
      'Content-Type':   ct,
      'Accept':         ac,
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);
}

async function adsGet(path) {
  const token = await getAccessToken();
  return httpsRequest({
    hostname: ADS_HOST, path, method: 'GET',
    headers: {
      'Amazon-Advertising-API-ClientId': AMZ_CLIENT_ID,
      'Amazon-Advertising-API-Scope':    AMZ_PROFILE_ID,
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    },
  });
}

function downloadUrl(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        zlib.gunzip(buf, (err, data) => {
          const text = err ? buf.toString('utf-8') : data.toString('utf-8');
          try { resolve(JSON.parse(text)); }
          catch { resolve(text); }
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchCampaignReport() {
  const today     = new Date();
  const endDate   = today.toISOString().slice(0, 10).replace(/-/g, '');
  const startDate = new Date(today - 30 * 86400000).toISOString().slice(0, 10).replace(/-/g, '');

  // レポートリクエスト
  const reqResult = await adsPost(
    '/reporting/reports',
    {
      name: 'Campaign Performance',
      startDate,
      endDate,
      configuration: {
        adProduct:    'SPONSORED_PRODUCTS',
        groupBy:      ['campaign'],
        columns:      ['campaignId', 'campaignName', 'impressions', 'clicks', 'cost', 'sales30d', 'purchases30d'],
        reportTypeId: 'spCampaigns',
        timeUnit:     'SUMMARY',
        format:       'GZIP_JSON',
      },
    },
    'application/vnd.createasyncreportrequest.v3+json',
    'application/vnd.createasyncreportrequest.v3+json'
  );

  if (reqResult.status !== 200 || !reqResult.data.reportId) {
    throw new Error('レポートリクエスト失敗 ' + reqResult.status + ': ' + JSON.stringify(reqResult.data));
  }

  const reportId = reqResult.data.reportId;

  // ポーリング（最大90秒）
  for (let i = 0; i < 18; i++) {
    await sleep(5000);
    const st = await adsGet(`/reporting/reports/${reportId}`);
    const status = st.data.status;
    if (status === 'COMPLETED') {
      const url = st.data.url;
      if (!url) throw new Error('ダウンロードURLなし');
      return await downloadUrl(url);
    }
    if (status === 'FAILED') throw new Error('レポート失敗: ' + JSON.stringify(st.data));
  }
  throw new Error('レポートタイムアウト');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { endpoint } = req.query;

  if (endpoint === 'health') return res.status(200).json({ status: 'ok', time: new Date().toISOString() });

  if (endpoint === 'debug') {
    try {
      const token = await getAccessToken();
      return res.status(200).json({ status: 'ok', token_length: token.length, profile_id: AMZ_PROFILE_ID });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  try {
    if (endpoint === 'campaigns') {
      const r = await adsPost('/sp/campaigns/list',
        { stateFilter: { include: ['ENABLED', 'PAUSED'] }, maxResults: 100 },
        'application/vnd.spCampaign.v3+json',
        'application/vnd.spCampaign.v3+json'
      );
      return res.status(r.status).json(r.data);

    } else if (endpoint === 'keywords') {
      const r = await adsPost('/sp/keywords/list',
        { stateFilter: { include: ['ENABLED', 'PAUSED'] }, maxResults: 200 },
        'application/vnd.spKeyword.v3+json',
        'application/vnd.spKeyword.v3+json'
      );
      return res.status(r.status).json(r.data);

    } else if (endpoint === 'adgroups') {
      const r = await adsPost('/sp/adGroups/list',
        { stateFilter: { include: ['ENABLED', 'PAUSED'] }, maxResults: 100 },
        'application/vnd.spAdGroup.v3+json',
        'application/vnd.spAdGroup.v3+json'
      );
      return res.status(r.status).json(r.data);

    } else if (endpoint === 'targets') {
      const r = await adsPost('/sp/targets/list',
        { stateFilter: { include: ['ENABLED', 'PAUSED'] }, maxResults: 200 },
        'application/vnd.spTargetingClause.v3+json',
        'application/vnd.spTargetingClause.v3+json'
      );
      return res.status(r.status).json(r.data);

    } else if (endpoint === 'report') {
      const reportData = await fetchCampaignReport();
      return res.status(200).json({ report: Array.isArray(reportData) ? reportData : [] });

    } else {
      return res.status(400).json({ error: `不明なendpoint: ${endpoint}` });
    }
  } catch (e) {
    console.error('[proxy error]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
