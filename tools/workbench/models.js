export function qvCurve(source, r, x, p, low, high) {
  const z = r*r + x*x;
  if (!z || high <= low) throw Error("Enter nonzero impedance and an increasing voltage range.");
  return Array.from({length: 201}, (_, i) => {
    const v = low + (high-low)*i/200;
    const b = x*v*v;
    const c = v**4 + (2*r*p-source*source)*v*v + z*p*p;
    const d = b*b-z*c;
    return [v, d < 0 ? null : (Math.sqrt(d)-b)/z];
  });
}

export function cablePull(weight, initial, friction, route) {
  let tension = initial;
  return route.map(([kind, value, radius]) => {
    if (kind === "straight") tension += friction*weight*value;
    else tension *= Math.exp(friction*value*Math.PI/180);
    if (!Number.isFinite(tension)) throw Error("Route produces tension outside the numeric range.");
    return [kind, tension, kind === "bend" ? tension/radius : null];
  });
}

export function unitCommit(units, demand) {
  const states = new Map([[0, {cost:0, rows:[]}]]);
  let previous = states;
  const count = 1 << units.length;
  for (const load of demand) {
    const next = new Map();
    for (let mask = 0; mask < count; mask++) {
      const online = units.map((u,i)=>({...u,i})).filter(u=>mask & (1<<u.i));
      const min = online.reduce((a,u)=>a+u.min,0);
      const max = online.reduce((a,u)=>a+u.max,0);
      if (load < min || load > max) continue;
      const output = units.map(()=>0);
      let remaining=load-min;
      let running=0;
      for (const u of online.sort((a,b)=>a.energy-b.energy)) {
        const extra=Math.min(remaining,u.max-u.min);
        remaining-=extra;
        output[u.i]=u.min+extra;
        running+=u.fixed+output[u.i]*u.energy;
      }
      let best;
      for (const [last, path] of previous) {
        const startup=online.reduce((a,u)=>a+((last & (1<<u.i)) ? 0 : u.start),0);
        const cost=path.cost+running+startup;
        if (!best || cost < best.cost) best={cost,rows:[...path.rows,[load,...output.map((mw,i)=>mw===0&&(mask&(1<<i)) ? "On" : mw),running+startup]]};
      }
      next.set(mask,best);
    }
    if (!next.size) throw Error(`No feasible commitment for hour ${previous.values().next().value.rows.length+1}.`);
    previous=next;
  }
  return [...previous.values()].reduce((a,b)=>a.cost<=b.cost?a:b);
}

export function parseConfig(text) {
  const rows=text.trim().split(/\r?\n/).map(line=>line.split(",").map(value=>value.trim()));
  const [total,a,d]=rows[1] ?? [];
  const analog=Number(a?.match(/^(\d+)A$/i)?.[1]);
  const digital=Number(d?.match(/^(\d+)D$/i)?.[1]);
  if (!Number.isInteger(analog)||!Number.isInteger(digital)||Number(total)!==analog+digital||total<1||total>512) throw Error("Unsupported COMTRADE channel configuration.");
  const names=rows.slice(2,2+analog+digital).map((r,i)=>r[1]||`Channel ${i+1}`);
  const scales=rows.slice(2,2+analog).map(r=>[Number(r[5]),Number(r[6]),r[4]]);
  if(scales.some(([a,b])=>!Number.isFinite(a)||!Number.isFinite(b))) throw Error("Invalid COMTRADE scale.");
  const rateCount=Number(rows[3+analog+digital]?.[0]);
  if(!Number.isInteger(rateCount)||rateCount<0||rateCount>100) throw Error("Invalid COMTRADE sampling rates.");
  const rates=rows.slice(4+analog+digital,4+analog+digital+Math.max(1,rateCount)).map(r=>r.map(Number));
  const format=rows[6+analog+digital+Math.max(1,rateCount)]?.[0]?.toUpperCase();
  const timeMultiplier=Number(rows[7+analog+digital+Math.max(1,rateCount)]?.[0] ?? 1);
  if (!["ASCII","BINARY","BINARY32","FLOAT32"].includes(format)||!(timeMultiplier>0)) throw Error("Unsupported COMTRADE DAT format or time multiplier.");
  return {analog,digital,names,scales,rates,format,timeMultiplier};
}

