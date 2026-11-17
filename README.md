# OAuth サーバー

[![CI](https://github.com/shogo00713/oauth-server/actions/workflows/ci.yaml/badge.svg)](https://github.com/shogo00713/oauth-server/actions/workflows/ci.yaml)

- OAuth2.0 のフローを体感する学習用に作成した Web アプリケーションです
- OAuth2.0 の認可コードグラントを実行するために、「認可サーバー」「リソースサーバー」「クライアント」の 3 役があります
- state, PKCE, JWT 形式のアクセストークン などを導入しています

## 作成にあたって

- 本当は認可サーバーとリソースサーバーの部分だけ切り出して作りたいところなのですが、OAuth としては、認可・リソースサーバー側に価値のあるリソースを持っておく構造なので、リソースサーバーも含めています
    - クライアントも、とりあえず 1 つ目として同時に作成しています

- 題材はシンプルな「メモアプリ」が軸となっています
    - リソースサーバーは、実際にメモが存在する立場です
    - クライアントは、それを簡単に編集できるアプリです

## 現状の到達点 (M1)

- 認可コードグラント（ + PKCE ）
- JWT のアクセストークン（ RS256、鍵はファイルに直置き ）
- クライアント認証
- メモの作成、一覧、編集、削除、キーワード検索機能（メモ自体は SQLite で保存）
- state、Cookie セッション、オープンリダイレクト対策

## まだできていないこと

- TLS（ https ）、Secure Cookie の導入
- リフレッシュトークンの導入
- AS のユーザーと client の登録
- AS の認可コードとセッションの永続化

## ディレクトリ構成

```
apps/
  as/      認可サーバー
  rs/      リソースサーバー（シンプルメモアプリ）
  client/  クライアント（メモボード）
  e2e/     結合テスト
docs/
  requirements/  RFC から読み取った、OAuth2.0 としての仕様について
  spec/          このプロジェクトでのアプリの仕様書
  design/        設計書
  milestones/    各マイルストーンごとの範囲
keys/            署名鍵
data/            RS の SQLite の永続化データ
```

## 使用している技術

- Node.js, TypeScript, Express 5, express-session
- helmet、EJS、zod、jose、argon2
- node:sqlite
- Vitest、Prettier、pnpm workspace　

## 参考にした仕様

- RFC 6749 （OAuth 2.0）
- RFC 7636 （PKCE）
- RFC 6750 （Bearer トークン）
- RFC 9068 （JWT 形式のアクセストークン）
- RFC 8725 （JWT のベストプラクティス）
- RFC 9700 （OAuth 2.0 のセキュリティ BCP）
