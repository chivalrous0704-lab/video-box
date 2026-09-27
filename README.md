# 動画BOX v0.18

## 修正内容
Instagram動画は取得・保存できるのに、iPhone Safari内のプレビューで再生できない問題への対策版です。

v0.17までは動画のRange配信を自前で処理していましたが、
Safariのbyte-range要求と相性が悪い可能性があるため、
v0.18ではExpress標準のsendFileに任せる方式へ変更しました。

- Range配信をExpress標準処理へ変更
- HEAD要求にも安定対応
- プレビューはinline配信
- キャッシュ無効
- プレビューURL設定時にvideo要素を明示的に再読込

動画取得方法自体はv0.17と同じです。
