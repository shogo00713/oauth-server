# oauth-server

- OAuth 学習用の「認可サーバー」「リソースサーバー」「クライアント」を実装する
- 実践的なメモアプリを題材として、OAuth の一通りの機能を実装する

## 名前

- HTTPS 化で変わるかもしれないが暫定

| 役割 | 名前 | 識別子 | URL |
|---|---|---|---|
| AS | 認可サーバー | `auth` | `http://auth.simplememo.localhost:4000` |
| RS | シンプルメモアプリ | `simplememo` | `http://simplememo.localhost:5000` |
| client | メモボード | `memoboard` | `http://memoboard.localhost:4001` |

- `iss` には、AS の URL を使用する
- `aud` には、RS の識別子を使用する
- `redirect_uri` には、 `http://localhost:4001/callback` を使用する

## データストア

| データ | 置き場所 | M1 | M3 |
|---|---|---|---|
| users, clients | AS の SQLite | ○ | ○ |
| refresh tokens | AS の SQLite | - | ○ （M2から）|
| 認可コード | AS | インメモリ | Valkey |
| AS のセッション | express-session | MemoryStore | TODO |
| client のセッション | express-session | MemoryStore | TODO |
| メモ | RS の SQLite | ○ | ○ |