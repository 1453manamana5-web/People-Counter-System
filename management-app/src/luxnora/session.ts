import type {ComparisonDay, ComparisonWindow} from "../counterComparisonMetrics";
import type {Day} from "../counterLifecycle";

// Browser-memory reuse for recent verified history within one mounted scope.
// No identifiers or Firestore results are persisted.
export function createHistoryMemo() {
  const entries=new Map<string,{until:number;row:ComparisonDay}>();
  const key=(scope:string,day:Day,window:ComparisonWindow|undefined)=>
    JSON.stringify([scope,day.id,day.date,day.version,day.finalized,window]);
  return {
    get(scope:string,day:Day,window:ComparisonWindow|undefined,now:number) {
      const id=key(scope,day,window);
      const found=entries.get(id);
      if(found&&now<found.until) return found.row;
      entries.delete(id);
      return undefined;
    },
    put(scope:string,day:Day,window:ComparisonWindow|undefined,row:ComparisonDay,now:number) {
      if(!scope||row.status!=="verified"||row.issues||row.id!==day.id||row.date!==day.date||day.finalized==null||!Number.isSafeInteger(day.version)) return;
      if(entries.size>=4) entries.delete(entries.keys().next().value!);
      entries.set(key(scope,day,window),{until:now+20_000,row});
    },
    clear(){entries.clear();},
  };
}
