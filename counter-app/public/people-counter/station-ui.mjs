// Presentation only. The existing camera, ledger and calibration modules keep their DOM nodes.
const $=id=>document.getElementById(id);
const pages=["capture","setup","adjust","records"];
const workspace=$("stationWorkspace");
let wasPaired=false;
let editingPair=false;
const query=new URLSearchParams(window.location.search);
const incomingDay=query.get('day')||'';
const validIncoming=/^[a-f0-9-]{36}_[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(incomingDay);
const incomingRole=query.get('role');
const incomingName=(query.get('name')||'').slice(0,100);
let linkApplied=false;
const paired=()=>window.counterLedger?.paired?.()===true;
function show(page){
 if(!paired())page="setup";
 if(!pages.includes(page))page="capture";
 workspace.dataset.page=page;
 for(const element of document.querySelectorAll("[data-screen]"))element.hidden=!element.dataset.screen.split(" ").includes(page);
 for(const button of document.querySelectorAll(".station-nav [data-go]")){
  if(button.dataset.go===page)button.setAttribute("aria-current","page");else button.removeAttribute("aria-current");
 }
 refreshStatus();
}
function refreshStatus(){
 const approved=paired();
 document.querySelector(".station-shell").dataset.paired=String(approved);
 for(const id of ["stationNav","stationSetupHeading","stationOfflineCard","ledgerState","stationCameraState","message","counterRemoteControl","syncLedger","clockState"])$(id).hidden=!approved;
 $("pairingIntro").hidden=approved;
 const ended=window.counterLedger?.ended?.()===true;
 $("pairingTitle").textContent=ended?"開催日が終了しました":"受付端末を接続";
 $("pairingHint").textContent=ended?"受付は解除されました。未同期記録は保持します。次の開催日へ接続してください。":"管理アプリで表示した接続QRから開くと開催日IDの入力は不要です。";
 const state=window.counterLedger?.pairingStatus?.();
 const savedDay=window.counterLedger?.day?.();
 if(!linkApplied&&validIncoming&&!approved&&!savedDay){
  $("ledgerEvent").value=incomingDay;
  if(incomingRole==="in"||incomingRole==="out")$("ledgerRole").value=incomingRole;
  $("counterStationName").value=$("ledgerRole").value==="out"?"展示室 出口":"展示室 入口";
  linkApplied=true;
 }
 const wait=!approved&&!ended&&state==="pending"&&!editingPair;
 $("pairFormCard").hidden=wait;
 $("pairWaitCard").hidden=!approved&&!wait;
 $("pairWaitTitle").textContent=approved?"接続状態":"管理アプリで接続を承認";
 $("pairFormTitle").textContent=approved?"開催日・運用設定":"接続先を設定";
 $("pairSubmit").textContent=approved?"設定を保存":"接続コードを発行";
 $("pairNameField").hidden=approved;
 $("pairCodeGuide").hidden=approved;
 $("pairEdit").hidden=approved;
 $("pairRefresh").hidden=approved;
 const linked=!approved&&validIncoming&&$("ledgerEvent").value===incomingDay&&!editingPair;
 $("pairDayField").hidden=linked;
 $("pairLinkSummary").hidden=!linked;
 $("pairLinkSummary").textContent=(incomingName||"選択された開催日")+" · "+incomingDay.slice(-10);
 if(wait)$("pairingHint").textContent="受付端末に表示されたコードを管理アプリで入力し、承認してください。";
 if(approved!==wasPaired){wasPaired=approved;show(approved?"capture":"setup");return;}
 if(!approved&&workspace.dataset.page!=="setup"){show("setup");return;}

 const configured=window.counterLedger?.configured?.()===true;
 const role=window.counterLedger?.role?.();
 const badge=$("stationRoleBadge");badge.textContent=role==="out"?"出口":role==="in"?"入口":"未設定";badge.dataset.role=role||"";

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
$("pairEdit").addEventListener("click",()=>{editingPair=true;refreshStatus();});
$("ledgerSetup").addEventListener("submit",()=>{editingPair=false;});
$("ledgerRole").addEventListener("change",()=>{if(!paired())$("counterStationName").value=$("ledgerRole").value==="out"?"展示室 出口":"展示室 入口";});
$("pairRefresh").addEventListener("click",()=>window.counterLedger?.refreshPairing?.());
window.addEventListener("online",refreshStatus);window.addEventListener("offline",refreshStatus);
show("setup");
