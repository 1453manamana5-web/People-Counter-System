export const knowledge = {
  occupancy: ["今何人いる", "今何人おる", "部屋にどれくらい人がいる", "現在の滞在人数", "残ってる人は何人"],
  entries: ["今日何人来た", "何人入りましたか", "入った人数", "来場者の累計は", "今日の来場回数"],
  exits: ["何人出た", "帰った人の数", "退場者数", "何人退出した"],
  dwell: ["平均滞在時間", "どのくらい長居", "みんなどれくらい滞在してる"],
  stations: ["端末の状態を確認", "入口の調子はどう", "出口のカメラを調べて", "受付は動いている", "同期できてる"],
  issues: ["なんか人数おかしくない", "記録に異常はある", "計測漏れがないか確認", "数字が合わない"],
  forecast: ["この後混みそう", "混雑予測を見せて", "これからの人数予想", "何分後に混む"],
  briefing: ["今日の結果まとめといて", "今の状況をまとめて", "開催結果を報告して", "運営の状況"],
  routine: ["入口端末をしばらく見守って","問題が起きたら対応して","出口の通信を監視して"],
  readiness: ["もう開場できる", "準備できたか見て", "開場前のチェック", "始める準備はできた"],
  compare: ["去年より少なくない", "前年度と比べて", "去年との差を知りたい", "開催日ごとに比較"],
  trend: ["さっきより人増えてる", "滞在人数の増減", "前と比べて今は人が増えた"],
  crowd: ["最大同時滞在の時間帯", "混雑ピーク"],
  graph: ["グラフにして", "グラフを表示して", "入退場の推移を見せて", "チャート開いて"],
  records: ["通過記録を開いて", "入退場履歴を見せて", "記録画面へ移動"],
  event: ["開催設定を開いて", "開場時間を変更して", "イベント編集画面", "閉場の設定を見せて"],
} as const;
export type Intent = keyof typeof knowledge;
export type Plan = {intent:Intent;role?:"in"|"out";horizon?:"closing";comparisonMetric?:"entries"|"exits"|"occupancy";previousYear?:boolean;period?:"am"|"pm"|number|{from:number;to:number};focus:boolean;readOnly:boolean;operation?:"open"|"close";schedule?:{field:"start"|"end";time:string}};
export type Interpretation = {plans:Plan[];message?:string;reset?:boolean};

const normalize = (raw:string) => raw.normalize("NFKC").toLowerCase().replace(/[\s？！?!。]/g,"")
  .replace(/おおよそ|だいたい/g,"").replace(/きょう|本日/g,"今日").replace(/いま/g,"今")
  .replace(/何名|何にん|何ニン/g,"何人").replace(/足を運んだ|お越しになった|来はった|来よった/g,"来た")
  .replace(/帰っちゃった|帰らはった|出ていった/g,"帰った").replace(/この先|このあと/g,"この後")
  .replace(/受付の機械|受付の端末/g,"受付端末")
  .replace(/いてはる|居てる|居る/g,"いる").replace(/入ってきた|入って来た|入りました/g,"入った")
  .replace(/来てくれた|来られた|訪れた|訪問した/g,"来た")
  .replace(/出てった|出て行った|退出した|帰っていった/g,"退場した")
  .replace(/ただ今|現時点|現時刻/g,"今").replace(/さっきから|最近の/g,"直近")
  .replace(/([0-9]{1,2})([〜~－–—-])([0-9]{1,2})時/g,"$1時$2$3時")
  .replace(/([0-9]{1,3})分間/g,"$1分")
  .replace(/入場者|来客数/g,"来場者").replace(/デバイス|ipad/g,"端末").replace(/カメラ―/g,"カメラ");
function grams(value:string) {
  const result = new Set<string>();
  for (const n of [1,2,3]) for(let i=0;i+n<=value.length;i++) result.add(value.slice(i,i+n));
  return result;
}
const samples = (Object.entries(knowledge) as [Intent,readonly string[]][]).flatMap(([intent,examples]) =>
  examples.map(text => ({intent,text:normalize(text),features:grams(normalize(text))})));
