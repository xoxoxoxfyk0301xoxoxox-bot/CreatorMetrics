# creator-metrics-collector

YouTube、Pinterest、Threadsの公式APIから日次パフォーマンスを取得し、Google Sheetsに保存するTypeScript/Node.js Collectorです。

## 設計

- `MetricsAdapter`: 媒体固有の取得処理。YouTube/Pinterest は同じ出力形式へ正規化します。
- `GoogleSheetsStore`: `DailyMetrics` は `date + platform + accountId`、`ContentMetrics` は `date + platform + contentId` をキーに Upsert します。
- `CollectionLog`: 媒体ごとに日次/コンテンツ取得件数、各書き込み件数、成功/失敗、理由、所要時間、エラーを追記します。
- 障害分離: Adapter は並列に実行され、片方の取得・保存が失敗しても他方は保存されます。
- 日付: 既定は `Asia/Tokyo` の前日です。`COLLECTION_DATE` で再実行・バックフィルできます。

`src/adapters/` に `MetricsAdapter` 実装を追加し、`src/cli.ts` の配列へ登録するだけで X / Threads / note / 楽天ROOMなどを拡張できます。

## 事前準備

Node.js 20 以上が必要です。

1. Google Cloud で YouTube Analytics API、YouTube Data API v3、Google Sheets API を有効化します。
2. OAuth 2.0 クライアント（ローカル実行は Desktop app 推奨）を作成し、対象スプレッドシートにアクセスできるGoogleユーザーで認可します。
3. Pinterest Developer でアプリを作成し、Pinterest API v5 の必要スコープ（少なくとも分析読み取り）を持つアクセストークンを取得します。
4. 空のGoogle Spreadsheetを用意します。シートタブとヘッダーは初回実行時に自動作成されます。

```bash
npm install
cp .env.example .env
```

`.env` にGoogleクライアント情報を入れ、Googleのrefresh tokenを生成します。

```bash
npm run auth:google
```

refresh token は標準出力せず、所有者だけが読める `.google-refresh-token` に一時保存します。その値と残りの設定を `.env` に移し、一時ファイルを削除してください。`.env`、トークン、credentialsファイルは `.gitignore` の対象です。

## 実行

```bash
npm run collect
```

媒体を限定すると、対象外媒体のENVは不要です。

```bash
npm run collect:youtube
npm run collect:pinterest
npm run collect:threads
npm run diagnose:youtube
npm run diagnose:threads
npm run import:csv
npm run import:note
npm run import:rakuten
npm run dashboard
npm run report
npm run daily
```

`diagnose:youtube` はAnalyticsの安全なクエリパラメータ、レスポンスヘッダー/行数、認証チャンネル情報だけを表示し、TokenやOAuth Secretは出力しません。Analyticsが動画行を返さない日も、uploads playlistに存在する動画はゼロ値の日次スナップショットとして保存します。

## Threads

Meta AppにThreads use caseを追加し、収集用の`threads_basic`と`threads_manage_insights`、投稿を使う場合は`threads_content_publish`を有効にします。`.env.example`のThreads App ID、App Secret、Redirect URIを設定後、次を実行します。

```bash
npm run auth:threads
```

OAuth Authorization Code flowで短期Tokenを取得して60日間の長期Tokenへ交換し、`.threads-token.json`へ権限`0600`で保存します。Token値は標準出力されず、このファイルはGit除外されています。期限7日前以降の収集時に未失効Tokenをrefreshし、ファイルを更新します。`THREADS_REDIRECT_URI`にはCloudflare Tunnelなどの公開HTTPS URLを登録し、転送先のbuilt-in serverは`THREADS_CALLBACK_HOST`（既定`127.0.0.1`）と`THREADS_CALLBACK_PORT`（既定`3100`）で別に指定します。AuthorizationとToken Exchangeには同じ公開Redirect URIが使われます。

Threadsは`GET /me/threads`の全ページを取得後、`THREADS_LOOKBACK_DAYS`（既定90日）以内の投稿を対象にlifetime Insightsを毎日スナップショット保存します。`followers_count`は`followers`へ正規化します。

## Threads text posting queue

投稿機能は収集とは別の`src/posting/`に分離し、テキスト投稿だけを扱います。AI生成、画像・動画、reply、like、follow、DMは実装していません。投稿には`threads_content_publish` permissionが必要です。既存Tokenが読み取りscopeだけの場合、初回実投稿前に `npm run auth:threads` で再認可してください。

