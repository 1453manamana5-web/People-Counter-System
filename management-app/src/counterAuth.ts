import {onAuthStateChanged,signInWithEmailAndPassword,signOut,sendEmailVerification} from "firebase/auth";
import {doc,getDocFromServer} from "firebase/firestore";
import {ensureFirebaseAuth,getFirebaseDb} from "../../counter-app/src/managerFirebaseClient";
export type CounterManager={uid:string;terminalId:string;role:"admin"|"subAdmin";name:string};
export type CounterEvent={id:string;name:string;date:string;start:string};
const denied=(code="manager/login-required",message="人数カウント専用アカウントでログインしてください。")=>Object.assign(new Error(message),{code});
export const authCode=(error:unknown)=>String((error as {code?:string}|null)?.code??"");
export function loginErrorMessage(error:unknown){const code=authCode(error);if(["auth/invalid-credential","auth/invalid-login-credentials","auth/wrong-password","auth/user-not-found","auth/invalid-email"].includes(code))return "メールアドレスまたはパスワードを確認してください。";if(code==="auth/user-disabled")return "アカウントが無効です。管理者に確認してください。";if(code==="auth/operation-not-allowed")return "Firebaseのメール／パスワード認証が有効になっていません。";if(code==="auth/too-many-requests")return "試行回数の制限がかかりました。しばらくして再試行してください。";if(code==="auth/network-request-failed")return "認証サーバーに接続できません。通信環境を確認してください。";return "処理できませんでした。"+(code?"（"+code+"）":"接続を確認してください。");}
export async function verifyManager():Promise<CounterManager>{
 const auth=await ensureFirebaseAuth(),u=auth.currentUser;
 if(!u||u.isAnonymous)throw denied();
 if(!u.emailVerified){await u.reload();if(!u.emailVerified)throw denied("manager/email-unverified","メール確認が完了していません。");await u.getIdToken(true);}
 let grant;try{grant=(await getDocFromServer(doc(getFirebaseDb(),"counterManagers",u.uid))).data();}catch(error){if(authCode(error)==="permission-denied")throw denied("manager/rules-denied","管理者情報を読み取れません。Firebaseの専用ルールが公開済みか確認してください。");throw error;}
 if(auth.currentUser?.uid!==u.uid)throw denied();
 if(!grant)throw denied("manager/grant-missing","管理者の承認情報がありません。AuthenticationのUIDとcounterManagersのドキュメントIDを確認してください。");
 if(grant.enabled!==true||!["admin","subAdmin"].includes(grant.role))throw denied("manager/grant-disabled","管理者の権限が無効、または登録内容が正しくありません。");
 return {uid:u.uid,terminalId:u.uid,role:grant.role,name:typeof grant.name==="string"?grant.name:"管理者"};
}
export async function watchCounterAuth(change:(uid:string|null)=>void){return onAuthStateChanged(await ensureFirebaseAuth(),u=>change(u?.uid??null));}
export async function signInManager(email:string,password:string){const a=await ensureFirebaseAuth();const result=await signInWithEmailAndPassword(a,email.trim(),password);await result.user.getIdToken(true);return result.user.emailVerified;}
export async function requestManagerVerification(){const a=await ensureFirebaseAuth();const u=a.currentUser;if(!u||u.isAnonymous)throw denied();await u.reload();if(u.emailVerified){await u.getIdToken(true);return false;}await sendEmailVerification(u);return true;}
export async function signOutManager(){await signOut(await ensureFirebaseAuth());}
export async function counterEvents():Promise<CounterEvent[]>{return [];}
export function permissionDenied(error:unknown){return /permission-denied|unauthenticated|^manager\//.test(authCode(error));}
export async function bounded<T>(promise:Promise<T>,ms=12000):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("サーバーとの接続を確認してください。")),ms);})]);}finally{clearTimeout(timer);}}
