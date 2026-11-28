"""Scenario authoring and deterministic split materialization."""
import argparse
from collections import Counter
from itertools import product
import json
from pathlib import Path
import random
import unicodedata

from oracle import CAPS, label

ROOT=Path(__file__).resolve().parent
FORMS=json.loads((ROOT/"scenarios.json").read_text())
ROLES=("入口","出口","両端末","受付")
PERIODS=("午前","午後","開場直後","正午前後","最後の1時間","開催日全体","10時から11時","13時から14時")
TOPICS={"QRペアリング":"station.pair","オフライン運用":"station.offline","カメラ設置":"station.setup",
        "記録の出力":"data.export","試験と本番":"mode","開催日の新規作成":"event.create",
        "閉場後の集計確定":"event.lifecycle","人物認識の仕組み":"station.vision",
        "予定時刻の編集":"event.schedule","会場内の計測記録の修正":"records.edit",
        "バックアップ復元":"data.restore","権限の確認":"access","混雑予測":"analysis.forecast",
        "時間帯グラフ":"analysis.range","通過履歴":"records","端末診断":"station.health",
        "年度比較":"analysis.compare","入退場の集計":"analysis.summary"}
EXTERNAL=("今週の天気","電車のダイヤ","為替レート","別の学校の出席簿","料理の献立","サッカーの結果","宿題の答え","周辺の店の営業時間")
OPERATIONS=("開場","閉場","開催終了","集計確定")


def normalize(text):
    return "".join(unicodedata.normalize("NFKC",text).lower().split())


def scenarios(split,seed):
    rng=random.Random(seed)
    results=[]
    for task,forms in FORMS[split].items():
        for index, form in enumerate(forms):
            family=f"{split}:{task}:{index}"
            choices=[
                ROLES if "{role}" in form else (None,),
                PERIODS if "{period}" in form else (None,),
                TOPICS if "{topic}" in form else (None,),
                OPERATIONS if "{operation}" in form else (None,),
                EXTERNAL if "{external}" in form else (None,),
            ]
            for role,period,topic,operation,external in product(*choices):
                text=form.format(role=role,period=period,topic=topic,operation=operation,external=external)
                # Change only state fields relevant to this decision. This creates
                # contrast pairs even when the utterance is exactly the same.
                axes = {
                    "count":{"records":("ready","missing","conflict"),"mode":("live","test")},
                    "compare":{"past":("verified","missing","mismatch"),"mode":("live","test")},
                    "health":{"telemetry":("fresh","stale","missing"),"focus":("none","entrance","exit")},
                    "forecast":{"records":("ready","missing","conflict"),"telemetry":("fresh","stale"),"mode":("live","test")},
                    "filter":{"records":("ready","missing"),"mode":("live","test")},
                    "compound":{"records":("ready","missing","conflict"),"telemetry":("fresh","stale","missing")},
                    "conditional":{"past":("verified","missing","mismatch"),"comparison":("lower","equal","higher"),"mode":("live","test")},
                    "guide":{"screen":("events","stations","analysis","records")},
                    "approve":{"authorized":(True,False),"stage":("prepare","trial","open","restricted","closing","finished"),"mode":("live","test"),
                               "review":("ready","occupied","unsynced"),"finalized":(True,False)},
                    "reference":{"prior":("count","compare","filter","ambiguous","none"),"focus":("entrance","exit","none")},
                }.get(task,{})
                for vals in product(*axes.values()):
                    context=dict(zip(axes,vals))
                    if task=="approve":
                        if context["finalized"] and context["stage"]!="finished":
                            continue
                        if operation in ("開場","閉場") and context["review"]!="ready":
                            continue
                    if task=="conditional" and context["past"]!="verified" and context["comparison"]!="lower":
                        continue
                    if task=="conditional" and context["mode"]=="test" and context["past"]!="verified":
                        continue
                    if task=="guide" and context["screen"] not in {"events",{
                       "station":"stations","analysis":"analysis","records":"records","data":"records",
                       "event":"events","mode":"events","access":"events"}[TOPICS[topic].split(".")[0]]}:
                        continue
                    query={"task":task,"role":role,"period":period,"topic":TOPICS.get(topic),"operation":operation}
                    results.append({"family":family,"text":text,"context":context,"query":query,
                                    "expected":label(query,context),"origin":"authored-template+synthetic-operating-context"})
    rng.shuffle(results)
    return results


def select(rows,count):
    # Stratify by intent and retain contrast examples with distinct outcomes.
    groups={}
    for row in rows:
        groups.setdefault(row["query"]["task"],[]).append(row)
    result=[]
    while len(result)<count and groups:
        for key in list(groups):
            result.append(groups[key].pop())
            if not groups[key]:
                del groups[key]
            if len(result)==count:
                break
    if len(result)!=count:
        raise ValueError(f"Insufficient distinct scenarios: {len(result)} < {count}")
    return result


