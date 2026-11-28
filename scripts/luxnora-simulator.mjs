// Generates anonymous aggregate operations. Ground truth is returned separately.
const minute=60_000;
export const scenarios=["normal","offline","sync-delay","camera-stop","lost-out","duplicate-in","aggregate-drift","timeline-drift"];
export function simulate(index, scenario) {
  const scope="virtual/live", id="virtual";
  const opened=Date.UTC(2026,10,28,0);
  const now=opened+60*minute;
  const visitors=10+index%41;
  const exits=Math.floor(visitors*(0.3+0.1*(index%6)));
  const arrivals=Array.from({length:visitors},(_,i)=>opened+minute+i*(1000+(index%5)*700)+Math.floor(i*i*60));
  const departed=arrivals.slice(0,exits).map(at=>at+minute*(8+index%13));
  const truth={entries:arrivals.length,exits:departed.length};
  const operation=(at,direction,seq)=>({id:direction+seq,eventId:id,mode:"live",kind:"passage",
    source:"auto",at,rawAt:at,direction,person:"visitor",invalid:false,device:direction,synced:true,sequence:seq+1});
  const outbound=departed.map((at,seq)=>operation(at,"out",seq)).filter((_,i)=>scenario!=="lost-out"||i!==1);
  const inbound=arrivals.map((at,seq)=>operation(at,"in",seq));
  if(scenario==="duplicate-in") inbound.push({...inbound[1],id:"duplicate",source:"manual"});
  const station=role=>({role,mode:"live",status:"approved",
    alert:scenario==="camera-stop"&&role==="in"?"camera":scenario==="offline"&&role==="out"?"network":"none",
    lastSeen:now-(scenario==="offline"&&role==="out"?600_000:0),
    pending:scenario==="sync-delay"&&role==="out"?3:0,camera:!(scenario==="camera-stop"&&role==="in"),ai:true});
  const current=!["offline","sync-delay"].includes(scenario);
  return {truth, operations:[...inbound,...outbound], scenario,
    evidence:{scope,name:"仮想文化祭",mode:"live",now,current,ledgerFromServer:current,stationsFromServer:true,
      config:{opened,closed:null},day:{id,date:"2026-11-28"},stations:[station("in"),station("out")],prediction:[]}};
}

export function passageScenario(index, kind) {
  const t=100+index%12*15;
  const y=.25+(index%8)*.05;
  const points=(x,cross=y)=>[{x,y:cross,w:.13,score:.9}];
  if(kind==="conflicting-frame") return {expected:0,frames:[[t,points(.29)],[t*2,points(.49)],[t*2,points(.65)]]};
  if(kind==="reverse") return {expected:0,frames:[[t,points(.72)],[t*2,points(.49)],[t*3,points(.27)]]};
  if(kind==="two-lanes") return {expected:2,frames:[.27,.43,.57,.71].map((x,i)=>
    [t*(i+1),[...points(x),...points(x-.035,y+.22)]])};
  if(kind==="occlusion") return {expected:1,frames:[[t,points(.28)],[t*2,points(.46)],[t*3,[]],[t*4,points(.65)],[t*5,points(.73)]]};
  return {expected:1,frames:[.28,.46,.59,.73].map((x,i)=>[t*(i+1),points(x)])};
}
