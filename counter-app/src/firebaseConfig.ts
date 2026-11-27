import {getApps,initializeApp} from "firebase/app";
import {getAuth} from "firebase/auth";
import {getFirestore} from "firebase/firestore";

// Firebase browser configuration (public app identifiers, never server credentials).
// Pin the independent project; a legacy QR configuration must never be substituted.
export const config=Object.freeze({
 apiKey:"AIzaSyDTQShuDem3WlmwaXwt5jkfQ8C9s2foFnc",
 authDomain:"people-counter-system-aed75.firebaseapp.com",
 projectId:"people-counter-system-aed75",
 storageBucket:"people-counter-system-aed75.firebasestorage.app",
 messagingSenderId:"452477870918",
 appId:"1:452477870918:web:12a7d28a39a8960e307b47"
});
export function counterApp(kind:"manager"|"station"){
 const name="pcs-independent-"+kind;
 const existing=getApps().find(a=>a.name===name);
 if(existing&&existing.options.projectId!==config.projectId)throw new Error("接続先が人数カウント専用プロジェクトではありません。");
 return existing??initializeApp(config,name);
}
export const counterAuth=(kind:"manager"|"station")=>getAuth(counterApp(kind));
export const counterDb=(kind:"manager"|"station")=>getFirestore(counterApp(kind));
