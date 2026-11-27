import {counterAuth,counterDb} from "./firebaseConfig";
export const getFirebaseDb=()=>counterDb("manager");
export async function ensureFirebaseAuth(){const a=counterAuth("manager");await a.authStateReady();return a;}
export async function getFirebaseUid(){const a=await ensureFirebaseAuth();if(!a.currentUser||a.currentUser.isAnonymous)throw Object.assign(new Error("ログインが必要です。"),{code:"permission-denied"});return a.currentUser.uid;}
