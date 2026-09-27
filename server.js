const express=require("express");
const app=express();
app.use(express.static(__dirname));

function safeUrl(raw){try{const u=new URL(raw);if(!["http:","https:"].includes(u.protocol))return null;return u}catch{return null}}
function filenameFrom(url,ct){try{let n=decodeURIComponent(new URL(url).pathname.split("/").pop()||"video.mp4");if(!/\.[a-z0-9]{2,5}$/i.test(n))n+=(ct||"").includes("webm")?".webm":".mp4";return n}catch{return "video.mp4"}}
async function getVideo(raw){const u=safeUrl(raw);if(!u)throw new Error("URLが不正です");const r=await fetch(u,{redirect:"follow",headers:{"User-Agent":"Mozilla/5.0"}});if(!r.ok)throw new Error("取得失敗");return r}

app.get("/api/tiktok-oembed",async(req,res)=>{
  try{
    const raw=req.query.url;
    const u=safeUrl(raw); if(!u) return res.status(400).json({ok:false,error:"URLが不正です"});
    const r=await fetch("https://www.tiktok.com/oembed?url="+encodeURIComponent(raw),{redirect:"follow"});
    if(!r.ok) throw new Error("TikTok情報を取得できませんでした");
    const d=await r.json();
    const m=(d.html||"").match(/data-video-id=["'](\d+)["']/);
    const videoId=m?m[1]:null;
    res.json({
      ok:true,title:d.title||"",author_name:d.author_name||"",thumbnail_url:d.thumbnail_url||"",
      resolved_url:raw, player_url: videoId ? "https://www.tiktok.com/player/v1/"+videoId+"?controls=1&progress_bar=1&play_button=1" : raw
    });
  }catch(e){res.status(400).json({ok:false,error:e.message})}
});

app.get("/api/check",async(req,res)=>{try{
  const r=await getVideo(req.query.url);const ct=r.headers.get("content-type")||"";
  const isVideo=ct.startsWith("video/")||/\.(mp4|webm|mov|m4v)(?:$|\?)/i.test(req.query.url||"");
  try{r.body?.cancel()}catch{}
  res.json({ok:true,isVideo,contentType:ct,filename:filenameFrom(req.query.url,ct),proxyUrl:"/api/stream?url="+encodeURIComponent(req.query.url)})
}catch(e){res.status(400).json({ok:false,error:e.message})}});

app.get(["/api/stream","/api/download"],async(req,res)=>{try{
  const r=await getVideo(req.query.url);const ct=r.headers.get("content-type")||"application/octet-stream";
  if(!ct.startsWith("video/")&&!/\.(mp4|webm|mov|m4v)(?:$|\?)/i.test(req.query.url||""))return res.status(400).send("直接動画URLではありません");
  res.setHeader("Content-Type",ct);const len=r.headers.get("content-length");if(len)res.setHeader("Content-Length",len);
  if(req.path.includes("download"))res.setHeader("Content-Disposition",`attachment; filename="${filenameFrom(req.query.url,ct).replace(/"/g,"")}"`);
  const reader=r.body.getReader();while(true){const {done,value}=await reader.read();if(done)break;res.write(Buffer.from(value))}res.end()
}catch(e){res.status(400).send(e.message)}});

const port=process.env.PORT||3000;
app.listen(port,()=>console.log("video-box v0.7 on",port));