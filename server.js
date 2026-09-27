const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const youtubedl = require("youtube-dl-exec");
const ffmpegPath = require("ffmpeg-static");
const { spawn } = require("child_process");

const app = express();
app.use(express.static(__dirname));

const MEDIA_TTL = 30 * 60 * 1000;
const MEDIA_DIR = path.join(os.tmpdir(), "video-box-media");
fs.mkdirSync(MEDIA_DIR, { recursive: true });
const mediaCache = new Map();

const TIKTOK_UAS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1"
];

function safeUrl(raw) {
  try {
    const u = new URL(raw);
    if (!["http:", "https:"].includes(u.protocol)) return null;
    return u;
  } catch { return null; }
}

function isTikTokUrl(raw) {
  try {
    const h = new URL(raw).hostname.toLowerCase();
    return h.includes("tiktok.com") || h.includes("tiktokv.com");
  } catch { return false; }
}

function commonFlags() {
  return {
    noWarnings: true,
    noCheckCertificates: true,
    noPlaylist: true,
    // iPhoneで再生しやすい H.264 + AAC のMP4を最優先
    format: "best[ext=mp4][vcodec^=avc1][acodec^=mp4a]/best[ext=mp4][vcodec^=h264][acodec^=aac]/best[ext=mp4][vcodec!=none][acodec!=none]/best[vcodec!=none][acodec!=none]/best"
  };
}

function tiktokFlags(ua) {
  return {
    ...commonFlags(),
    userAgent: ua,
    addHeader: [
      "Referer:https://www.tiktok.com/",
      "Accept-Language:ja,en-US;q=0.9,en;q=0.8"
    ]
  };
}

async function extractSocial(raw) {
  const base = { ...commonFlags(), dumpSingleJson: true, skipDownload: true };
  if (!isTikTokUrl(raw)) return youtubedl(raw, base, { timeout: 45000 });

  let lastErr;
  for (const ua of TIKTOK_UAS) {
    try { return await youtubedl(raw, { ...base, ...tiktokFlags(ua) }, { timeout: 45000 }); }
    catch (e) { lastErr = e; }
  }
  try { await youtubedl.update(); } catch {}
  try { return await youtubedl(raw, { ...base, ...tiktokFlags(TIKTOK_UAS[0]) }, { timeout: 45000 }); }
  catch (e) { lastErr = e; }
  throw lastErr || new Error("TikTokの投稿情報を取得できませんでした");
}


function chooseIosFormat(d) {
  const formats = Array.isArray(d?.formats) ? d.formats : [];
  if (!formats.length) return "";

  const isVideoAudio = f =>
    f && f.format_id &&
    f.vcodec && f.vcodec !== "none" &&
    f.acodec && f.acodec !== "none";

  const isMp4 = f => String(f.ext || "").toLowerCase() === "mp4";
  const isH264 = f => /^(avc1|h264)/i.test(String(f.vcodec || ""));
  const isAac = f => /^(mp4a|aac)/i.test(String(f.acodec || ""));

  const score = f =>
    (Number(f.height) || 0) * 1000000 +
    (Number(f.tbr) || 0) * 1000 +
    (Number(f.filesize || f.filesize_approx) || 0) / 1000000;

  const groups = [
    formats.filter(f => isVideoAudio(f) && isMp4(f) && isH264(f) && isAac(f)),
    formats.filter(f => isVideoAudio(f) && isMp4(f) && isH264(f)),
    formats.filter(f => isVideoAudio(f) && isMp4(f))
  ];

  for (const group of groups) {
    if (group.length) {
      group.sort((a, b) => score(b) - score(a));
      return String(group[0].format_id);
    }
  }
  return "";
}


function makeIphoneCompatible(inputPath, id) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error("ffmpegが利用できません"));

    const outputPath = path.join(MEDIA_DIR, `${id}.iphone.mp4`);
    try { fs.rmSync(outputPath, { force: true }); } catch {}

    const args = [
      "-y",
      "-i", inputPath,
      "-map", "0:v:0",
      "-map", "0:a:0?",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-profile:v", "main",
      "-level", "4.0",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      outputPath
    ];

    const proc = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";

    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
    }, 5 * 60 * 1000);

    proc.stderr.on("data", d => {
      err += d.toString();
      if (err.length > 12000) err = err.slice(-12000);
    });

    proc.on("error", e => {
      clearTimeout(timer);
      reject(e);
    });

    proc.on("close", code => {
      clearTimeout(timer);
      if (code !== 0 || !fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1024) {
        try { fs.rmSync(outputPath, { force: true }); } catch {}
        return reject(new Error("iPhone互換変換に失敗しました: " + (err.split("\n").filter(Boolean).slice(-2).join(" / ") || `ffmpeg code ${code}`)));
      }
      resolve(outputPath);
    });
  });
}