export function waveform(cfg, buffer, channel) {
  const {analog,digital,scales,rates,format,timeMultiplier}=cfg;
  if(!Number.isInteger(channel)||channel<0||channel>=analog+digital) throw Error("Select a channel.");
  let records;
  if(format==="ASCII") {
    const lines=new TextDecoder().decode(buffer).trim().split(/\r?\n/);
    records=lines.map(line=>{
      const row=line.split(",");
      if(row.length<2+analog+digital) throw Error("Truncated ASCII data record.");
      return [Number(row[0]),Number(row[1]),Number(row[2+channel])];
    });
  } else {
    const width=format==="BINARY"?2:4;
    const size=8+analog*width+2*Math.ceil(digital/16);
    if(!buffer.byteLength||buffer.byteLength%size) throw Error("DAT length does not match the CFG record layout.");
    const view=new DataView(buffer);
    records=Array.from({length:buffer.byteLength/size},(_,i)=>{
      const start=i*size;
      const bit=channel-analog;
      const offset=start+8+channel*width;
      const value=bit>=0 ? (view.getUint16(start+8+analog*width+2*Math.floor(bit/16),true)>>(bit%16))&1 :
        format==="FLOAT32" ? view.getFloat32(offset,true) : width===2 ? view.getInt16(offset,true) : view.getInt32(offset,true);
      return [view.getUint32(start,true),view.getUint32(start+4,true),value];
    });
  }
  if(records.length<2 || records.some(row=>row.some(value=>!Number.isFinite(value)))) throw Error("At least two valid samples are required.");
  const useTimestamps=records.at(-1)[1]>records[0][1];
  const sampleTime=sample=>{
    let time=0, start=1;
    for(const [hz,end] of rates) {
      if(!(hz>0)||end<start) break;
      time+=Math.max(0,Math.min(sample,end+1)-start)/hz;
      if(sample<=end+1) return time;
      start=end+1;
    }
    throw Error("The DAT timestamps or CFG sample rates cannot define a time axis.");
  };
  const [gain,offset,unit]=scales[channel] ?? [1,0,"state"];
  const startTime=records[0][1];
  return {unit, points:records.map(([sample,t,raw])=>[useTimestamps?(t-startTime)*timeMultiplier*1e-6:sampleTime(sample),raw*gain+offset])};
}

export function powerFactoryScript(project, studyCase) {
  return `import powerfactory

app = powerfactory.GetApplication()
if app is None:
    raise RuntimeError("Start Python with the matching PowerFactory API.")
if app.ActivateProject(${JSON.stringify(project)}) != 0:
    raise RuntimeError("Could not activate the project.")
${studyCase ? `folder = app.GetProjectFolder("study")
cases = [case for case in folder.GetContents("*.IntCase", 1)
         if case.loc_name == ${JSON.stringify(studyCase)}]
if len(cases) != 1 or cases[0].Activate() != 0:
    raise RuntimeError("Expected exactly one matching study case.")
` : ""}load_flow = app.GetFromStudyCase("ComLdf")
if load_flow is None or load_flow.Execute() != 0:
    raise RuntimeError("Load flow failed.")
for bus in app.GetCalcRelevantObjects("*.ElmTerm"):
    print(bus.loc_name, bus.GetAttribute("m:u"))
`;
}

export function pscadScript(file, name) {
  return `import mhi.pscad

def main():
    pscad = mhi.pscad.launch()
    if pscad is None:
        raise RuntimeError("Could not launch PSCAD.")
    try:
        pscad.load(${JSON.stringify(file)})
        project = pscad.project(${JSON.stringify(name)})
        if project is None:
            raise RuntimeError("Project not found in the loaded workspace.")
        project.run()
    finally:
        pscad.quit()

if __name__ == "__main__":
    main()
`;
}
