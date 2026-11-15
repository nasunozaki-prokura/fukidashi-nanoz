# ColorfulBoxへの配置（PHP 8.4・MariaDB）

この手順は今後の検証・公開用です。現在のSites版の公開先、DNS、投稿データは自動で変更しません。画面のHTML・CSSは現在のまま使います。

## 構成

```text
/home/ACCOUNT/
├── public_html/                 ← 既存HP（変更しない）
└── apps/fukidashi/
    ├── public/                  ← 新サブドメインのドキュメントルート
    │   ├── .htaccess
    │   ├── api.php
    │   ├── index.html
    │   ├── app.js
    │   ├── styles.css
    │   └── qrcode.min.js
    ├── php/                     ← API・SQL・CLIツール（非公開）
    ├── config/
    │   ├── config.example.php
    │   └── local.php            ← 実際の接続情報（非公開・Git対象外）
    └── backups/                 ← バックアップ（非公開・Git対象外）
```

`ACCOUNT`はcPanelの実際のアカウント名に置き換えます。新サービスのドキュメントルートをHPと共有しません。設定・DB・バックアップは、**本番HPとテストHPを含むすべての公開フォルダの外**に置きます。アプリの`public/`だけを公開してください。

PHP版は専用サブドメインのルート配置を想定しています。`/fukidashi/`のような既存HPの下位URL配置には対応していません。

## 必要な機能・権限

- PHP 8.4以降、`PDO`・`pdo_mysql`・`mbstring`。
- MariaDB 10.6系とInnoDB。アプリ専用DB・専用ユーザー。
- Apache互換の`.htaccess`、URL書き換え、DirectoryIndex。PHPファイルが実行されること。
- 新サブドメインの追加、DNSの対象レコード、SSL発行・更新。
- アプリ用ファイルの転送、非公開フォルダの読み書き、ログの閲覧。
- CLIツールを使う場合はSSH等からPHP CLIを実行できること。SSHがない場合のSQL初期化・バックアップは後述。

DBの初期化時には`CREATE TABLE`が必要です。公開アプリの通常動作に必要なのは、専用DBに対する`SELECT`・`INSERT`・`UPDATE`です。WordPressのDBやユーザーを流用しません。

## 1. 配布ファイルを作る

開発用リポジトリのルートで実行します。Node.jsはこのパッケージ作成用で、ColorfulBox上の実行には不要です。

```sh
npm run package:colorfulbox
```

`artifacts/fukidashi-colorfulbox.tar.gz`が生成されます。アーカイブにはPHPコード、画面、設定の見本、ライセンスを含みます。`local.php`、投稿データ、バックアップ、`node_modules`、Git情報は含みません。

アーカイブを**公開フォルダの外**へ展開し、アプリ全体を`/home/ACCOUNT/apps/fukidashi`に配置します。隠しファイルの`.htaccess`も転送してください。

## 2. 専用DBと設定を準備する

1. cPanelで吹き出しくん専用のDBとユーザーを作り、関連付けます。画面に表示される接頭辞込みの名前を記録します。
2. `config/config.example.php`を`config/local.php`へコピーします。
3. `origin`に使用予定のHTTPSのURL、`database`に専用DBの接続情報を設定します。
4. `public_roots`に既存HP・テストHP等の公開ルートを記載します。通常、`/home/ACCOUNT/public_html`を含めればその配下も対象になります。別の場所に公開ルートがあれば追加します。新アプリの公開ルートは自動追加されます。
5. `backup_dir`の非公開フォルダを作成します。

ファイル所有者とPHP実行ユーザーの関係を確認した上で、`local.php`は0600、バックアップフォルダは0700を基本にします。PHPから読めない場合は、全員に公開する権限へ広げるのではなく、所有者・グループを確認してください。

`origin`には末尾の`/`や`/admin`を付けません。接続先やCookieの判定に使う固定値で、アクセス元のHostヘッダーからは生成しません。本番ではHTTPSとSecure Cookieが必須です。

### cPanelがpublic_html外のドキュメントルートを許可しない場合

アプリの`php/`と`config/`を`public_html`の下へ移動して解決しないでください。次の代替配置は、cPanelの制約を確認した後に選択します。

1. `public/`のファイルのみを`/home/ACCOUNT/public_html/fukidashi-public`へ配置し、専用サブドメインのルートをそこに設定。
2. その公開先の`.htaccess`へ以下を追加（パスは実際の値へ変更）。

   ```apache
   SetEnv FUKIDASHI_APP_ROOT /home/ACCOUNT/apps/fukidashi
   ```

3. 非公開側の`config/local.php`へ`'public_dir' => '/home/ACCOUNT/public_html/fukidashi-public'`を追加。
4. `public_roots`に本番HPの公開ルートが含まれていることを確認。

この場合もサブドメイン側のURLは`/admin`・`/api/...`となります。`SetEnv`の反映、親HPの`.htaccess`との干渉、親HP側のURLから同じファイルへアクセスしたときの挙動を検証してください。Apache側が環境変数をPHPへ渡さない場合は、この代替案をそのまま使えません。

## 3. DBテーブルを作り、接続を確認する

アプリのルートでPHP 8.4のCLIを使用します。ColorfulBoxでのPHP CLIの実パスは別途確認してください。Webドメインのバージョンと、単に`php`で実行されるCLIのバージョンは一致するとは限りません。

