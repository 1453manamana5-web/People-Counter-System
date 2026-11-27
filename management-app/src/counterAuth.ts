import {onAuthStateChanged,signInWithEmailAndPassword,signOut,sendEmailVerification} from "firebase/auth";
import {doc,getDocFromServer} from "firebase/firestore";
import {ensureFirebaseAuth,getFirebaseDb} from "../../counter-app/src/managerFirebaseClient";
export type CounterManager={uid:string;terminalId:string;role:"admin"|"subAdmin";name:string};
export type CounterEvent={id:string;name:string;date:string;start:string};
const denied=()=>Object.assign(new Error("人数カウント専用アカウントの承認が必要です。"),{code:"permission-denied"});
export async function verifyManager():Promise<CounterManager>{
 const auth=await ensureFirebaseAuth(),u=auth.currentUser;
 if(!u||u.isAnonymous||!u.emailVerified)throw denied();
 const grant=(await getDocFromServer(doc(getFirebaseDb(),"counterManagers",u.uid))).data();
 if(auth.currentUser?.uid!==u.uid||!grant||grant.enabled!==true||!["admin","subAdmin"].includes(grant.role))throw denied();
 return {uid:u.uid,terminalId:u.uid,role:grant.role,name:typeof grant.name==="string"?grant.name:"管理者"};
}
export async function watchCounterAuth(change:(uid:string|null)=>void){return onAuthStateChanged(await ensureFirebaseAuth(),u=>change(u?.uid??null));}
export async function signInManager(email:string,password:string){const a=await ensureFirebaseAuth();const result=await signInWithEmailAndPassword(a,email,password);await result.user.getIdToken(true);return result.user.emailVerified;}
export async function requestManagerVerification(){const a=await ensureFirebaseAuth();const u=a.currentUser;if(!u||u.isAnonymous)throw denied();await u.reload();if(u.emailVerified){await u.getIdToken(true);return false;}await sendEmailVerification(u);return true;}
export async function signOutManager(){await signOut(await ensureFirebaseAuth());}
export async function counterEvents():Promise<CounterEvent[]>{return [];}
export function permissionDenied(error:unknown){return /permission-denied|unauthenticated/.test((error as {code?:string}|null)?.code??"");}
export async function bounded<T>(promise:Promise<T>,ms=12000):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("サーバーとの接続を確認してください。")),ms);})]);}finally{clearTimeout(timer);}}