単体操作は次のコマンドで行います。

```bash
npm run post:threads:add -- --text "投稿候補"
npm run post:threads:list
npm run post:threads:review -- --id POST_ID
npm run post:threads:approve -- --id POST_ID
npm run post:threads:schedule -- --id POST_ID --at "2026-09-01T12:00:00+09:00"
npm run post:threads:dry-run -- --id POST_ID
npm run post:threads:publish -- --id POST_ID
npm run post:threads:due
npm run post:threads:cancel -- --id POST_ID
```

Phase 2ではUTF-8（BOM可）のCSVまたはJSON配列から候補を一括登録できます。CSVヘッダーとJSON fieldは`content,scheduledAt,notes`だけを使用し、CSVの引用符内改行にも対応します。1行の不備で他の行は停止しません。インポート時は承認・予約を行わず、既存Queueまたは同一CSV内の完全一致は新規行を作らず重複スキップとして集計し、類似候補は`REVIEW`、それ以外は`DRAFT`になります。ImportはPostQueueを一度だけ読み、作成行をバッチ追記します。

過去の再Importで作成された重複候補は、まず`npm run post:threads:cleanup-import-duplicates -- --dry-run`で確認できます。対象は`source=import`かつ`DRAFT/REVIEW`の完全一致だけで、最古の行を残します。明示的な`--apply`実行時も後発行を削除せず`CANCELLED`へ変更し、APPROVED/SCHEDULED/PUBLISHEDには触れません。

Threadsの標準投稿時間はAsia/Tokyoで、朝07:40〜08:20、昼11:40〜12:30、夜22:30〜23:30（寝かしつけ後）です。固定時刻ではなく、日付・slot・postIdから再現可能なdeterministic jitterを生成します。既存CSVの08:00・12:00・21:00はそれぞれ朝・昼・夜のslot指定として扱えます。適用前は`npm run post:threads:schedule-imported -- --jitter --dry-run`で確認し、`--dry-run`を外した場合だけAPPROVED行をbatch更新します。従来のjitterなし`npm run post:threads:schedule-imported`も互換性のため維持しています。

```bash
cp data/posts/threads-posts.csv.example data/posts/threads-posts.csv
npm run post:threads:import -- --file data/posts/threads-posts.csv
npm run post:threads:list -- --status DRAFT
npm run post:threads:list -- --status REVIEW
npm run post:threads:approve-all -- --status DRAFT
npm run post:threads:schedule-imported
npm run post:threads:upcoming
npm run post:threads:status
npm run post:threads:due -- --dry-run
```

`approve-all`は安全のため`DRAFT`だけを承認し、`REVIEW`は個別承認が必要です。CSVの`scheduledAt`を使わない場合は、JSTの時刻枠を指定してAPPROVEDを古い順に予約できます。

```bash
npm run post:threads:schedule-batch -- \
  --start "2026-09-01T08:00:00+09:00" \
  --times "08:00,12:00,21:00"
```

予約は未来日時だけ、同時刻なし、投稿間隔60分以上です。既存のSCHEDULEDを上書きする`--force`はありません。`post:threads:due`は予約時刻順に処理し、1件が失敗しても後続を継続します。予定から360分を超えた投稿は突然公開せず`EXPIRED`にし、`PostHistory`へ記録します。`--dry-run`は対象を分類するだけで、Threads APIによる公開や状態変更を行いません。実行結果は`PublisherRunLog`へ`SUCCESS / PARTIAL / FAILED / NO_DUE`として残します。

`PostQueue`は本文を保持する可変台帳、`PostHistory`は本文を重複保存しない不変attemptログです。本文は改行・前後空白・連続水平空白だけを正規化してSHA-256化します。PUBLISHEDまたはAPPROVED/SCHEDULED/PUBLISHINGと完全一致する本文は`SKIPPED_DUPLICATE`、URL・ハッシュタグ除去後の一致またはbigram類似度90%以上は自動削除せず`REVIEW`警告になります。

publishは公式Threads APIの`POST /me/threads?media_type=TEXT`でコンテナを作り、`POST /me/threads_publish`で公開します。`auto_publish_text`は使用しません。postIdごとのPID/nonce lock、status、threadsPostIdにより二重投稿を防止します。retry上限は3回で、認証エラーは分類して記録し、自動無限retryはしません。`post:threads:due`は期限到来済みSCHEDULEDを古い順に1件ずつ処理し、1件失敗しても後続を継続します。Phase 1ではlaunchdへの自動投稿登録は行いません。

