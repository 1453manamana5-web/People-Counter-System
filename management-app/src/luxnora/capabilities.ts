import type {Target} from "./assistant";
import type {Plan} from "./language";

type Access = "read" | "existing-confirmation" | "manual";
type Offline = "local" | "loaded-data" | "server" | "prepared-station";
type Surface = "home" | "analysis" | "stations" | "records" | "event" | "settings" | "reception";
export type Capability = {
  id: string; title: string; terms: string; surface: Surface; access: Access; offline: Offline;
  input: string; output: string; requires: string; effect: string; verify: string;
  alternative?: string; related: string[]; source: string; guide: string; target?: Target;
};

// Only declared UI targets are navigable. The descriptions never become commands.
export const capabilities = [
  {id:"event.create",title:"イベントを作成",terms:"イベント 新規作成 開催日 日程 会場 登録 作り方 下書き",
    surface:"event",access:"existing-confirmation",offline:"server",input:"イベント名、会場、1件以上の開催日と予定時刻",
    output:"作成フォーム、保存後の開催日",requires:"承認済みの管理端末と通信",effect:"保存時に開催情報を作成",
    verify:"一覧で開催日を確認",related:["event.schedule","station.pair"],source:"CounterManagerApp / NewCounterEvent",
    guide:"イベント名のメニューから「新規作成」を開き、名前・会場・開催日と予定時刻を入力します。入力を確認してから保存してください。",target:"new-event"},
  {id:"event.schedule",title:"開催情報と予定時刻",terms:"予定時刻 日程 開場予定 閉場予定 イベント名 会場 変更 設定",
    surface:"event",access:"existing-confirmation",offline:"server",input:"開催日、イベント名、会場、開始・終了時刻",output:"保存後の開催予定",
    requires:"予定時刻は準備中の開催日",effect:"保存時に開催情報を変更",verify:"イベント管理の予定時刻を確認",
    related:["event.lifecycle","event.create"],source:"CounterEventPanels / CounterScheduleEditor",
    guide:"「イベント管理」の「イベント情報と予定時刻」で確認できます。予定時刻を編集できるのは準備中です。",target:"event"},
  {id:"event.lifecycle",title:"開場・閉場・確定",terms:"開場 閉場 準備 試験 開始 制限 終了 会場空室 確定",
    surface:"event",access:"existing-confirmation",offline:"server",input:"開催日と現在の開催段階",output:"保存した開催段階と実時刻",
    requires:"承認済み端末とサーバー確認、操作に応じた現地確認",effect:"運用段階を変更。確定時に受付端末の承認解除",
    verify:"イベント管理に表示される実時刻・同期状態を確認",related:["mode","station.pair"],source:"CounterDayPanel / counterLifecycle",
    guide:"「イベント管理」で現在の開催段階から使える操作を確認できます。閉場処理を開始しても、開催日終了までは退場を計測します。",target:"event"},
  {id:"mode",title:"試験と本番",terms:"試験 本番 違い テスト 練習 切替 モード 集計 混ざる",
    surface:"event",access:"read",offline:"loaded-data",input:"開催日と運用区分",output:"区分別の集計",
    requires:"開催日を選択",effect:"画面の表示区分のみ",verify:"試験運用の表示を確認",related:["event.lifecycle","analysis.summary"],
    source:"CounterManagerApp / CounterDayPanel",
    guide:"試験と本番の記録は分かれています。試験で表示・修正した記録は本番集計に入りません。試験中はイベント管理から試験集計を開けます。",target:"event"},
  {id:"station.pair",title:"入口・出口端末のペアリング",terms:"ペアリング QR コード 接続 登録 承認 台 追加 解除 受付端末 端末を登録 端末登録",
    surface:"stations",access:"manual",offline:"server",input:"開催日、受付端末からの申請、役割",output:"登録・承認状態",
    requires:"人数カウント専用開催日と通信",effect:"確認後に受付端末を割り当て",verify:"入口・出口の承認状態を確認",
    related:["station.health","access"],source:"CounterPairPanel / StationList",
    guide:"管理アプリの「受付端末」でペアリング用QRを開き、受付端末で読み取って申請します。承認と入口・出口の割り当てを確認してください。",target:"stations"},
  {id:"station.health",title:"受付端末の診断と復旧",terms:"履歴 通信 診断 復旧 カメラ 停止 未同期 異常 端末 状態",
    surface:"stations",access:"manual",offline:"loaded-data",input:"開催日、入口または出口、端末報告",output:"通信・カメラ・認識・未同期状態",
    requires:"対象端末が承認済み",effect:"診断は閲覧のみ。復旧は既存画面の確認操作",verify:"端末が応答し新しい推論が継続すること",
    related:["station.offline","station.setup"],source:"StationList / CounterRemotePanel",
    guide:"「受付端末」で最終通信と未同期件数を確認できます。古い報告では現在の稼働は分かりません。復旧後は端末からの確認結果を見てください。",target:"stations"},
  {id:"station.offline",title:"通信切断とオフライン運用",terms:"オフライン 通信 Wi-Fi 途切れ 切断 ネット 切れ 未同期 回線 同期 復帰 同期方法 再同期",
    surface:"reception",access:"read",offline:"prepared-station",input:"ペアリング済みの受付端末、事前準備済み資産",output:"端末内の通過記録・未同期件数",
    requires:"有効な開催日と端末内保存が利用可能",effect:"通信復旧後に端末内の未送信記録を同期",
    verify:"端末内の保存と再同期後の未同期件数を確認",related:["station.health","station.pair"],
    source:"counter-offline.js / ledger-ui.mjs",
    guide:"準備済みの受付端末では、通信が途切れても保存が使える間は端末内に記録できます。復旧後は未同期件数を確認してください。新規ペアリングには通信が必要です。"},
  {id:"station.setup",title:"iPadの設置と通過試験",terms:"iPad 位置 設置 高さ 向き A B カメラ 画角 アシスタント 逆方向 置けば",
    surface:"reception",access:"manual",offline:"prepared-station",input:"受付端末の画角、A/Bライン、運用方向",output:"プレビューと試験通過",
    requires:"現地でカメラが使用可能",effect:"受付画面で設置条件を調整",verify:"正逆方向・横並び・荷物を含む試験",
    related:["station.health","station.vision"],source:"people-counter/index.html / adaptive-ui.mjs / CounterDayPanel",
    guide:"受付端末の調整画面で、通路とA・Bの両ラインがプレビューに収まる位置にiPadを置きます。向きを合わせ、正逆方向と横並びを現地で試してください。"},
  {id:"station.vision",title:"人物認識と匿名計測",terms:"人物 認識 個人識別 顔 高さ 身長 検出 計測 原理 追跡 設定",
    surface:"reception",access:"manual",offline:"prepared-station",input:"カメラ映像、検出設定、A/B通過方向",output:"匿名の通過記録",
    requires:"カメラとモデルが準備済み",effect:"受付の計測・保存動作",verify:"試験通過で誤計測を確認",
    related:["station.setup","analysis.summary"],source:"vision.mjs / tracker.mjs / ledger-ui.mjs",
    guide:"受付端末は人物候補のA・Bライン通過を数えます。通過回数には再入場も含まれるため、来場した個人の実人数とは区別してください。"},
  {id:"records",title:"通過記録と絞り込み",terms:"通過 記録 履歴 入場 退場 方向 表 一覧 絞り込み",
    surface:"records",access:"read",offline:"loaded-data",input:"開催日、試験・本番、入退場方向",output:"記録一覧",
    requires:"取得済みの台帳",effect:"画面の表示方向のみ",verify:"一覧の方向表示を確認",
    related:["records.edit","data.export"],source:"CounterManagerApp / Records",
    guide:"「通過記録」で入場・退場を絞り込めます。記録には自動・手動・無効などの状態が表示されます。",target:"records"},
  {id:"records.edit",title:"記録の追加・修正",terms:"修正 訂正 手動追加 通過 時刻 理由 区分 無効",
    surface:"records",access:"manual",offline:"server",input:"記録または通過時刻と修正理由",output:"変更履歴",
    requires:"承認済み端末、通信、修正の根拠",effect:"保存時に追加・修正履歴を記録",verify:"通過記録の表示と履歴の確認",
    related:["records","data.restore"],source:"CounterManagerApp / PassageEditor",
    guide:"「通過記録」で対象を選び、通過日時と理由を確認して修正します。記録が欠けている場合は、現地で確認できた通過だけを手動追加できます。",target:"records"},
  {id:"analysis.summary",title:"人数と来場状況の分析",terms:"人数 来場 滞在 入退場 概況 集計 報告 混雑 ピーク グラフ 運営 改善点",
    surface:"analysis",access:"read",offline:"loaded-data",input:"開催日、運用区分と期間",output:"入退場回数、滞在人数、時系列",
    requires:"整合性を確認できる計測記録",effect:"分析と表示のみ",verify:"期間と台帳への照合",
    related:["analysis.range","analysis.forecast","analysis.compare"],source:"CounterManagerApp / CounterAnalysisTools / ledger.mjs",
    guide:"「来場者分析」で来場の推移、最大滞在、入退場の回数を見られます。同期が確認できない記録は暫定として扱います。",target:"graph"},
  {id:"analysis.range",title:"期間別集計とグラフ",terms:"期間 時間帯 午前 午後 直近 任意期間 グラフ 表示 折れ線",
    surface:"analysis",access:"read",offline:"loaded-data",input:"開催日と範囲の開始・終了",output:"期間内の集計とグラフ",
    requires:"計測期間と範囲が重なること",effect:"画面の期間指定のみ",verify:"グラフに表示された開始と終了を確認",
    related:["analysis.summary","data.export"],source:"CounterAnalysisTools",
    guide:"「来場者分析」の「期間別の集計」で直近または任意の期間を選べます。グラフの時刻を動かすとその時点の滞在人数が表示されます。",target:"graph"},
  {id:"analysis.compare",title:"開催日・年度比較",terms:"年度 去年 前年 昨年 比較 前年度 実績 差 集計",
    surface:"analysis",access:"read",offline:"server",input:"比較する開催日または年度",output:"本番記録を使った比較表",
    requires:"対象の本番記録、差の判定には比較できる確定条件",effect:"閲覧とCSV出力",
    verify:"対象年度、同期・確定状況と実開場時間",related:["analysis.summary","data.export"],source:"CounterComparison / history.ts",
    guide:"「来場者分析」の「開催日・年度の比較」で対象を選びます。期間と確定条件が揃う場合に比較し、計測方式の違いが不明な場合は記録上の差として扱います。",target:"compare"},
  {id:"analysis.forecast",title:"混雑予測",terms:"予測 将来 混む 先 閉場まで ペース 推計",
    surface:"analysis",access:"read",offline:"loaded-data",input:"当日レコードと有効な時間範囲",output:"推計と幅",
    requires:"同期・整合性・十分な通過記録",effect:"表示のみ",verify:"推計と観測の区別および予測時刻",
    related:["analysis.summary","analysis.range"],source:"forecast.ts / CounterManagerApp",
    guide:"営業中の同期済みの通過記録から、今のペースを使った混雑の推計を表示します。記録が少ない場合や閉場予定を超える場合は推計を保留します。",target:"graph"},
  {id:"data.export",title:"データ出力",terms:"保存 出力 書き出し ダウンロード CSV PNG PDF JSON 印刷 バックアップ",
    surface:"analysis",access:"manual",offline:"loaded-data",input:"出力形式、対象期間、取得済みの台帳",output:"ローカルに保存するファイルまたは印刷",
    requires:"取得済みの対象データ",effect:"画面から手動で端末へ保存",verify:"出力内容、運用区分と期間を確認",
    related:["analysis.range","data.restore"],source:"CounterAnalysisTools / CounterComparison / Records",
    guide:"「来場者分析」の期間別集計から期間CSV・グラフPNG・印刷/PDF・開催日のJSONを選べます。「通過記録」にもCSVがあります。",target:"graph"},
  {id:"data.restore",title:"バックアップの復元",terms:"復元 復旧 バックアップ JSON ファイル 差分 取込",
    surface:"records",access:"manual",offline:"server",input:"対象開催日、形式が合うJSONと復元前の状態",output:"復元プレビューと結果",
    requires:"管理者、通信、復元前の差分確認",effect:"確認後に台帳へ取り込み",verify:"対象区分、差分と最終集計を確認",
    related:["records","data.export","access"],source:"CounterRestorePanel / counterRestore",
    guide:"管理者は「通過記録」のJSONバックアップの復元で、対象と差分を確認できます。確定済みの場合は既存画面で集計を確認待ちに戻してから進めます。",target:"records"},
  {id:"access",title:"管理端末の権限",terms:"権限 管理者 副管理者 UID 承認 管理端末 設定",
    surface:"settings",access:"manual",offline:"loaded-data",input:"現在の管理端末",output:"名称と役割の表示",
    requires:"管理端末の認証",effect:"設定画面の表示のみ",verify:"設定に表示される役割を確認",
    related:["station.pair","data.restore"],source:"CounterManagerApp / counterAuth",
    guide:"「設定」で管理端末の名称・権限を確認できます。管理者・副管理者の端末承認はFirebase側で管理します。",target:"settings"},
] satisfies Capability[];

