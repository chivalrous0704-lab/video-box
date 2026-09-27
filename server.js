const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname;
const MAX_BYTES = 500 * 1024 * 1024; // 500MB

function isPrivateIp(ip) {
  if (!net.isIP(ip)) return true;
  if (ip.includes(':')) {
    const low = ip.toLowerCase();
    return low === '::1' || low.startsWith('fc') || low.startsWith('fd') || low.startsWith('fe80:');
  }
  const p = ip.split('.').map(Number);
  return p[0] === 10 || p[0] === 127 || p[0] === 0 ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] >= 224);
}

async function validateUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('URLの形式が正しくありません'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('http/https URLのみ対応しています');
  if (!u.hostname || u.username || u.password) throw new Error('このURL形式には対応していません');
  const records = await dns.lookup(u.hostname, { all: true });
  if (!records.length || records.some(r => isPrivateIp(r.address))) throw new Error('安全上、このURLには接続できません');
  return u;
}

function requestOnce(u, method = 'GET', headers = {}) {
  return new Promise((resolve, reject) => {
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method,
      headers: {
        'User-Agent': 'VideoBox/0.2',
        'Accept': 'video/*,audio/*,application/octet-stream;q=0.8,*/*;q=0.2',
        ...headers,
      },
      timeout: 15000,
    }, resolve);
    req.on('timeout', () => req.destroy(new Error('接続がタイムアウトしました')));
    req.on('error', reject);
    req.end();
  });
}

async function fetchRemote(raw, method = 'GET', headers = {}, redirects = 0) {
  if (redirects > 5) throw new Error('リダイレクトが多すぎます');
  const u = await validateUrl(raw);
  const res = await requestOnce(u, method, headers);
  if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
    res.resume();
    const next = new URL(res.headers.location, u).toString();
    return fetchRemote(next, method, headers, redirects + 1);
  }
  return { res, finalUrl: u.toString() };
}

function mediaAllowed(contentType, url) {
  const ct = (contentType || '').toLowerCase();
  if (ct.startsWith('video/') || ct.startsWith('audio/') || ct === 'application/octet-stream') return true;
  return /\.(mp4|mov|m4v|webm|mp3|m4a|aac|wav|ogg)(\?|$)/i.test(url);
}

function safeName(url, contentType = '') {
  let name = 'video';
  try {
    const p = new URL(url).pathname.split('/').filter(Boolean).pop();
    if (p) name = decodeURIComponent(p).replace(/[^\w.\-()\[\]ぁ-んァ-ヶ一-龠々ー]/g, '_').slice(0, 120);
  } catch {}
  if (!path.extname(name)) {
    const map = {'video/mp4':'.mp4','video/webm':'.webm','audio/mpeg':'.mp3','audio/mp4':'.m4a','audio/wav':'.wav'};
    name += map[(contentType || '').split(';')[0].toLowerCase()] || '.mp4';
  }
  return name;
}

function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Content-Length':data.length,'Cache-Control':'no-store'});
  res.end(data);
}

function serveStatic(req, res) {
  let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, {error:'Forbidden'});
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return sendJson(res, 404, {error:'Not found'});
    const ext = path.extname(file).toLowerCase();
    const types = {'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
    res.writeHead(200, {'Content-Type':types[ext] || 'application/octet-stream','Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'});
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const parsed = new URL(req.url, 'http://localhost');
    if (parsed.pathname === '/api/inspect' && req.method === 'GET') {
      const raw = parsed.searchParams.get('url');
      if (!raw) return sendJson(res, 400, {error:'URLが必要です'});
      const host = new URL(raw).hostname.toLowerCase();
      if (/(^|\.)instagram\.com$|(^|\.)tiktok\.com$|(^|\.)x\.com$|(^|\.)twitter\.com$|(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(host)) {
        return sendJson(res, 422, {error:'SNSの投稿ページURLからの抽出には対応していません。公式のダウンロード機能、または権利を持つ直接動画URLをご利用ください。', social:true});
      }
      let remote;
      try { remote = await fetchRemote(raw, 'HEAD'); }
      catch { remote = await fetchRemote(raw, 'GET', {'Range':'bytes=0-0'}); }
      const { res: rr, finalUrl } = remote;
      const ct = rr.headers['content-type'] || '';
      const len = Number(rr.headers['content-length'] || 0);
      const ok = rr.statusCode >= 200 && rr.statusCode < 400 && mediaAllowed(ct, finalUrl) && (!len || len <= MAX_BYTES);
      rr.resume();
      if (!ok) return sendJson(res, 415, {error:'直接の動画・音声ファイルURLとして確認できませんでした', status:rr.statusCode, contentType:ct});
      return sendJson(res, 200, {ok:true, finalUrl, contentType:ct, bytes:len || null, filename:safeName(finalUrl, ct)});
    }

    if (parsed.pathname === '/api/download' && req.method === 'GET') {
      const raw = parsed.searchParams.get('url');
      if (!raw) return sendJson(res, 400, {error:'URLが必要です'});
      const {res: rr, finalUrl} = await fetchRemote(raw, 'GET');
      const ct = rr.headers['content-type'] || 'application/octet-stream';
      const len = Number(rr.headers['content-length'] || 0);
      if (rr.statusCode < 200 || rr.statusCode >= 300 || !mediaAllowed(ct, finalUrl) || (len && len > MAX_BYTES)) {
        rr.resume();
        return sendJson(res, 415, {error:'ダウンロード可能な動画・音声ファイルではありません'});
      }
      const filename = safeName(finalUrl, ct).replace(/"/g,'');
      res.writeHead(200, {
        'Content-Type': ct,
        ...(len ? {'Content-Length': len} : {}),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control':'no-store',
        'X-Content-Type-Options':'nosniff'
      });
      let sent = 0;
      rr.on('data', chunk => {
        sent += chunk.length;
        if (sent > MAX_BYTES) { rr.destroy(); res.destroy(); }
      });
      rr.pipe(res);
      rr.on('error', () => res.destroy());
      return;
    }

    serveStatic(req, res);
  } catch (e) {
    sendJson(res, 500, {error:e.message || 'サーバーエラー'});
  }
});

server.listen(PORT, () => console.log(`Video BOX v0.2: http://localhost:${PORT}`));