`post:threads:dry-run`はToken値を出さず、profile取得でToken有効性を確認します。実投稿permissionの最終確認はpublish時になるため、再認可後も初回live postは必ずユーザー承認を得て手動実行してください。

### Threads publisher LaunchAgent

Threadsのdue publisherは、日次メトリクス用LaunchAgentとは別に5分間隔で登録します。

```bash
npm run post:scheduler:install
npm run post:scheduler:status
npm run post:scheduler:run
npm run post:scheduler:uninstall
```

Labelは`com.creator-metrics-collector.threads-publisher`、`StartInterval`は300秒です。install時に現在のRepositoryとnpmの実パスを検出し、`~/Library/LaunchAgents/`へ権限`0600`のplistを生成します。plistにはToken、Secret、`.env`本文を保存しません。標準出力・標準エラーはGit管理外の`logs/threads-publisher.stdout.log`と`logs/threads-publisher.stderr.log`へ追記されます。

Macがスリープ、電源OFF、ログアウト中は投稿できません。起動・復帰後の次回5分checkでdue処理しますが、360分を超えて遅延した予約は`EXPIRED`になります。ログはlaunchdが自動rotationしないため、月1回程度サイズを確認し、ジョブ停止中に退避・圧縮してください。`post:scheduler:uninstall`はpublisher用plistだけを解除・削除し、既存の`com.creator-metrics-collector.daily`には触れません。

## Threads Content Planning & AI Draft Generation

Phase 3は投稿処理の前段だけを担当します。OpenAI公式SDKのResponses APIとStructured Outputsを使い、Content Planと投稿案を生成します。AIから直接APPROVED、SCHEDULED、PUBLISHEDへ進む経路はなく、生成結果は必ず`DRAFT`または`REVIEW`から始まります。

`config/threads-content-strategy.json`で言語、voice、audience、Content Pillar、避ける話題、文体、公開禁止情報、検証済み事実を編集できます。公開禁止ルールには投稿自動化、API、launchd、Scheduler、Collector、Token、OAuth、Secret、GitHub内部構造、Queue、テスト情報を含めています。数値実績は`verifiedFacts`に明示された根拠がない限り安全検査で拒否します。

```bash
npm run content:threads:plan -- --days 7 --posts-per-day 3 --dry-run
npm run content:threads:plan -- --days 7 --posts-per-day 3
npm run content:threads:plan:list
npm run content:threads:generate -- --count 5 --dry-run
npm run content:threads:generate -- --count 5
npm run content:threads:review
npm run content:threads:status
npm run content:threads:reject -- --plan-id PLAN_ID
npm run content:threads:regenerate -- --plan-id PLAN_ID --dry-run
```

1 runのPlan／Draft上限は21件、SDK retryは2回、同じPlanの再生成は2回までです。dry-runはPostQueueとPlan statusを変更せず、`ContentAIRunLog`へ件数・概算Token・`DRY_RUN`だけを保存します。Prompt全文やAPI Keyは保存しません。

`ContentLedger`はPUBLISHEDだけでなくDRAFT、REVIEW、APPROVED、SCHEDULEDも参照し、coreTheme、claim、readerValue、adviceの4軸で比較します。文字列の完全・近似重複は既存Phase 1判定を維持し、Phase 3ではAIとdeterministic判定の厳しい方を採用します。`DUPLICATE`はQueueへ入れず、`POSSIBLE_DUPLICATE`は`REVIEW`、`UNIQUE`は`DRAFT`です。Threads実績は`HIGH / NORMAL / LOW / INSUFFICIENT_DATA`のテーマ選定contextに限り、好成績投稿の言い換え量産には使いません。