type Entry = Capability;
const byId = new Map<string,Entry>(capabilities.map(x=>[x.id,x]));
export function getCapability(id:string) { return byId.get(id); }

const normalize=(s:string)=>s.normalize("NFKC").toLowerCase();
const grams=(s:string)=>new Set(Array.from({length:Math.max(0,s.length-1)},(_,i)=>s.slice(i,i+2)));
const index=capabilities.map(entry=>{
  const words=normalize(entry.terms+" "+entry.title).split(" ");
  return {entry,words,features:grams(words.join(" "))};
});
export function searchCapabilities(query:string, limit=2) {
  const text=normalize(query).slice(0,320);
  const tokens=grams(text);
  return index.map(({entry,words,features})=>{
    const exact=new Set(words.filter(word=>word.length>=2&&text.includes(word)));
    const overlap=[...tokens].filter(word=>features.has(word)&&!word.includes(" ")).length;
    const score=[...exact].reduce((sum,key)=>sum+key.length*2,0)+overlap;
    return {entry,score};
  }).filter(item=>item.score>=5).sort((a,b)=>b.score-a.score).slice(0,limit);
}

export type ViewState = {page:Exclude<Surface,"reception">; direction?:Plan["role"]; stationRole?:Plan["role"]; chartAt?:number; ready:boolean};
