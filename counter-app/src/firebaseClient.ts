import {signInAnonymously,type Auth} from "firebase/auth";
import {counterAuth,counterDb} from "./firebaseConfig";
let pending:Promise<Auth>|undefined;
export const getFirebaseDb=()=>counterDb("station");
export function ensureFirebaseAuth(){return pending??=(async()=>{const auth=counterAuth("station");await auth.authStateReady();if(!auth.currentUser)await signInAnonymously(auth);return auth;})().finally(()=>{pending=undefined;});}
export async function getFirebaseUid(){const a=await ensureFirebaseAuth();if(!a.currentUser)throw new Error("未認証");return a.currentUser.uid;}
