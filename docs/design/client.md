# クライアント(メモボード)の設計

## 1. 全体像

- OAuth の confidential client として働くメモアプリ
- ユーザーは識別しない
- シンプルメモアプリの API を呼んで、メモの一覧、作成、編集、削除、検索を提供する


## 2. 構成

### ディレクトリ

```
apps/client/src/
  index.ts     起動用
  app.ts       Express 本体
  config.ts    環境変数の読み込みと zod の検証
  routes/      home / detail / login / callback / logout
  oauth/       認可 URL の構築、callback の処理、token 交換、(M2)リフレッシュ
  rs/          RS の API を呼ぶ部分
  lib/         切り出した純関数
  views/       ejs(list / detail / error)
```

### ルーティング

| パス | メソッド | 役割 |
|---|---|---|
| `/` | GET | メモ一覧|
| `/detail/:id` | GET、POST | メモの表示、編集、削除 |
| `/login` | GET | 認可リクエストを始める |
| `/callback` | GET | `redirect_uri` |
| `/logout` | POST | ログアウト |


### 環境変数

- `BASE_URL`(自分の URL)、`AS_BASE_URL`、`RS_BASE_URL`、`PORT`
- `CLIENT_ID`、`CLIENT_SECRET`、`SESSION_SECRET`
- `REQUESTED_SCOPE`(M1 は `read write`)

## 3. 主要な処理の流れ

### OAuth フロー

1. `state` と `code_verifier` を作って、セッションに保存する
2. URL を作って、リダイレクト経由で AS へ飛ぶ
3. 認可コードを持って戻ってきたら、 `state` の検証をする
4. トークン交換をする

### RS の呼び出し

- `Authorization: Bearer <access_token>` を付ける

| 応答 | M1 | M2 以降 |
|---|---|---|
| 200、201、204 | 画面に反映 | 同じ |
| 401 | セッションを捨てて再ログイン | リフレッシュして、1 回だけ再試行 |
| 403(`insufficient_scope`) | 「権限不足」のエラー画面 | M3 で追加認可 |
| 403(それ以外) | 「許可されていない」のエラー画面 | 同じ |
| 404、5xx、通信の失敗 | エラー画面(リトライしない) | 同じ |


### ログアウト

- セッションを破棄する(トークンも消える)
- AS 側のセッションは残るから、すぐ再ログインしても、AS のログイン画面は出ない


## 4. データの構造

### セッション

| キー | 内容 | 期間 |
|---|---|---|
| `state` | `state` の値 | `/login` から `/callback` まで |
| `codeVerifier` | `code_verifier` | 同上 |
| `tokens` | `accessToken`、`tokenType`、`expiresAt`、`scope`、(M2)`refreshToken` | ログイン中 |
| `flash` | エラーや通知の一時メッセージ | 1 回 |
| `pendingAction`(M3) | やろうとしていた操作(種別と対象の ID) | 追加認可の間 |

- sid だけはブラウザの cookie に入る
