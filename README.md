# 動画BOX v0.12

## v0.12 修正
- TikTokで出る `Unexpected response from webpage request` 対策を追加
- TikTokだけ Chrome 145 相当の User-Agent で取得を試行
- 失敗時は別User-Agentで再試行
- 最後に yt-dlp を更新してからもう一度再試行
- Service Worker のキャッシュ名を v0.12 に更新

## これまでの機能
- Instagram / TikTok / X の公開投稿URLから動画情報を取得
- アプリ内プレビュー
- 「端末に保存」
- 「元の投稿を開く」
- 直接動画URLの保存

## 注意
SNS側の仕様変更・ログイン限定・非公開・年齢制限・地域制限などでは取得できない場合があります。
