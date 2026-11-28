"""Validate intervention return models, then use a fresh held-out cohort."""
import json
from evaluate import policy_runs, Planner, OUT

FRESH=(1_021_000,1_047_000,1_083_000)


def main():
    planner=Planner()
    validation={}
    # The baseline may win. We select the margin on validation only.
    for margin in (.1,.2,.35):
        validation[str(margin)]=policy_runs(planner,"guarded-value",validation=True,margin=margin)
    def score(result):
        row=result["summary"]
        return 5*row["restored"]-.25*row["unnecessary"]-.35*row["lost"]
    best=float(max(validation,key=lambda key:score(validation[key])))
    report={"seeds":FRESH,"margin":best,"validation":validation,"results":{}}
    for mode in ("rules","beam","value","guarded-value"):
        report["results"][mode]=policy_runs(planner,mode,seeds=FRESH,margin=best)
        print(mode,report["results"][mode]["summary"],flush=True)
    (OUT/"value-results.json").write_text(json.dumps(report,indent=2)+"\n")


if __name__=="__main__":
    main()
