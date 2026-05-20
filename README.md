# Amazon広告 チーム管理ダッシュボード

Amazon広告APIのProxyサーバーと管理ダッシュボードのセットです。

## 構成

```
amazon-ads-proxy/
├── server.js          # Express Proxyサーバー
├── package.json
├── .env.example       # 環境変数テンプレート（.envを別途作成）
├── .gitignore
└── public/
    └── index.html     # 管理ダッシュボード（Claude powered AI分析付き）
```

## ローカル起動

```bash
# 1. 依存パッケージのインストール
npm install

# 2. 環境変数の設定
cp .env.example .env
# .env を編集して認証情報を入力

# 3. 起動
npm start
# または開発時（ホットリロードあり）
npm run dev
```

ブラウザで http://localhost:3001 を開く

## Railwayへのデプロイ

### 1. GitHubにpush
```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_ORG/amazon-ads-proxy.git
git push -u origin main
```

### 2. Railway で新規プロジェクト作成
1. https://railway.app にログイン
2. 「New Project」→「Deploy from GitHub repo」
3. リポジトリを選択 → 自動デプロイ開始

### 3. 環境変数を設定
Railway 管理画面 → Variables タブ で以下を追加：

| Key            | 説明                              |
|----------------|-----------------------------------|
| CLIENT_ID      | Amazon広告 Client ID              |
| CLIENT_SECRET  | Amazon広告 Client Secret          |
| REFRESH_TOKEN  | OAuth Refresh Token               |
| PROFILE_ID     | 日本マーケット Profile ID         |
| TEAM_TOKEN     | チームアクセス用トークン（任意）  |

デプロイ後、Railway が自動でURLを発行します：
```
https://amazon-ads-proxy-xxxx.up.railway.app
```

## APIエンドポイント

| Method | Path                    | 説明                         |
|--------|-------------------------|------------------------------|
| GET    | /health                 | サーバー稼働確認             |
| GET    | /api/campaigns          | キャンペーン一覧             |
| GET    | /api/adgroups           | 広告グループ一覧             |
| GET    | /api/keywords           | キーワード一覧               |
| GET    | /api/targets            | ターゲティング一覧           |
| POST   | /api/reports            | パフォーマンスレポート取得   |
| GET    | /api/reports/:reportId  | レポートダウンロード         |

TEAM_TOKEN が設定されている場合、全APIリクエストに以下ヘッダーが必要：
```
x-team-token: your-secret-team-token-here
```

## Amazon広告API 認証情報の取得手順

### 1. アプリ登録（Client ID / Secret）
1. https://advertising.amazon.co.jp にログイン
2. ツール → APIアクセス → 「新しいアプリを追加」
3. リダイレクトURL: `https://localhost`
4. Client ID と Client Secret を控える

### 2. Refresh Tokenの取得
ブラウザでアクセス（CLIENT_ID を置き換え）：
```
https://www.amazon.co.jp/ap/oa?client_id=CLIENT_ID&scope=advertising::campaign_management&response_type=code&redirect_uri=https://localhost
```

リダイレクト後のURLから `code=xxxxx` を取得してcurlを実行：
```bash
curl -X POST https://api.amazon.co.jp/auth/o2/token \
  -d "grant_type=authorization_code" \
  -d "code=取得したcode" \
  -d "client_id=CLIENT_ID" \
  -d "client_secret=CLIENT_SECRET" \
  -d "redirect_uri=https://localhost"
```

レスポンスの `refresh_token` を `.env` の `REFRESH_TOKEN` に設定。

### 3. Profile IDの確認
```bash
# Access Tokenを取得後
curl https://advertising-api-fe.amazon.com/v2/profiles \
  -H "Amazon-Advertising-API-ClientId: CLIENT_ID" \
  -H "Authorization: Bearer ACCESS_TOKEN"
```

`countryCode: "JP"` の `profileId` を `PROFILE_ID` に設定。

## 注意事項

- `.env` は絶対にGitにコミットしない（`.gitignore` で除外済み）
- 認証情報はRailwayの環境変数（Variables）で管理する
- Amazon広告APIのレート制限: 1リクエスト/秒（バースト時は一時停止）
