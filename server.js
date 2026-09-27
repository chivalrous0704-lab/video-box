const express = require("express");
const crypto = require("crypto");
const youtubedl = require("youtube-dl-exec");

const app = express();
app.use(express.static(__dirname));

const mediaCache = new Map();
const MEDIA_TTL = 30 * 60 * 1000;

function safeUrl(raw) {
  try {
    const u = new URL(raw);
    if (!["http:", "https:"].includes(u.protocol)) return null;
    return u;
  } catch {
    return null;
  }
}

function filenameFrom(url, ct) {
  try {
    let n = decodeURIComponent(new URL(url).pathname.split("/").pop() || "video.mp4");
    if (!/\.[a-z0-9]{2,5}$/i.test(n)) n += (ct || "").includes("webm") ? ".webm" : ".mp4";
    return n;
  } catch {
    return "video.mp4";
  }
}

function cleanFilename(name, ext = "mp4") {
  const base = String(name || "video")
    .replace(/[\\/:*?"<>|\r\n]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "video";
  const e = String(ext || "mp4").replace(/[^a-z0-9]/gi, "").toLowerCase() || "mp4";
  return base.toLowerCase().endsWith("." + e) ? base : `${base}.${e}`;
}

async function getVideo(raw, range) {
  const u = safeUrl(raw);
  if (!u) throw new Error("URLが不正です");
  const headers = { "User-Agent": "Mozilla/5.0" };
  if (range) headers.Range = range;
  const r = await fetch(u, { redirect: "follow", headers });
  if (!r.ok && r.status !== 206) throw new Error("取得失敗");
  return r;
}

function pickEntry(d) {
  if (!d) return null;
  if (Array.isArray(d.entries) && d.entries.length) {
    for (const e of d.entries) {
      const picked = pickEntry(e);
      if (picked) return picked;
    }
  }
  return d;
}

function chooseFormat(d) {
  const formats = Array.isArray(d.formats) ? d.formats : [];
  const combined = formats
    .filter(f => f && f.url && f.vcodec && f.vcodec !== "none" && f.acodec && f.acodec !== "none")
    .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.tbr || 0) - (a.tbr || 0));
  const mp4 = combined.find(f => String(f.ext || "").toLowerCase() === "mp4");
  return mp4 || combined[0] || formats.filter(f => f && f.url).sort((a, b) => (b.height || 0) - (a.height || 0))[0] || null;
}

function storeMedia(info) {
  const id = crypto.randomBytes(16).toString("hex");
  mediaCache.set(id, { ...info, expiresAt: Date.now() + MEDIA_TTL });
  return id;
}

function getMedia(id) {
  const x = mediaCache.get(id);
  if (!x) return null;
  if (x.expiresAt < Date.now()) {
    mediaCache.delete(id);
    return null;
  }
  return x;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, x] of mediaCache.entries()) if (x.expiresAt < now) mediaCache.delete(id);
}, 10 * 60 * 1000).unref();

app.get("/api/social-info", async (req, res) => {
  try {
    const raw = req.query.url;
    if (!safeUrl(raw)) return res.status(400).json({ ok: false, error: "URLが不正です" });

    const out = await youtubedl(raw, {
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificates: true,
      skipDownload: true,
      noPlaylist: true,
      format: "best[ext=mp4]/best"
    }, { timeout: 45000 });

    const root = typeof out === "string" ? JSON.parse(out) : out;
    const d = pickEntry(root);
    if (!d) throw new Error("投稿情報を取得できませんでした");

    const fmt = d.url ? d : chooseFormat(d);
    if (!fmt || !fmt.url) throw new Error("保存できる動画URLを取得できませんでした");

    const ext = fmt.ext || d.ext || "mp4";
    const title = d.title || d.description || d.fulltitle || "SNS動画";
    const author = d.uploader || d.channel || d.creator || d.uploader_id || "";
    const thumbnail = d.thumbnail || (Array.isArray(d.thumbnails) && d.thumbnails.length ? d.thumbnails[d.thumbnails.length - 1].url : "") || "";
    const webpageUrl = d.webpage_url || raw;
    const headers = { ...(d.http_headers || {}), ...(fmt.http_headers || {}) };
    const mediaId = storeMedia({
      url: fmt.url,
      headers,
      ext,
      title,
      webpageUrl,
      contentType: ext === "webm" ? "video/webm" : "video/mp4"
    });

    res.json({
      ok: true,
      title,
      author,
      thumbnail,
      webpage_url: webpageUrl,
      filename: cleanFilename(title, ext),
      ext,
      mediaId,
      mediaUrl: `/api/media/${mediaId}`,
      downloadUrl: `/api/media/${mediaId}?download=1`
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || "取得できませんでした" });
  }
});

app.get("/api/media/:id", async (req, res) => {
  try {
    const item = getMedia(req.params.id);
    if (!item) return res.status(410).send("リンクの有効期限が切れました。もう一度『確認』してください。");

    const headers = { ...item.headers };
    if (!headers["User-Agent"] && !headers["user-agent"]) headers["User-Agent"] = "Mozilla/5.0";
    if (req.headers.range) headers.Range = req.headers.range;

    const upstream = await fetch(item.url, { redirect: "follow", headers });
    if (!upstream.ok && upstream.status !== 206) throw new Error(`動画取得失敗 (${upstream.status})`);

    res.status(upstream.status);
    for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", item.contentType || "video/mp4");
    if (req.query.download === "1") {
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(cleanFilename(item.title, item.ext))}`);
    }

    if (!upstream.body) return res.end();
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) await new Promise(resolve => res.once("drain", resolve));
    }
    res.end();
  } catch (e) {
    if (!res.headersSent) res.status(400).send(e.message || "取得できませんでした");
    else res.end();
  }
});

app.get("/api/check", async (req, res) => {
  try {
    const r = await getVideo(req.query.url);
    const ct = r.headers.get("content-type") || "";
    const isVideo = ct.startsWith("video/") || /\.(mp4|webm|mov|m4v)(?:$|\?)/i.test(req.query.url || "");
    try { r.body?.cancel(); } catch {}
    res.json({ ok: true, isVideo, filename: filenameFrom(req.query.url, ct), proxyUrl: "/api/stream?url=" + encodeURIComponent(req.query.url) });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.get(["/api/stream", "/api/download"], async (req, res) => {
  try {
    const r = await getVideo(req.query.url, req.headers.range);
    const ct = r.headers.get("content-type") || "application/octet-stream";
    if (!ct.startsWith("video/") && !/\.(mp4|webm|mov|m4v)(?:$|\?)/i.test(req.query.url || "")) return res.status(400).send("直接動画URLではありません");
    res.status(r.status);
    for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) {
      const v = r.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    const reader = r.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) await new Promise(resolve => res.once("drain", resolve));
    }
    res.end();
  } catch (e) {
    res.status(400).send(e.message);
  }
});

app.listen(process.env.PORT || 3000, () => console.log("video-box v0.11"));
