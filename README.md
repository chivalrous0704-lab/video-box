# 動画BOX v0.26

## yt-dlp 更新版

YouTubeの `Sign in to confirm you're not a bot` 対策として、
Render起動時に yt-dlp を更新する処理を追加しました。

### 変更点
- `youtube-dl-exec` を 3.1.15 に固定
- 起動時に yt-dlp の `nightly` 更新を優先して実行
- nightly更新に失敗した場合は通常更新へフォールバック
- 更新自体が失敗しても動画BOXは起動する
- 起動ログに実際の yt-dlp バージョンを表示

### 注意
この更新でYouTube取得が改善する可能性はありますが、
YouTube側がRenderのアクセス元をボット判定している場合は、
最新版でもCookie認証を要求されることがあります。
