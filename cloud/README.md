# クラウド版

公開先: https://fukidashi-nanoz.nakauchi-s.chatgpt.site

SitesでホストするCloudflare Worker版です。`../public/`の画面をそのまま使用し、Node.js版のファイル保存をD1に置き換えています。GitHub Pagesの`../docs/`は公開アプリへ案内する入口です。

## 検証・ビルド

リポジトリのルートから、Node.js 24以上で実行します（テストに組み込みSQLiteを使用）。

```sh
node --test cloud/worker.test.mjs
node cloud/build.mjs
```

`cloud/dist/server/index.js`にHTML・CSS・JavaScript・QRライブラリを埋め込んだWorkerを生成します。Sitesの独立したソースチェックアウトへ同期する際は、`cloud/`の内容に加えて`public/`をそのチェックアウト直下へコピーしてください。

## 保存と公開

- `.openai/hosting.json`の`project_id`は現在の公開先を指します。同じSiteの更新では保持してください。
- D1バインディングは`DB`。`drizzle/`のSQLはSitesで公開時に適用します。リクエスト処理中にテーブルは作成しません。
- ボードごとのバージョンを比較して更新するため、複数端末からの同時投稿でも他の投稿を上書きしません。
- 管理者キーは作成したブラウザのlocalStorageに保持されます。参加者は公開用トークンとHttpOnlyの端末Cookieで参加します。閲覧用データに端末Cookieの値は含めません。
- GitHubへpushするとGitHub Pagesの入口が更新されます。アプリ本体はSitesで、同じプロジェクトへのソース同期・バージョン保存・デプロイが別途必要です。
- ローカルの`data/boards.json`はアップロード・移行していません。
