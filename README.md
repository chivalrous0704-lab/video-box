# 動画BOX v0.20

## 修正内容
v0.19 の Render 起動エラーを修正しました。

原因:
server.js 内の ffmpeg エラー処理で改行文字が壊れ、JavaScript の構文エラーになっていました。

v0.20 では修正後に Node.js の構文チェックを実施し、起動できることを確認しています。

Instagram:
- H.264 + AAC
- 最大720p
- 30fps
- yuv420p
- faststart
- 変換最大60秒