function cleanupPrefix(id) {
  try {
    for (const n of fs.readdirSync(MEDIA_DIR)) {
      if (n.startsWith(id + ".")) fs.rmSync(path.join(MEDIA_DIR, n), { force: true });
    }
  } catch {}
}

function findDownloadedFile(id) {
  const names = fs.readdirSync(MEDIA_DIR).filter(n => n.startsWith(id + ".") && !n.endsWith(".part") && !n.endsWith(".ytdl"));
  if (!names.length) return null;
  names.sort((a, b) => fs.statSync(path.join(MEDIA_DIR, b)).size - fs.statSync(path.join(MEDIA_DIR, a)).size);
  return path.join(MEDIA_DIR, names[0]);
}

async function runDownload(raw, id, flags) {
  cleanupPrefix(id);
  const outTemplate = path.join(MEDIA_DIR, `${id}.%(ext)s`);
  await youtubedl(raw, { ...flags, output: outTemplate }, { timeout: 180000, maxBuffer: 1024 * 1024 * 8 });
  const filePath = findDownloadedFile(id);
  if (!filePath) throw new Error("動画ファイルを作成できませんでした");
  return filePath;
}

async function downloadSocial(raw, id, metadata) {
  const preferredFormat = chooseIosFormat(metadata);
  const baseFlags = preferredFormat ? { ...commonFlags(), format: preferredFormat } : commonFlags();

  if (!isTikTokUrl(raw)) return runDownload(raw, id, baseFlags);

  let lastErr;
  for (const ua of TIKTOK_UAS) {
    try {
      const tf = tiktokFlags(ua);
      if (preferredFormat) tf.format = preferredFormat;
      return await runDownload(raw, id, tf);
    }
    catch (e) { lastErr = e; }
  }
  try { await youtubedl.update(); } catch {}
  try {
    const tf = tiktokFlags(TIKTOK_UAS[0]);
    if (preferredFormat) tf.format = preferredFormat;
    return await runDownload(raw, id, tf);
  }
  catch (e) { lastErr = e; }
  throw lastErr || new Error("TikTok動画を取得できませんでした");
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

function cleanFilename(name, ext = "mp4") {
  const base = String(name || "video")
    .replace(/[\\/:*?"<>|\r\n]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "video";
  const e = String(ext || "mp4").replace(/[^a-z0-9]/gi, "").toLowerCase() || "mp4";
  return base.toLowerCase().endsWith("." + e) ? base : `${base}.${e}`;
}

function mimeFromExt(ext) {
  switch (String(ext).toLowerCase()) {
    case "webm": return "video/webm";
    case "mov": return "video/quicktime";
    case "m4v": return "video/x-m4v";
    default: return "video/mp4";
  }
}

function storeMedia(info) {
  const id = info.id || crypto.randomBytes(16).toString("hex");
  mediaCache.set(id, { ...info, id, expiresAt: Date.now() + MEDIA_TTL });
  return id;
}

function getMedia(id) {
  const x = mediaCache.get(id);
  if (!x) return null;
  if (x.expiresAt < Date.now() || !x.filePath || !fs.existsSync(x.filePath)) {
    try { if (x.filePath) fs.rmSync(x.filePath, { force: true }); } catch {}
    mediaCache.delete(id);
    return null;
  }
  return x;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, x] of mediaCache.entries()) {
    if (x.expiresAt < now) {
      try { if (x.filePath) fs.rmSync(x.filePath, { force: true }); } catch {}
      mediaCache.delete(id);
    }
  }
}, 10 * 60 * 1000).unref();