def conversations():
    rows=[]
    for history,focus,mode,past,period in product(("count","compare","filter","ambiguous","none"),
            ("entrance","exit","none"),("live","test"),("verified","missing","mismatch"),PERIODS):
        if history=="none" and focus!="none":
            continue
        context={"prior":history,"focus":focus,"mode":mode,"past":past,"records":"ready"}
        query={"task":"reference","period":period,"role":None,"topic":None}
        rows.append({"family":"conversation:revision:"+history,"text":"それ、時間の方は"+period+"にしてもらえる",
          "history":[{"actor":"operator","text":{
            "count":"通過した回数を集計して","compare":"去年との比較をお願いします",
            "filter":"通過した記録だけ一覧にして","ambiguous":"その数字と記録を両方見せて",
            "none":"はじめまして"}[history]},
            {"actor":"assistant","text":({"entrance":"入口","exit":"出口","none":"対象未指定"}[focus])+
             "。表示は"+("試験" if mode=="test" else "本番")+"です。"}],
          "context":context,"query":query,"expected":label(query,context),"origin":"synthetic-dialogue-state"})
    random.Random(25555).shuffle(rows)
    return rows[:200]


def audit(splits):
    seen_text={}
    seen_form={}
    for split, tasks in FORMS.items():
        for task, forms in tasks.items():
            for form in forms:
                signature=normalize(form)
                if signature in seen_form:
                    raise ValueError((form,seen_form[signature],split,task))
                seen_form[signature]=(split,task)
    hashes=set()
    report={}
    for split,rows in splits.items():
        outcomes={}
        for row in rows:
            text=normalize(row["text"])
            scenario=(text,json.dumps(row["context"],sort_keys=True,ensure_ascii=False))
            if scenario in hashes:
                raise ValueError("Duplicate scenario")
            hashes.add(scenario)
            if text in seen_text and seen_text[text]!=split:
                raise ValueError("Text crosses split")
            seen_text[text]=split
            outcomes.setdefault(text,set()).add(json.dumps(row["expected"],sort_keys=True))
            if not set(row["expected"]["capabilities"])<=set(CAPS):
                raise ValueError("Unregistered capability")
            if row["expected"]["decision"]=="confirm" and not row["context"].get("authorized",False):
                raise ValueError("Unapproved confirmation")
        report[split]={"records":len(rows),"unique_utterances":len({normalize(row["text"]) for row in rows}),
            "families":len({row["family"] for row in rows}),
            "unique_utterance_outcomes":sum(map(len,outcomes.values())),
            "context_contrasts":sum(len(items)>1 for items in outcomes.values()),
            "decisions":dict(Counter(row["expected"]["decision"] for row in rows)),
            "tasks":dict(Counter(row["query"]["task"] for row in rows))}
    return report


def near_overlap(splits):
    def features(text):
        text=normalize(text)
        return set(zip(text,text[1:]))
    train=[features(text) for text in sorted({row["text"] for row in splits["train"]})]
    result={}
    for name in ("validation","independent","conversation"):
        texts=sorted({row["text"] for row in splits[name]})
        close=0
        for text in texts:
            grams=features(text)
            high=max(2*len(grams&other)/max(1,len(grams)+len(other)) for other in train)
            close+=high>=.8
        result[name]={"distinct_raw_texts":len(texts),"training_bigram_dice_gte_0.8":close}
    return result


def main():
    p=argparse.ArgumentParser()
    p.add_argument("--out",type=Path,required=True)
    a=p.parse_args()
    splits={name:select(scenarios(name,12520+i),n)
            for i,(name,n) in enumerate((("train",5000),("validation",1000),("independent",1000)))}
    splits["conversation"]=conversations()
    report=audit(splits)
    registry=(ROOT.parents[1]/"management-app/src/luxnora/capabilities.ts").read_text()
    if any(f'id:"{item}"' not in registry for item in CAPS):
        raise ValueError("Missing app capability")
    a.out.mkdir(parents=True,exist_ok=True)
    for name,rows in splits.items():
        (a.out/(name+".jsonl")).write_text("".join(json.dumps(row,ensure_ascii=False,sort_keys=True)+"\n" for row in rows))
    (a.out/"quality.json").write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n")
    (a.out/"near-overlap.json").write_text(json.dumps(near_overlap(splits),indent=2)+"\n")
    print(json.dumps(report,ensure_ascii=False))


if __name__=="__main__":
    main()
