import {getApps,initializeApp} from "firebase/app";
import {getAuth} from "firebase/auth";
import {getFirestore} from "firebase/firestore";
const config={apiKey:import.meta.env.VITE_COUNTER_FIREBASE_API_KEY,authDomain:import.meta.env.VITE_COUNTER_FIREBASE_AUTH_DOMAIN,projectId:import.meta.env.VITE_COUNTER_FIREBASE_PROJECT_ID,appId:import.meta.env.VITE_COUNTER_FIREBASE_APP_ID};
export function counterApp(kind:"manager"|"station"){
 if(Object.values(config).some(v=>typeof v!=="string"||!v.trim()))throw new Error("人数カウント専用Firebaseが未設定です。");
 const name="pcs-independent-"+kind;
 return getApps().find(a=>a.name===name)??initializeApp(config,name);
}
export const counterAuth=(kind:"manager"|"station")=>getAuth(counterApp(kind));
export const counterDb=(kind:"manager"|"station")=>getFirestore(counterApp(kind));
