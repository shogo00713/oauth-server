# 認可サーバーの設計

## 1. 全体像
- シンプルメモアプリの AS として機能する
- 特に、認証・アカウント管理の部分を担っている別サーバーのイメージ

## 2. 構成

### ディレクトリ構成

```
apps/as/src/
  index.ts     起動用
  app.ts       Express 本体
  config.ts    環境変数の読み込みと zod の検証
  routes/      authorize / login / consent / token
  lib/         切り出した純関数
  stores/      ストアのインターフェースと実装
  views/       ejs (login / consent / error)
```

### ルーティング
- `/authorize` : OAuth 認可エンドポイント
- `/token` : OAuth トークンエンドポイント
- `login` : OAuth ログイン画面
- `consent` : OAuth 認可同意画面

### lib

| ファイル名 | 機能 |　使用用途 |
|---|---|---|
| random.ts | ランダムなトークンの生成 | 認可コードなどの生成 |
| pkce.ts | code_verifeir、code_challenge の形式と値の検証 | PKCE の検証 |


### 環境変数
- `ISSUER`、`PORT`、`AUDIENCE`(`simple-memo`)
- `SESSION_SECRET`、`SIGNING_KEY_PATH`(PEM)、`DB_PATH`
- `CODE_TTL_SEC`(60)、`ACCESS_TOKEN_TTL_SEC`(600)、`DEFAULT_SCOPE`(`read`)

## 3. 主要な処理の流れ
基本的に、OAuth のフローが回ることを軸に、いくつかの拡張機能も持たせている

### 認可エンドポイント （`authorize`）
飛んできたら、ユーザーのログイン → 認可の同意を取る → 元の URL に戻す処理をする
1. クエリを解析して、正しい形式のみ受け付ける
1. ログインしていなかったら、 `/login` に飛ばす
1. ユーザー名とパスワードでログインして、 `consent` へ
1. 同意にチェックを入れて、決定
1. OK なら、認可コードを発行して、保存して、URLへ返す

### トークンエンドポイント
認可コードをアクセストークンと交換するだけ
1. 正しいクエリか、認可コードかを確かめる
1. JWT 形式のアクセストークンを発行して添えて返す
* JWT なので、アクセストークンには DB がいらない

## 4. データの構造

### 認可コード
- SHA256 の ID をキーとする
- 有効期限は 60秒
- `clientId`、`redirectUri`、`codeChallenge`、`sub`、`scope`、`expiresAt` を紐付けて持つ

### アクセストークン
- JWT を使用する
- 形式は RS256 で、鍵は 直置き -> JWKS 移行
- 鍵ローテーションも実装予定
- 有効期限は 10分

### リフレッシュトークン
- 段階的に実装予定
- Opaque 形式で、 AS の SQLite で持つ
- 有効期限は 1時間

### SQLite

| テーブル | 列 |
|---|---|
| `users` | `id`、`username`、`password_hash`(argon2)、`created_at` |
| `clients` | `client_id`、`secret_hash`(SHA-256)、`name`、`redirect_uris`(JSON 配列) |
| `refresh_tokens` | `id`、`token_hash`、`family_id`、`client_id`、`user_id`、`scope`、`origin_code_hash`、`expires_at`、`used_at`、`revoked_at` |