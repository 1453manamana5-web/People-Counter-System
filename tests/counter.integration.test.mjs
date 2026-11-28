import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import ts from "typescript";
import {initializeTestEnvironment} from "@firebase/rules-unit-testing";
import * as firestore from "firebase/firestore";
import * as ledger from "../counter-app/public/people-counter/ledger.mjs";
import * as commands from "../counter-app/public/people-counter/station-command.mjs";
import {openRecordStore} from "../counter-app/public/people-counter/records.mjs";
import {IDBFactory} from "fake-indexeddb";

// Run the real TypeScript business modules against the local Firestore emulator.
// Only their Firebase initialization is replaced: no production Firebase connection.
function load(path,imports={}){
 const source=readFileSync(new URL("../"+path,import.meta.url),"utf8");
 const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const exports={};
 new Function("exports","require",output)(exports,key=>{
  if(key==="firebase/firestore")return firestore;
  if(Object.hasOwn(imports,key))return imports[key];
  throw Error("Unexpected integration import: "+key);
 });
 return exports;
}
const lifecycle=load("management-app/src/counterLifecycle.ts");
const adapter=(db,uid)=>({getFirebaseDb:()=>db,getFirebaseUid:async()=>uid,ensureFirebaseAuth:async()=>({currentUser:{uid}})});
const managerModules=(db,uid)=>{
 const firebase=adapter(db,uid);
 return {events:load("management-app/src/counterEvents.ts",{"../../counter-app/src/managerFirebaseClient":firebase,"./counterLifecycle":lifecycle}),
 data:load("management-app/src/counterManagementData.ts",{"../../counter-app/src/managerFirebaseClient":firebase,"../../counter-app/public/people-counter/ledger.mjs":ledger})};
};
const stationModule=(db,uid,code)=>load("counter-app/src/counterSync.ts",{"./firebaseClient":adapter(db,uid),"../public/people-counter/station-command.mjs":{...commands,pairingCode:()=>code}});
const dbFor=(env,uid)=>env.authenticatedContext(uid,{firebase:{sign_in_provider:"anonymous"}}).firestore();
function untilRecords(data,day,mode,count){
 return new Promise((resolve,reject)=>{
  let stop=()=>{};
  const timer=setTimeout(()=>{stop();reject(Error("Timed out waiting for manager server snapshot: "+mode));},15000);
  stop=data.subscribeCounterEvent(day,mode,{config(){},stations(){},operations(snapshot){
   if(snapshot.source==="error"){clearTimeout(timer);stop();reject(Error(snapshot.errorCode||snapshot.error));}
   if(snapshot.source==="server"&&snapshot.data.length===count){clearTimeout(timer);stop();resolve(snapshot.data);}
  }});
 });
}

