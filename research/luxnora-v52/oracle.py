"""Outcome logic for simulated operating conditions, independent of phrasing."""
CAPS=("event.create","event.schedule","event.lifecycle","mode","station.pair","station.health",
      "station.offline","station.setup","station.vision","records","records.edit","analysis.summary",
      "analysis.range","analysis.compare","analysis.forecast","data.export","data.restore","access")
GOALS=("count","compare","health","forecast","filter","compound","conditional","guide","approve","negate","reference","outside")
DECISIONS=("answer","partial","clarify","confirm","blocked","cancel","out-of-scope")
PERIODS=("none","午前","午後","開場直後","正午前後","最後の1時間","開催日全体","10時から11時","13時から14時")
ROLES=("none","entrance","exit","both")


def label(query,state):
    goal=query["task"]
    role={"入口":"entrance","出口":"exit","両端末":"both","受付":state.get("focus","none")}.get(query.get("role"),"none")
    period=query.get("period") or "none"
    decision="answer"
    caps=[]
    edge=False

    if goal=="outside":
        decision="out-of-scope"
    elif goal=="negate":
        decision="cancel"
    elif goal=="guide":
        caps=[query["topic"]]
    elif goal=="approve":
        caps=["event.lifecycle"]
        stage={"開場":("prepare","trial"),"閉場":("open","restricted"),
               "開催終了":("closing",),"集計確定":("finished",)}[query["operation"]]
        review=state.get("review","ready")
        checked=(query["operation"] in ("開場","閉場") or
                 query["operation"]=="開催終了" and review!="occupied" or review=="ready")
        decision="confirm" if (state["authorized"] and state["stage"] in stage and state["mode"]=="live" and
                                not state.get("finalized",False) and checked) else "blocked"
    else:
        if goal=="reference":
            role=state.get("focus","none")
            goal=state["prior"]
            if goal in ("none","ambiguous"):
                decision="clarify"
        if goal in ("count","compound"):
            caps.append("analysis.summary")
            if state.get("records") in ("missing","conflict"):
                decision="partial"
        if goal in ("compare","conditional"):
            caps.append("analysis.compare")
            if state.get("past","verified")!="verified" or state.get("mode")=="test":
                decision="partial"
            elif goal=="conditional" and state.get("comparison")=="lower":
                caps.append("station.health")
                edge=True
        if goal in ("health","compound"):
            caps.append("station.health")
            if state["telemetry"]!="fresh":
                decision="partial"
        if goal=="forecast":
            caps.append("analysis.forecast")
            if state["records"]!="ready" or state["telemetry"]!="fresh" or state["mode"]=="test":
                decision="partial"
        if goal=="filter":
            caps.append("records")
            if state.get("records")=="missing":
                decision="partial"
    return {"intent":query["task"],"decision":decision,"capabilities":caps,"role":role,"period":period,
            "negated":query["task"]=="negate","ordered_diagnosis":edge,
            "mode":state.get("mode","none"),
            "availability":{key:state[key] for key in ("records","past","telemetry") if key in state},
            "confirmation_required":query["task"]=="approve"}
