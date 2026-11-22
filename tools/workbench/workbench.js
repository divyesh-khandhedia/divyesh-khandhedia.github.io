import {qvCurve,cablePull,unitCommit,parseConfig,waveform,powerFactoryScript,pscadScript} from "./models.js";
const fmt=new Intl.NumberFormat("en",{maximumSignificantDigits:7});
function node(tag,text) {
  const item=document.createElement(tag);
  if(text!==undefined) item.textContent=text;
  return item;
}
function table(headers,rows) {
  const wrap=node("div"); wrap.className="table-scroll"; wrap.tabIndex=0;
  const grid=node("table");
  const row=grid.createTHead().insertRow();
  for(const header of headers) {const th=node("th",header); th.scope="col"; row.append(th);}
  const body=grid.createTBody();
  for(const values of rows) {
    const row=body.insertRow();
    for(const value of values) row.insertCell().textContent=value===null?"—":typeof value==="number"?fmt.format(value):value;
  }
  wrap.append(grid);return wrap;
}
function plot(points,xLabel,yLabel) {
  const canvas=node("canvas");
  canvas.setAttribute("role","img");
  canvas.setAttribute("aria-label",`${yLabel} versus ${xLabel}`);
  canvas.width=800;canvas.height=280;
  const valid=points.filter(([,y])=>Number.isFinite(y));
  if(!valid.length) throw Error("No feasible points in the selected range.");
  let min=Infinity,max=-Infinity;
  for(const [,y] of valid){min=Math.min(min,y);max=Math.max(max,y);}
  if(max===min){max+=1;min-=1;}
  const xmin=points[0][0], xmax=points.at(-1)[0];
  if(!(xmax>xmin)) throw Error("The horizontal axis has zero or negative duration.");
  const x=value=>85+690*(value-xmin)/(xmax-xmin);
  const y=value=>225-195*(value-min)/(max-min);
  const ctx=canvas.getContext("2d");
  ctx.font="15px system-ui";ctx.fillStyle="#172c2a";ctx.strokeStyle="#bccdc4";
  for(let i=0;i<=4;i++){
    const a=xmin+(xmax-xmin)*i/4,b=min+(max-min)*i/4;
    ctx.fillText(fmt.format(a),x(a)-10,248);ctx.fillText(fmt.format(b),3,y(b)+5);
    ctx.beginPath();ctx.moveTo(85,y(b));ctx.lineTo(775,y(b));ctx.stroke();
  }
  ctx.fillText(xLabel,350,275);ctx.fillText(yLabel,4,16);
  ctx.strokeStyle="#145848";ctx.lineWidth=2;ctx.beginPath();
  let active=false;
  for(const [a,b] of points){if(b===null){active=false;continue;} if(active)ctx.lineTo(x(a),y(b));else ctx.moveTo(x(a),y(b));active=true;}
  ctx.stroke();
  return canvas;
}
function rows(text) {
  return text.trim().split(/\r?\n/).filter(line=>line.trim()).map(line=>line.split(",").map(value=>value.trim()));
}
function numeric(value) {
  if(!value || !Number.isFinite(Number(value))) throw Error("Enter finite numbers in every numeric field.");
  return Number(value);
}
function source(text,filename) {
  const out=node("div"), code=node("pre",text), link=node("a","Download Python script");
  link.className="button";link.download=filename;
  link.href=URL.createObjectURL(new Blob([text],{type:"text/x-python"}));
  out.append(code,link);return out;
}
const actions={
  qv:(_,n)=>{
    const points=qvCurve(...["source","r","x","p","low","high"].map(n));
    const valid=points.filter(([,q])=>q!==null);
    if(!valid.length) throw Error("No feasible operating point in this sweep.");
    const peak=valid.reduce((a,b)=>a[1]>=b[1]?a:b);
    return [node("p",`Peak sampled Q: ${fmt.format(peak[1])} pu at ${fmt.format(peak[0])} pu voltage.`),plot(points,"Voltage (pu)","Reactive load (pu)")];
  },
  pull:(data,n)=>{
    const route=rows(data.get("route")).map(([kind,value,radius,...rest],i)=>{
      if(rest.length || !["straight","bend"].includes(kind) || (kind==="straight" && radius!==undefined)) throw Error(`Check segment ${i+1} format.`);
      const length=numeric(value),r=kind==="bend"?numeric(radius):null;
      if(length<0 || (kind==="bend" && r<=0)) throw Error(`Check segment ${i+1} dimensions.`);
      return [kind,length,r];
    });
    return [table(["Segment","Exit tension (N)","Sidewall pressure (N/m)"],cablePull(n("weight"),n("initial"),n("friction"),route))];
  },
  commitment:data=>{
    const units=rows(data.get("units")).map(([name,...values])=>{
      if(!name||values.length!==5) throw Error("Each unit needs a name and five numeric values.");
      const [min,max,energy,fixed,start]=values.map(numeric);
      if(min<0||max<=0||max<min||fixed<0||start<0) throw Error("Check unit limits and startup/no-load costs.");
      return {name,min,max,energy,fixed,start};
    });
    const demand=data.get("demand").trim().split(/[,\s]+/).map(numeric);
    if(units.length>7||!units.length||demand.length>48||demand.some(v=>v<0)||new Set(units.map(u=>u.name.toLowerCase())).size!==units.length) throw Error("Enter 1–7 unique units and 1–48 nonnegative loads.");
    const result=unitCommit(units,demand);
    return [node("p",`Total cost: ${fmt.format(result.cost)}`),table(["Hour","Demand (MW)",...units.map(u=>u.name+" (MW)"),"Hourly cost"],result.rows.map((r,i)=>[i+1,...r]))];
  },
  comtrade:async data=>{
    const cfgFile=data.get("cfg"), dat=data.get("dat");
    if(cfgFile.size>256*1024||dat.size>12*1024*1024) throw Error("Use a CFG under 256 KiB and a DAT under 12 MiB.");
    const cfg=parseConfig(await cfgFile.text());
    const buffer=await dat.arrayBuffer();
    const select=node("select"), label=node("label","Channel "), output=node("div");
    cfg.names.forEach((name,i)=>{const o=node("option",name);o.value=i;select.append(o);});
    label.append(select);
    const draw=()=>{
      try{
        const {unit,points}=waveform(cfg,buffer,Number(select.value));
        const stride=Math.max(1,Math.ceil(points.length/1800));
        const display=[];
        for(let i=0;i<points.length;i+=stride){
          let low=i,high=i;
          for(let j=i+1;j<Math.min(i+stride,points.length);j++){
            if(points[j][1]<points[low][1]) low=j;
            if(points[j][1]>points[high][1]) high=j;
          }
          for(const j of [low,high].sort((a,b)=>a-b)) display.push(points[j]);
        }
        display.unshift(points[0]); display.push(points.at(-1));
        output.replaceChildren(node("p",`${points.length.toLocaleString()} samples · ${cfg.format}`),plot(display,"Time (s)",unit||"Amplitude"));
      }catch(e){output.replaceChildren(node("p",e.message));}
    };
    select.addEventListener("change",draw);draw();
    return [label,output];
  },
  powerfactory:data=>[source(powerFactoryScript(data.get("project").trim(),data.get("case").trim()),"powerfactory_loadflow.py")],
  pscad:data=>[source(pscadScript(data.get("file").trim(),data.get("name").trim()),"pscad_run.py")],
};

for(const form of document.querySelectorAll("form")){
  const result=form.nextElementSibling;
  let request=0;
  form.addEventListener("submit",async event=>{
    event.preventDefault();
    const current=++request;
    const data=new FormData(form);
    for(const link of result.querySelectorAll("a[download]")) URL.revokeObjectURL(link.href);
    try{
      const parts=await actions[form.parentElement.id](data,key=>Number(data.get(key)));
      if(current===request) result.replaceChildren(...parts);
    }catch(e){if(current===request) result.replaceChildren(node("p",e.message));}
  });
}