app.get("/api/social-info", async (req, res) => {
  const raw = req.query.url;
  if (!safeUrl(raw)) return res.status(400).json({ ok: false, error: "URLが不正です" });

  const id = crypto.randomBytes(16).toString("hex");
  try {
    const out = await extractSocial(raw);
    const root = typeof out === "string" ? JSON.parse(out) : out;
    const d = pickEntry(root);
    if (!d) throw new Error("投稿情報を取得できませんでした");

    const title = d.title || d.description || d.fulltitle || "SNS動画";
    const author = d.uploader || d.channel || d.creator || d.uploader_id || "";
    const thumbnail = d.thumbnail || (Array.isArray(d.thumbnails) && d.thumbnails.length ? d.thumbnails[d.thumbnails.length - 1].url : "") || "";
    const webpageUrl = d.webpage_url || raw;

    // v0.13: CDNの直URLをブラウザで再取得しない。
    // yt-dlp自身に動画を一度サーバーへ保存させ、そこから端末へ配信する。
    const downloadedPath = await downloadSocial(raw, id, d);

    // v0.15: 保存できてもiPhoneで再生できないInstagram動画対策。
    // 一度H.264 + AAC / yuv420p / faststartのMP4に変換してから配信する。
    let filePath;
    try {
      filePath = await makeIphoneCompatible(downloadedPath, id);
      if (downloadedPath !== filePath) {
        try { fs.rmSync(downloadedPath, { force: true }); } catch {}
      }
    } catch (convertError) {
      throw new Error(convertError?.message || "iPhone互換形式への変換に失敗しました");
    }

    const ext = "mp4";
    const stat = fs.statSync(filePath);
    storeMedia({ id, filePath, ext, title, webpageUrl, size: stat.size, contentType: "video/mp4" });

    res.json({
      ok: true,
      title,
      author,
      thumbnail,
      webpage_url: webpageUrl,
      filename: cleanFilename(title, ext),
      ext,
      size: stat.size,
      selectedFormat: "H.264 + AAC (iPhone互換変換済み)",
      mediaId: id,
      mediaUrl: `/api/media/${id}`,
      downloadUrl: `/api/media/${id}?download=1`
    });
  } catch (e) {
    cleanupPrefix(id);
    const msg = String(e?.stderr || e?.message || "取得できませんでした").split("\n").filter(Boolean).slice(-2).join(" / ");
    res.status(400).json({ ok: false, error: msg || "取得できませんでした" });
  }
});

app.get("/api/media/:id", (req, res) => {
  try {
    const item = getMedia(req.params.id);
    if (!item) return res.status(410).send("リンクの有効期限が切れました。もう一度『確認』してください。");

    const stat = fs.statSync(item.filePath);
    const total = stat.size;
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Type", item.contentType || "video/mp4");
    if (req.query.download === "1") {
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(cleanFilename(item.title, item.ext))}`);
    }

    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m) return res.status(416).end();
      let start = m[1] ? Number(m[1]) : 0;
      let end = m[2] ? Number(m[2]) : total - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= total) {
        res.setHeader("Content-Range", `bytes */${total}`);
        return res.status(416).end();
      }
      end = Math.min(end, total - 1);
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
      res.setHeader("Content-Length", end - start + 1);
      return fs.createReadStream(item.filePath, { start, end }).pipe(res);
    }

    res.setHeader("Content-Length", total);
    fs.createReadStream(item.filePath).pipe(res);
  } catch (e) {
    if (!res.headersSent) res.status(500).send(e.message || "取得できませんでした");
    else res.end();
  }
});

async function getVideo(raw, range) {
  const u = safeUrl(raw);
  if (!u) throw new Error("URLが不正です");
  const headers = { "User-Agent": "Mozilla/5.0" };
  if (range) headers.Range = range;
  const r = await fetch(u, { redirect: "follow", headers });
  if (!r.ok && r.status !== 206) throw new Error("取得失敗");
  return r;
}

function filenameFrom(url, ct) {
  try {
    let n = decodeURIComponent(new URL(url).pathname.split("/").pop() || "video.mp4");
    if (!/\.[a-z0-9]{2,5}$/i.test(n)) n += (ct || "").includes("webm") ? ".webm" : ".mp4";
    return n;
  } catch { return "video.mp4"; }
}

app.get("/api/check", async (req, res) => {
  try {
    const r = await getVideo(req.query.url);
    const ct = r.headers.get("content-type") || "";
    const isVideo = ct.startsWith("video/") || /\.(mp4|webm|mov|m4v)(?:$|\?)/i.test(req.query.url || "");
    try { r.body?.cancel(); } catch {}
    res.json({ ok: true, isVideo, filename: filenameFrom(req.query.url, ct), proxyUrl: "/api/stream?url=" + encodeURIComponent(req.query.url) });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.get(["/api/stream", "/api/download"], async (req, res) => {
  try {
    const r = await getVideo(req.query.url, req.headers.range);
    const ct = r.headers.get("content-type") || "application/octet-stream";
    if (!ct.startsWith("video/") && !/\.(mp4|webm|mov|m4v)(?:$|\?)/i.test(req.query.url || "")) return res.status(400).send("直接動画URLではありません");
    res.status(r.status);
    for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) {
      const v = r.headers.get(h); if (v) res.setHeader(h, v);
    }
    const reader = r.body.getReader();
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      if (!res.write(Buffer.from(value))) await new Promise(resolve => res.once("drain", resolve));
    }
    res.end();
  } catch (e) { res.status(400).send(e.message); }
});

app.listen(process.env.PORT || 3000, () => console.log("video-box v0.15"));
