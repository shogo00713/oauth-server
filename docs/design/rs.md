# リソースサーバー(シンプルメモアプリ)の設計

## 1. 全体像

- メモの API を提供する RS
- 認証とアカウント管理は AS に任せて、RS はユーザー情報を持たない

## 2. 構成

### ディレクトリ

```
apps/rs/src/
  index.ts       起動用
  app.ts         Express 本体
  config.ts      環境変数の読み込みと zod の検証
  middleware/    bearer / verify-token / require-scope / error-handler
  routes/        memos
  lib/           切り出した純関数
  stores/        メモのストアのインターフェースと SQLite 実装
```

### ルーティング

| パス | メソッド | 受理する scope | 内容 |
|---|---|---|---|
| `/memos` | GET | `read` または `write` | 一覧画面 |
| `/memos/:id` | GET | `read` または `write` | 個別のメモの画面 |
| `/memos` | POST | `write` | 新しいメモの作成 |
| `/memos/:id` | PUT | `write` | メモの更新 |
| `/memos/:id` | DELETE | `write` | メモの削除 |


### 環境変数

- `ISSUER`、`AUDIENCE`、`PORT`、`DB_PATH`
- `VERIFY_KEY_PATH`(AS の公開鍵の PEM。M3 で `JWKS_URL` に置き換わる)

## 3. 主要な処理の流れ

### 認証

1. `Authorization` ヘッダーからアクセストークンを取り出す
2. JWT に従い検証する

### 各 API

- 一覧: 持ち主で絞って、全件を返す
- 取得: ID で取得、無ければ 404、持ち主が違えば 403、あれば 200
- 作成: 入力を zod で検証、ランダムな ID を作って保存、201 で作ったメモを返す
- 更新: 検証、取得、404 か 403 の判定、更新(更新日時を更新)、200
- 削除: 取得、404 か 403 の判定、削除、204

## 4. データの構造

### SQLite

| テーブル | 列 |
|---|---|
| `memos` | `id`、`owner`(= `sub`)、`body`、`created_at`、`updated_at` |

### API の JSON

- メモ : `{ id, body, createdAt, updatedAt }`
- 作成と更新のリクエスト: `{ body }`
- 入力検証 : `body` は文字列、1 文字以上、最大長は TODO 