export function classify(value:string):Intent|undefined {
  const features=grams(value);
  const ranked=new Map<Intent,number>();
  for (const {intent,features:known,text} of samples) {
    let common=0;
    for(const item of features) if(known.has(item)) common+=item.length;
    const score=value.includes(text)?.93:common/(known.size+features.size);
    ranked.set(intent,Math.max(ranked.get(intent)??0,score));
  }
  const [first,second]=[...ranked].sort((a,b)=>b[1]-a[1]);
  return first[1]>=.34&&first[1]-second[1]>=.055?first[0]:undefined;
}
function timeOfDay(value:string) {
  const parts=/^(?:(午前|午後))?(\d{1,2})(?:時|:)(半|[0-5]?\d)?(?:分)?$/.exec(value);
  if(!parts) return null;
  const hour=Number(parts[2]),minute=parts[3]==="半"?30:Number(parts[3]??0);
  if(hour>=24||minute>=60||(parts[1]&&hour>12)) return null;
  return (parts[1]?hour%12+(parts[1]==="午後"?12:0):hour)*60+minute;
}

export function interpret(raw:string,previous?:Plan):Interpretation {
  raw=raw.normalize("NFKC").trim();
  if (raw.length>320) return {plans:[],message:"一度に入力できるのは320文字までです。"};
  if (/取り消|キャンセル|やっぱりいい|なしで$/.test(raw.trim().replace(/[。？！?!]+$/,""))) return {plans:[],reset:true,message:"依頼を取り消しました。"};
  const plain=normalize(raw);
  if(/^(?:こんにちは|こんばんは|おはよう(?:ございます)?|よろしく(?:お願いします)?|ありがとう(?:ございます)?|了解|わかった|おっけー|ok)$/.test(plain))
    return {plans:[],message:/ありがとう|了解|わかった|おっけー|ok/.test(plain)?"承知しました。ほかに確認したいことがあれば伝えてください。":"こんにちは。人数集計、端末の状態確認、混雑予測などをお手伝いできます。"};
  if(/^(?:何ができる(?:の|ん|んですか)?|何できる|使い方(?:を教えて)?|ヘルプ|できること(?:を教えて)?|機能(?:を教えて)?|君は何者|あなたは誰)$/.test(plain))
    return {plans:[],message:"Luxnoraです。現在の滞在人数、入退場回数、混雑予測、時間帯別集計、年度比較、端末診断、開場準備の確認ができます。重要な操作は管理画面で確認が必要です。"};
  if(/(?:天気|株価|時刻表|特急|数学|英作文|レシピ|ニュース)/.test(plain)&&!/人数|滞在|受付端末|通過記録|開場|閉場/.test(plain))
    return {plans:[],message:"この管理アプリではイベント運営・人数計測に関する依頼に対応できます。"};
  if(/^(?:人数(?:は|教えて|を教えて)?|何人|何人ですか)$/.test(plain)&&!previous)
    return {plans:[],message:"現在の滞在人数と累計入場回数のどちらを確認しますか？"};
  if(/^(?:なんか|なんとなく)?今日(?:は|って)?(?:人|来場者|入場者|人数|来場)?(?:が)?少なく(?:ない|ありませんか)$/.test(plain))
    return {plans:[],message:"何と比べますか？ 直前の時間帯と前年の開催日など、基準を指定してください。"};
  const readOnly=/変えない|変更しない|触らない|そのまま|見るだけ|確認だけ|操作しない|開けない|開場しない|閉場しない|停止しない|しないで|せんといて|しないでください|しないよう|してほしくない|して欲しくない|してはいけない|してはだめ|しなくていい|しなくてよい|しちゃだめ|するな|やめて/.test(raw);
  if (/削除|消去|権限変更|管理者にして|無効化/.test(raw))
    return {plans:[],message:"この操作は該当する管理画面から確認してください。"};
  const separated=raw.replace(/(して)、(?=混雑|入口|出口|端末|入場|退場|滞在|来場)/g,"$1；");
  const clauses=separated.split(/(?:[。\n；;?!？！]|それから|そのあと|そして|続けて|、(?=(?:あと|ついでに|次に))|(?:あと|ついでに|次に)(?=入口|出口|端末|今|今日|午後|午前|入場|退場|滞在|混雑))/).map(normalize).filter(Boolean);
  if (clauses.length>4) return {plans:[],message:"一度に4件まで確認できます。"};
  const plans:Plan[]=[];
  for(const clause of clauses) {
    const prior=plans.at(-1)??previous;
    const both=/入口.*出口|出口.*入口|両方|両端末|全端末|すべての端末/.test(clause);
    const role=both?undefined:clause.includes("入口")?"in":clause.includes("出口")?"out":undefined;
    const allDay=/一日(?:全体|分)?|1日(?:全体|分)?|終日|時間指定なし|全時間帯|開催日全体|全体で|今日(?:全体|の合計)|今日の累計/.test(clause);
    const relative=clause.match(/(?:直近|過去|ここ|この|最近)(\d{1,3})(分|時間)/);
    const clock=/((?:午前|午後)?\d{1,2}(?:時|:)(?:半|[0-5]?\d)?(?:分)?)(?:から|〜|~|－|–|—|-)((?:午前|午後)?\d{1,2}(?:時|:)(?:半|[0-5]?\d)?(?:分)?)/.exec(clause);
    const from=clock?timeOfDay(clock[1]):null, to=clock?timeOfDay(clock[2]):null;
    if(clock&&(from===null||to===null||from>=to)) return {plans:[],message:"時刻は同じ開催日で、終了を開始より後に指定してください。"};
    const period:Plan["period"]=from!==null&&to!==null?{from,to}:clause.includes("午前")?"am":clause.includes("午後")?"pm":relative?Math.min(1440,Number(relative[1])*(relative[2]==="時間"?60:1)):undefined;
    const operational=/開場して|閉場して|停止して|再起動|再開して|変えて|変更して|切り替えて|変更しよ|変えといて/.test(clause);
    const timed=/(?:午前|午後)?\d{1,2}(?:時|:)(?:半|[0-5]?\d)?(?:分)?/.exec(clause);
    const time=timed?timeOfDay(timed[0]):null;
    const futureDate=/昨日|来年|明日|先月|来月|先週|\d{1,2}月\d{1,2}日/.test(clause);
    if (futureDate || (/\d{1,2}(?:時(?!間)|:)/.test(clause)&&!clock&&!(/開場|閉場/.test(clause)&&/変更|設定|変え/.test(clause))))
      return {plans:[],message:"対象の開催日をイベント一覧から選んでください。時間帯は午前・午後、または「10時から12時」のように指定できます。"};
    if (/開場してもいい|開場して大丈夫|開けてもええ|開場できる|開場してよい|開場していい|開場しても問題|開場できそう|開場の準備|開場準備|開場前の確認/.test(clause)&&!/変更|変え|設定/.test(clause)) {
      plans.push({intent:"readiness",focus:true,readOnly:true});
      continue;
    }
    if(operational&&!readOnly&&/開場/.test(clause)&&/閉場/.test(clause))
      return {plans:[],message:"開場と閉場のどちらを操作しますか？ 一度に一つずつ指定してください。"};
    if (operational&&!readOnly) {
      if (/開場|閉場/.test(clause)) {
        const field=clause.includes("閉場")?"end":"start";
        const schedule=time!==null&&!clock&&/変更|変え|設定/.test(clause)?{
          field,time:String(Math.floor(time/60)).padStart(2,"0")+":"+String(time%60).padStart(2,"0"),
        } as const:undefined;
        const operation=!schedule&&!timed&&!clock&&/開場して|閉場して/.test(clause)?(field==="end"?"close":"open"):undefined;
        plans.push({intent:"event",focus:true,readOnly:false,operation,schedule});
        continue;
      }
      if (/入口|出口|端末|カメラ/.test(clause)) {
        plans.push({intent:"stations",role,focus:true,readOnly:true});
        continue;
      }
    }
    if (/設定は変えない|設定を変えない|設定はそのまま|操作しない/.test(clause) && !role&&!period) continue;
    let intent:Intent|undefined;
    const question=/何人|人数|どのくらい|どれくらい|どれほど|何回|何名|数|合計/.test(clause);
    if(/受付|開場|運用/.test(clause)&&/準備|始められ|開始でき|始めていい/.test(clause)) intent="readiness";
    else if(/入口|出口|端末|カメラ|受付|同期|通信|認識|計測機器/.test(clause)&&/見守|監視|しばらく.*確認/.test(clause)) intent="routine";
    else if(/入退場|入場.*退場|退場.*入場/.test(clause)&&/人数|回数|何人|合計|集計|それぞれ|状況/.test(clause)&&!/記録|履歴|グラフ|推移/.test(clause)) {
      const common={period:allDay?undefined:period,focus:false,readOnly:true};
      plans.push({intent:"entries",...common},{intent:"exits",...common});continue;
    }
    else if(/端末|入口|出口|カメラ|受付|同期|通信|認識/.test(clause)&&/正常|大丈夫|問題|異常|稼働|動作|動いて|繋が|つなが|接続|状態|診断|調子|同期|未送信|未同期|確認|チェック|見て|調べ|オンライン|オフライン|止ま|反応/.test(clause)&&!/入場|退場|来場|滞在人数|通過記録/.test(clause)) intent="stations";
    else if(/記録|集計|数字|人数|カウント|計測|データ/.test(clause)&&/おかし|合わ|矛盾|不一致|漏れ|誤差|整合性|異常|間違|正しいか|信用/.test(clause)) intent="issues";
    else if(/昨年|去年|前年/.test(clause)&&prior&&["entries","exits","occupancy","compare"].includes(prior.intent)&&
      /^(?:じゃあ|では)?(?:昨年|去年|前年)(?:は|も|と比べて|との比較)?$/.test(clause)) intent="compare";
    else if(/さっき|先ほど|少し前/.test(clause)&&/増|減|多|少|比/.test(clause)&&/人|来場|滞在/.test(clause)&&!/来場|入場|退場|累計/.test(clause)) intent="trend";
    else if(/この後|これから|今後|後で|何分後|先の|予測|予想|閉場まで|今のペース/.test(clause)&&/増|減|混|人数|人|来場|滞在|予測|予想|空く|来そう|入りそう/.test(clause)) intent="forecast";
    else if(/混雑|混ん|多かった|最大同時|ピーク|一番人|最高人数/.test(clause)&&/時間|時刻|ピーク|一番|最大|いつ|最も/.test(clause)) intent="crowd";
    else if(/滞在|長居|滞留|居た時間|いる時間/.test(clause)&&/平均|何分|何時間|時間|どれくらい|どのくらい/.test(clause)&&!/人数|何人/.test(clause)) intent="dwell";
    else if(/昨年|去年|前年|前年度|前年比|年度間|年度比較/.test(clause)&&
      (/比|差|違|増|減|少|多|同じ|比較/.test(clause)||question&&/入場|退場|来場|滞在|帰った/.test(clause))) intent="compare";
    else if(/グラフ|チャート|推移|折れ線|時間帯別/.test(clause)&&!/記録画面/.test(clause)) intent="graph";
    else if(/通過|入退場|入場|退場|計測/.test(clause)&&/履歴|記録一覧|記録を|記録画面|ログ/.test(clause)) intent="records";
    else if(/状況|実績|結果|運営|全体/.test(clause)&&/まとめ|報告|要約|概況|分析|教えて|どう/.test(clause)) intent="briefing";
    else if((question&&/帰った|退場|退出|出た/.test(clause)&&!/入退場/.test(clause))||/^(?:じゃあ|では)?(?:退場|退出)(?:は|の方|だけ|を教えて|も)?$/.test(clause)) intent="exits";
    else if((question&&/来た|来場|入った|入場|累計/.test(clause)&&!/入退場/.test(clause))||/^(?:じゃあ|では)?(?:入場|来場|累計)(?:は|の方|だけ|を教えて|も)?$/.test(clause)) intent="entries";
    else if(/滞在人数|現在人数|同時滞在|残ってる人|残っている人/.test(clause)||question&&/今|館内|室内|会場内|展示室内|いる|残っ/.test(clause)||/^(?:じゃあ|では)?(?:滞在|現在|今いる人)(?:は|の方|だけ|を教えて|も)?$/.test(clause)) intent="occupancy";
    else if(/混雑|混ん/.test(clause)&&/今日|状況|ピーク|一番/.test(clause)) intent="crowd";
    if(!intent&&prior?.intent==="stations"&&(both||role)&&/^(?:じゃあ|それなら|次は|あと|ついでに|あ、)?(?:入口|出口|両方|両端末|全端末)(?:の方|のほう)?(?:は|も|もお願い|も確認|も見て|も調べて|だけ|もどう|はどう|も頼む)?$/.test(clause)) intent="stations";
    if(!intent&&prior&&prior.intent!=="event"&&(period!==undefined||allDay)&&!/端末|カメラ|受付|開場|閉場|設定|変更|操作/.test(clause)) intent=prior.intent;
    if(!intent&&prior&&prior.intent!=="event"&&/^(?:じゃあ|それなら|次は|あと)?(?:それ|その結果|この結果)(?:も|は|を|で)?(?:教えて|見せて|お願い|もう一度|再確認)?$/.test(clause)) intent=prior.intent;
    intent??=classify(clause);
    if (role&&!intent&&/方も|も調べ|も見|はどう/.test(clause)) intent="stations";
    if (!intent&&/見守|監視|異常が起きたら/.test(clause)) intent="routine";
    if (!intent&&period!==undefined&&prior?.intent!=="event") intent=prior?.intent;
    if (!intent&&prior?.intent!=="event"&&/^(?:じゃあ|それなら|次は|あと)?(?:それ|この結果|その結果)(?:は|も|を)?(?:教えて|見せて|お願い)?$/.test(clause)) intent=prior?.intent;
    if (!intent&&/何人/.test(clause)&&/今|おる|居る/.test(clause)) intent="occupancy";
    if (!intent&&/何人/.test(clause)&&/入|来/.test(clause)) intent="entries";
    if (!intent) return {plans:[],message:clauses.length>1?"複数の依頼のうち意味を特定できないものがあります。内容を分けて指定してください。":"依頼の対象を特定できませんでした。滞在人数・入場回数・端末状態・混雑予測など、確認したい対象を教えてください。"};
    if (timed&&intent==="event"&&readOnly) return {plans:[],message:"設定は変更しません。イベント管理で現在の予定を確認できます。"};
    plans.push({intent,role:both?undefined:role??(intent==="stations"&&prior?.intent==="stations"?prior.role:undefined),
      period:allDay?undefined:period??((intent==="occupancy"&&/今|現在/.test(clause))?undefined:(intent===prior?.intent||intent==="graph"||intent==="compare"?prior?.period:undefined)),
      previousYear:intent==="compare"&&/昨年|去年|前年/.test(clause)?true:undefined,
      comparisonMetric:intent==="compare"?
        (/退場|帰った/.test(clause)?"exits":/入場|来場/.test(clause)?"entries":/滞在/.test(clause)?"occupancy":
          prior?.intent==="entries"||prior?.intent==="exits"||prior?.intent==="occupancy"?prior.intent:prior?.comparisonMetric):undefined,
      horizon:intent==="forecast"&&/閉場まで|閉場時/.test(clause)?"closing":undefined,
      focus:/見せ|確認して|開い|調べ|移動|グラフ/.test(clause)||["forecast","compare","graph","records","event"].includes(intent),readOnly});
  }
  if(plans.length>4)return {plans:[],message:"一度に4件まで確認できます。"};
  return {plans,message:plans.length?undefined:"設定を保持しました。"};
}