test("real modules: event → two stations → trial → live → offline retry → manager snapshot → closing and verified totals", {timeout:90000}, async()=>{
 const env=await initializeTestEnvironment({projectId:"demo-people-counter",firestore:{rules:readFileSync("firestore.rules","utf8")}});
 const stores=[];
 try{
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx=>{
   for(const uid of ["managerA","managerB"])await firestore.setDoc(firestore.doc(ctx.firestore(),"counterManagers",uid),{name:uid,role:"admin",enabled:true});
  });
  const adminDb=dbFor(env,"managerA"), admin=managerModules(adminDb,"managerA"), second=managerModules(dbFor(env,"managerB"),"managerB");
  const entryDb=dbFor(env,"entrance"),exitDb=dbFor(env,"exit");
  const entry=stationModule(entryDb,"entrance","481206"),exit=stationModule(exitDb,"exit","907314");
  const inDevice=crypto.randomUUID(),outDevice=crypto.randomUUID();
  const day=await admin.events.createCounterSeries({name:"Integration",venue:"Test room",days:[{date:"2027-11-13",start:"09:00",end:"15:00"}]});
  const state=async()=> (await admin.events.listCounterSeries()).days.find(row=>row.id===day);
  assert.equal((await state()).stage,"prepare");
  assert.equal(await entry.enrollCounterStation(day,{name:"入口",device:inDevice,role:"in"},true),"481206");
  assert.equal(await exit.enrollCounterStation(day,{name:"出口",device:outDevice,role:"out"},true),"907314");
  assert.equal((await entry.readCounterStation(day)).status,"pending");
  await assert.rejects(entry.readCounterConfig(day,"live"),{code:"permission-denied"});
  const a=await admin.data.findCounterPair(day,"481206");
  const b=await second.data.findCounterPair(day,"907314");
  assert.equal(a.uid,"entrance");assert.equal(b.uid,"exit");
  await admin.data.saveCounterStation(day,a.uid,{status:"approved",role:"in"}, "481206");
  await entry.heartbeatCounterStation(day,{version:"17",camera:false,ai:false,profile:"unknown",pending:0,alert:"setup",mode:"test",configVersion:0});
  await entry.changeCounterStationRole(day,"out",inDevice);
  assert.equal((await entry.readCounterStation(day)).role,"out");
  await entry.changeCounterStationRole(day,"in",inDevice);
  assert.equal((await entry.readCounterStation(day)).role,"in");
  await second.data.saveCounterStation(day,b.uid,{status:"approved",role:"out"}, "907314");
  assert.equal((await entry.readCounterStation(day)).status,"approved");
  await assert.rejects(entry.changeCounterStationRole(day,"out",inDevice),/別の端末/);
  assert.equal((await exit.readCounterStation(day)).role,"out");
  assert.equal((await entry.readCounterConfig(day,"live")).paused,true);
  assert.equal((await exit.readCounterConfig(day,"test")).paused,true);
  const move=async(command,review={empty:false,synced:false})=>{
   const current=await state();await admin.events.operateCounterDay(day,current.version,command,review);
   return state();
  };
  const trial=await move("trial");
  assert.equal((await entry.readCounterConfig(day,"test")).paused,false);
  assert.equal((await exit.readCounterConfig(day,"live")).paused,true);
  const make=(mode,role,device,at,version,seq)=>({id:"ledger:"+crypto.randomUUID(),kind:"passage",eventId:day,mode,device,station:role,direction:role,person:"visitor",source:"auto",invalid:false,at,rawAt:at,createdAt:at,configVersion:version,sequence:seq,passageId:crypto.randomUUID(),synced:false});
  const trialRow=make("test","in",inDevice,trial.trialOpened,trial.version,1);
  await entry.pushOperations(day,"test",[trialRow]);
  assert.equal((await untilRecords(admin.data,day,"test",1)).length,1);
  assert.equal((await untilRecords(admin.data,day,"live",0)).length,0);
  await move("prepare");
  const live=await move("open");
  assert.equal((await entry.readCounterConfig(day,"test")).paused,true);
  const cfg=await exit.readCounterConfig(day,"live");assert.equal(cfg.paused,false);assert.equal(cfg.version,live.version);
  for(const station of [entry,exit])await station.heartbeatCounterStation(day,{version:"17",camera:true,ai:true,profile:"baseline",pending:0,alert:"none",mode:"live",configVersion:live.version});
  assert.ok(Math.abs(await entry.serverClock(day)-Date.now())<120000);
  const t=live.opened;
  const incoming=[make("live","in",inDevice,t,live.version,1),make("live","in",inDevice,t,live.version,2)];
  const outgoing=[make("live","out",outDevice,t+1,live.version,1),make("live","out",outDevice,t+2,live.version,2)];
  const entryStore=await openRecordStore({indexedDB:new IDBFactory()});stores.push(entryStore);
  const exitStore=await openRecordStore({indexedDB:new IDBFactory()});stores.push(exitStore);
  for(const row of incoming)await entryStore.addLedger(row);
  for(const row of outgoing)await exitStore.addLedger(row);
  await assert.rejects(ledger.uploadPending(entryStore,await entryStore.ledger(),day,"live",async()=>{throw Error("offline");}),/offline/);
  assert.equal((await entryStore.ledger()).filter(row=>!row.synced).length,2);
  await ledger.uploadPending(entryStore,await entryStore.ledger(),day,"live",entry.pushOperations);
  await ledger.uploadPending(exitStore,await exitStore.ledger(),day,"live",exit.pushOperations);
  await entry.pushOperations(day,"live",incoming); // network ack lost, same IDs
  await assert.rejects(entry.pushOperations(day,"live",[{...incoming[0],at:t+500}]),/同じID/);
  assert.equal((await entryStore.ledger()).filter(row=>!row.synced).length,0);
  const page=await exit.pullOperations(day,"live");
  assert.equal(page.rows.length,4);assert.equal((await exit.pullOperations(day,"live",page.cursor)).rows.length,0);
  const rows=await untilRecords(admin.data,day,"live",4);
  const current=ledger.analyze(rows,{eventId:day,mode:"live",opened:t,now:Date.now()});
  assert.deepEqual([current.entries,current.exits,current.occupancy,current.pending],[2,2,0,0]);
  await assert.rejects(exit.changeCounterStationRole(day,"in",outDevice),/別の端末/);
  await move("close");
  assert.equal((await entry.readCounterConfig(day,"live")).paused,false);
  await move("finish",{empty:true,synced:false});
  assert.equal((await exit.readCounterConfig(day,"live")).paused,true);
  assert.equal((await exit.readCounterStation(day)).status,"approved"); // recovery only until verification
  await assert.rejects(stationModule(dbFor(env,"late"),"late","552211").enrollCounterStation(day,{name:"late",device:crypto.randomUUID(),role:"out"},true),{code:"permission-denied"});
  await entry.pushOperations(day,"live",incoming); // retry prior records while awaiting final verification
  const verified=await move("verify",{empty:true,synced:true});
  const final=ledger.analyze(rows,{eventId:day,mode:"live",opened:t,closed:verified.ended,verified:true,now:Date.now()});
  assert.deepEqual([final.entries,final.exits,final.occupancy,final.issues.length],[2,2,0,0]);
  assert.equal(final.integralAverage,1.5);assert.equal(final.sumAverage,1.5);
  assert.equal((await firestore.getDoc(firestore.doc(adminDb,"events",day,"counterConfig","live"))).get("verified"),true);
  for(const [role,station] of [["in",entry],["out",exit]]){assert.equal((await station.readCounterStation(day)).status,"revoked");assert.equal((await firestore.getDoc(firestore.doc(adminDb,"events",day,"counterAssignments",role))).get("uid"),null);}
  await assert.rejects(admin.data.saveCounterStation(day,"exit",{status:"approved"}),/終了した開催日/);
  await assert.rejects(exit.readCounterConfig(day,"live"),{code:"permission-denied"});
 }finally{for(const store of stores)store.close();await env.cleanup();}
});
