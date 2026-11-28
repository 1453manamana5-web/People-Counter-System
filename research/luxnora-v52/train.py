"""Compare lightweight character models on structured, state-dependent tasks."""
import argparse
from collections import Counter
import json
from pathlib import Path
import resource
from time import perf_counter
import unicodedata

import numpy as np
import torch
from torch import nn

from oracle import CAPS, DECISIONS, GOALS, PERIODS, ROLES

torch.set_num_threads(1)
BINS=512
LENGTH=72
HEADS=(GOALS,DECISIONS,ROLES,PERIODS,("none","live","test"))
WIDTH=sum(map(len,HEADS))+len(CAPS)+2


def normalize(text):
    return unicodedata.normalize("NFKC",text).lower().strip()


def hashed(text):
    text="^"+normalize(text)+"$"
    result=np.zeros(BINS,np.float32)
    for n in (1,2,3):
        for i in range(len(text)-n+1):
            code=0
            for char in text[i:i+n]:
                code=(code*31+ord(char))%BINS
            result[code]=1
    return result/max(1,np.linalg.norm(result))


def encode(rows,vocabulary,attributes):
    context=np.zeros((len(rows),len(attributes)),np.float32)
    att={word:i for i,word in enumerate(attributes)}
    sequence=np.zeros((len(rows),LENGTH),np.int64)
    vectors=np.zeros((len(rows),BINS),np.float32)
    single=np.zeros((len(rows),len(HEADS)),np.int64)
    multi=np.zeros((len(rows),len(CAPS)+2),np.float32)
    for i,row in enumerate(rows):
        text=normalize(row["text"])
        vectors[i]=hashed(text)
        chars=[vocabulary.get(char,1) for char in text[:LENGTH]]
        sequence[i,:len(chars)]=chars
        for key,value in row["context"].items():
            j=att.get(f"{key}={value}")
            if j is not None:
                context[i,j]=1
        expected=row["expected"]
        for j,key in enumerate(("intent","decision","role","period","mode")):
            single[i,j]=HEADS[j].index(expected[key])
        for val in expected["capabilities"]:
            multi[i,CAPS.index(val)]=1
        multi[i,-2:]=expected["negated"],expected["ordered_diagnosis"]
    return tuple(torch.from_numpy(a) for a in (vectors,sequence,context,single,multi))


class Classifier(nn.Module):
    def __init__(self,kind,vocab,attributes):
        super().__init__()
        self.kind=kind
        if kind in ("cnn","fusion"):
            self.embed=nn.Embedding(vocab,24,padding_idx=0)
            self.conv=nn.Conv1d(24,32,3,padding=1)
            features=64+attributes+(BINS if kind=="fusion" else 0)
        else:
            features=BINS+attributes
        self.encoder=nn.Identity() if kind=="linear" else nn.Sequential(nn.Linear(features,96),nn.ReLU())
        self.head=nn.Linear(features if kind=="linear" else 96, WIDTH)

    def forward(self,ngrams,sequence,context):
        if self.kind in ("cnn","fusion"):
            mask=sequence.ne(0)[:,None,:]
            conv=self.conv(self.embed(sequence).transpose(1,2)).relu()
            masked=conv*mask
            features=torch.cat((masked.amax(-1),masked.sum(-1)/mask.sum(-1).clamp_min(1)),1)
            if self.kind=="fusion":
                features=torch.cat((features,ngrams),1)
        else:
            features=ngrams
        return self.head(self.encoder(torch.cat((features,context),1)))


def partition(logits):
    return logits.split([*map(len,HEADS),len(CAPS)+2],1)


def objective(out,single,multi,cap_only):
    *categories,binary=partition(out)
    capabilities=nn.functional.binary_cross_entropy_with_logits(binary,multi,
        pos_weight=torch.tensor([2.0]*len(CAPS)+[1.5,1.5]))
    if cap_only:
        return nn.functional.binary_cross_entropy_with_logits(binary[:,:len(CAPS)],multi[:,:len(CAPS)])
    return sum(nn.functional.cross_entropy(logits,single[:,i]) for i,logits in enumerate(categories))+.9*capabilities