```sh
php -v
php php/bin/manage.php setup
php php/bin/manage.php check
```

`setup`はDB自体を作成しません。**テーブルが一つもない専用DB**にのみ`boards`テーブルを作成します。既存テーブルがあれば停止し、変更しません。Webリクエスト中にDBテーブルを自動作成する処理はありません。

SSHが使えない場合は、phpMyAdminで**専用DBを選んで**`php/schema.mysql.sql`をインポートします。SQLファイルを公開フォルダに置く必要はありません。`check`相当の実環境確認は、検証URLでの動作確認と管理画面で行います。ブラウザから初期化するインストーラーは提供しません。

## 4. 検証URLとHTTPSを準備する

- 既存の`test.nasunozaki-proclub.com`はWordPress検証用として維持します。吹き出しくん用に別名を選んでください。
- 検証用・正式用それぞれのサブドメイン、公開フォルダ、DNS、証明書を確認します。
- 先に検証URLを使う場合は、`origin`もそのURLに一致させます。
- 新サービスのドメインにPHP 8.4を明示設定し、既存HP側の設定は変更しません。
- HTTPからHTTPSへの案内は新サービスに対して設定・確認します。本番HPやWordPress検証用ドメインの既存スイッチは今回の変更対象ではありません。

## 5. 動作確認と更新

`https://専用ドメイン/admin`を開き、現在と同じ画面からイベントを作成します。

- イベント作成・公開、HTTPSのQR生成、別端末からの投稿と自動反映。
- 想定人数での同時投稿、移動、編集、いいね。
- 他の人の投稿を編集できないこと、公開終了・期限切れ・再公開でのURL更新。
- PHP再起動後も投稿が残ること、エラー時に接続情報が画面へ出ないこと。
- DBバックアップ取得と、空の検証用DBへの復元。
- 既存HPと問い合わせフォームが引き続き動くこと。

HTML・CSSは従来のものです。PHPが配信するページには非表示のメタ情報だけを付け、ブラウザが`/api/session`から投稿者IDを取得します。CookieはHttpOnly・Secure・SameSite=Laxで、`userId`をリクエストに偽装しても他の投稿を編集できません。

更新はGitHubのコミットを基準に配布ファイルを作り直し、`public/`と`php/`を同じリリースで配置します。`local.php`とバックアップは上書きしません。現在のスキーマは初回作成用で、将来のスキーマ変更時には別の移行SQLを用意します。戻すために前の配布ファイルを保存してください。

## バックアップと復元

```sh
php php/bin/manage.php backup
php php/bin/manage.php restore /非公開フォルダ/boards-日時-識別子.json
```

`backup`は`backup_dir`へ0600のJSONファイルを原子的に保存し、パスだけを表示します。所有者キーや投稿を含むため、GitHub・公開フォルダには置きません。サーバー外にも保管し、保存期間と担当者を決めてください。

`restore`は**空のboardsテーブル**にだけ取り込みます。既存の投稿があれば停止し、上書きしません。復元試験は新しい検証DBで行います。独自形式のバックアップのほか、従来のNode.js版`data/boards.json`、D1の`data`カラムを含む行配列JSONを取り込めます。各ボードの管理キー・公開トークンを保ち、異常時は全体をロールバックします。

SSHがない運用では、phpMyAdminから専用DBだけをSQLエクスポートし、空の検証DBへSQLインポートして復元を試験する方法を検討してください。SQLダンプと本ツールのJSONは別形式です。InstallatronのWordPressバックアップに吹き出しくんが含まれることを前提にしません。

## 現在のSites版から移す場合

- 現在のD1のデータをこのコードが直接読むことはありません。読み取り・エクスポートの方法、投稿受付を区切る時間、データを引き継ぐ範囲を決めてから実施します。
- JSONの入力ファイルは管理者が取得し、非公開ディレクトリに置きます。接続トークンをソースやシェルの引数へ埋め込まないでください。
- データを取り込んでも、**旧ドメインのlocalStorageとCookieは新ドメインに自動移動しません**。管理者キーの安全な引き継ぎを別途準備する必要があります。既存参加者の編集権限も自動では引き継がれません。
- 新しいイベントから始める運用なら、投稿データ移行は不要です。
- 画面・QR・データ・管理者権限を新URLで確認してから、HP・GitHubの案内リンクを切り替えます。現在の入口ページは今回変更していません。

## ローカル検証

PHP 8.4とMariaDB 10.6系のコマンドが必要です。テストは一時ディレクトリにDBを初期化し、ネットワーク接続を無効にしたMariaDBと、4ワーカーのPHPサーバーを起動・終了します。既存DBや本番の接続情報は使いません。

```sh
npm run test:php
```

必要なら`PHP_BIN`と`MARIADB_BIN_DIR`で実行ファイルの場所を指定します。PHP組み込みサーバー用ルーターはテスト専用です。Apache/cPanelの`.htaccess`・SSL・権限の実際の動作は、配置先で別途確認してください。

## 参照資料

- https://help.colorfulbox.jp/article/sub-domain-conf/
- https://help.colorfulbox.jp/article/php-version-change/
- https://help.colorfulbox.jp/article/database-spec-list/
- https://help.colorfulbox.jp/article/free-ssl-use/
- https://mariadb.com/docs/server/reference/sql-statements/data-manipulation/selecting-data/for-update
- https://www.php.net/manual/en/pdo.prepared-statements.php
