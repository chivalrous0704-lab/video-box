const express=require("express");
const app=express();
app.use(express.static(__dirname));

function safeUrl(raw){try{const u=new URL(raw);if(!["http:","https:"].includes(u.protocol))return null;return u}catch{return null}}
function filenameFrom(url,ct){try{let n=decodeURIComponent(new URL(url).pathname.split("/").pop()||"video.mp4");if(!/\.[a-z0-9]{2,5}$/i.test(n))n+=(ct||"").includes("webm")?".webm":".mp4";return n}catch{return "video.mp4"}}
async function getVideo(raw){const u=safeUrl(raw);if(!u)throw new Error("URLが不正です");const r=await fetch(u,{redirect:"follow",headers:{"User-Agent":"Mozilla/5.0"}});if(!r.ok)throw new Error("取得失敗");return r}
async function resolveUrl(raw){
  const u=safeUrl(raw); if(!u) throw new Error("URLが不正です");
  const r=await fetch(u,{redirect:"follow",headers:{"User-Agent":"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1"}});
  const finalUrl=r.url||raw; try{r.body?.cancel()}catch{}
  return finalUrl;
}
function normalizeXUrl(raw){
  const u=safeUrl(raw); if(!u) throw new Error("URLが不正です");
  if(u.hostname==="x.com"||u.hostname.endsWith(".x.com")) u.hostname="twitter.com";
  return u.toString();
}

app.get("/api/tiktok-oembed",async(req,res)=>{
  try{
    const raw=req.query.url; if(!safeUrl(raw)) return res.status(400).json({ok:false,error:"URLが不正です"});
    const resolved=await resolveUrl(raw);
    const api="https://www.tiktok.com/oembed?url="+encodeURIComponent(resolved);
    const r=await fetch(api,{headers:{"User-Agent":"Mozilla/5.0"}});
    const txt=await r.text(); if(!r.ok) throw new Error("TikTok oEmbed "+r.status);
    const d=JSON.parse(txt); const id=((d.html||"").match(/data-video-id=["'](\d+)["']/)||resolved.match(/\/video\/(\d+)/)||[])[1];
    if(!id) throw new Error("動画IDを取得できませんでした");
    res.json({ok:true,title:d.title||"",author_name:d.author_name||"",thumbnail_url:d.thumbnail_url||"",resolved_url:resolved,player_url:"https://www.tiktok.com/player/v1/"+id+"?controls=1&progress_bar=1&play_button=1"});
  }catch(e){res.status(400).json({ok:false,error:e.message})}
});

app.get("/api/instagram-oembed",async(req,res)=>{
  try{
    const raw=req.query.url; const api="https://graph.facebook.com/v26.0/instagram_oembed?omitscript=true&url="+encodeURIComponent(raw);
    const r=await fetch(api,{headers:{"User-Agent":"Mozilla/5.0"}}); const txt=await r.text();
    if(!r.ok) throw new Error("Instagram oEmbed "+r.status);
    const d=JSON.parse(txt); res.json({ok:true,provider:"Instagram",html:d.html||""});
  }catch(e){res.status(400).json({ok:false,error:e.message})}
});

app.get("/api/x-oembed",async(req,res)=>{
  try{
    const raw=req.query.url; const normalized=normalizeXUrl(raw);
    const api="https://publish.twitter.com/oembed?omit_script=1&dnt=1&url="+encodeURIComponent(normalized);
    const r=await fetch(api,{headers:{"User-Agent":"Mozilla/5.0","Accept":"application/json"}});
    const txt=await r.text(); if(!r.ok) throw new Error("X oEmbed "+r.status);
    const d=JSON.parse(txt); res.json({ok:true,provider:"X",html:d.html||""});
  }catch(e){res.status(400).json({ok:false,error:e.message})}
});

app.get("/api/check",async(req,res)=>{try{
  const r=await getVideo(req.query.url);const ct=r.headers.get("content-type")||"";const isVideo=ct.startsWith("video/")||/\.(mp4|webm|mov|m4v)(?:$|\?)/i.test(req.query.url||"");try{r.body?.cancel()}catch{}
  res.json({ok:true,isVideo,filename:filenameFrom(req.query.url,ct),proxyUrl:"/api/stream?url="+encodeURIComponent(req.query.url)})
}catch(e){res.status(400).json({ok:false,error:e.message})}});

app.get(["/api/stream","/api/download"],async(req,res)=>{try{
  const r=await getVideo(req.query.url);const ct=r.headers.get("content-type")||"application/octet-stream";
  if(!ct.startsWith("video/")&&!/\.(mp4|webm|mov|m4v)(?:$|\?)/i.test(req.query.url||""))return res.status(400).send("直接動画URLではありません");
  res.setHeader("Content-Type",ct); const reader=r.body.getReader(); while(true){const {done,value}=await reader.read();if(done)break;res.write(Buffer.from(value))}res.end()
}catch(e){res.status(400).send(e.message)}});

app.listen(process.env.PORT||3000,()=>console.log("video-box v0.9"));
