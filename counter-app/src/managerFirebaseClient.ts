import {signInAnonymously,signOut,type Auth} from "firebase/auth";
import {counterAuth,counterDb} from "./firebaseConfig";
let pending:Promise<Auth>|undefined;
export const getFirebaseDb=()=>counterDb("manager");
// A dedicated, persistent Firebase Auth installation. Never reuse the counting station session.
export function ensureFirebaseAuth():Promise<Auth>{
 return pending??=(async()=>{
  const auth=counterAuth("manager");await auth.authStateReady();
  // Retire the former password login locally, without deleting its Firebase account.
  if(auth.currentUser&&!auth.currentUser.isAnonymous)await signOut(auth);
  if(!auth.currentUser)await signInAnonymously(auth);
  if(!auth.currentUser?.isAnonymous)throw new Error("管理端末の認証を確認できません。");
  return auth;
 })().finally(()=>{pending=undefined;});
}
export async function getFirebaseUid(){const a=await ensureFirebaseAuth();if(!a.currentUser?.isAnonymous)throw Object.assign(new Error("端末認証が必要です。"),{code:"permission-denied"});return a.currentUser.uid;}