@torch.inference_mode()
def scores(model,dat,threshold,detailed=False):
    *cats,binary=partition(model(*dat[:3]))
    expected=dat[3]
    answers=torch.stack([out.argmax(1) for out in cats],1)
    predicted=binary.sigmoid()>=threshold
    actual=dat[-1].bool()
    yes=actual[:,:len(CAPS)]
    got=predicted[:,:len(CAPS)]
    truth=expected[:,1]
    should_answer=torch.isin(truth, torch.tensor([DECISIONS.index("answer"),DECISIONS.index("partial")]))
    says_answer=torch.isin(answers[:,1], torch.tensor([DECISIONS.index("answer"),DECISIONS.index("partial")]))
    no_scope=truth==DECISIONS.index("out-of-scope")
    matched=(yes==got).all(1)
    multi=actual[:,:len(CAPS)].sum(1)>1
    good=(answers==expected).all(1)&(predicted==actual).all(1)
    shared=(yes&got).sum().item()
    result={"cases":len(truth),
        **{name:int((answers[:,i]==expected[:,i]).sum()) for i,name in enumerate(("intent","decision","role","period","mode"))},
        "negative":int((predicted[:,-2]==actual[:,-2]).sum()),
        "ordered":int((predicted[:,-1]==actual[:,-1]).sum()),
        "full":int(good.sum()),"cap_set":int(matched.sum()),"multi_cases":int(multi.sum()),
        "multi_exact":int((multi&matched).sum()),"precision":shared/max(1,got.sum().item()),
        "recall":shared/max(1,yes.sum().item()),
        "correct_answers":int((should_answer&says_answer&matched).sum()),
        "wrong_answers":int((says_answer&(~should_answer|~matched)).sum()),
        "fully_correct_answers":int((should_answer&good).sum()),
        "incomplete_or_wrong_answers":int((says_answer&~good).sum()),
        "excessive_abstention":int((should_answer&~says_answer).sum()),
        "correct_hold":int((~should_answer&~says_answer).sum()),
        "out_of_scope_as_answer":int((no_scope&says_answer).sum()),
        "unsupported_confirmation":int(((truth!=DECISIONS.index("confirm"))&(answers[:,1]==DECISIONS.index("confirm"))).sum())}
    if detailed:
        return result,answers.numpy(),got.numpy(),good.numpy()
    return result


def fit(kind,train,valid,vocabulary,attributes,steps,policy,seed):
    torch.manual_seed(seed)
    net=Classifier(kind,len(vocabulary)+2,len(attributes))
    opt=torch.optim.AdamW(net.parameters(),lr=.006)
    length=len(train[0])
    rng=np.random.default_rng(seed)
    timing=perf_counter()
    order=torch.argsort((train[-1][:,:len(CAPS)].sum(1)>1).int()+
        (train[3][:,0]==GOALS.index("reference")).int()+(train[3][:,0]==GOALS.index("conditional")).int())
    curve=[]
    for epoch in range(steps):
        candidates=order[:max(32,round(length*.52))] if policy=="curriculum" and epoch<steps//3 else torch.arange(length)
        selection=torch.from_numpy(rng.permutation(candidates.numpy()) if len(candidates)==length else rng.choice(candidates.numpy(),length,replace=True))
        for ix in selection.split(160):
            ng,seq,ctx,single,multi=(x[ix] for x in train)
            loss=objective(net(ng,seq,ctx),single,multi,policy=="cap-only")
            opt.zero_grad()
            loss.backward()
            opt.step()
        curve.append(scores(net.eval(),valid,.5)["full"])
    def risk(threshold):
        m=scores(net,valid,threshold)
        return (m["cap_set"]+m["multi_exact"]-.35*m["wrong_answers"],-threshold)
    threshold=max((.3,.4,.5,.6,.7),key=risk)
    return net.eval(),threshold,curve,perf_counter()-timing


def portable(net,threshold,vocab,attributes,quantize=True):
    weights={}
    for name,array in net.state_dict().items():
        values=array.numpy()
        scale=float(np.max(np.abs(values)))/127 if quantize and values.ndim>1 else 0.
        weights[name]={"shape":list(values.shape),
                       "scale":scale,"values":np.rint(values/scale).astype(np.int8).ravel().tolist() if scale else values.ravel().tolist()}
    return {"kind":net.kind,"bins":BINS,"length":LENGTH,"heads":HEADS,"capabilities":CAPS,"threshold":threshold,
            "vocabulary":vocab,"attributes":attributes,"weights":weights}


def read_rows(directory,split):
    return [json.loads(row) for row in (directory/(split+".jsonl")).read_text().splitlines()]


