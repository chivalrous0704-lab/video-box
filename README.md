# 動画BOX v0.21

## 修正内容
v0.20 の Instagram 取得時に出ていた
`isInstagramUrl is not defined`
を修正しました。

原因:
Instagram判定関数を呼び出していましたが、関数そのものが未定義でした。

v0.21 では `instagram.com` / `instagr.am` を判定する関数を追加しています。

構文チェック:
`node --check server.js` 済み
