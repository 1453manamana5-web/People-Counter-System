import test,{before,after,beforeEach} from "node:test";
import {readFileSync} from "node:fs";
import {initializeTestEnvironment,assertSucceeds,assertFails} from "@firebase/rules-unit-testing";
import {doc,getDoc,getDocs,collection,setDoc,updateDoc,writeBatch,serverTimestamp} from "firebase/firestore";
const event="12345678-1234-4234-8234-123456789012", day=event+"_2027-11-14";
const station="12345678-1234-4234-8234-123456789013";
let env;
before(async()=>{env=await initializeTestEnvironment({projectId:"demo-people-counter",firestore:{rules:readFileSync("firestore.rules","utf8")}})});
after(async()=>{await env?.cleanup()});
beforeEach(async()=>{await env.clearFirestore();await env.withSecurityRulesDisabled(async ctx=>{
 const db=ctx.firestore();
 for(const [id,role,enabled] of [["admin","admin",true],["deputy","subAdmin",true],["revoked","admin",false],["unverified","admin",true],["unverifiedDeputy","subAdmin",true],["badRole","other",true]])await setDoc(doc(db,"counterManagers",id),{name:id,role,enabled});
 await setDoc(doc(db,"counterDays",day),{eventId:event,stage:"prepare",version:0});
 await setDoc(doc(db,"events",day,"counterDevices","station"),{name:"entry",device:station,role:"in",status:"pending",requestedAt:new Date(),pairingIssuedAt:new Date()});
})});
const manager=(id="admin")=>env.authenticatedContext(id,{firebase:{sign_in_provider:"anonymous"}}).firestore();
const legacyPassword=(id="admin")=>env.authenticatedContext(id,{email:"legacy@example.test",email_verified:true,firebase:{sign_in_provider:"password"}}).firestore();
const anon=(id="station")=>env.authenticatedContext(id,{firebase:{sign_in_provider:"anonymous"}}).firestore();
test("only console-approved anonymous manager installations may list events",async()=>{
 for(const db of [manager(),manager("deputy"),manager("unverified"),manager("unverifiedDeputy")])await assertSucceeds(getDocs(collection(db,"counterEvents")));
 for(const db of [manager("revoked"),manager("stranger"),manager("badRole"),anon(),legacyPassword(),env.unauthenticatedContext().firestore()])await assertFails(getDocs(collection(db,"counterEvents")));
});
test("privileges cannot be granted or altered from any browser",async()=>{
 await assertFails(setDoc(doc(manager("stranger"),"counterManagers","stranger"),{name:"stranger",role:"admin",enabled:true}));
 await assertFails(updateDoc(doc(manager("deputy"),"counterManagers","deputy"),{role:"admin"}));
 await assertFails(updateDoc(doc(manager(),"counterManagers","deputy"),{role:"admin"}));
 await assertSucceeds(getDoc(doc(manager("deputy"),"counterManagers","deputy")));
 await assertFails(getDoc(doc(manager("deputy"),"counterManagers","admin")));
});
test("all QR ticket paths remain closed, even for managers",async()=>{
 for(const path of [["events",day,"tickets","t"],["terminals","t"],["terminalInstallations","admin"],["events",day,"receptionRecords","r"]]){
  await assertFails(getDoc(doc(manager(),...path)));await assertFails(setDoc(doc(manager(),...path),{test:true}));
 }
});
test("pending station cannot approve itself or receive approval without pairing",async()=>{
 const db=anon(),ref=doc(db,"events",day,"counterDevices","station");
 await assertSucceeds(getDoc(ref));
 await assertFails(updateDoc(ref,{status:"approved"}));
 const admin=manager(),batch=writeBatch(admin),audit={updatedAt:serverTimestamp(),updatedByUid:"admin"};
 batch.update(doc(admin,"events",day,"counterDevices","station"),{status:"approved",...audit});
 batch.set(doc(admin,"events",day,"counterAssignments","in"),{uid:"station",...audit});
 await assertFails(batch.commit());
});
test("native event and both mode configs can be created together",async()=>{
 const db=manager("deputy"),id="87654321-1234-4234-8234-123456789012",d=id+"_2027-11-15",audit={updatedAt:serverTimestamp(),updatedByUid:"deputy"},batch=writeBatch(db);
 batch.set(doc(db,"counterEvents",id),{name:"test",venue:"room",...audit});
 batch.set(doc(db,"counterDays",d),{eventId:id,date:"2027-11-15",start:"09:00",end:"15:00",stage:"prepare",opened:null,trialOpened:null,closing:null,ended:null,emptyConfirmed:null,finalized:null,version:0,operation:"",...audit});
 for(const mode of ["live","test"])batch.set(doc(db,"events",d,"counterConfig",mode),{opened:null,closed:null,paused:true,verified:false,version:0,...audit});
 await assertSucceeds(batch.commit());
});

test("approved anonymous admin may list managers; deputy and legacy password may not",async()=>{
 await assertSucceeds(getDocs(collection(manager("unverified"),"counterManagers")));
 await assertFails(getDocs(collection(manager("unverifiedDeputy"),"counterManagers")));
 await assertFails(getDoc(doc(legacyPassword(),"counterManagers","admin")));
 await assertFails(setDoc(doc(manager("stranger"),"counterManagers","stranger"),{name:"stranger",role:"admin",enabled:true}));
});

test("an unapproved installation can check its own grant but cannot self-approve or access event data",async()=>{
 const db=anon("newInstallation");await assertSucceeds(getDoc(doc(db,"counterManagers","newInstallation")));
 await assertFails(getDoc(doc(db,"counterManagers","admin")));
 await assertFails(setDoc(doc(db,"counterManagers","newInstallation"),{name:"new",role:"admin",enabled:true}));
 await assertFails(getDocs(collection(db,"counterDays")));
});
test("console approval and revocation take effect on an existing anonymous identity",async()=>{
 const db=anon("newManager"),grant="newManager";await assertFails(getDocs(collection(db,"counterEvents")));
 await env.withSecurityRulesDisabled(async ctx=>setDoc(doc(ctx.firestore(),"counterManagers",grant),{name:"new",role:"admin",enabled:true}));
 await assertSucceeds(getDocs(collection(db,"counterEvents")));
 await env.withSecurityRulesDisabled(async ctx=>updateDoc(doc(ctx.firestore(),"counterManagers",grant),{enabled:false}));
 await assertFails(getDocs(collection(db,"counterEvents")));
});