def main(directory,out,epochs):
    rows={split:read_rows(directory,split) for split in ("train","validation","independent","conversation")}
    train=rows["train"]
    chars=sorted({char for row in train for char in normalize(row["text"])})
    vocab={char:i+2 for i,char in enumerate(chars)}
    attributes=sorted({f"{key}={value}" for row in train for key,value in row["context"].items()})
    data={split:encode(batch,vocab,attributes) for split,batch in rows.items()}
    report={"variants":{},"validation_difficulties":dict(Counter(r["family"].split(":")[1] for r in rows["validation"]))}
    choose={}
    for name,kind,n,policy,boost in (
        ("linear-142","linear",142,"mixed",False),("linear-500","linear",500,"mixed",False),
        ("linear-1000","linear",1000,"mixed",False),("linear-5000","linear",5000,"mixed",False),
        ("mlp-5000","mlp",5000,"mixed",False),("cnn-5000","cnn",5000,"mixed",False),
        ("fusion-5000","fusion",5000,"mixed",False),
        ("mlp-curriculum","mlp",5000,"curriculum",False),("mlp-cap-only","mlp",5000,"cap-only",False),
        ("mlp-priority","mlp",5000,"mixed",True)):
        selection=tuple(a[:n] for a in data["train"])
        if boost:
            # Based on development class balance, replay rare denials, out of
            # scope, and conditional cases once per epoch. No held-out rows.
            intents=selection[3][:,0]
            extra=torch.where(torch.isin(intents,torch.tensor([GOALS.index(k) for k in
                ("negate","outside","conditional")])))[0]
            selection=tuple(torch.cat((x,x[extra]),0) for x in selection)
        model,threshold,curve,seconds=fit(kind,selection,data["validation"],vocab,attributes,epochs,policy,5201)
        val=scores(model,data["validation"],threshold)
        out_row={"kind":kind,"train_cases":n,"epoch_rows":len(selection[0]),"seconds":seconds,
                 "threshold":threshold,"curve":curve,"validation":val}
        report["variants"][name]=out_row
        model_file=out/(name+".pt")
        torch.save({"kind":kind,"weights":model.state_dict(),"threshold":threshold,
                    "vocabulary":vocab,"attributes":attributes},model_file)
        out_row["checkpoint_bytes"]=model_file.stat().st_size
        choose[name]=(model,threshold)
        print(name,val["full"],val["cap_set"],round(seconds,2),flush=True)
    eligible=[key for key in choose if key!="mlp-cap-only"]
    best=max(eligible,key=lambda key:report["variants"][key]["validation"]["full"])
    report["chosen_on_validation"]=best
    issues=[]
    for name,(model,threshold) in choose.items():
        for split in ("independent","conversation"):
            metrics,pred,sets,good=scores(model,data[split],threshold,detailed=True)
            if name==best and split=="independent":
                for row, cat, cap, ok in zip(rows[split],pred,sets,good):
                    if not ok:
                        issues.append({"text":row["text"],"context":row["context"],"expected":row["expected"],
                            "actual":{"intent":GOALS[cat[0]],"decision":DECISIONS[cat[1]],"role":ROLES[cat[2]],
                            "period":PERIODS[cat[3]],"capabilities":[key for key,flag in zip(CAPS,cap) if flag]}})
            report["variants"][name][split]=metrics
            if name==best:
                report.setdefault("selected_by_task",{})[split]={
                    task:{"cases":sum(r["query"]["task"]==task for r in rows[split]),
                          "complete":int(sum(ok for ok,r in zip(good,rows[split]) if r["query"]["task"]==task))}
                    for task in GOALS if any(r["query"]["task"]==task for r in rows[split])}
    model,threshold=choose[best]
    asset=portable(model,threshold,vocab,attributes)
    (out/"browser-float.json").write_text(json.dumps(portable(model,threshold,vocab,attributes,False),
        ensure_ascii=False,separators=(",",":"))+"\n")
    (out/"browser-int8.json").write_text(json.dumps(asset,ensure_ascii=False,separators=(",",":"))+"\n")
    quantized=Classifier(model.kind,len(vocab)+2,len(attributes))
    quantized.load_state_dict({key:torch.tensor(np.asarray(item["values"],np.float32).reshape(item["shape"])*
        (item["scale"] or 1.)) for key,item in asset["weights"].items()})
    holdout=data["independent"]
    qmetrics=scores(quantized.eval(),holdout,threshold)
    def browser_outputs(net):
        with torch.inference_mode():
            *heads,binary=partition(net(*holdout[:3]))
        return zip(torch.stack([head.argmax(1) for head in heads],1).tolist(),
                   (binary.sigmoid()>=threshold).tolist())
    report["quantized"]=qmetrics
    report["peak_rss_kib"]=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    (out/"failures.json").write_text(json.dumps(issues,ensure_ascii=False,indent=2)+"\n")
    (out/"metrics.json").write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n")
    (out/"browser-reference.json").write_text(json.dumps([{"text":row["text"],"context":row["context"],
        "expected":{"int8":{"categories":qcat,"binary":qbin},"float":{"categories":fcat,"binary":fbin}}}
        for row,(qcat,qbin),(fcat,fbin) in zip(rows["independent"],browser_outputs(quantized),browser_outputs(model))],
        ensure_ascii=False)+"\n")


if __name__=="__main__":
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--data",type=Path,required=True)
    p.add_argument("--out",type=Path,required=True)
    p.add_argument("--epochs",type=int,default=16)
    a=p.parse_args()
    a.out.mkdir(parents=True,exist_ok=True)
    main(a.data,a.out,a.epochs)