AIコマンドだけが`OPENAI_API_KEY`を要求します。Collector、daily、publisherはKey未設定でも従来どおり動作します。AIへ送るのはStrategy、Plan、Ledger要約、予約投稿要約、Threads実績要約だけで、OAuth／Token／Secret／購入者情報／`.env`本文は送りません。API実装は[OpenAI公式JavaScript quickstart](https://platform.openai.com/docs/quickstart/make-your-first-api-request)に基づきます。

## Threads Posting Dashboard

`npm run posting:dashboard`はPostQueue、ContentPlan、ContentLedger、PostHistoryを読み取り、表示専用の`PostingDashboard`タブだけを再生成します。SSOT側の値は更新せず、Dashboard編集から承認・予約・投稿が実行されることもありません。OpenAI API KeyとThreads Access Tokenは不要です。

上部にはAsia/Tokyoの月曜〜日曜を対象とする今週件数、下書き、要確認、承認済、予約済、投稿済、エラー、次回投稿を表示します。一覧は今週を先頭に投稿日・投稿時刻・status順で並べ、内部ID、contentHash、threadsPostId、errorCode、retryCountは表示しません。Content PillarとCore ThemeはPlan／Ledgerに存在する値だけを結合し、欠損時は推測せず「未設定」、重複情報がない場合は「未判定」とします。

```bash
npm run posting:dashboard
# 再現可能な検証
POSTING_DASHBOARD_DATE=2026-08-31 npm run posting:dashboard
```

Phase 3.1ではdailyへの自動組込み、Apps Script、DashboardからのApprove／Schedule／Publishは行いません。運用確認後にdaily連携を別変更として追加できます。

全媒体実行時に媒体固有ENVが不足している場合、その媒体だけが `failed` として `CollectionLog` に記録され、設定済み媒体の収集は継続します。共通ENV（`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`GOOGLE_REFRESH_TOKEN`、`METRICS_SPREADSHEET_ID`、`TZ`）は起動時に必須です。

特定日の再取得（同一キーを更新）:

```bash
COLLECTION_DATE=2026-08-25 npm run collect
```

YouTube Analytics の日次値は集計確定まで遅延する場合があります。定期実行では前日または数日前を再取得してください。Pinterest access token の更新はPinterest側のOAuth運用に合わせ、Secret ManagerやCIのSecretに保存してください。

## Google Sheets schema

`DailyMetrics`: `date, platform, accountId, metrics, collectedAt`

`ContentMetrics`: `date, platform, contentId, contentType, title, publishedAt, views, estimatedMinutesWatched, likes, comments, shares, averageViewDuration, collectedAt`

`CollectionLog`: `runId, collectedAt, date, platform, status, dailyMetrics, contentMetrics, writtenDaily, writtenContent, durationMs, reason, error`

CSV Importでは`SalesMetrics`、`Transactions`、`CommissionPayments`を必要時に自動作成します。既存3シートの列は保持し、`CollectionLog`の末尾へImport監査列を追加します。

## Human-Readable Analytics Layer

`npm run dashboard` は既存Raw Sheetを読み取り、収集やCSV Importを実行せず、次の3シートだけを再生成します。基準日は通常Asia/Tokyoの前日で、再現可能な検証には `DASHBOARD_DATE=2026-08-29 npm run dashboard` を使えます。

- `Dashboard`: 日本語の媒体別KPI、比較値、対象期間、Data Quality
- `WeeklySummary`: 基準日を含む直近7日間の集計。直前の7日間と比較
- `TopContent`: YouTube / Threadsの直近7日間Top 5。views、engagementRate、publishedAt、contentIdの順で決定

集計期間はAsia/Tokyoの日付で、current=`asOf - 6日`〜`asOf`、previous=`asOf - 13日`〜`asOf - 7日`です。7日分のcoverageが揃わない数値0は、正常取得済みの実績0とは扱いません。

Data Qualityは `OK`、`NO_DATA`、`NOT_SUPPORTED`、`INSUFFICIENT_BASELINE`、`STALE`、`PARTIAL` を保持します。空欄・未取得・非対応を数値0へ変換しません。Dashboardではそれぞれ「データなし」「未対応」「比較データ不足」「更新待ち」「一部データ」と表示します。

媒体全体の判定ではData Qualityを収集成功の意味に流用せず、`collectionStatus`（OK/PARTIAL/FAILED/STALE/NO_DATA）、`activityStatus`（HAS_DATA/ZERO_ACTIVITY/NO_DATA）、`comparisonStatus`（COMPARABLE/INSUFFICIENT_BASELINE）の3軸を`WeeklySummary`へ保存します。投稿数・再生数が正常値0の場合は収集失敗ではなく`ZERO_ACTIVITY`です。直前期間のbaseline不足も対象期間実績とは独立して扱います。YouTubeの日次Analytics行が空でも動画別period行が保存されている場合、週次views/likes/comments/sharesはそのperiod行から安全に集計します。

### Metric semantics

| 媒体 | データ | 意味 | 集計方法 |
|---|---|---|---|
| YouTube | DailyMetrics views/likes/comments/shares | period（日次） | 期間内をSUM |
| YouTube | ContentMetrics | period（日次・動画別） | 期間内をSUM |
| YouTube | channel viewCount/subscriberCount/videoCount | snapshot | 現在値。週次SUMには使わない |
| Threads | DailyMetrics views/likes/replies/reposts/clicks | period（日次） | 期間内をSUM |
| Threads | DailyMetrics followers | snapshot | 現在値。週次SUMには使わない |
| Threads | ContentMetrics | lifetime snapshot | 期間前baselineと期間末snapshotの差分。baselineなしは推測しない |
| note | note_sales_summary | period（月次） | 対象月の値を利用。未Import月はNO_DATA |
| note | note_sales_history | increment（取引イベント） | 販売件数の詳細。未取得を0扱いしない |
| 楽天 | rakuten_period | period（日次） | 売上・報酬・クリック・件数のPrimary Source |
| 楽天 | rakuten_order | snapshot（注文の最新status） | 確定/未確定/破棄の内訳だけに利用 |
| 楽天 | rakuten_commission_payment | period（月次支払） | 実支払確認用。売上へ加算しない |

楽天売上は `rakuten_period` だけから集計します。注文別CSVと二重加算せず、CommissionPaymentsも売上・発生報酬には加算しません。noteには公式CSVに存在しないビューやスキを生成しません。

## Daily Orchestrator

通常運用は次の1コマンドで完了します。

```bash
npm run daily
```

処理順はYouTube収集、Threads収集、Dashboard生成、Report生成です。note／楽天CSVのImport、Pinterest、Xは実行しません。媒体ごとに障害を分離し、片方の収集が失敗しても最新RawデータからDashboardとReportを生成します。結果は日本語で要約し、`DailyRunLog`へrunId単位でUpsertします。`reportStatus`は既存列の末尾へ追加されるため、従来行との列互換を維持します。

DashboardにはYouTube／Threadsの最新データ日、note／楽天の最終CSV取込日を表示します。YouTube／Threadsが基準日より古い場合は`STALE`、noteは当月または前月の売上CSVがなければ`STALE`、楽天は最終成功Importから35日超で`STALE`です。閾値は `src/dashboard/freshness.ts` の `FRESHNESS_THRESHOLDS` に分離しています。

`daily`は標準入力を要求しないため、将来cron、launchd、GitHub Actionsから同じコマンドを呼べます。OAuth認可そのものは事前に完了し、refresh token／Threads長期tokenを非対話実行環境のSecretとして設定してください。

## Human-Readable Report

`npm run report`は収集やImportをせず、既存のDashboard、WeeklySummary、TopContentから`Report`シートだけを再生成します。文章は固定ルールによるdeterministicな日本語で、LLMや外部AI APIは使いません。内容は対象期間、全体状況、YouTube、Threads、収益、直近7日間の変化、データ状態です。戦略提案や推測値は生成しません。

YouTube／Threadsの直前7日間比は次の閾値です。Data Qualityが`OK`以外の場合は、数値があってもこの判定よりData Qualityの説明を優先します。

- `+20%以上`: 好調
- `+5%以上 +20%未満`: やや好調
- `-5%超 +5%未満`: 横ばい
- `-20%超 -5%以下`: やや低下
- `-20%以下`: 低下
- previous=0/current>0: NEW
- 比較値なし: 比較不能

Reportの「取得可能な収益合計」は、同じ月について次の2項目が両方`OK`の場合だけ計算します。

```text
note 手数料控除後売上
+ 楽天 期間別成果CSVの成果報酬
```

楽天の商品売上金額、注文status別報酬、CommissionPaymentsは合計へ加えません。これにより商品購入総額の誤算入と同一報酬の二重計上を防ぎます。どちらかが未取得、STALE、PARTIAL等なら合計は「比較不能」と表示します。

## macOS LaunchAgent

macOSでは次のHelperで、現在のRepositoryパスと実際のnpmパスを検出したユーザー専用LaunchAgentを設定できます。macOS専用で、他のLaunchAgentには触れません。

```bash
npm run scheduler:install
npm run scheduler:status
npm run scheduler:run
npm run scheduler:uninstall
```

Labelは`com.creator-metrics-collector.daily`、実行時刻はMacのローカル時刻で毎日09:30です。Asia/Tokyo運用ではMacのタイムゾーンをAsia/Tokyo（JST）に設定してください。Repository内のplistはplaceholderだけのTemplateです。install時に `~/Library/LaunchAgents/com.creator-metrics-collector.daily.plist` を権限`0600`で生成し、現在の絶対パス、検出済みnpmパス、安全なPATHだけを設定します。LaunchAgentはそのnpmで既存の`npm run daily`を直接呼びます。`.env`本文、Google／ThreadsのToken、Client/App Secretはplistへ書きません。

`StartCalendarInterval`は、Macがスリープ中に09:30を過ぎた場合、次回復帰時に1回実行します。複数回分は1回へまとめられます。電源OFF中の予定は保持されないため、その日は次回09:30まで実行されません。ログインしていない間はユーザーLaunchAgentは動作しません。

標準出力と標準エラーはGit管理外の `logs/launchd.stdout.log`、`logs/launchd.stderr.log` へ追記されます。launchd自身はこれらをrotationしないため、月1回程度サイズを確認し、ジョブ停止中に古いログを退避・圧縮またはtruncateしてください。ログにはSecret、Token、Raw API response、個人IDを出さない実装ですが、共有や公開は避けてください。

`npm run daily`は `/tmp/creator-metrics-collector-daily.lock` を権限`0600`で取得します。launchd実行と手動実行が重なった場合、後から来た処理は収集を開始しません。PIDが存在しないlockは次回起動時に自動回収し、nonce確認により古いプロセスが新しいlockを削除することも防ぎます。

停止・削除は次で行います。生成plistだけを登録解除・削除し、Repository、ログ、`.env`、Tokenは残します。

```bash
npm run scheduler:uninstall
```

## note / 楽天アフィリエイトCSV Import

公式画面からダウンロードしたCSVを、内容を変更せず次のInboxへ置きます。

```text
data/import/note/
data/import/rakuten/
```

`import:csv`は両方、`import:note`と`import:rakuten`は指定Inboxだけを処理します。BOM付きUTF-8、UTF-8、Shift-JIS系を読み取り、楽天CSVのタイトル行・英語フィールド行、注文別CSVのコード定義表をヘッダー検出でスキップします。原CSVは更新・移動・削除しません。

ファイル全体のSHA-256を`CollectionLog`へ保存し、同じファイルの再取込を抑止します。行は次のキーでUpsertします。

- note売上情報: `platform + source + 年月`
- note販売履歴: `platform + source + 取引ID`（空の場合だけPIIを含まないcanonical fieldsのSHA-256）
- 楽天期間別: `date + platform + source`
- 楽天ショップ別: `platform + source + periodMonth + shopName`
- 楽天成果報酬支払額: `platform + source + yearMonth`
- 楽天注文別: `transactionDate, shopName, itemName, grossSales, commission, commissionRate, measurementId`のdeterministic SHA-256。statusは除外するため未確定から確定・破棄へ同一行を更新します。

楽天注文別CSVには公式に確認できた安定注文IDがないため、同一日時・ショップ・商品・金額・報酬・料率・計測IDが完全一致する別注文はhash collisionとなる制約があります。`measurementId`単独を取引IDとは扱いません。実CSVで安定IDが追加確認できた場合にのみキーを移行してください。

楽天の期間別・ショップ別・注文別CSVは、実データヘッダーより前のタイトル行（例: `期間別成果: 2026.08`、`注文別成果: 2026.08`）から`periodMonth=2026-08`を抽出します。`SalesMetrics`と`Transactions`へ保持し、タイトルに年月がない場合は推測せず、そのファイルをSchema errorとして失敗させます。

note販売履歴の`購入者名`、`発行事業者`、`適格事業者登録番号`は解析後に破棄し、Sheets・ログへ保存しません。CSV本文、取引ID、計測IDもdiagnostic outputへ表示しません。未知列があるファイルはSchema driftとしてそのファイルだけ失敗し、他ファイルのImportは継続します。

YouTubeの動画別値はAnalytics Query APIを`dimensions=video`で対象日全体に問い合わせるため、その日に公開された動画に限定されません。Analytics側が対象日にレポート行を返した既存動画が保存対象です。thumbnail impressions/CTRはYouTube Reporting APIのReachレポート項目であり、Query APIのこのレポートには混在させていません。

## 開発・検証

```bash
npm run build
npm test
npm run verify
```

テストは外部APIを呼ばず、障害分離、日付境界、Upsertキーの安定性を検証します。

## 運用上の注意

- SecretをGitへコミットしないでください。CIではSecretストアから環境変数を注入します。
- Collector終了コードは両媒体とも失敗した場合のみ非ゼロです。部分失敗は `CollectionLog` とコンソール結果で監視してください。
- Google Sheetsへの同時多重実行は避けてください。単一ジョブでの日次実行を想定しています。
