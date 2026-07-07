/**
 * Amazon広告API Proxy
 * Vercel Serverless Function（/api/proxy.js）
 * SP API v3対応版
 */

const https = require('https');

const AMZ_CLIENT_ID     = (process.env.AMZ_CLIENT_ID     || '').trim();
const AMZ_CLIENT_SECRET = (process.env.AMZ_CLIENT_SECRET || '').trim();
const AMZ_REFRESH_TOKEN = (process.env.AMZ_REFRESH_TOKEN || '').trim();
const AMZ_PROFILE_ID    = (process.env.AMZ_PROFILE_ID    || '').trim();

const TOKEN_URL = 'api.amazon.co.jp';
const ADS_HOST  = 'advertising-api-fe.amazon.com';

function httpsRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch (e) { reject(new Error('Parse error: ' + raw.slice(0, 300))); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getAccessToken() {
  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: AMZ_REFRESH_TOKEN,
    client_id:     AMZ_CLIENT_ID,
    client_secret: AMZ_CLIENT_SECRET,
  }).toString();

  const result = await httpsRequest({
    hostname: TOKEN_URL,
    path:     '/auth/o2/token',
    method:   'POST',
    headers: {
      'Content-Type':   'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);

  if (!result.data.access_token) {
    throw new Error('Token取得失敗: ' + JSON.stringify(result.data));
  }
  return result.data.access_token.trim().replace(/[\r\n\s]/g, '');
}

async function adsPost(path, bodyObj) {
  const token = await getAccessToken();
  const body  = JSON.stringify(bodyObj);
  return httpsRequest({
    hostname: ADS_HOST,
    path,
    method: 'POST',
    headers: {
      'Amazon-Advertising-API-ClientId': AMZ_CLIENT_ID,
      'Amazon-Advertising-API-Scope':    AMZ_PROFILE_ID,
      'Authorization':  `Bearer ${token}`,
      'Content-Type':   'application/vnd.spCampaign.v3+json',
      'Accept':         'application/vnd.spCampaign.v3+json',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);
}

async function adsGet(path, acceptHeader) {
  const token = await getAccessToken();
  return httpsRequest({
    hostname: ADS_HOST,
    path,
    method: 'GET',
    headers: {
      'Amazon-Advertising-API-ClientId': AMZ_CLIENT_ID,
      'Amazon-Advertising-API-Scope':    AMZ_PROFILE_ID,
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      'Accept':        acceptHeader || 'application/json',
    },
  });
}

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
        status: 'ok',
        token_length: token.length,
        token_prefix: token.slice(0, 10) + '...',
        client_id_ok: AMZ_CLIENT_ID.startsWith('amzn1'),
        profile_id:   AMZ_PROFILE_ID,
      });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  try {
    let result;

    if (endpoint === 'campaigns') {
      // SP v3: POSTでリスト取得
      result = await adsPost('/sp/campaigns/list', {
        stateFilter: { include: ['ENABLED', 'PAUSED'] },
        maxResults: 100,
      });
      // acceptヘッダーをv3に上書き
    } else if (endpoint === 'keywords') {
      result = await adsPost('/sp/keywords/list', {
        stateFilter: { include: ['ENABLED', 'PAUSED'] },
        maxResults: 200,
      });
    } else if (endpoint === 'adgroups') {
      result = await adsPost('/sp/adGroups/list', {
        stateFilter: { include: ['ENABLED', 'PAUSED'] },
        maxResults: 100,
      });
    } else if (endpoint === 'targets') {
      result = await adsPost('/sp/targets/list', {
        stateFilter: { include: ['ENABLED', 'PAUSED'] },
        maxResults: 200,
      });
    } else {
      return res.status(400).json({
        error: `不明なendpoint: ${endpoint}`,
        valid: ['campaigns', 'keywords', 'adgroups', 'targets', 'health', 'debug'],
      });
    }

    return res.status(result.status).json(result.data);

  } catch (e) {
    console.error('[proxy error]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
