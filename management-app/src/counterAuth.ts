import {onAuthStateChanged} from "firebase/auth";
import {doc,getDocFromServer} from "firebase/firestore";
import {ensureFirebaseAuth,getFirebaseDb} from "../../counter-app/src/managerFirebaseClient";
export type CounterManager={uid:string;terminalId:string;role:"admin"|"subAdmin";name:string};
export type CounterEvent={id:string;name:string;date:string;start:string};
const denied=(code="manager/login-required",message="管理端末を認証してください。")=>Object.assign(new Error(message),{code});
export const authCode=(error:unknown)=>String((error as {code?:string}|null)?.code??"");
export async function verifyManager():Promise<CounterManager>{
 const auth=await ensureFirebaseAuth(),u=auth.currentUser;
 if(!u?.isAnonymous)throw denied();
 const token=await u.getIdTokenResult();
 if(token.signInProvider!=="anonymous")throw denied();
 let grant;try{grant=(await getDocFromServer(doc(getFirebaseDb(),"counterManagers",u.uid))).data();}catch(error){if(authCode(error)==="permission-denied")throw denied("manager/rules-denied","管理者情報を読み取れません。Firebaseの専用ルールが公開済みか確認してください。");throw error;}
 if(auth.currentUser?.uid!==u.uid)throw denied();
 if(!grant)throw denied("manager/grant-missing","この端末は未承認です。表示された端末UIDをFirebaseで承認してください。");
 if(grant.enabled!==true||!["admin","subAdmin"].includes(grant.role))throw denied("manager/grant-disabled","管理者の権限が無効、または登録内容が正しくありません。");
 return {uid:u.uid,terminalId:u.uid,role:grant.role,name:typeof grant.name==="string"?grant.name:"管理者"};
}
export async function watchCounterAuth(change:(uid:string|null)=>void){return onAuthStateChanged(await ensureFirebaseAuth(),u=>change(u?.uid??null));}
export async function counterEvents():Promise<CounterEvent[]>{return [];}
export function permissionDenied(error:unknown){return /permission-denied|unauthenticated|^manager\//.test(authCode(error));}
export async function bounded<T>(promise:Promise<T>,ms=12000):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("サーバーとの接続を確認してください。")),ms);})]);}finally{clearTimeout(timer);}}
