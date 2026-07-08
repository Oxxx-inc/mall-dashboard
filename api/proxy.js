/**
 * Amazon広告API Proxy
 * Vercel Serverless Function（/api/proxy.js）
 * 2段階レポート方式（Hobby plan対応）
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
  return httpsRequest({
    hostname: ADS_HOST, path, method: 'POST',
    headers: {
      'Amazon-Advertising-API-ClientId': AMZ_CLIENT_ID,
      'Amazon-Advertising-API-Scope':    AMZ_PROFILE_ID,
      'Authorization':  `Bearer ${token}`,
      'Content-Type':   contentType || 'application/json',
      'Accept':         accept      || 'application/json',
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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { endpoint, id } = req.query;

  if (endpoint === 'health') return res.status(200).json({ status: 'ok', time: new Date().toISOString() });

  try {
    // キャンペーン一覧
    if (endpoint === 'campaigns') {
      const r = await adsPost('/sp/campaigns/list',
        { stateFilter: { include: ['ENABLED', 'PAUSED'] }, maxResults: 100 },
        'application/vnd.spCampaign.v3+json',
        'application/vnd.spCampaign.v3+json'
      );
      return res.status(r.status).json(r.data);

    // キーワード一覧
    } else if (endpoint === 'keywords') {
      const r = await adsPost('/sp/keywords/list',
        { stateFilter: { include: ['ENABLED', 'PAUSED'] }, maxResults: 200 },
        'application/vnd.spKeyword.v3+json',
        'application/vnd.spKeyword.v3+json'
      );
      return res.status(r.status).json(r.data);

    // ① レポートリクエスト（即時返却）- キャンペーン＋キーワード両方
    } else if (endpoint === 'report_request') {
      const today     = new Date();
      const endDate   = (req.query.end   || today.toISOString().slice(0, 10));
      const startDate = (req.query.start || new Date(today - 30 * 86400000).toISOString().slice(0, 10));

      // キャンペーンレポート
      const campReport = await adsPost(
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

      // キーワードレポート
      const kwReport = await adsPost(
        '/reporting/reports',
        {
          name: `Keyword Performance ${startDate} ${endDate}`,
          startDate,
          endDate,
          configuration: {
            adProduct:    'SPONSORED_PRODUCTS',
            groupBy:      ['adGroup'],
            columns:      ['keywordId', 'keywordText', 'matchType', 'impressions', 'clicks', 'cost', 'sales30d', 'purchases30d'],
            reportTypeId: 'spKeywords',
            timeUnit:     'SUMMARY',
            format:       'GZIP_JSON',
          },
        },
        'application/vnd.createasyncreportrequest.v3+json',
        'application/vnd.createasyncreportrequest.v3+json'
      );

      // キャンペーンレポートID取得
      let campReportId;
      if (campReport.status === 200 && campReport.data.reportId) {
        campReportId = campReport.data.reportId;
      } else if (campReport.status === 425) {
        const m = JSON.stringify(campReport.data).match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);
        if (m) campReportId = m[1];
      }

      // キーワードレポートID取得
      let kwReportId;
      if (kwReport.status === 200 && kwReport.data.reportId) {
        kwReportId = kwReport.data.reportId;
      } else if (kwReport.status === 425) {
        const raw = JSON.stringify(kwReport.data);
        const m = raw.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/g);
        if (m && m.length > 0) kwReportId = m[m.length - 1]; // 最後のUUIDを取得
        console.log('[kwReport 425] raw:', raw, 'extracted:', kwReportId);
      } else {
        console.log('[kwReport error] status:', kwReport.status, 'data:', JSON.stringify(kwReport.data));
      }

      if (!campReportId) {
        return res.status(campReport.status).json({ error: 'キャンペーンレポート失敗: ' + JSON.stringify(campReport.data) });
      }

      return res.status(200).json({
        reportId:   campReportId,
        kwReportId: kwReportId || null,
        status:     'PENDING',
      });

    // ② レポートステータス確認 & ダウンロード（即時返却）
    } else if (endpoint === 'report_status') {
      if (!id) return res.status(400).json({ error: 'idパラメータが必要です' });

      const st = await adsGet(`/reporting/reports/${id}`);
      const status = st.data.status;

      if (status === 'COMPLETED') {
        const url = st.data.url;
        if (!url) return res.status(500).json({ error: 'ダウンロードURLなし' });
        const data = await downloadUrl(url);
        return res.status(200).json({ status: 'COMPLETED', report: Array.isArray(data) ? data : [] });
      }

      if (status === 'FAILED') {
        return res.status(500).json({ status: 'FAILED', error: JSON.stringify(st.data) });
      }

      // PENDING or PROCESSING
      return res.status(200).json({ status: status || 'PENDING' });

    } else {
      return res.status(400).json({
        error: `不明なendpoint: ${endpoint}`,
        valid: ['campaigns', 'keywords', 'report_request', 'report_status', 'health'],
      });
    }
  } catch (e) {
    console.error('[proxy error]', e.message);
    return res.status(500).json({ error: e.message });
  }
};
