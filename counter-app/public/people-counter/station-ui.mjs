// Presentation only. The existing camera, ledger and calibration modules keep their DOM nodes.
const $=id=>document.getElementById(id);
const pages=["capture","setup","adjust","records"];
const workspace=$("stationWorkspace");
function show(page){
 if(!pages.includes(page))page="capture";
 workspace.dataset.page=page;
 for(const element of document.querySelectorAll("[data-screen]"))element.hidden=!element.dataset.screen.split(" ").includes(page);
 for(const button of document.querySelectorAll(".station-nav [data-go]")){
  if(button.dataset.go===page)button.setAttribute("aria-current","page");else button.removeAttribute("aria-current");
 }
 refreshStatus();
}
function refreshStatus(){
 const configured=window.counterLedger?.configured?.()===true;
 const role=window.counterLedger?.role?.();
 const badge=$("stationRoleBadge");badge.textContent=role==="out"?"出口":role==="in"?"入口":"未設定";badge.dataset.role=role||"";
 $("stationOnboard").hidden=workspace.dataset.page!=="capture"||configured;
 const assign=(target,value)=>{if($(target).textContent!==value)$(target).textContent=value;};
 assign("stationApproval",$("counterStationState").textContent||"未設定");
 assign("stationControl",$("counterRemoteControl").textContent||"");
 assign("stationCameraState","カメラ："+$("status").textContent);
 const summary=window.counterLedger?.summary?.();
 assign("stationCountLabel",configured?(role==="out"?"退場者数":"入場者数"):"端末内の試験回数");
 assign("stationCountMode",configured?(summary?.mode==="live"?"本番":summary?.mode==="test"?"試験":"確認中"):"未設定");
 assign("stationCount",configured?(summary?String(role==="out"?summary.exits:summary.entries):"—"):$("total").textContent);
 assign("stationCountNote",configured?"選択中の開催日・運用区分の集計（未同期記録を含む）。":"未接続の試験セッションの回数です。");
 assign("stationEventTotals",summary?"入場 "+summary.entries+"人　退場 "+summary.exits+"人　滞在 "+summary.occupancy+"人":"");
}
for(const button of document.querySelectorAll("[data-go]"))button.addEventListener("click",()=>{show(button.dataset.go);window.scrollTo({top:0,behavior:"auto"});});
const observer=new MutationObserver(refreshStatus);
for(const id of ["counterStationState","counterRemoteControl","ledgerSummary","ledgerState","status","total"])observer.observe($(id),{childList:true,characterData:true,subtree:true});
window.addEventListener("pcs-counter-role-changed",refreshStatus);
window.addEventListener("pcs-counter-control-changed",refreshStatus);
show("capture");
