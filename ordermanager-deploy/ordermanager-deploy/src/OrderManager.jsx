import { useState, useCallback, useMemo, useRef, Fragment, useContext, useEffect } from "react";
import * as XLSX from 'xlsx';
import { AuthContext } from "./AuthContext";
import { apiClient } from "./api";

/* ═══ DATA HELPERS ═══ */
// utility arrays & functions used across components
var DAYS=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

function activeType(sc){var t=new Date().getDay();for(var k in sc){if(sc[k]===t)return k;}return null;}
function weekNum(d){var dt=new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate()));dt.setUTCDate(dt.getUTCDate()+4-(dt.getUTCDay()||7));var ys=new Date(Date.UTC(dt.getUTCFullYear(),0,1));return Math.ceil(((dt-ys)/86400000+1)/7);}
function dateKey(type, manualOpenOrder, manualOpenSeq){
  var n=new Date();
  var base=n.getFullYear()+"-W"+String(weekNum(n)).padStart(2,"0");
  if(manualOpenOrder&&manualOpenSeq&&manualOpenOrder===type) return base+"-M"+manualOpenSeq+"-"+type;
  return base+"-"+type;
}
function lastWeekKey(type){var n=new Date();return n.getFullYear()+"-W"+String(weekNum(n)-1).padStart(2,"0")+"-"+type;}
function getCurrentOrderForStoreType(orderMap, storeId, type, manualOpenOrder, manualOpenSeq){
  var exactKey=storeId+"_"+dateKey(type,manualOpenOrder,manualOpenSeq);
  if(orderMap&&orderMap[exactKey]) return orderMap[exactKey];
  // compatibility fallback for older keys before manual-open sequence was introduced
  if(manualOpenOrder&&manualOpenSeq&&manualOpenOrder===type){
    var legacyKey=storeId+"_"+dateKey(type,null,null);
    var legacy=orderMap&&orderMap[legacyKey];
    if(legacy&&legacy.status!=="submitted"&&legacy.status!=="processed") return legacy;
  }
  return null;
}
function sortItems(a){
  return a.slice().sort(function(x,y){
    var nx=String(x&&x.name||"");
    var ny=String(y&&y.name||"");
    var byName=nx.localeCompare(ny,undefined,{sensitivity:"base"});
    if(byName!==0) return byName;
    return String(x&&x.code||"").localeCompare(String(y&&y.code||""),undefined,{sensitivity:"base"});
  });
}
var TEMPLATE_STORE_SLOTS=[
  {apna:"Apna 1",city:"Bellevue"},
  {apna:"Apna 2",city:"Bothell"},
  {apna:"Apna 3",city:"Sammamish"},
  {apna:"Apna 4",city:"Kent"},
  {apna:"Apna 5",city:"Redmond"},
];
function mapStoresToTemplateSlots(stores){
  var list=Array.isArray(stores)?stores:[];
  var used={};
  var slots=TEMPLATE_STORE_SLOTS.map(function(slot){
    var idx=list.findIndex(function(s,i){return !used[i]&&String((s&&s.name)||"").toLowerCase().indexOf(slot.city.toLowerCase())>=0;});
    if(idx>=0){used[idx]=true;return Object.assign({},slot,{store:list[idx]});}
    return Object.assign({},slot,{store:null});
  });
  var rest=list.filter(function(_,i){return !used[i];});
  var ri=0;
  return slots.map(function(slot){
    if(slot.store) return slot;
    var next=rest[ri++]||null;
    return Object.assign({},slot,{store:next});
  });
}
function fmtDT(iso){if(!iso)return"-";var d=new Date(iso);return d.toLocaleDateString()+" "+d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});}
function parseCSV(text){var lines=text.split(/\r?\n/).filter(function(l){return l.trim();});if(lines.length<2)return[];var hdr=lines[0].split(",").map(function(h){return h.trim().toLowerCase().replace(/[^a-z0-9]/g,"");});var ci=hdr.findIndex(function(h){return h.indexOf("code")>=0||h==="sku";});var ni=hdr.findIndex(function(h){return h.indexOf("name")>=0||h==="item"||h==="description";});var cti=hdr.findIndex(function(h){return h.indexOf("cat")>=0||h==="group";});var ui=hdr.findIndex(function(h){return h.indexOf("unit")>=0||h==="uom";});if(ni===-1)return[];var r=[];for(var i=1;i<lines.length;i++){var cols=lines[i].split(",").map(function(c){return c.trim().replace(/"/g,"");});if(!cols[ni])continue;r.push({code:ci>=0&&cols[ci]?cols[ci]:"CSV"+String(i).padStart(4,"0"),name:cols[ni],category:cti>=0?(cols[cti]||""):"",unit:ui>=0?(cols[ui]||""):"",});}return r;}
function parseOrderSheetRows(rows){
  if(!rows||rows.length<2)return[];
  var hdrRow=-1,hdr=[];
  for(var r=0;r<Math.min(rows.length,25);r++){
    var cand=(rows[r]||[]).map(function(h){return String(h||"").trim().toLowerCase().replace(/[^a-z0-9]/g,"");});
    var hasQty=cand.findIndex(function(h){return h==="qty"||h.indexOf("quantity")>=0||h.indexOf("case")>=0;})>=0;
    var hasItem=cand.findIndex(function(h){return h.indexOf("name")>=0||h==="item"||h==="description"||h.indexOf("code")>=0||h==="sku";})>=0;
    if(hasQty&&hasItem){hdrRow=r;hdr=cand;break;}
  }
  if(hdrRow===-1)return[];
  var ci=hdr.findIndex(function(h){return h.indexOf("code")>=0||h==="sku";});
  var ni=hdr.findIndex(function(h){return h.indexOf("name")>=0||h==="item"||h==="description";});
  var qi=hdr.findIndex(function(h){return h==="qty"||h.indexOf("quantity")>=0||h.indexOf("case")>=0;});
  var noi=hdr.findIndex(function(h){return h==="note"||h==="notes"||h.indexOf("remark")>=0||h.indexOf("comment")>=0;});
  if(qi===-1)return[];
  var out=[];
  for(var i=hdrRow+1;i<rows.length;i++){
    var cols=rows[i]||[];
    var code=ci>=0&&cols[ci]!=null?String(cols[ci]).trim():"";
    var name=ni>=0&&cols[ni]!=null?String(cols[ni]).trim():"";
    var rawQty=qi>=0&&cols[qi]!=null?String(cols[qi]).trim():"";
    var qty=Math.max(0,parseInt(rawQty,10)||0);
    var note=noi>=0&&cols[noi]!=null?String(cols[noi]).trim():"";
    if(!code&&!name&&!qty&&!note)continue;
    out.push({code:code,name:name,quantity:qty,note:note});
  }
  return out;
}
function parseOrderCSV(text){
  var lines=text.split(/\r?\n/).filter(function(l){return l.trim();});
  var rows=lines.map(function(l){return l.split(",").map(function(c){return c.trim().replace(/^\"|\"$/g,"");});});
  return parseOrderSheetRows(rows);
}
function normLabel(v){return String(v||"").toLowerCase().replace(/[^a-z0-9]/g,"").trim();}
function syntheticOrderKeyFromName(name){return "XLS::"+String(name||"").trim();}
function displayNameForOrderKey(code, items){
  var found=(items||[]).find(function(it){return it.code===code;});
  if(found&&found.name)return found.name;
  if(String(code||"").indexOf("XLS::")===0)return String(code).slice(5);
  return String(code||"");
}
function worksheetToRows(ws){
  if(!ws||!ws["!ref"]) return [];
  var range=XLSX.utils.decode_range(ws["!ref"]);
  var rows=[];
  for(var r=range.s.r;r<=range.e.r;r++){
    var row=[];
    for(var c=range.s.c;c<=range.e.c;c++){
      var cell=ws[XLSX.utils.encode_cell({r:r,c:c})];
      row.push(cell&&cell.v!=null?String(cell.v):"");
    }
    rows.push(row);
  }
  return rows;
}
function sameJson(a,b){
  try{return JSON.stringify(a)===JSON.stringify(b);}catch(_e){return false;}
}




var S={
  page:{minHeight:"100vh",display:"flex",fontFamily:"'Segoe UI',-apple-system,BlinkMacSystemFont,sans-serif",background:"#ECEFF3",color:"#111827"},
  sidebar:{width:240,minWidth:240,background:"rgba(250,250,247,.78)",backdropFilter:"blur(10px)",WebkitBackdropFilter:"blur(10px)",borderRight:"1px solid rgba(148,163,184,.28)",display:"flex",flexDirection:"column",height:"100vh",position:"sticky",top:0,overflowY:"auto"},
  sideHdr:{padding:"18px 14px",borderBottom:"1px solid rgba(148,163,184,.22)",display:"flex",alignItems:"center",gap:8},
  logo:{width:34,height:34,borderRadius:8,background:"linear-gradient(135deg,#22C55E,#15803D)",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:700,fontSize:13,color:"#fff",flexShrink:0},
  navItem:{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",borderRadius:6,cursor:"pointer",fontSize:12.5,fontWeight:500,marginBottom:1},
  navA:{background:"#DCFCE7",color:"#166534"},navI:{color:"#475569"},
  main:{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"},
  topbar:{height:52,minHeight:52,borderBottom:"1px solid rgba(148,163,184,.22)",display:"flex",alignItems:"center",justifyContent:"space-between",padding:"0 20px",background:"rgba(252,252,250,.72)",backdropFilter:"blur(10px)",WebkitBackdropFilter:"blur(10px)"},
  content:{flex:1,overflowY:"auto",padding:20},
  card:{background:"rgba(255,255,255,.72)",backdropFilter:"blur(8px)",WebkitBackdropFilter:"blur(8px)",border:"1px solid rgba(148,163,184,.24)",borderRadius:12,padding:18,marginBottom:14,boxShadow:"0 8px 20px rgba(15,23,42,.06)"},
  cH:{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12,flexWrap:"wrap",gap:8},
  t:{fontSize:15,fontWeight:700,color:"#0F172A"},d:{fontSize:12,color:"#64748B",marginTop:2},
  sg:{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))",gap:10,marginBottom:16},
  sc:{background:"rgba(255,255,255,.72)",border:"1px solid rgba(148,163,184,.24)",borderRadius:12,padding:14,backdropFilter:"blur(6px)",WebkitBackdropFilter:"blur(6px)"},
  sL:{fontSize:10,color:"#64748B",fontWeight:600,textTransform:"uppercase",letterSpacing:.5},
  sV:{fontSize:24,fontWeight:700,marginTop:3,fontFamily:"monospace",color:"#0F172A"},sS:{fontSize:11,color:"#64748B",marginTop:2},
  tw:{overflow:"auto",borderRadius:8,border:"1px solid rgba(148,163,184,.25)",maxHeight:"62vh",background:"rgba(255,255,255,.58)"},
  th:{padding:"9px 10px",textAlign:"left",fontWeight:600,color:"#334155",fontSize:11,textTransform:"uppercase",letterSpacing:.5,whiteSpace:"nowrap",borderBottom:"1px solid rgba(148,163,184,.24)",background:"rgba(241,245,249,.8)",position:"sticky",top:0,zIndex:5},
  td:{padding:"9px 10px",borderBottom:"1px solid rgba(148,163,184,.22)",fontSize:13,color:"#0F172A"},
  tm:{padding:"9px 10px",borderBottom:"1px solid rgba(148,163,184,.22)",fontFamily:"monospace",fontSize:12,color:"#475569"},
  b:{display:"inline-flex",alignItems:"center",gap:4,padding:"7px 12px",borderRadius:6,fontSize:11.5,fontWeight:600,cursor:"pointer",border:"none",whiteSpace:"nowrap",fontFamily:"inherit"},
  bP:{background:"#16A34A",color:"#fff"},bS:{background:"rgba(255,255,255,.72)",color:"#0F172A",border:"1px solid rgba(148,163,184,.34)"},
  bD:{background:"rgba(248,113,113,0.1)",color:"#F87171",border:"1px solid rgba(248,113,113,0.2)"},
  bG:{background:"rgba(22,163,74,0.1)",color:"#166534",border:"1px solid rgba(22,163,74,0.25)"},
  bW:{background:"rgba(251,191,36,0.1)",color:"#FBBF24",border:"1px solid rgba(251,191,36,0.2)"},
  bg:{display:"inline-flex",padding:"2px 8px",borderRadius:16,fontSize:10.5,fontWeight:600},
  bgG:{background:"rgba(22,163,74,0.12)",color:"#166534"},bgY:{background:"rgba(251,191,36,0.14)",color:"#92400E"},
  bgR:{background:"rgba(248,113,113,0.12)",color:"#B91C1C"},bgB:{background:"rgba(34,197,94,0.12)",color:"#166534"},
  bgP:{background:"rgba(168,85,247,0.12)",color:"#0F766E"},
  inp:{width:"100%",padding:"8px 10px",borderRadius:8,border:"1px solid rgba(148,163,184,.34)",background:"rgba(255,255,255,.82)",color:"#0F172A",fontSize:13,outline:"none",fontFamily:"inherit"},
  ni:{width:70,padding:"5px 3px",textAlign:"center",fontFamily:"monospace",fontSize:12,borderRadius:8,border:"1px solid rgba(148,163,184,.34)",background:"rgba(255,255,255,.82)",color:"#0F172A",outline:"none"},
  ie:{width:60,padding:"4px",textAlign:"center",fontFamily:"monospace",fontSize:11.5,borderRadius:4,border:"1.5px solid #16A34A",background:"#FFFFFF",color:"#0F172A",outline:"none"},
  lb:{display:"block",fontSize:10.5,fontWeight:600,color:"#475569",marginBottom:3,textTransform:"uppercase",letterSpacing:.4},
  ov:{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16},
  mo:{background:"rgba(255,255,255,.86)",backdropFilter:"blur(12px)",WebkitBackdropFilter:"blur(12px)",border:"1px solid rgba(148,163,184,.28)",borderRadius:14,padding:22,width:500,maxWidth:"95vw",maxHeight:"82vh",overflowY:"auto",color:"#0F172A",boxShadow:"0 20px 40px rgba(15,23,42,.14)"},
  mW:{width:750},mA:{display:"flex",gap:8,justifyContent:"flex-end",marginTop:14},
  fg:{marginBottom:12},fr:{display:"flex",gap:10},
  nI:{padding:"10px 14px",borderRadius:6,marginBottom:10,background:"rgba(22,163,74,0.08)",border:"1px solid rgba(22,163,74,0.2)",color:"#166534",fontSize:12.5},
  nP:{padding:"10px 14px",borderRadius:6,marginBottom:10,background:"rgba(251,191,36,0.1)",border:"1px solid rgba(251,191,36,0.25)",color:"#92400E",fontSize:12.5},
  nG:{padding:"10px 14px",borderRadius:6,marginBottom:10,background:"rgba(22,163,74,0.08)",border:"1px solid rgba(22,163,74,0.22)",color:"#166534",fontSize:12.5},
  tabs:{display:"flex",gap:2,marginBottom:14,padding:2,background:"rgba(241,245,249,.86)",borderRadius:8,width:"fit-content",border:"1px solid rgba(148,163,184,.28)",backdropFilter:"blur(6px)",WebkitBackdropFilter:"blur(6px)"},
  tab:{padding:"5px 12px",borderRadius:5,fontSize:11.5,fontWeight:600,cursor:"pointer",border:"none",fontFamily:"inherit"},
  tA:{background:"#16A34A",color:"#fff"},tI:{background:"transparent",color:"#475569"},
  eB:{background:"none",border:"none",cursor:"pointer",color:"#64748B",padding:2,borderRadius:4,display:"inline-flex",alignItems:"center"},
  cE:{background:"rgba(22,163,74,0.08)"},
  to:{position:"fixed",top:14,right:14,zIndex:2000,padding:"8px 16px",borderRadius:6,fontSize:12.5,fontWeight:500,color:"#34D399",background:"#065F46",border:"1px solid rgba(52,211,153,0.3)"},
  toE:{color:"#F87171",background:"#7F1D1D",border:"1px solid rgba(248,113,113,0.3)"},
  lP:{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"#ECEFF3"},
  lC:{width:540,maxWidth:"94vw",background:"rgba(255,255,255,.74)",backdropFilter:"blur(14px)",WebkitBackdropFilter:"blur(14px)",border:"1px solid rgba(15,23,42,.12)",borderRadius:22,padding:"44px 42px",boxShadow:"0 24px 48px rgba(15,23,42,.14)"},
  lE:{padding:"6px 10px",borderRadius:6,fontSize:11.5,background:"rgba(248,113,113,0.1)",color:"#F87171",border:"1px solid rgba(248,113,113,0.2)",marginBottom:10,textAlign:"center"},
  sB:{display:"flex",alignItems:"center",gap:5,padding:"5px 10px",background:"rgba(255,255,255,.8)",border:"1px solid rgba(148,163,184,.34)",borderRadius:8},
  sI:{border:"none",background:"none",padding:0,fontSize:12.5,color:"#0F172A",outline:"none",width:130,fontFamily:"inherit"},
  ft:{padding:12,borderTop:"1px solid rgba(148,163,184,.22)"},
  uC:{display:"flex",alignItems:"center",gap:7,padding:"7px 9px",borderRadius:8,background:"rgba(241,245,249,.72)"},
  av:{width:28,height:28,borderRadius:"50%",background:"linear-gradient(135deg,#34D399,#059669)",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:700,fontSize:11,color:"#fff",flexShrink:0},
  loB:{display:"flex",alignItems:"center",gap:4,marginTop:5,width:"100%",padding:"6px 9px",borderRadius:8,border:"1px solid rgba(148,163,184,.32)",background:"rgba(255,255,255,.5)",color:"#475569",fontSize:10.5,cursor:"pointer",fontFamily:"inherit"},
  tbl:{width:"100%",borderCollapse:"collapse"},
};

/* ═══ ICONS ═══ */
function Ic({type,size}){var z=size||16;var p={home:"M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",clip:"M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2 M8 2h8v4H8z",grid:"M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z",up:"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M17 8l-5-5-5 5 M12 3v12",users:"M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 7a4 4 0 1 0 0-0.01 M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75",bell:"M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9 M13.73 21a2 2 0 0 1-3.46 0",gear:"M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0",out:"M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9",check:"M20 6L9 17l-5-5",plus:"M12 5v14M5 12h14",trash:"M3 6h18 M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",search:"M11 11m-8 0a8 8 0 1 0 16 0a8 8 0 1 0-16 0 M21 21l-4.35-4.35",edit:"M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7 M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z",pin:"M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z M12 10m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0",lock:"M3 11h18v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V11z M7 11V7a5 5 0 0 1 10 0v4",save:"M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z M17 21v-8H7v8 M7 3v5h8",send:"M22 2L11 13 M22 2l-7 20-4-9-9-4 20-7z",eye:"M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0",x:"M18 6L6 18M6 6l12 12",menu:"M3 12h18M3 6h18M3 18h18",truck:"M1 3h15v13H1z M16 8h4l3 3v5h-7V8z M5.5 18.5a2.5 2.5 0 1 0 0-0.01 M18.5 18.5a2.5 2.5 0 1 0 0-0.01",chart:"M18 20V10 M12 20V4 M6 20v-6",mail:"M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M22 6l-10 7L2 6",phone:"M22 16.92v3a2 2 0 0 1-2.18 2A19.86 19.86 0 0 1 3.09 5.18 2 2 0 0 1 5.11 3h3a2 2 0 0 1 2 1.72c.13.81.36 1.6.68 2.34a2 2 0 0 1-.45 2.11L8.91 10.6a16 16 0 0 0 6.29 6.29l1.43-1.43a2 2 0 0 1 2.11-.45c.74.32 1.53.55 2.34.68a2 2 0 0 1 1.72 2v.23z"};return(<svg width={z} height={z} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{(p[type]||"").split(" M").map(function(s,i){return <path key={i} d={i===0?s:"M"+s}/>;})}</svg>);}

/* ═══ TOAST ═══ */
function Toast({msg,isErr}){if(!msg)return null;return <div style={Object.assign({},S.to,isErr?S.toE:{})}>{msg}</div>;}

/* ═══ LOGIN ═══ */
function Login({logo}){
  var _a=useState(""),un=_a[0],sU=_a[1];var _b=useState(""),pw=_b[0],sP=_b[1];var _c=useState(""),err=_c[0],sE=_c[1];var _d=useState(false),loading=_d[0],sL=_d[1];
  var auth=useContext(AuthContext);

  var go=function(){sL(true);sE("");auth.login(un,pw).then(function(){sL(false);}).catch(function(e){sE(e.message);sL(false);});};
  return(<div style={S.lP}><div style={S.lC}>
    <div style={{display:"flex",alignItems:"center",gap:10,justifyContent:"center",marginBottom:28}}>
      {logo?<img src={logo} alt="Logo" style={{width:44,height:44,borderRadius:10,objectFit:"cover"}}/>:<div style={Object.assign({},S.logo,{width:44,height:44,fontSize:15})}>OM</div>}
      <div><div style={{fontWeight:800,fontSize:24,color:"#111827",lineHeight:1}}>OrderManager</div><div style={{fontSize:12,color:"#334155",marginTop:4}}>Multi-Store Ordering Platform</div></div>
    </div>
    <div style={{textAlign:"center",fontSize:34,fontWeight:800,letterSpacing:".01em",marginBottom:8,color:"#0B1220"}}>Welcome Back</div>
    <div style={{textAlign:"center",fontSize:17,color:"#1F2937",marginBottom:24}}>Sign in to manage orders</div>
    {err&&<div style={S.lE}>{err}</div>}
    {auth.error&&<div style={S.lE}>{auth.error}</div>}
    <div style={S.fg}><div style={S.lb}>Username</div><input style={Object.assign({},S.inp,{padding:"12px 14px",fontSize:15,borderRadius:12})} value={un} onChange={e=>sU(e.target.value)} placeholder="Enter username" onKeyDown={e=>{if(e.key==="Enter"&&!loading){go();}}} disabled={loading}/></div>
    <div style={S.fg}><div style={S.lb}>Password</div><input style={Object.assign({},S.inp,{padding:"12px 14px",fontSize:15,borderRadius:12})} type="password" value={pw} onChange={e=>sP(e.target.value)} placeholder="Enter password" onKeyDown={e=>{if(e.key==="Enter"&&!loading){go();}}} disabled={loading}/></div>
    <button style={Object.assign({},S.b,S.bP,{width:"100%",justifyContent:"center",padding:"13px 18px",borderRadius:999,fontSize:20,fontWeight:700,opacity:loading?0.6:1,marginTop:8})} onClick={go} disabled={loading}>{loading?"Signing in...":"Sign In"}</button>
  </div></div>);
}

/* ════════ MAIN APP ════════ */
export default function App(){
  var auth=useContext(AuthContext);
  var user=auth.user;
  var userKey=user?(String(user.username||"")+"|"+String(user.role||"")+"|"+String(user.storeId||"")):"anon";
  var _p=useState("dashboard"),page=_p[0],setPage=_p[1];
  var _t=useState(""),tM=_t[0],sTM=_t[1];var _te=useState(false),tE=_te[0],sTE=_te[1];
  var _i=useState([]),items=_i[0],setItems=_i[1];
  var _us=useState([]),users=_us[0],setUsers=_us[1];
  var _o=useState({}),orders=_o[0],setOrders=_o[1];
  var _n=useState([]),notifs=_n[0],setNotifs=_n[1];
  var _s=useState([]),stores=_s[0],setStores=_s[1];
  var _sc=useState({}),schedule=_sc[0],setSchedule=_sc[1];
  var _mo=useState(null),manualOpenOrder=_mo[0],setManualOpenOrder=_mo[1];
  var _ms=useState(null),manualOpenSeq=_ms[0],setManualOpenSeq=_ms[1];
  var _ct=useState(null),consolidatedType=_ct[0],setConsolidatedType=_ct[1];
  var _et=useState(null),entryType=_et[0],setEntryType=_et[1];
  var _rf=useState(null),reopenedFromId=_rf[0],setReopenedFromId=_rf[1];
  var _om=useState({}),orderMsgs=_om[0],setOrderMsgs=_om[1];
  var _su=useState([]),suppliers=_su[0],setSuppliers=_su[1];
  var _lg=useState(null),logo=_lg[0],setLogo=_lg[1];
  var _ld=useState(true),isLoading=_ld[0],setIsLoading=_ld[1];
  var _err=useState(null),loadError=_err[0],setLoadError=_err[1];
  var tR=useRef(null);var logoRef=useRef(null);var syncInFlightRef=useRef(false);
  
  // helper to persist logo string to backend
  var saveLogoToServer = async function(dataUrl){
    try{
      await apiClient.settings.updateLogo(dataUrl);
    }catch(err){
      console.error('logo save error',err);
      toast('Unable to save logo',true);
    }
  };

  var toast=useCallback(function(m,e){sTM(m);sTE(!!e);if(tR.current)clearTimeout(tR.current);tR.current=setTimeout(function(){sTM("");},2500);},[]);
  
  // Reset UI/data immediately when auth user changes to avoid showing previous user's screen/state.
  useEffect(function(){
    setPage("dashboard");
    setLoadError(null);
    setConsolidatedType(null);
    setEntryType(null);
    setReopenedFromId(null);
    setOrders({});
    setNotifs([]);
    setUsers([]);
    setSuppliers([]);
    if(!user){
      setItems([]);
      setStores([]);
      setSchedule({});
      setOrderMsgs({});
      setManualOpenOrder(null);
      setManualOpenSeq(null);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
  },[userKey]);
  
  // Fetch data on user login
  useEffect(function(){
    if(!user){setIsLoading(false);return;}
    var cancelled=false;
    var fetchData=async function(opts){
      var initial=!!(opts&&opts.initial);
      if(syncInFlightRef.current) return;
      syncInFlightRef.current=true;
      try{
        if(initial){setIsLoading(true);}
        var isA=user.role==="admin";
        var fetches={
          items:apiClient.items.getAll(),
          stores:apiClient.stores.getAll(),
          notifs:apiClient.notifications.getAll(),
          orders:apiClient.orders.getAll(isA?null:user.storeId),
          settings:apiClient.settings.getAll(),
        };
        if(isA){fetches.users=apiClient.users.getAll();fetches.suppliers=apiClient.suppliers.getAll();}
        var results=await Promise.all(Object.values(fetches));
        if(cancelled) return;
        var keys=Object.keys(fetches);
        var data={};keys.forEach(function(k,i){data[k]=results[i];});
        setLoadError(null);
        
        var nextItems=sortItems(data.items||[]);
        var nextStores=data.stores||[];
        var nextNotifs=data.notifs||[];
        setItems(function(prev){return sameJson(prev,nextItems)?prev:nextItems;});
        setStores(function(prev){return sameJson(prev,nextStores)?prev:nextStores;});
        setNotifs(function(prev){return sameJson(prev,nextNotifs)?prev:nextNotifs;});
        // server now returns nested objects to avoid collisions between
        // schedule and message keys.  each is keyed by order type (A/B/C).
        var settings = data.settings || {};
        var serverSched = settings.schedule || {};
        var serverMsg = settings.message || {};
        var serverManualOpen = settings.manualOpenOrder || null;
        var serverManualOpenSeq = settings.manualOpenSeq != null ? Number(settings.manualOpenSeq) : null;
        var nextMsgs={A:serverMsg.A||"",B:serverMsg.B||"",C:serverMsg.C||""};
        var nextManualSeq=Number.isNaN(serverManualOpenSeq)?null:serverManualOpenSeq;
        setOrderMsgs(function(prev){return sameJson(prev,nextMsgs)?prev:nextMsgs;});
        setManualOpenOrder(function(prev){return prev===serverManualOpen?prev:serverManualOpen;});
        setManualOpenSeq(function(prev){return prev===nextManualSeq?prev:nextManualSeq;});
        // pull logo value too (may be null)
        var nextLogo=settings.logo || null;
        setLogo(function(prev){return prev===nextLogo?prev:nextLogo;});
        // ensure schedule values are explicit null when not set
        var schedMap={
          A: serverSched.A != null ? serverSched.A : null,
          B: serverSched.B != null ? serverSched.B : null,
          C: serverSched.C != null ? serverSched.C : null,
        };
        // fallback to today's weekday if the server somehow returns null
        var today = new Date().getDay();
        ['A','B','C'].forEach(function(t){
          if (schedMap[t] == null) {
            console.warn('schedule for',t,'was null, defaulting to current day',today);
            schedMap[t] = today;
          }
        });
        console.log('fetched schedule',schedMap);
        setSchedule(function(prev){return sameJson(prev,schedMap)?prev:schedMap;});
        if(data.orders&&Array.isArray(data.orders)){
          // key orders by store_week-type so existing UI logic continues to work
          var orderMap={};
          data.orders.forEach(function(o){
            var key = o.storeId + "_" + o.week + "-" + o.type;
            orderMap[key] = {id:o.id, items:o.items||{}, notes:o.notes||{}, status:o.status, store:o.storeId, type:o.type, date:o.date};
          });
          setOrders(function(prev){return sameJson(prev,orderMap)?prev:orderMap;});
        }else{
          setOrders(function(prev){return Object.keys(prev||{}).length?{}:prev;});
        }
        if(isA){
          var nextUsers=data.users||[];
          var nextSuppliers=data.suppliers||[];
          setUsers(function(prev){return sameJson(prev,nextUsers)?prev:nextUsers;});
          setSuppliers(function(prev){return sameJson(prev,nextSuppliers)?prev:nextSuppliers;});
        }
        else {
          setUsers(function(prev){return prev.length?[]:prev;});
          setSuppliers(function(prev){return prev.length?[]:prev;});
        }
        if(initial){setIsLoading(false);}
      }catch(e){
        if(cancelled) return;
        if(initial){setLoadError(e.message);setIsLoading(false);toast(e.message,true);}
        else{console.warn("Live sync failed:",e&&e.message?e.message:e);}
      }finally{
        syncInFlightRef.current=false;
      }
    };
    if(auth.loading)return;
    fetchData({initial:true});
    var pullMs=3000;
    var timer=setInterval(function(){
      if(document.visibilityState==="visible"){fetchData({initial:false});}
    },pullMs);
    var onFocus=function(){fetchData({initial:false});};
    var onVisible=function(){if(document.visibilityState==="visible"){fetchData({initial:false});}};
    window.addEventListener("focus",onFocus);
    document.addEventListener("visibilitychange",onVisible);
    return function(){
      cancelled=true;
      clearInterval(timer);
      window.removeEventListener("focus",onFocus);
      document.removeEventListener("visibilitychange",onVisible);
    };
  },[userKey,auth.loading]);
  
  if(auth.loading){return <div style={Object.assign({},S.lP,{justifyContent:"center"})}><div style={{color:"#64748B"}}>Loading...</div></div>;}
  if(!user){return(<Fragment><input ref={logoRef} type="file" accept="image/*" style={{display:"none"}} onChange={function(e){
      var f=e.target.files&&e.target.files[0];if(!f)return;if(f.size>500000){toast("Logo must be under 500KB",true);return;}var r=new FileReader();r.onload=function(ev){setLogo(ev.target.result);toast("Logo updated");saveLogoToServer(ev.target.result);};r.readAsDataURL(f);e.target.value="";}}/><Login logo={logo}/></Fragment>);}
  
  if(isLoading||loadError){return <div style={Object.assign({},S.lP,{justifyContent:"center"})}><div style={{color:loadError?"#F87171":"#64748B"}}>{loadError?loadError:"Loading..."}</div></div>;}
  
  var sN=user.storeId?(stores.find(function(s){return s.id===user.storeId;})||{}).name||user.storeId:"All Stores";
  var isA=user.role==="admin";
  var aot=manualOpenOrder||activeType(schedule);
  var navs=isA?[
    {id:"dashboard",label:"Dashboard",ico:"home"},{id:"orders",label:"Order Monitor",ico:"clip"},
    {id:"consolidated",label:"Consolidated",ico:"grid"},{id:"supplier-orders",label:"Supplier Orders",ico:"truck"},
    {id:"items",label:"Item Master",ico:"up"},{id:"users",label:"Users",ico:"users"},
    {id:"suppliers",label:"Suppliers",ico:"truck"},{id:"notifications",label:"Notifications",ico:"bell"},
    {id:"stores",label:"Stores",ico:"pin"},{id:"reports",label:"Reports",ico:"chart"},
    {id:"settings",label:"Settings",ico:"gear"},
  ]:[
    {id:"dashboard",label:"Dashboard",ico:"home"},{id:"order-entry",label:"Place Order",ico:"clip"},
    {id:"history",label:"Order History",ico:"eye"},
  ];
  var PP={aot:aot,manualOpenOrder:manualOpenOrder,setManualOpenOrder:setManualOpenOrder,manualOpenSeq:manualOpenSeq,setManualOpenSeq:setManualOpenSeq,entryType:entryType,setEntryType:setEntryType,consolidatedType:consolidatedType,setConsolidatedType:setConsolidatedType,reopenedFromId:reopenedFromId,setReopenedFromId:setReopenedFromId,orders:orders,setOrders:setOrders,items:items,setItems:setItems,users:users,setUsers:setUsers,notifs:notifs,setNotifs:setNotifs,stores:stores,setStores:setStores,user:user,toast:toast,setPage:setPage,schedule:schedule,setSchedule:setSchedule,orderMsgs:orderMsgs,setOrderMsgs:setOrderMsgs,suppliers:suppliers,setSuppliers:setSuppliers,logo:logo,setLogo:setLogo,logoRef:logoRef};
  var rP=function(){
    if(page==="dashboard"&&isA)return <AdminDash {...PP}/>;if(page==="dashboard")return <MgrDash {...PP}/>;
    if(page==="order-entry")return <OrderEntry {...PP}/>;if(page==="history")return <OrderHistory {...PP}/>;
    if(page==="orders")return <OrderMonitor {...PP}/>;if(page==="consolidated")return <Consolidated {...PP}/>;
    if(page==="supplier-orders")return <SupplierOrders {...PP}/>;
    if(page==="items")return <ItemMaster {...PP}/>;if(page==="users")return <UserMgmt {...PP}/>;
    if(page==="suppliers")return <SupplierMgmt {...PP}/>;
    if(page==="notifications")return <NotifMgmt {...PP}/>;if(page==="stores")return <StoreMgmt {...PP}/>;
    if(page==="reports")return <Reports {...PP}/>;if(page==="settings")return <Settings {...PP}/>;
    return null;
  };
  return(<div key={userKey} style={S.page}><Toast msg={tM} isErr={tE}/>
    <input ref={logoRef} type="file" accept="image/*" style={{display:"none"}} onChange={function(e){var f=e.target.files&&e.target.files[0];if(!f)return;if(f.size>500000){toast("Logo must be under 500KB",true);return;}var r=new FileReader();r.onload=function(ev){setLogo(ev.target.result);toast("Logo updated");saveLogoToServer(ev.target.result);};r.readAsDataURL(f);e.target.value="";}}/><aside style={S.sidebar}>
      <div style={S.sideHdr}>{logo?<img src={logo} alt="Logo" style={{width:34,height:34,borderRadius:8,objectFit:"cover",flexShrink:0}}/>:<div style={S.logo}>OM</div>}<div><div style={{fontWeight:700,fontSize:13}}>OrderManager</div><div style={{fontSize:10,color:"#6B7186"}}>{sN}</div></div></div>
      <nav style={{flex:1,padding:"8px 6px",overflowY:"auto"}}>
        <div style={{fontSize:9,fontWeight:600,color:"#6B7186",textTransform:"uppercase",letterSpacing:1,padding:"8px 10px 3px"}}>Navigation</div>
        {navs.map(function(n){return(<div key={n.id} style={Object.assign({},S.navItem,page===n.id?S.navA:S.navI)} onClick={function(){setPage(n.id);}}><Ic type={n.ico} size={15}/><span>{n.label}</span></div>);})}
      </nav>
      <div style={S.ft}><div style={S.uC}><div style={S.av}>{(user?.name || user?.username || "?").charAt(0)}</div><div><div style={{fontSize:11,fontWeight:600}}>{user.name}</div><div style={{fontSize:9,color:"#6B7186"}}>{isA?"Admin":"Manager"}</div></div></div>
        <button style={S.loB} onClick={function(){auth.logout();}}><Ic type="out" size={13}/><span>Sign Out</span></button></div>
    </aside>
    <div style={S.main}>
      <header style={S.topbar}><div style={{fontSize:15,fontWeight:700}}>{(navs.find(function(n){return n.id===page;})||{}).label||"Dashboard"}</div></header>
      <div style={S.content}>{rP()}</div>
    </div></div>);
}

/* ═══ ADMIN DASHBOARD ═══ */
function AdminDash({orders,users,items,notifs,aot,setPage,stores,schedule,toast,manualOpenOrder,manualOpenSeq}){
  var now=new Date(), curW=weekNum(now), curY=now.getFullYear();
  var weekOrders=Object.values(orders).filter(function(o){if(!o||!o.date)return false;var d=new Date(o.date);return d.getFullYear()===curY&&weekNum(d)===curW;});
  var sub=weekOrders.filter(function(o){return o.status==="submitted"||o.status==="draft_shared";}).length;
  var proc=weekOrders.filter(function(o){return o.status==="processed";}).length;
  // Pending reminders: managers who haven't submitted for active order
  var pendingAlerts=[];
  if(aot){stores.forEach(function(st){var o=getCurrentOrderForStoreType(orders,st.id,aot,manualOpenOrder,manualOpenSeq);if(!o||o.status==="draft"){var mgr=users.find(function(u){return u.storeId===st.id&&u.role==="manager"&&u.active;});pendingAlerts.push({storeId:st.id,store:st.name,manager:mgr?mgr.name:"N/A",phone:mgr?mgr.phone:"N/A"});}});}
  var sendOneReminder=async function(row){
    try{
      if(!aot) return;
      var resp=await apiClient.orders.sendReminder(aot,row.storeId);
      if((resp.sent||0)>0){toast("SMS sent: "+(resp.sent||0));}
      else if((resp.failed||0)>0){
        var msg=(resp.errors&&resp.errors[0]&&resp.errors[0].error)?resp.errors[0].error:"SMS failed";
        toast("SMS failed: "+msg,true);
      } else {
        toast("No pending target for SMS",true);
      }
    }catch(e){toast(e.message,true);}
  };
  var sendAllReminders=async function(){
    try{
      if(!aot) return;
      var resp=await apiClient.orders.sendReminder(aot);
      if((resp.sent||0)>0){toast("SMS sent: "+(resp.sent||0)+" / "+(resp.total||0));}
      else if((resp.failed||0)>0){
        var msg=(resp.errors&&resp.errors[0]&&resp.errors[0].error)?resp.errors[0].error:"SMS failed";
        toast("SMS failed: "+msg,true);
      } else {
        toast("No pending targets for SMS",true);
      }
    }catch(e){toast(e.message,true);}
  };
  return(<div>
    <div style={S.sg}>
      <div style={S.sc}><div style={S.sL}>Stores</div><div style={Object.assign({},S.sV,{color:"#34D399"})}>{stores.length}</div></div>
      <div style={S.sc}><div style={S.sL}>Items</div><div style={Object.assign({},S.sV,{color:"#166534"})}>{items.length}</div></div>
      <div style={S.sc}><div style={S.sL}>Submitted</div><div style={Object.assign({},S.sV,{color:"#FBBF24"})}>{sub}</div></div>
      <div style={S.sc}><div style={S.sL}>Processed</div><div style={Object.assign({},S.sV,{color:"#0F766E"})}>{proc}</div></div>
      <div style={S.sc}><div style={S.sL}>Today</div><div style={Object.assign({},S.sV,{color:"#FB923C",fontSize:18})}>{aot?"Order "+aot:"None"}</div></div>
    </div>
    {pendingAlerts.length>0&&aot&&(<div style={S.card}><div style={S.cH}><div><div style={Object.assign({},S.t,{color:"#F87171"})}>Pending Submissions - Order {aot}</div><div style={S.d}>These stores have not submitted yet. Auto SMS runs in final 1 hour window every 30 minutes.</div></div><button style={Object.assign({},S.b,S.bW)} onClick={sendAllReminders}>Send Reminder to All</button></div>
      <div style={S.tw}><table style={S.tbl}><thead><tr><th style={S.th}>Store</th><th style={S.th}>Manager</th><th style={S.th}>Phone</th><th style={S.th}>Action</th></tr></thead><tbody>
        {pendingAlerts.map(function(a,i){return <tr key={i}><td style={S.td}>{a.store}</td><td style={S.td}>{a.manager}</td><td style={S.tm}>{a.phone}</td><td style={S.td}><button style={Object.assign({},S.b,S.bS,{padding:"3px 8px",fontSize:10.5})} onClick={function(){sendOneReminder(a);}}>Send SMS</button></td></tr>;})}
      </tbody></table></div></div>)}
    {notifs.map(function(n){return <div key={n.id} style={n.type==="promo"?S.nP:S.nI}>{n.text}</div>;})}
    <div style={S.card}><div style={S.cH}><div style={S.t}>Quick Actions</div></div>
      <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
        <button style={Object.assign({},S.b,S.bP)} onClick={function(){setPage("consolidated");}}>Consolidated</button>
        <button style={Object.assign({},S.b,S.bS)} onClick={function(){setPage("supplier-orders");}}>Supplier Orders</button>
        <button style={Object.assign({},S.b,S.bS)} onClick={function(){setPage("reports");}}>Reports</button>
        <button style={Object.assign({},S.b,S.bS)} onClick={function(){setPage("items");}}>Items</button>
        <button style={Object.assign({},S.b,S.bS)} onClick={function(){setPage("users");}}>Users</button>
      </div></div>
    <div style={S.card}><div style={S.t}>Order Schedule</div>
      <div style={Object.assign({},S.tw,{marginTop:8})}><table style={S.tbl}><thead><tr><th style={S.th}>Order</th><th style={S.th}>Day</th><th style={S.th}>Status</th></tr></thead><tbody>
        {["A","B","C"].map(function(t){return(<tr key={t}><td style={Object.assign({},S.td,{fontWeight:600})}>Order {t}</td><td style={S.td}>{DAYS[schedule[t]]||"Unset"}</td><td style={S.td}><span style={Object.assign({},S.bg,aot===t?S.bgG:S.bgY)}>{aot===t?"Open":"Locked"}</span></td></tr>);})}</tbody></table></div></div>
  </div>);
}

/* ═══ MANAGER DASHBOARD ═══ */
function MgrDash({user,orders,notifs,aot,setPage,stores,schedule,orderMsgs,manualOpenOrder,manualOpenSeq}){
  var sName=(stores.find(function(s){return s.id===user.storeId;})||{}).name||user.storeId;
  var my=Object.keys(orders).filter(function(k){return k.indexOf(user.storeId)===0;});
  var sub=my.filter(function(k){return orders[k].status==="submitted"||orders[k].status==="processed";}).length;
  var curOrder=aot?getCurrentOrderForStoreType(orders,user.storeId,aot,manualOpenOrder,manualOpenSeq):null;
  var curStatus=curOrder?curOrder.status:null;
  return(<div>
    {notifs.map(function(n){return <div key={n.id} style={n.type==="promo"?S.nP:S.nI}>{n.text}</div>;})}
    <div style={S.sg}>
      <div style={S.sc}><div style={S.sL}>Your Store</div><div style={Object.assign({},S.sV,{color:"#166534",fontSize:16})}>{sName}</div></div>
      <div style={S.sc}><div style={S.sL}>Today</div><div style={Object.assign({},S.sV,{color:aot?"#34D399":"#6B7186",fontSize:18})}>{aot?"Order "+aot:"None"}</div></div>
      <div style={S.sc}><div style={S.sL}>Completed</div><div style={Object.assign({},S.sV,{color:"#FBBF24"})}>{sub}</div><div style={S.sS}>{my.length} total</div></div>
    </div>
    {aot&&(<div style={S.card}>
      <div style={S.cH}>
        <div>{curStatus==="submitted"?(<Fragment><div style={Object.assign({},S.t,{color:"#34D399"})}>Order {aot} is Submitted</div><div style={S.d}>Your order has been submitted successfully.</div></Fragment>)
          :curStatus==="processed"?(<Fragment><div style={Object.assign({},S.t,{color:"#0F766E"})}>Order {aot} is Processed</div><div style={S.d}>Admin has processed this order.</div></Fragment>)
          :curStatus==="draft"||curStatus==="draft_shared"?(<Fragment><div style={Object.assign({},S.t,{color:"#F59E0B"})}>Order {aot} is Draft</div><div style={S.d}>Draft saved. Open Place Order to edit draft or submit final.</div></Fragment>)
          :(<Fragment><div style={Object.assign({},S.t,{color:"#FBBF24"})}>Order {aot} - Action Required</div><div style={S.d}>{orderMsgs[aot]||"Please submit your order."}</div></Fragment>)}</div>
        {curStatus!=="submitted"&&curStatus!=="processed"&&<button style={Object.assign({},S.b,S.bP)} onClick={function(){setPage("order-entry");}}>{curStatus==="draft"||curStatus==="draft_shared"?"Open Draft":"Place Order"}</button>}
      </div>
    </div>)}
  </div>);
}

/* ═══ ORDER ENTRY ═══ */
function OrderEntry({user,items,orders,setOrders,aot,toast,stores,schedule,orderMsgs,manualOpenOrder,manualOpenSeq,entryType,setEntryType,notifs}){
  var _s=useState(entryType||aot||"A"),sel=_s[0],setSel=_s[1];
  var _cf=useState(false),showConfirm=_cf[0],setShowConfirm=_cf[1];
  var _ed=useState(false),isEditingDraft=_ed[0],setIsEditingDraft=_ed[1];
  var _dl=useState({}),draftLockByKey=_dl[0],setDraftLockByKey=_dl[1];
  var oKey=user.storeId+"_"+dateKey(sel,manualOpenOrder,manualOpenSeq);var lwKey=user.storeId+"_"+lastWeekKey(sel);
  var ex=orders[oKey];var lw=orders[lwKey];var locked=sel!==aot;
  // Draft and draft_shared remain editable; only submitted/processed are read-only.
  var done=ex&&(ex.status==="submitted"||ex.status==="processed");
  var hasServerDraft=!!(ex&&(ex.status==="draft"||ex.status==="draft_shared"));
  var isDraftOrder=hasServerDraft||!!draftLockByKey[oKey];
  var ro=locked||done||(isDraftOrder&&!isEditingDraft);
  var _q=useState(function(){return ex&&ex.items?Object.assign({},ex.items):items.reduce(function(a,it){a[it.code]=0;return a;},{});}),qty=_q[0],setQty=_q[1];
  var _n=useState(function(){return ex&&ex.notes?Object.assign({},ex.notes):items.reduce(function(a,it){a[it.code]="";return a;},{});}),notes=_n[0],setNotes=_n[1];
  useEffect(function(){
    setQty(function(prev){
      return items.reduce(function(a,it){
        if(ex&&ex.items&&ex.items[it.code]!=null){a[it.code]=ex.items[it.code];}
        else{a[it.code]=prev&&prev[it.code]!=null?prev[it.code]:0;}
        return a;
      },{});
    });
    setNotes(function(prev){
      return items.reduce(function(a,it){
        if(ex&&ex.notes&&ex.notes[it.code]){a[it.code]=ex.notes[it.code];}
        else{a[it.code]=prev&&prev[it.code]!=null?prev[it.code]:"";}
        return a;
      },{});
    });
  },[oKey,items,ex&&ex.id]);
  useEffect(function(){
    setIsEditingDraft(false);
  },[oKey]);
  useEffect(function(){
    if(entryType&&entryType!==sel){setSel(entryType);}
    if(entryType&&setEntryType){setEntryType(null);}
  },[entryType]);
  useEffect(function(){
    if(ex&& (ex.status==="submitted"||ex.status==="processed")){
      setDraftLockByKey(function(prev){
        if(!prev[oKey]) return prev;
        var n=Object.assign({},prev);delete n[oKey];return n;
      });
    }
  },[oKey,ex&&ex.status]);
  var setQ=function(c,v){if(ro)return;setQty(function(p){var n=Object.assign({},p);n[c]=Math.max(0,parseInt(v)||0);return n;});};
  var setN=function(c,v){if(ro)return;setNotes(function(p){var n=Object.assign({},p);n[c]=v;return n;});};
  var save=async function(){
    try{
      // send to backend, status draft
      const resp = await apiClient.orders.create({type:sel,items:qty,notes:notes,status:"draft",storeId:user.storeId});
      var id = resp.orderId;
      setOrders(function(p){var n=Object.assign({},p);n[oKey]={id:id,items:Object.assign({},qty),notes:Object.assign({},notes),status:"draft",store:user.storeId,type:sel,date:new Date().toISOString()};return n;});
      setDraftLockByKey(function(prev){var n=Object.assign({},prev);n[oKey]=true;return n;});
      setIsEditingDraft(false);
      toast("Draft saved");
    }catch(e){toast(e.message,true);}
  };
  var doSubmit=async function(){
    try{
      const resp = await apiClient.orders.create({type:sel,items:qty,notes:notes,status:"submitted",storeId:user.storeId});
      var id = resp.orderId;
      setOrders(function(p){var n=Object.assign({},p);n[oKey]={id:id,items:Object.assign({},qty),notes:Object.assign({},notes),status:"submitted",store:user.storeId,type:sel,date:new Date().toISOString()};return n;});
      setDraftLockByKey(function(prev){if(!prev[oKey]) return prev;var n=Object.assign({},prev);delete n[oKey];return n;});
      setIsEditingDraft(false);
      setShowConfirm(false);
      toast("Order submitted!");
    }catch(e){toast(e.message,true);setShowConfirm(false);}
  };
  var sName=(stores.find(function(s){return s.id===user.storeId;})||{}).name||"";
  var filled=Object.values(qty).filter(function(v){return v>0;}).length;
  var totalCases=Object.values(qty).reduce(function(a,b){return a+(parseInt(b,10)||0);},0);
  var sorted=useMemo(function(){
    var known=items.slice();
    var knownCodes={};known.forEach(function(it){knownCodes[it.code]=true;});
    var extraCodes=Object.keys(Object.assign({},qty,notes)).filter(function(code){return !knownCodes[code]&&((qty[code]||0)>0||(notes[code]||"").trim());});
    var extras=extraCodes.map(function(code){return {code:code,name:displayNameForOrderKey(code,items),category:"",unit:"",_extra:true};});
    return sortItems(known.concat(extras));
  },[items,qty,notes]);
  return(<div>
    {(notifs||[]).map(function(n){return <div key={n.id} style={n.type==="promo"?S.nP:S.nI}>{n.text}</div>;})}
    <div style={S.tabs}>{["A","B","C"].map(function(t){return <button key={t} style={Object.assign({},S.tab,sel===t?S.tA:S.tI)} onClick={function(){setSel(t);}}>Order {t}{t===aot?" *":""}</button>;})}</div>
    {locked&&<div style={S.nP}>Order {sel} is locked. Opens on {DAYS[schedule[sel]]||"Unset"}.</div>}
    {done&&<div style={S.nG}>Order {sel} has been {ex.status}. Read only.</div>}
    {isDraftOrder&&!isEditingDraft&&<div style={S.nI}>Draft order saved and locked. Click Edit Draft to modify, then Save Draft or Submit.</div>}
    {isDraftOrder&&isEditingDraft&&<div style={S.nI}>Editing draft. You can save draft again multiple times before final submit.</div>}
    <div style={S.card}><div style={S.cH}>
      <div><div style={S.t}>Order {sel} - {sName}</div><div style={S.d}>{filled} items | {ex?ex.status:"New"}</div></div>
      <div style={{display:"flex",gap:5,alignItems:"center",flexWrap:"wrap"}}>
        {done?null:(isDraftOrder&&!isEditingDraft?<Fragment><button style={Object.assign({},S.b,S.bS)} onClick={function(){setIsEditingDraft(true);}}>Edit Draft</button><button style={Object.assign({},S.b,S.bP)} onClick={function(){setShowConfirm(true);}}>Submit</button></Fragment>:<Fragment><button style={Object.assign({},S.b,S.bS)} onClick={save}>Save Draft</button><button style={Object.assign({},S.b,S.bP)} onClick={function(){setShowConfirm(true);}}>Submit</button></Fragment>)}
      </div>
    </div>
    <div style={Object.assign({},S.card,{padding:"10px 14px"})}>
      <div style={{display:"flex",gap:16,flexWrap:"wrap",alignItems:"center"}}>
        <div style={{fontSize:12.5}}><span style={{color:"#64748B"}}>Total Cases:</span> <strong style={{color:"#0F172A",fontFamily:"monospace"}}>{totalCases}</strong></div>
      </div>
    </div>
    <div style={S.tw}><table style={S.tbl}>
      <thead><tr><th style={S.th}>Item Name</th><th style={Object.assign({},S.th,{textAlign:"center"})}>Qty</th><th style={S.th}>Note</th></tr></thead>
      <tbody>{sorted.map(function(it){return(<tr key={it.code}><td style={Object.assign({},S.td,{fontWeight:500})}>{it.name}</td><td style={Object.assign({},S.td,{textAlign:"center"})}><input style={Object.assign({},S.ni,ro?{opacity:.4}:{})} type="number" min="0" value={qty[it.code]||0} onChange={function(e){setQ(it.code,e.target.value);}} disabled={ro}/></td><td style={S.td}><input style={Object.assign({},S.inp,ro?{opacity:.5}:{},{padding:"5px 8px",fontSize:11.5})} value={notes[it.code]||""} onChange={function(e){setN(it.code,e.target.value);}} placeholder="note" disabled={ro}/></td></tr>);})}</tbody>
    </table></div></div>
    {showConfirm&&(<div style={S.ov} onClick={function(){setShowConfirm(false);}}><div style={Object.assign({},S.mo,{width:420,textAlign:"center"})} onClick={function(e){e.stopPropagation();}}>
      <div style={{fontSize:40,marginBottom:8}}>⚠️</div>
      <div style={{fontSize:16,fontWeight:700,marginBottom:8}}>Submit Order {sel}?</div>
      <div style={{fontSize:13,color:"#64748B",marginBottom:20,lineHeight:1.6}}>Are you sure you want to submit this order?<br/>Once submitted, you will <strong style={{color:"#F87171"}}>not be able to edit</strong> it.</div>
      <div style={{display:"flex",gap:8,justifyContent:"center"}}>
        <button style={Object.assign({},S.b,S.bS,{padding:"9px 24px"})} onClick={function(){setShowConfirm(false);}}>No, Go Back & Edit</button>
        <button style={Object.assign({},S.b,S.bP,{padding:"9px 24px"})} onClick={doSubmit}>Yes, Submit</button>
      </div>
    </div></div>)}
  </div>);
}

/* ═══ ORDER HISTORY ═══ */
function OrderHistory({user,orders,items,setOrders,toast,setPage,manualOpenOrder,manualOpenSeq,setEntryType}){
  var my=Object.entries(orders).filter(function(e){return e[0].indexOf(user.storeId)===0;}).sort(function(a,b){return new Date(b[1].date)-new Date(a[1].date);});
  var _s=useState(null),sel=_s[0],setSel=_s[1];
  var statusBg=function(st){return st==="processed"?S.bgP:st==="submitted"?S.bgG:S.bgY;};
  var reopenAsDraft=async function(o){
    try{
      var resp=await apiClient.orders.create({type:o.type,items:o.items||{},notes:o.notes||{},status:"draft",storeId:user.storeId});
      var key=user.storeId+"_"+dateKey(o.type,manualOpenOrder,manualOpenSeq);
      setOrders(function(p){
        var n=Object.assign({},p);
        n[key]={id:resp.orderId,items:Object.assign({},o.items||{}),notes:Object.assign({},o.notes||{}),status:"draft",store:user.storeId,type:o.type,date:new Date().toISOString()};
        return n;
      });
      if(setEntryType) setEntryType(o.type);
      if(setPage) setPage("order-entry");
      toast("Submitted order reopened as draft");
    }catch(e){toast(e.message,true);}
  };
  var closeDraft=async function(o,k){
    if(!window.confirm("Close this draft and lock it as submitted?")) return;
    try{
      var resp=await apiClient.orders.create({type:o.type,items:o.items||{},notes:o.notes||{},status:"submitted",storeId:user.storeId});
      setOrders(function(p){
        var n=Object.assign({},p);
        n[k]=Object.assign({},n[k]||o,{id:resp.orderId||o.id,status:"submitted",date:new Date().toISOString()});
        return n;
      });
      toast("Draft closed and submitted");
    }catch(e){toast(e.message,true);}
  };
  return(<div><div style={S.card}><div style={S.t}>Past Orders</div>
    {my.length===0?<div style={{textAlign:"center",padding:30,color:"#6B7186"}}>No orders yet</div>:
    <div style={Object.assign({},S.tw,{marginTop:8})}><table style={S.tbl}><thead><tr><th style={S.th}>Order</th><th style={S.th}>Date/Time</th><th style={S.th}>Status</th><th style={S.th}>Items</th><th style={S.th}></th></tr></thead><tbody>
      {my.map(function(e){var k=e[0],o=e[1];return(<tr key={k}><td style={Object.assign({},S.td,{fontWeight:600})}>Order {o.type}</td><td style={S.tm}>{fmtDT(o.date)}</td><td style={S.td}><span style={Object.assign({},S.bg,statusBg(o.status))}>{o.status}</span></td><td style={S.td}>{Object.values(o.items||{}).filter(function(v){return v>0;}).length}</td><td style={S.td}><div style={{display:"flex",gap:4,flexWrap:"wrap"}}><button style={Object.assign({},S.b,S.bS,{padding:"3px 8px",fontSize:10.5})} onClick={function(){setSel(k);}}>View</button>{o.status==="submitted"&&<button style={Object.assign({},S.b,S.bW,{padding:"3px 8px",fontSize:10.5})} onClick={function(){reopenAsDraft(o);}}>Reopen as Draft</button>}{o.status==="draft"&&<button style={Object.assign({},S.b,S.bG,{padding:"3px 8px",fontSize:10.5})} onClick={function(){closeDraft(o,k);}}>Close Draft</button>}</div></td></tr>);})}</tbody></table></div>}</div>
    {sel&&orders[sel]&&(<div style={S.ov} onClick={function(){setSel(null);}}><div style={S.mo} onClick={function(e){e.stopPropagation();}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:12}}>Order {orders[sel].type} - {fmtDT(orders[sel].date)}</div>
      <div style={S.tw}><table style={S.tbl}><thead><tr><th style={S.th}>Item</th><th style={Object.assign({},S.th,{textAlign:"right"})}>Qty</th><th style={S.th}>Note</th></tr></thead><tbody>
        {Object.keys(Object.assign({},orders[sel].items||{},orders[sel].notes||{})).filter(function(code){return (orders[sel].items[code]||0)>0||((orders[sel].notes||{})[code]);}).map(function(code){return <tr key={code}><td style={S.td}>{displayNameForOrderKey(code,items)}</td><td style={Object.assign({},S.td,{textAlign:"right",fontFamily:"monospace"})}>{(orders[sel].items||{})[code]||0}</td><td style={S.td}>{((orders[sel].notes||{})[code])||"-"}</td></tr>;})}</tbody></table></div>
      <div style={S.mA}><button style={Object.assign({},S.b,S.bS)} onClick={function(){setSel(null);}}>Close</button></div></div></div>)}
  </div>);
}

/* ═══ ORDER MONITOR (with time + process button) ═══ */
function OrderMonitor({orders,setOrders,items,stores,aot,toast,setPage,setConsolidatedType,setReopenedFromId}){
  var _f=useState("all"),ft=_f[0],sFt=_f[1];
  var _cl=useState([]),completedLogs=_cl[0],setCompletedLogs=_cl[1];
  var _sd=useState(null),selDone=_sd[0],setSelDone=_sd[1];
  var all=Object.entries(orders).sort(function(a,b){return new Date(b[1].date)-new Date(a[1].date);});
  var f=(ft==="all"||ft==="completed")?all:all.filter(function(e){return e[1].type===ft;});
  var isReceived=function(st){return st==="submitted"||st==="draft_shared";};
  var statusBg=function(st){return st==="processed"?S.bgP:isReceived(st)?S.bgG:S.bgY;};
  var statusLabel=function(st){return st==="draft_shared"?"submitted":st;};
  useEffect(function(){
    var cancelled=false;
    apiClient.supplierOrders.getAll().then(function(list){
      if(cancelled) return;
      setCompletedLogs((list||[]).slice().sort(function(a,b){return new Date(b.sentAt||0)-new Date(a.sentAt||0);}));
    }).catch(function(){});
    return function(){cancelled=true;};
  },[]);
  var refreshCompletedLogs=async function(){
    try{
      const list=await apiClient.supplierOrders.getAll();
      setCompletedLogs((list||[]).slice().sort(function(a,b){return new Date(b.sentAt||0)-new Date(a.sentAt||0);}));
    }catch(e){}
  };
  useEffect(function(){
    if(ft==="completed") refreshCompletedLogs();
  },[ft]);
  var reopenCompleted=async function(log){
    try{
      await apiClient.supplierOrders.reopen(log._id);
      await refreshCompletedLogs();
      if(setConsolidatedType) setConsolidatedType(log.type);
      if(setReopenedFromId) setReopenedFromId(log._id||null);
      if(setPage) setPage("consolidated");
      toast("Completed order reopened. You can edit and resend from Consolidated.");
    }catch(e){toast(e.message,true);}
  };
  var processAll=async function(type){
    try{
      var tasks=[];
      Object.entries(orders).forEach(function([k,o]){
        if(o.type===type&&isReceived(o.status)&&o.id){
          tasks.push(apiClient.orders.process(o.id));
        }
      });
      await Promise.all(tasks);
      setOrders(function(prev){
        var n=Object.assign({},prev);
        Object.entries(n).forEach(function([k,o]){if(o.type===type&&isReceived(o.status)){n[k]=Object.assign({},o,{status:"processed"});}});
        return n;
      });
      toast("Order "+type+" marked as processed for all stores");
    }catch(e){toast(e.message,true);}
  };
  var closeDraftFromAdmin=async function(k,o){
    if(!o||o.status!=="draft") return;
    if(!window.confirm("Close this draft and lock it as submitted?")) return;
    try{
      var resp=await apiClient.orders.create({type:o.type,items:o.items||{},notes:o.notes||{},status:"submitted",storeId:o.store});
      setOrders(function(p){
        var n=Object.assign({},p);
        n[k]=Object.assign({},n[k]||o,{id:resp.orderId||o.id,status:"submitted",date:new Date().toISOString()});
        return n;
      });
      toast("Draft closed and submitted");
    }catch(e){toast(e.message,true);}
  };
  return(<div>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8,marginBottom:14}}>
      <div style={S.tabs}>{["all","A","B","C","completed"].map(function(t){return <button key={t} style={Object.assign({},S.tab,ft===t?S.tA:S.tI)} onClick={function(){sFt(t);}}>{t==="all"?"All":t==="completed"?"Completed":"Order "+t}</button>;})}</div>
      {ft!=="all"&&ft!=="completed"&&<button style={Object.assign({},S.b,S.bW)} onClick={function(){processAll(ft);}}>Process Order {ft} (All Stores)</button>}
    </div>
    {ft==="completed" ? (
      <div style={S.card}><div style={S.t}>Completed Orders (All Sent Consolidated Orders)</div>
        {completedLogs.length===0?<div style={{textAlign:"center",padding:30,color:"#6B7186"}}>No completed orders</div>:
        <div style={Object.assign({},S.tw,{marginTop:8})}><table style={S.tbl}><thead><tr><th style={S.th}>Date</th><th style={S.th}>Order</th><th style={S.th}>Supplier</th><th style={S.th}>Email</th><th style={S.th}>Week</th><th style={S.th}>Details</th><th style={S.th}>Status</th><th style={S.th}>Actions</th></tr></thead><tbody>
          {completedLogs.map(function(l){
            var canReopen=true;
            return(<tr key={l._id||l.sentAt}>
              <td style={S.tm}>{fmtDT(l.sentAt)}</td>
              <td style={S.td}>Order {l.type}</td>
              <td style={S.td}>{l.supplierName}</td>
              <td style={S.tm}>{l.email}</td>
              <td style={S.tm}>{l.week}</td>
              <td style={S.td}><button style={Object.assign({},S.b,S.bS,{padding:"3px 8px",fontSize:10})} onClick={function(){setSelDone(l);}}>View Details</button></td>
              <td style={S.td}><span style={Object.assign({},S.bg,l.finished===false?S.bgW:S.bgG)}>{l.finished===false?"reopened":"completed"}</span></td>
              <td style={S.td}>{canReopen?<button style={Object.assign({},S.b,S.bW,{padding:"3px 8px",fontSize:10})} onClick={function(){reopenCompleted(l);}}>{l.finished===false?"Open / Resend":"Reopen / Resend"}</button>:null}</td>
            </tr>);
          })}
        </tbody></table></div>}
      </div>
    ) : (
      <div style={S.card}><div style={S.t}>Submissions ({f.length})</div>
        {f.length===0?<div style={{textAlign:"center",padding:30,color:"#6B7186"}}>No orders</div>:
        <div style={Object.assign({},S.tw,{marginTop:8})}><table style={S.tbl}><thead><tr><th style={S.th}>Store</th><th style={S.th}>Order</th><th style={S.th}>Date / Time</th><th style={S.th}>Status</th><th style={S.th}>Filled</th><th style={S.th}>Action</th></tr></thead><tbody>
          {f.map(function(e){var k=e[0],o=e[1];var sn=(stores.find(function(s){return s.id===o.store;})||{}).name||o.store;return(<tr key={k}>
            <td style={Object.assign({},S.td,{fontWeight:500})}>{sn}</td><td style={S.td}>Order {o.type}</td>
            <td style={S.tm}>{fmtDT(o.date)}</td>
            <td style={S.td}><span style={Object.assign({},S.bg,statusBg(o.status))}>{statusLabel(o.status)}</span></td>
            <td style={S.td}>{Object.values(o.items||{}).filter(function(v){return v>0;}).length}/{items.length}</td>
            <td style={S.td}>{isReceived(o.status)&&o.id&&<button style={Object.assign({},S.b,S.bG,{padding:"3px 8px",fontSize:10})} onClick={async function(){
                try{await apiClient.orders.process(o.id);
                  setOrders(function(p){var n=Object.assign({},p);n[k]=Object.assign({},n[k],{status:"processed"});return n;});
                  toast("Processed");
                }catch(e){toast(e.message,true);} }}>Process</button>}{o.status==="draft"&&<button style={Object.assign({},S.b,S.bW,{padding:"3px 8px",fontSize:10,marginLeft:4})} onClick={function(){closeDraftFromAdmin(k,o);}}>Close Draft</button>}</td>
          </tr>);})}</tbody></table></div>}
      </div>
    )}
    {selDone&&(<div style={S.ov} onClick={function(){setSelDone(null);}}><div style={Object.assign({},S.mo,S.mW)} onClick={function(e){e.stopPropagation();}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:10}}>Sent Consolidated Order {selDone.type} - {fmtDT(selDone.sentAt)}</div>
      <div style={{fontSize:12,color:"#64748B",marginBottom:8}}>Supplier: {selDone.supplierName} | {selDone.email} | Week: {selDone.week}</div>
      {selDone.snapshotLines&&selDone.snapshotLines.length>0?
        <div style={Object.assign({},S.tw,{maxHeight:420})}><pre style={{margin:0,padding:12,whiteSpace:"pre-wrap",fontFamily:"ui-monospace, SFMono-Regular, Menlo, monospace",fontSize:11.5,color:"#0F172A"}}>{selDone.snapshotLines.join("\n")}</pre></div>
      :<div style={Object.assign({},S.nI,{marginBottom:0})}>No stored sent details for this record (older history entry).</div>}
      <div style={S.mA}><button style={Object.assign({},S.b,S.bS)} onClick={function(){setSelDone(null);}}>Close</button></div>
    </div></div>)}
  </div>);
}

/* ═══ CONSOLIDATED ═══ */
function Consolidated({orders,setOrders,items,aot,manualOpenOrder,manualOpenSeq,toast,stores,suppliers,consolidatedType,setConsolidatedType,reopenedFromId,setReopenedFromId}){
  var _v=useState(consolidatedType||aot||"A"),vt=_v[0],sVt=_v[1];
  var _e=useState(null),eSt=_e[0],sES=_e[1];var _eq=useState({}),eQ=_eq[0],sEQ=_eq[1];
  var _en=useState({}),eNotes=_en[0],sENotes=_en[1];
  var _emg=useState(false),eMailing=_emg[0],sEMailing=_emg[1];
  var _as=useState(false),autoSaving=_as[0],setAutoSaving=_as[1];
  var _st=useState(1),step=_st[0],setStep=_st[1];
  var _sv=useState([]),savedRows=_sv[0],setSavedRows=_sv[1];
  var _sp=useState([]),splitSupplierIds=_sp[0],setSplitSupplierIds=_sp[1];
  var _gp=useState({}),globalSplit=_gp[0],setGlobalSplit=_gp[1];
  var _ov=useState({}),itemOverrides=_ov[0],setItemOverrides=_ov[1];
  var _ss=useState({}),sentSplitBySupplier=_ss[0],setSentSplitBySupplier=_ss[1];
  var _logs=useState([]),logs=_logs[0],setLogs=_logs[1];
  var autoSaveTimerRef=useRef(null);
  var dk=dateKey(vt,manualOpenOrder,manualOpenSeq);
  var logWeekKey=dk.endsWith("-"+vt)?dk.slice(0,dk.length-(vt.length+1)):dk;
  var weekPrefix=dk.slice(0,8);
  var slots=useMemo(function(){return mapStoresToTemplateSlots(stores);},[stores]);
  var supplierList=Array.isArray(suppliers)?suppliers:[];
  var getStoreOrder=function(storeId){return getCurrentOrderForStoreType(orders,storeId,vt,manualOpenOrder,manualOpenSeq);};
  var supplierById=useMemo(function(){var m={};supplierList.forEach(function(s){m[s.id]=s;});return m;},[supplierList]);
  useEffect(function(){ if(consolidatedType&&consolidatedType!==vt) sVt(consolidatedType); },[consolidatedType]);
  useEffect(function(){
    var onlyOpen = consolidatedType||aot||null;
    if(onlyOpen && vt!==onlyOpen){
      sVt(onlyOpen);
      sES(null);sEQ({});sENotes({});
      if(setReopenedFromId) setReopenedFromId(null);
    }
  },[consolidatedType,aot]);
  useEffect(function(){
    setStep(1);setSavedRows([]);setSplitSupplierIds([]);setGlobalSplit({});setItemOverrides({});setSentSplitBySupplier({});
    if(setReopenedFromId) setReopenedFromId(null);
  },[dk]);
  useEffect(function(){
    let cancelled=false;
    apiClient.supplierOrders.getAll().then(function(h){if(!cancelled) setLogs(h||[]);}).catch(function(){});
    return function(){cancelled=true;};
  },[]);

  var baseRows=useMemo(function(){
    var knownCodes={};items.forEach(function(it){knownCodes[it.code]=true;});
    var dynamicCodes={};
    slots.forEach(function(sl){
      if(!sl.store) return;
      var o=getStoreOrder(sl.store.id)||{};
      Object.keys(Object.assign({},o.items||{},o.notes||{})).forEach(function(code){dynamicCodes[code]=true;});
    });
    var rows=items.slice();
    Object.keys(dynamicCodes).forEach(function(code){
      if(!knownCodes[code]) rows.push({code:code,name:displayNameForOrderKey(code,items),category:"",unit:"",_extra:true});
    });
    rows.sort(function(a,b){return String(a.name||"").localeCompare(String(b.name||""));});
    return rows.map(function(it){
      var qtyByStoreId={};var total=0;
      slots.forEach(function(sl){
        if(!sl.store) return;
        var so=getStoreOrder(sl.store.id);var q=so&&so.items?(so.items[it.code]||0):0;
        qtyByStoreId[sl.store.id]=q;total+=q;
      });
      return {code:it.code,name:it.name,qtyByStoreId:qtyByStoreId,total:total};
    });
  },[items,orders,slots,vt,manualOpenOrder,manualOpenSeq]);

  var startE=function(sid){
    var exOrder=getStoreOrder(sid)||{};
    var exItems=exOrder.items||{};var exNotes=exOrder.notes||{};
    var q={};var n={};items.forEach(function(it){q[it.code]=exItems[it.code]||0;n[it.code]=exNotes[it.code]||"";});
    sEQ(q);sENotes(n);sES(sid);
  };
  var persistEdit=async function(sid,nextQ,nextNotes,silent){
    if(!sid) return;
    try{
      setAutoSaving(true);
      var resp=await apiClient.orders.create({type:vt,items:nextQ,notes:nextNotes,status:"submitted",storeId:sid});
      var id=resp.orderId;var k=sid+"_"+dk;
      setOrders(function(p){var n=Object.assign({},p);n[k]=Object.assign({},p[k]||{},{id:id,items:Object.assign({},nextQ),notes:Object.assign({},nextNotes),status:(p[k]||{}).status||"submitted",store:sid,type:vt,date:(p[k]||{}).date||new Date().toISOString()});return n;});
      if(!silent) toast("Updated");
    }catch(e){toast(e.message,true);}finally{setAutoSaving(false);}
  };
  var scheduleAutoSave=function(nextQ,nextNotes){
    if(!eSt) return;
    if(autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current=setTimeout(function(){autoSaveTimerRef.current=null;persistEdit(eSt,nextQ,nextNotes,true);},450);
  };
  var cancelE=function(){
    if(autoSaveTimerRef.current){clearTimeout(autoSaveTimerRef.current);autoSaveTimerRef.current=null;if(eSt) persistEdit(eSt,eQ,eNotes,true);}
    sES(null);sEQ({});sENotes({});
  };
  useEffect(function(){return function(){if(autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);};},[]);

  var latestTypeLog=useMemo(function(){
    var filtered=(logs||[]).filter(function(l){return l&&l.type===vt&&String(l.week||"")===String(logWeekKey||"");});
    filtered.sort(function(a,b){return new Date(b.sentAt||0)-new Date(a.sentAt||0);});
    return filtered[0]||null;
  },[logs,vt,logWeekKey]);
  var isCompletedLocked=!!(latestTypeLog&&latestTypeLog.finished===true);
  useEffect(function(){ if(isCompletedLocked&&step!==3){ setStep(3); } },[isCompletedLocked]);
  var parsePct=function(v){
    var s=String(v||"").replace(/[^0-9]/g,"");
    var n=parseInt(s,10);
    if(Number.isNaN(n)) return 0;
    return Math.max(0,Math.min(100,n));
  };
  var defaultSplitMap=function(ids){
    var m={};if(!ids.length) return m;
    if(ids.length===1){m[ids[0]]=100;return m;}
    var even=Math.floor(100/ids.length);var used=0;
    for(var i=0;i<ids.length-1;i++){m[ids[i]]=even;used+=even;}
    m[ids[ids.length-1]]=Math.max(0,100-used);
    return m;
  };
  var normalizeSplit=function(ids,inputMap){
    var out={};if(!ids.length) return out;
    var sum=0;
    for(var i=0;i<ids.length-1;i++){
      var sid=ids[i];
      var v=Math.max(0,Math.min(100,Number((inputMap||{})[sid])||0));
      out[sid]=v;sum+=v;
    }
    out[ids[ids.length-1]]=Math.max(0,100-sum);
    return out;
  };
  var beginSplit=function(){
    if(isCompletedLocked){toast("This consolidated order is completed and locked. Reopen from Order Monitor to edit.",true);return;}
    if(eSt){toast("Finish current store edit first",true);return;}
    var snap=baseRows.map(function(r){return {code:r.code,name:r.name,total:r.total,qtyByStoreId:Object.assign({},r.qtyByStoreId)};});
    var ids=supplierList.slice(0,2).map(function(s){return s.id;});
    if(ids.length<2){toast("Add at least two suppliers first",true);return;}
    setSavedRows(snap);
    setSplitSupplierIds(ids);
    setGlobalSplit(defaultSplitMap(ids));
    setItemOverrides({});
    setStep(2);
  };
  var toggleSplitSupplier=function(sid,checked){
    setSplitSupplierIds(function(prev){
      var has=prev.indexOf(sid)>=0;
      if(checked&&!has) return prev.concat([sid]);
      if(!checked&&has) return prev.filter(function(x){return x!==sid;});
      return prev;
    });
  };
  useEffect(function(){
    if(!splitSupplierIds.length) return;
    setGlobalSplit(function(prev){return normalizeSplit(splitSupplierIds,Object.assign({},defaultSplitMap(splitSupplierIds),prev));});
  },[splitSupplierIds]);

  var splitRowsBySupplier=useMemo(function(){
    var out={};if(!splitSupplierIds.length||!savedRows.length) return out;
    splitSupplierIds.forEach(function(sid){out[sid]=[];});
    savedRows.forEach(function(r){
      var pcts=normalizeSplit(splitSupplierIds,(itemOverrides&&itemOverrides[r.code])||globalSplit);
      var perSupplier={};splitSupplierIds.forEach(function(sid){perSupplier[sid]={};});
      slots.forEach(function(sl){
        if(!sl.store) return;
        var base=Number(r.qtyByStoreId&&r.qtyByStoreId[sl.store.id])||0;
        var used=0;
        splitSupplierIds.forEach(function(sid,idx){
          var q=0;
          if(idx===splitSupplierIds.length-1) q=Math.max(0,base-used);
          else {q=Math.round(base*((pcts[sid]||0)/100));used+=q;}
          perSupplier[sid][sl.store.id]=q;
        });
      });
      splitSupplierIds.forEach(function(sid){
        var total=0;Object.values(perSupplier[sid]).forEach(function(v){total+=Number(v)||0;});
        out[sid].push({code:r.code,name:r.name,qtyByStoreId:perSupplier[sid],total:total});
      });
    });
    return out;
  },[savedRows,splitSupplierIds,globalSplit,itemOverrides,slots]);

  var sendSplitEmail=async function(sid){
    var supplier=supplierById[sid]||null;
    var rows=splitRowsBySupplier[sid]||[];
    if(isCompletedLocked){toast("This consolidated order is completed and locked. Reopen from Order Monitor to edit.",true);return;}
    if(!supplier||!supplier.email){toast("Supplier email missing",true);return;}
    sEMailing(true);
    try{
      var payloadRows=rows.map(function(r){return {itemCode:r.code,itemName:r.name,qtyByStoreId:r.qtyByStoreId};});
      var nextSent=Object.assign({},sentSplitBySupplier);nextSent[sid]=true;
      var isFinal=splitSupplierIds.length>0 && splitSupplierIds.every(function(id){return nextSent[id];});
      var emailResp=await apiClient.orders.emailConsolidated(vt,supplier.email,supplier.name,reopenedFromId,{rows:payloadRows,finished:isFinal});
      toast("Email sent to "+supplier.email);
      if(emailResp&&emailResp.supplierOrder){
        setLogs(function(l){return [emailResp.supplierOrder].concat(l||[]).sort(function(a,b){return new Date(b.sentAt||0)-new Date(a.sentAt||0);});});
      }
      setSentSplitBySupplier(nextSent);
      if(setReopenedFromId) setReopenedFromId(null);
    }catch(e){toast(e.message,true);}finally{sEMailing(false);}
  };

  var tCellBase={border:"1px solid #B9BEC9",padding:"6px 8px",fontFamily:"Calibri,'Segoe UI',Arial,sans-serif",fontSize:11,color:"#111827",lineHeight:1.2,height:26};
  var tHeadTop=Object.assign({},tCellBase,{fontWeight:700,background:"#FFFFFF",textAlign:"left"});
  var tHeadTopCenter=Object.assign({},tHeadTop,{textAlign:"center"});
  var tHeadSub=Object.assign({},tCellBase,{fontWeight:700,background:"#D9D9D9",textAlign:"center",textTransform:"uppercase"});
  var tProductCell=Object.assign({},tCellBase,{fontWeight:600,background:"#FFFFFF",textAlign:"left"});
  var tQtyCell=Object.assign({},tCellBase,{background:"#FFFFFF",textAlign:"center"});
  var onlyOpen=(consolidatedType||aot||vt);

  return(<div>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:6,marginBottom:14}}>
      <div style={S.tabs}>{["A","B","C"].map(function(t){
        var lockedBySchedule=!manualOpenOrder;var locked=t!==onlyOpen||lockedBySchedule;
        var tip=lockedBySchedule?"Locked while using schedule. Use manual override (or reopen/resend flow) to open a consolidated order.":(t!==onlyOpen?("Locked. Only Order "+onlyOpen+" is open right now."):"");
        return <button key={t} disabled={locked} title={tip} style={Object.assign({},S.tab,vt===t?S.tA:S.tI,locked?{opacity:.45,cursor:"not-allowed"}:{})} onClick={function(){if(locked)return;sVt(t);if(setConsolidatedType)setConsolidatedType(t);cancelE();}}>{"Order "+t}</button>;
      })}</div>
      <div style={{display:"flex",gap:6}}><span style={Object.assign({},S.bg,step===1?S.bgG:S.bgY)}>1. Consolidated</span><span style={Object.assign({},S.bg,step===2?S.bgG:S.bgY)}>2. Split</span><span style={Object.assign({},S.bg,step===3?S.bgG:S.bgY)}>3. Preview/Send</span></div>
    </div>
    {(consolidatedType||aot)&&<div style={S.nI}>{!manualOpenOrder?"Schedule mode active: consolidated tabs are locked.":("Only Order "+(consolidatedType||aot)+" is open right now. Other consolidated orders are locked until their scheduled day or manual override.")}</div>}
    {isCompletedLocked&&<div style={S.nG}>Consolidated Order {vt} is completed and locked. Reopen from Order Monitor to edit/send again.</div>}
    {reopenedFromId&&<div style={S.nP}>Resend mode active. This send will be stored as a reopened resend history entry.</div>}
    {eSt&&<div style={S.nI}>Editing: {(stores.find(function(s){return s.id===eSt;})||{}).name}</div>}

    {step===1&&(<div style={Object.assign({},S.card,{padding:0})}>
      <div style={{padding:"12px 14px",borderBottom:"1px solid rgba(148,163,184,.24)",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
        <div><div style={S.t}>Consolidated Order {vt}</div><div style={S.d}>Review store quantities, then save and continue to supplier split.</div></div>
        <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap",justifyContent:"flex-end"}}>
          {eSt&&<button style={Object.assign({},S.b,S.bS)} onClick={cancelE}>Cancel</button>}
          {eSt&&autoSaving&&<span style={Object.assign({},S.bg,S.bgY)}>Auto-saving...</span>}
          <button style={Object.assign({},S.b,S.bP)} onClick={beginSplit} disabled={isCompletedLocked}>Save & Continue</button>
        </div>
      </div>
      <div style={Object.assign({},S.tw,{border:"none",borderRadius:0})}><table style={Object.assign({},S.tbl,{borderCollapse:"collapse",tableLayout:"fixed"})}><thead>
        <tr><th style={Object.assign({},tHeadTop,{minWidth:240})}>{("Date: "+new Date().toLocaleDateString())}</th>{slots.map(function(sl){return <th key={sl.apna} style={Object.assign({},tHeadTopCenter,{minWidth:120})}>{sl.apna+vt}</th>;})}</tr>
        <tr><th style={Object.assign({},tHeadSub,{textAlign:"left"})}>PRODUCT</th>{slots.map(function(sl){return <th key={sl.apna+"_q"} style={Object.assign({},tHeadSub,{minWidth:120})}><div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:4}}><span>QUANTITY (case qty)</span>{sl.store&&<button disabled={isCompletedLocked} style={Object.assign({},S.eB,eSt===sl.store.id?{color:"#16A34A"}:{},isCompletedLocked?{opacity:.45,cursor:"not-allowed"}:{})} onClick={function(){if(isCompletedLocked)return;eSt===sl.store.id?cancelE():startE(sl.store.id);}}><Ic type="edit" size={11}/></button>}</div></th>;})}</tr>
      </thead><tbody>{baseRows.map(function(it){
        var qs=slots.map(function(sl){if(!sl.store)return 0;if(eSt===sl.store.id)return eQ[it.code]||0;return (it.qtyByStoreId&&it.qtyByStoreId[sl.store.id])||0;});
        return(<tr key={it.code}><td style={tProductCell}>{it.name}</td>{slots.map(function(sl,idx){var sid=sl.store&&sl.store.id;var isE=sid&&eSt===sid;return(<td key={sl.apna} style={Object.assign({},tQtyCell,isE?S.cE:{})}>{isE?<input style={S.ie} type="number" min="0" value={eQ[it.code]||0} onChange={function(e){var v=Math.max(0,parseInt(e.target.value)||0);sEQ(function(p){var n=Object.assign({},p);n[it.code]=v;scheduleAutoSave(n,eNotes);return n;});}} disabled={isCompletedLocked}/>:<span style={{fontFamily:"Calibri,'Segoe UI',Arial,sans-serif",fontSize:11,color:qs[idx]>0?"#0F172A":"#64748B"}}>{qs[idx]||""}</span>}</td>);})}</tr>);
      })}</tbody></table></div>
    </div>)}

    {step===2&&(<div style={S.card}>
      <div style={S.cH}><div><div style={S.t}>Split Order {vt} by Supplier</div><div style={S.d}>Set overall percentages and optional item-level overrides.</div></div></div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(220px,1fr))",gap:8,marginBottom:12}}>
        {supplierList.map(function(s){
          var checked=splitSupplierIds.indexOf(s.id)>=0;
          return <label key={s.id} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",border:"1px solid rgba(148,163,184,.3)",borderRadius:8,background:checked?"rgba(22,163,74,.08)":"rgba(255,255,255,.7)"}}><input type="checkbox" checked={checked} onChange={function(e){toggleSplitSupplier(s.id,e.target.checked);}}/><span style={{fontSize:12.5,fontWeight:600}}>{s.name}</span><span style={{fontSize:11,color:"#64748B"}}>{s.email}</span></label>;
        })}
      </div>
      {splitSupplierIds.length<2&&<div style={S.nP}>Select at least 2 suppliers to split this order.</div>}
      {splitSupplierIds.length>=2&&(<Fragment>
        <div style={Object.assign({},S.card,{padding:"10px 12px"})}>
          <div style={{fontSize:12,fontWeight:700,marginBottom:8}}>Overall Split %</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:8}}>
            {splitSupplierIds.map(function(sid,idx){
              var last=idx===splitSupplierIds.length-1;var p=normalizeSplit(splitSupplierIds,globalSplit)[sid]||0;
              return <div key={sid}><div style={S.lb}>{(supplierById[sid]||{}).name||sid}</div><input style={S.inp} type="text" inputMode="numeric" value={p} readOnly={last||isCompletedLocked} onChange={function(e){var v=parsePct(e.target.value);setGlobalSplit(function(prev){var n=Object.assign({},prev);n[sid]=v;return normalizeSplit(splitSupplierIds,n);});}}/></div>;
            })}
          </div>
        </div>
        <div style={Object.assign({},S.tw,{maxHeight:"46vh"})}><table style={S.tbl}><thead><tr><th style={S.th}>Product</th><th style={Object.assign({},S.th,{textAlign:"right"})}>Total</th>{splitSupplierIds.map(function(sid){return <th key={sid} style={Object.assign({},S.th,{textAlign:"center"})}>{(supplierById[sid]||{}).name||sid} %</th>;})}</tr></thead><tbody>
          {savedRows.map(function(r){
            var itemPct=normalizeSplit(splitSupplierIds,(itemOverrides&&itemOverrides[r.code])||globalSplit);
            return <tr key={r.code}><td style={S.td}>{r.name}</td><td style={Object.assign({},S.tm,{textAlign:"right"})}>{r.total||0}</td>{splitSupplierIds.map(function(sid,idx){var last=idx===splitSupplierIds.length-1;return <td key={sid} style={Object.assign({},S.td,{textAlign:"center"})}><input style={Object.assign({},S.inp,{width:80,textAlign:"center"})} type="text" inputMode="numeric" readOnly={last||isCompletedLocked} value={itemPct[sid]||0} onChange={function(e){var v=parsePct(e.target.value);setItemOverrides(function(prev){var cur=Object.assign({},prev[r.code]||{});cur[sid]=v;var n=Object.assign({},prev);n[r.code]=normalizeSplit(splitSupplierIds,cur);return n;});}}/></td>;})}</tr>;
          })}
        </tbody></table></div>
      </Fragment>)}
      <div style={S.mA}><button style={Object.assign({},S.b,S.bS)} onClick={function(){setStep(1);}}>Back</button><button style={Object.assign({},S.b,S.bP)} disabled={splitSupplierIds.length<2||isCompletedLocked} onClick={function(){setStep(3);}}>Save Split & Preview</button></div>
    </div>)}

    {step===3&&(<div style={S.card}>
      <div style={S.cH}><div><div style={S.t}>Supplier Preview & Send</div><div style={S.d}>Both split orders are shown side by side. You can still override product split percentages below.</div></div></div>
      <div style={Object.assign({},S.card,{padding:"10px 12px"})}>
        <div style={{fontSize:12,fontWeight:700,marginBottom:8}}>Further Product-Level Split Override</div>
        <div style={Object.assign({},S.tw,{maxHeight:"30vh"})}><table style={S.tbl}><thead><tr><th style={S.th}>Product</th>{splitSupplierIds.map(function(sid){return <th key={sid} style={Object.assign({},S.th,{textAlign:"center"})}>{(supplierById[sid]||{}).name||sid} %</th>;})}</tr></thead><tbody>
          {savedRows.map(function(r){
            var itemPct=normalizeSplit(splitSupplierIds,(itemOverrides&&itemOverrides[r.code])||globalSplit);
            return <tr key={r.code}><td style={S.td}>{r.name}</td>{splitSupplierIds.map(function(sid,idx){var last=idx===splitSupplierIds.length-1;return <td key={sid} style={Object.assign({},S.td,{textAlign:"center"})}><input style={Object.assign({},S.inp,{width:80,textAlign:"center"})} type="text" inputMode="numeric" readOnly={last||isCompletedLocked} value={itemPct[sid]||0} onChange={function(e){var v=parsePct(e.target.value);setItemOverrides(function(prev){var cur=Object.assign({},prev[r.code]||{});cur[sid]=v;var n=Object.assign({},prev);n[r.code]=normalizeSplit(splitSupplierIds,cur);return n;});}}/></td>;})}</tr>;
          })}
        </tbody></table></div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(480px,1fr))",gap:10}}>
        {splitSupplierIds.map(function(sid){
          var s=supplierById[sid]||{id:sid,name:sid,email:""};
          var rows=splitRowsBySupplier[sid]||[];
          var sent=!!sentSplitBySupplier[sid];
          return <div key={sid} style={Object.assign({},S.card,{marginBottom:0,padding:10})}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,marginBottom:8,flexWrap:"wrap"}}>
              <div><div style={S.t}>{s.name}</div><div style={S.d}>{s.email||"No email"}</div></div>
              <button style={Object.assign({},S.b,sent?S.bG:S.bP)} onClick={function(){sendSplitEmail(sid);}} disabled={eMailing||!s.email||isCompletedLocked||sent}>{sent?"Sent":"Send Supplier Order"}</button>
            </div>
            <div style={Object.assign({},S.tw,{maxHeight:"40vh",border:"1px solid rgba(148,163,184,.25)"})}><table style={Object.assign({},S.tbl,{borderCollapse:"collapse",tableLayout:"fixed"})}><thead>
              <tr><th style={Object.assign({},tHeadTop,{minWidth:240})}>{s.name}</th>{slots.map(function(sl){return <th key={sl.apna} style={Object.assign({},tHeadTopCenter,{minWidth:120})}>{sl.apna+vt}</th>;})}</tr>
              <tr><th style={Object.assign({},tHeadSub,{textAlign:"left"})}>PRODUCT</th>{slots.map(function(sl){return <th key={sl.apna+"_q"} style={Object.assign({},tHeadSub,{minWidth:120})}>QUANTITY (case qty)</th>;})}</tr>
            </thead><tbody>
              {rows.map(function(r){return <tr key={r.code}><td style={tProductCell}>{r.name}</td>{slots.map(function(sl){var q=sl.store?(r.qtyByStoreId&&r.qtyByStoreId[sl.store.id])||0:0;return <td key={sl.apna} style={tQtyCell}><span style={{fontFamily:"Calibri,'Segoe UI',Arial,sans-serif",fontSize:11,color:q>0?"#0F172A":"#64748B"}}>{q||""}</span></td>;})}</tr>;})}
            </tbody></table></div>
          </div>;
        })}
      </div>
      <div style={S.mA}><button style={Object.assign({},S.b,S.bS)} onClick={function(){setStep(2);}}>Back to Split</button></div>
    </div>)}
  </div>);
}
function SupplierOrders({orders,setOrders,items,aot,manualOpenOrder,manualOpenSeq,toast,stores,suppliers}){
  var _v=useState(aot||"A"),vt=_v[0],sVt=_v[1];
  var _sent=useState({}),sent=_sent[0],sSent=_sent[1];
  var _sending=useState({}),sending=_sending[0],sSending=_sending[1];
  var _hist=useState([]),history=_hist[0],setHistory=_hist[1];
  var dk=dateKey(vt,manualOpenOrder,manualOpenSeq);

  useEffect(function(){
    let cancelled=false;
    apiClient.supplierOrders.getAll().then(h=>{if(!cancelled) setHistory(h||[]);}).catch(()=>{});
    return ()=>{cancelled=true;};
  },[]);
  // Compute totals per item across all stores
  const itemList = Array.isArray(items) ? items : [];
  const supList = Array.isArray(suppliers) ? suppliers : [];
  var totals=useMemo(function(){var t={};itemList.forEach(function(it){var sum=0;stores.forEach(function(st){var k=st.id+"_"+dk;sum+=(orders[k]&&orders[k].items?orders[k].items[it.code]:0)||0;});if(sum>0)t[it.code]=sum;});return t;},[itemList,stores,orders,dk]);
  // Group by supplier
  var supplierGroups=useMemo(function(){return supList.map(function(sup){var supItems=itemList.filter(function(it){return (sup.items||[]).indexOf(it.code)>=0&&totals[it.code]>0;});return{supplier:sup,items:supItems};}).filter(function(g){return g.items.length>0;});},[supList,itemList,totals]);
  // Unassigned items
  var assigned={};supList.forEach(function(s){(s.items||[]).forEach(function(c){assigned[c]=true;});});
  var unassigned=itemList.filter(function(it){return totals[it.code]>0&&!assigned[it.code];});

  var sendEmail=function(sup,supItems){
    var subject="Purchase Order - Order "+vt+" - "+new Date().toLocaleDateString();
    var body="Dear "+sup.name+",\n\nPlease find our order details below:\n\n";
    supItems.forEach(function(it){body+=it.name+" ("+it.code+") - Qty: "+totals[it.code]+"\n";});
    body+="\nThank you.";
    var mailto="mailto:"+encodeURIComponent(sup.email)+"?subject="+encodeURIComponent(subject)+"&body="+encodeURIComponent(body);
    var a=document.createElement("a");a.href=mailto;a.click();
    sSent(function(p){var n=Object.assign({},p);n[sup.id+"_"+vt]=true;return n;});
    toast("Opening email for "+sup.name+" ("+sup.email+")");
  };
  var processOrder=async function(){
    try{
      var tasks=[];
      stores.forEach(function(st){var k=st.id+"_"+dk;var o=orders[k];if(o&&o.id&&(o.status==="submitted"||o.status==="draft")){tasks.push(apiClient.orders.process(o.id));}});
      await Promise.all(tasks);
      setOrders(function(prev){
        var n=Object.assign({},prev);
        stores.forEach(function(st){var k=st.id+"_"+dk;if(n[k]&&(n[k].status==="submitted"||n[k].status==="draft")){n[k]=Object.assign({},n[k],{status:"processed"});}});
        return n;
      });
      toast("Order "+vt+" marked processed for all stores");
    }catch(e){toast(e.message,true);}  };
  var allSent=supplierGroups.every(function(g){return sent[g.supplier.id+"_"+vt];});

  return(<div>
    {history.length>0&&(<div style={Object.assign({},S.card,{marginBottom:12})}>
      <div style={S.cH}><div><div style={S.t}>Sent Supplier Orders</div><div style={S.d}>{history.length} records</div></div></div>
      <div style={S.tw}><table style={S.tbl}><thead><tr><th style={S.th}>Date</th><th style={S.th}>Type</th><th style={S.th}>Supplier</th><th style={S.th}>Email</th><th style={S.th}>Week</th></tr></thead><tbody>
        {history.map(function(r){return(<tr key={r._id||r.sentAt}><td style={S.tm}>{new Date(r.sentAt).toLocaleString()}</td><td style={S.td}>{r.type}</td><td style={S.td}>{r.supplierName}</td><td style={S.tm}>{r.email}</td><td style={S.tm}>{r.week}</td></tr>);})}
      </tbody></table></div></div>)}
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:6,marginBottom:14}}>
      <div style={S.tabs}>{["A","B","C"].map(function(t){return <button key={t} style={Object.assign({},S.tab,vt===t?S.tA:S.tI)} onClick={function(){sVt(t);}}>Order {t}</button>;})}</div>
      {allSent&&supplierGroups.length>0&&<button style={Object.assign({},S.b,S.bG)} onClick={processOrder}>Mark All Processed</button>}
    </div>
    <div style={S.nI}>Split Order {vt} by supplier. Send emails, then mark as processed.</div>
    {supplierGroups.length===0&&<div style={S.card}><div style={{textAlign:"center",padding:30,color:"#6B7186"}}>No order data for Order {vt}. Submit orders first.</div></div>}
    {supplierGroups.map(function(g){
      var isSent=sent[g.supplier.id+"_"+vt];
      return(<div key={g.supplier.id} style={Object.assign({},S.card,{border:isSent?"1px solid rgba(52,211,153,0.3)":"1px solid rgba(148,163,184,.24)"})}>
        <div style={S.cH}>
          <div><div style={S.t}>{g.supplier.name}</div><div style={S.d}>{g.supplier.email} | {g.supplier.phone}</div></div>
          <div style={{display:"flex",gap:5,alignItems:"center"}}>
            {isSent?<span style={Object.assign({},S.bg,S.bgG)}>Email Sent</span>
            :<button style={Object.assign({},S.b,S.bP)} onClick={function(){sendEmail(g.supplier,g.items);}}><Ic type="mail" size={13}/>Send Email</button>}
          </div>
        </div>
        <div style={S.tw}><table style={S.tbl}><thead><tr><th style={S.th}>Code</th><th style={S.th}>Item</th><th style={S.th}>Category</th><th style={S.th}>Unit</th><th style={Object.assign({},S.th,{textAlign:"center"})}>Total Qty</th>
          {stores.map(function(st){return <th key={st.id} style={Object.assign({},S.th,{textAlign:"center",fontSize:9})}>{st.name.split(" ")[0]}</th>;})}</tr></thead>
          <tbody>{g.items.map(function(it){return(<tr key={it.code}><td style={S.tm}>{it.code}</td><td style={Object.assign({},S.td,{fontWeight:500})}>{it.name}</td><td style={Object.assign({},S.td,{color:"#64748B"})}>{it.category}</td><td style={Object.assign({},S.td,{color:"#64748B"})}>{it.unit}</td>
            <td style={Object.assign({},S.td,{textAlign:"center",fontFamily:"monospace",fontWeight:700,color:"#166534"})}>{totals[it.code]}</td>
            {stores.map(function(st){var k=st.id+"_"+dk;var q=orders[k]&&orders[k].items?orders[k].items[it.code]||0:0;return <td key={st.id} style={Object.assign({},S.td,{textAlign:"center",fontFamily:"monospace",fontSize:11,color:q>0?"#0F172A":"#64748B"})}>{q}</td>;})}
          </tr>);})}</tbody></table></div>
      </div>);
    })}
    {unassigned.length>0&&(<div style={Object.assign({},S.card,{borderColor:"rgba(248,113,113,0.3)"})}><div style={S.cH}><div><div style={Object.assign({},S.t,{color:"#F87171"})}>Unassigned Items</div><div style={S.d}>These items are not mapped to any supplier.</div></div></div>
      <div style={S.tw}><table style={S.tbl}><thead><tr><th style={S.th}>Code</th><th style={S.th}>Item</th><th style={Object.assign({},S.th,{textAlign:"center"})}>Total Qty</th></tr></thead><tbody>
        {unassigned.map(function(it){return <tr key={it.code}><td style={S.tm}>{it.code}</td><td style={S.td}>{it.name}</td><td style={Object.assign({},S.td,{textAlign:"center",fontFamily:"monospace",fontWeight:700})}>{totals[it.code]}</td></tr>;})}</tbody></table></div></div>)}
  </div>);
}

/* ═══ ITEM MASTER (no category rows) ═══ */
function ItemMaster({items,setItems,toast}){
  var _a=useState(false),shA=_a[0],sA=_a[1];var _u=useState(false),shU=_u[0],sU=_u[1];
  var _n=useState({code:"",name:"",category:"",unit:""}),nI=_n[0],sNI=_n[1];
  var _s=useState(""),sr=_s[0],sSr=_s[1];var _c=useState(null),csv=_c[0],sC=_c[1];var _m=useState("merge"),md=_m[0],sMd=_m[1];var fR=useRef(null);
  var fl=items.filter(function(it){var q=sr.toLowerCase();return it.name.toLowerCase().indexOf(q)>=0||it.code.toLowerCase().indexOf(q)>=0||(it.category||"").toLowerCase().indexOf(q)>=0;});
  var sorted=useMemo(function(){return sortItems(fl);},[fl]);
  var add=async function(){
      if(!nI.code||!nI.name){toast("Code and Name required",true);return;}
      if(items.find(function(i){return i.code===nI.code;})){toast("Code exists",true);return;}
      try{
        await apiClient.items.create(nI);
        // reload
        const all = await apiClient.items.getAll();
        setItems(sortItems(all));
        sNI({code:"",name:"",category:"",unit:""});sA(false);toast("Item added");
      }catch(e){toast(e.message,true);}    };
  var rm=async function(c){
      try{
        await apiClient.items.delete(c);
        const all = await apiClient.items.getAll();
        setItems(sortItems(all));
        toast("Removed");
      }catch(e){toast(e.message,true);}    };
  var hF=function(e){var f=e.target.files&&e.target.files[0];if(!f)return;var name=f.name||"";var ext=name.split(".").pop().toLowerCase();
    if(ext==="csv"||ext==="txt"){
      var r=new FileReader();
      r.onload=function(ev){var p=parseCSV(ev.target.result);if(!p.length){toast("Could not parse CSV",true);return;}sC(p);sU(true);};
      r.readAsText(f);
    }else if(ext==="xls"||ext==="xlsx"){
      var r=new FileReader();
      r.onload=function(ev){
        try{
          var data=new Uint8Array(ev.target.result);
          var wb=XLSX.read(data,{type:'array'});
          var ws=wb.Sheets[wb.SheetNames[0]];
          if(!ws){toast("No sheets found in Excel file",true);return;}
          var rows=XLSX.utils.sheet_to_json(ws,{header:1,raw:false});
          if(rows.length<2){toast("Excel file has no data",true);return;}
          var hdr=rows[0].map(function(h){return String(h).trim().toLowerCase().replace(/[^a-z0-9]/g,"");});
          var ci=hdr.findIndex(function(h){return h.includes("code")||h==="sku";});
          var ni=hdr.findIndex(function(h){return h.includes("name")||h==="item"||h==="description";});
          var cti=hdr.findIndex(function(h){return h.includes("cat")||h==="group";});
          var ui=hdr.findIndex(function(h){return h.includes("unit")||h==="uom";});
          if(ni===-1){toast("Excel file missing 'name' column",true);return;}
          var parsed=[];
          for(var i=1;i<rows.length;i++){
            var cols=rows[i];
            if(!cols||!cols[ni]) continue;
            parsed.push({
              code:ci>=0&&cols[ci]?cols[ci]:"CSV"+String(i).padStart(4,"0"),
              name:cols[ni],
              category:cti>=0?(cols[cti]||""):"",
              unit:ui>=0?(cols[ui]||""):"",
            });
          }
          if(parsed.length===0){toast("No valid item rows in Excel file",true);return;}
          sC(parsed);sU(true);
        }catch(err){console.error('Excel parse error',err);toast("Could not parse Excel file",true);}      };
      r.readAsArrayBuffer(f);
    }else{
      toast("Unsupported file type",true);
    }
    e.target.value="";};
  var cfU=async function(){if(!csv)return;try{await apiClient.items.bulkImport(csv,md);const all=await apiClient.items.getAll();setItems(sortItems(all));toast(md==="replace"?"Replaced "+csv.length+" items":"Merged "+csv.length+" items");}catch(e){toast(e.message,true);}sC(null);sU(false);};
  return(<div><div style={S.card}>
    <div style={S.cH}>
      <div><div style={S.t}>Item Master</div><div style={S.d}>{items.length} items</div></div>
      <div style={{display:"flex",gap:5,alignItems:"center",flexWrap:"wrap"}}>
        <div style={S.sB}><Ic type="search" size={13}/><input style={S.sI} placeholder="Search..." value={sr} onChange={function(e){sSr(e.target.value);}}/></div>
        <button style={Object.assign({},S.b,S.bS)} onClick={function(){fR.current&&fR.current.click();}}>Upload CSV/Excel</button>
        <button style={Object.assign({},S.b,S.bP)} onClick={function(){sA(true);}}>+ Add</button>
        <input ref={fR} type="file" accept=".csv,.txt,.xls,.xlsx" style={{display:"none"}} onChange={hF}/>
      </div>
    </div>
    <div style={{display:"flex",justifyContent:"center"}}>
      <div style={Object.assign({},S.tw,{width:"100%",maxWidth:1120})}><table style={S.tbl}><thead><tr><th style={S.th}>Code</th><th style={S.th}>Name</th><th style={S.th}>Category</th><th style={S.th}>Unit</th><th style={Object.assign({},S.th,{width:40})}></th></tr></thead>
        <tbody>{sorted.map(function(it){return(<tr key={it.code}><td style={S.tm}>{it.code}</td><td style={Object.assign({},S.td,{fontWeight:500})}>{it.name}</td><td style={Object.assign({},S.td,{color:"#64748B"})}>{it.category||"-"}</td><td style={Object.assign({},S.td,{color:"#64748B"})}>{it.unit||"-"}</td><td style={S.td}><button style={Object.assign({},S.b,S.bD,{padding:"2px 6px",fontSize:10})} onClick={function(){rm(it.code);}}>Del</button></td></tr>);})}{sorted.length===0&&<tr><td colSpan={5} style={Object.assign({},S.td,{textAlign:"center",padding:24,color:"#6B7186"})}>No items</td></tr>}</tbody></table></div>
    </div>
    </div>
    {shA&&(<div style={S.ov} onClick={function(){sA(false);}}><div style={S.mo} onClick={function(e){e.stopPropagation();}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:12}}>Add New Item</div>
      <div style={S.fg}><div style={S.lb}>Code *</div><input style={S.inp} value={nI.code} onChange={function(e){sNI(Object.assign({},nI,{code:e.target.value}));}}/></div>
      <div style={S.fg}><div style={S.lb}>Name *</div><input style={S.inp} value={nI.name} onChange={function(e){sNI(Object.assign({},nI,{name:e.target.value}));}}/></div>
      <div style={S.fr}><div style={Object.assign({},S.fg,{flex:1})}><div style={S.lb}>Category</div><input style={S.inp} value={nI.category} onChange={function(e){sNI(Object.assign({},nI,{category:e.target.value}));}}/></div>
        <div style={Object.assign({},S.fg,{flex:1})}><div style={S.lb}>Unit</div><input style={S.inp} value={nI.unit} onChange={function(e){sNI(Object.assign({},nI,{unit:e.target.value}));}}/></div></div>
      <div style={S.mA}><button style={Object.assign({},S.b,S.bS)} onClick={function(){sA(false);}}>Cancel</button><button style={Object.assign({},S.b,S.bP)} onClick={add}>Add</button></div></div></div>)}
    {shU&&csv&&(<div style={S.ov} onClick={function(){sU(false);sC(null);}}><div style={Object.assign({},S.mo,S.mW)} onClick={function(e){e.stopPropagation();}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:12}}>Upload CSV - {csv.length} items found</div>
      <div style={S.fg}><div style={S.lb}>Mode</div><select style={S.inp} value={md} onChange={function(e){sMd(e.target.value);}}><option value="merge">Merge</option><option value="replace">Replace</option></select></div>
      <div style={{fontSize:11,color:"#64748B",marginBottom:6}}>Preview (first 8):</div>
      <div style={Object.assign({},S.tw,{maxHeight:180})}><table style={S.tbl}><thead><tr><th style={S.th}>Code</th><th style={S.th}>Name</th><th style={S.th}>Category</th><th style={S.th}>Unit</th></tr></thead><tbody>
        {csv.slice(0,8).map(function(it,i){return <tr key={i}><td style={S.tm}>{it.code}</td><td style={S.td}>{it.name}</td><td style={S.td}>{it.category||"-"}</td><td style={S.td}>{it.unit||"-"}</td></tr>;})}</tbody></table></div>
      <div style={S.mA}><button style={Object.assign({},S.b,S.bS)} onClick={function(){sU(false);sC(null);}}>Cancel</button><button style={Object.assign({},S.b,S.bP)} onClick={cfU}>Confirm</button></div></div></div>)}
  </div>);
}

/* ═══ USER MANAGEMENT (with phone) ═══ */
function UserMgmt({users,setUsers,toast,stores}){
  var _a=useState(false),shA=_a[0],sA=_a[1];
  var _n=useState({username:"",password:"",name:"",phone:"",role:"manager",storeId:stores[0]?stores[0].id:"",active:true}),nu=_n[0],sN=_n[1];
  var _cs=useState(""),customStore=_cs[0],setCustomStore=_cs[1];
  var _osm=useState(false),otherStoreMode=_osm[0],setOtherStoreMode=_osm[1];
  var _r=useState(null),rP=_r[0],sRP=_r[1];var _pw=useState(""),nPw=_pw[0],sNP=_pw[1];
  var _eu=useState(null),editUserId=_eu[0],setEditUserId=_eu[1];
  var _ef=useState({username:"",name:"",phone:"",role:"manager",storeId:"",active:true}),editF=_ef[0],setEditF=_ef[1];
  var _ecs=useState(""),editCustomStore=_ecs[0],setEditCustomStore=_ecs[1];
  var _eosm=useState(false),editOtherStoreMode=_eosm[0],setEditOtherStoreMode=_eosm[1];
  var add=async function(){
      var resolvedStoreId=otherStoreMode?customStore.trim():nu.storeId;
      if(!nu.username||!nu.password||!nu.name||!nu.phone){toast("All fields including phone required",true);return;}
      if(nu.role==="manager"&&!resolvedStoreId){toast("Store is required for manager",true);return;}
      if(users.find(function(u){return u.username===nu.username;})){toast("Username exists",true);return;}
      try{
        await apiClient.users.create(Object.assign({},nu,{storeId:resolvedStoreId||null}));
        const all=await apiClient.users.getAll();
        setUsers(all);
        sN({username:"",password:"",name:"",phone:"",role:"manager",storeId:stores[0]?stores[0].id:"",active:true});
        setCustomStore("");
        setOtherStoreMode(false);
        sA(false);
        toast("User created");
      }catch(e){toast(e.message,true);}    };
  var toggle=async function(un){
      try{
        await apiClient.users.toggle(un);
        const all=await apiClient.users.getAll();
        setUsers(all);
        toast("Updated");
      }catch(e){toast(e.message,true);}    };
  var doReset=async function(){
      if(nPw.length<6){toast("Min 6 chars",true);return;}
      try{
        await apiClient.users.resetPassword(rP,nPw);
        const all=await apiClient.users.getAll();
        setUsers(all);
        sRP(null);sNP("");
        toast("Password reset");
      }catch(e){toast(e.message,true);}    };
  var openEdit=function(u){
      setEditUserId(u.id||u.username);
      setEditF({username:u.username||"",name:u.name||"",phone:u.phone||"",role:u.role||"manager",storeId:u.storeId||"",active:!!u.active});
      var known=stores.some(function(s){return s.id===(u.storeId||"");});
      setEditOtherStoreMode(!!(u.storeId&&!known));
      setEditCustomStore(known?"":(u.storeId||""));
    };
  var saveEdit=async function(){
      if(!editUserId) return;
      var resolvedStoreId=editOtherStoreMode?editCustomStore.trim():editF.storeId;
      if(!editF.username||!editF.name||!editF.phone){toast("Name, username and phone are required",true);return;}
      if(editF.role==="manager"&&!resolvedStoreId){toast("Store is required for manager",true);return;}
      try{
        await apiClient.users.update(editUserId, Object.assign({},editF,{storeId:resolvedStoreId||null}));
        const all=await apiClient.users.getAll();
        setUsers(all);
        setEditUserId(null);
        setEditCustomStore("");
        setEditOtherStoreMode(false);
        toast("User updated");
      }catch(e){toast(e.message,true);}    };
  var removeUser=async function(userId){
      try{
        if(!window.confirm("Delete this user?")) return;
        await apiClient.users.delete(userId);
        const all=await apiClient.users.getAll();
        setUsers(all);
        toast("User deleted");
      }catch(e){toast(e.message,true);}    };
  return(<div>
    <div style={S.card}><div style={S.cH}><div><div style={S.t}>Users</div><div style={S.d}>{users.length} total</div></div><button style={Object.assign({},S.b,S.bP)} onClick={function(){sA(true);}}>+ Add</button></div>
    <div style={S.tw}><table style={S.tbl}><thead><tr><th style={S.th}>Name</th><th style={S.th}>Username</th><th style={S.th}>Phone</th><th style={S.th}>Role</th><th style={S.th}>Store</th><th style={S.th}>Status</th><th style={S.th}>Actions</th></tr></thead><tbody>
      {users.map(function(u){var sn=u.storeId?((stores.find(function(s){return s.id===u.storeId;})||{}).name||u.storeId):"-";return(<tr key={u.username}>
        <td style={Object.assign({},S.td,{fontWeight:500})}>{u.name}</td><td style={S.tm}>{u.username}</td><td style={S.tm}>{u.phone||"-"}</td>
        <td style={S.td}><span style={Object.assign({},S.bg,u.role==="admin"?S.bgB:S.bgG)}>{u.role}</span></td><td style={S.td}>{sn}</td>
        <td style={S.td}><span style={Object.assign({},S.bg,u.active?S.bgG:S.bgR)}>{u.active?"Active":"Off"}</span></td>
        <td style={S.td}><div style={{display:"flex",gap:3}}>
          <button style={Object.assign({},S.b,S.bS,{padding:"2px 6px",fontSize:10})} onClick={function(){toggle(u.id||u.username);}}>{u.active?"Disable":"Enable"}</button>
          <button style={Object.assign({},S.b,S.bS,{padding:"2px 6px",fontSize:10})} onClick={function(){openEdit(u);}}>Edit</button>
          <button style={Object.assign({},S.b,S.bS,{padding:"2px 6px",fontSize:10})} onClick={function(){sRP(u.id||u.username);sNP("");}}>Reset PW</button>
          <button style={Object.assign({},S.b,S.bD,{padding:"2px 6px",fontSize:10})} onClick={function(){removeUser(u.id||u.username);}}>Delete</button></div></td></tr>);})}</tbody></table></div></div>
    {shA&&(<div style={S.ov} onClick={function(){sA(false);}}><div style={S.mo} onClick={function(e){e.stopPropagation();}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:12}}>Create User</div>
      <div style={S.fg}><div style={S.lb}>Name *</div><input style={S.inp} value={nu.name} onChange={function(e){sN(Object.assign({},nu,{name:e.target.value}));}}/></div>
      <div style={S.fr}><div style={Object.assign({},S.fg,{flex:1})}><div style={S.lb}>Username *</div><input style={S.inp} value={nu.username} onChange={function(e){sN(Object.assign({},nu,{username:e.target.value}));}}/></div>
        <div style={Object.assign({},S.fg,{flex:1})}><div style={S.lb}>Password *</div><input style={S.inp} type="password" value={nu.password} onChange={function(e){sN(Object.assign({},nu,{password:e.target.value}));}}/></div></div>
      <div style={S.fr}><div style={Object.assign({},S.fg,{flex:1})}><div style={S.lb}>Phone *</div><input style={S.inp} value={nu.phone} onChange={function(e){sN(Object.assign({},nu,{phone:e.target.value}));}} placeholder="555-0100"/></div>
        <div style={Object.assign({},S.fg,{flex:1})}><div style={S.lb}>Role</div><select style={S.inp} value={nu.role} onChange={function(e){sN(Object.assign({},nu,{role:e.target.value}));}}><option value="manager">Manager</option><option value="admin">Admin</option></select></div></div>
      <div style={S.fg}><div style={S.lb}>Store</div><select style={S.inp} value={otherStoreMode?"__other__":(nu.storeId||"")} onChange={function(e){
        if(e.target.value==="__other__"){setOtherStoreMode(true);}
        else{setOtherStoreMode(false);sN(Object.assign({},nu,{storeId:e.target.value}));}
      }}><option value="">Select Store</option>{stores.map(function(s){return <option key={s.id} value={s.id}>{s.name}</option>;})}<option value="__other__">Other</option></select></div>
      {otherStoreMode&&<div style={S.fg}><div style={S.lb}>Other Store Type *</div><input style={S.inp} value={customStore} onChange={function(e){setCustomStore(e.target.value);}} placeholder="Warehouse"/></div>}
      <div style={S.mA}><button style={Object.assign({},S.b,S.bS)} onClick={function(){sA(false);}}>Cancel</button><button style={Object.assign({},S.b,S.bP)} onClick={add}>Create</button></div></div></div>)}
    {rP&&(<div style={S.ov} onClick={function(){sRP(null);}}><div style={S.mo} onClick={function(e){e.stopPropagation();}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:12}}>Reset Password - {rP}</div>
      <div style={S.fg}><div style={S.lb}>New Password (min 6)</div><input style={S.inp} type="password" value={nPw} onChange={function(e){sNP(e.target.value);}}/></div>
      <div style={S.mA}><button style={Object.assign({},S.b,S.bS)} onClick={function(){sRP(null);}}>Cancel</button><button style={Object.assign({},S.b,S.bP)} onClick={doReset}>Reset</button></div></div></div>)}
    {editUserId&&(<div style={S.ov} onClick={function(){setEditUserId(null);}}><div style={S.mo} onClick={function(e){e.stopPropagation();}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:12}}>Edit User</div>
      <div style={S.fg}><div style={S.lb}>Name *</div><input style={S.inp} value={editF.name} onChange={function(e){setEditF(Object.assign({},editF,{name:e.target.value}));}}/></div>
      <div style={S.fg}><div style={S.lb}>Username *</div><input style={S.inp} value={editF.username} onChange={function(e){setEditF(Object.assign({},editF,{username:e.target.value}));}}/></div>
      <div style={S.fg}><div style={S.lb}>Phone *</div><input style={S.inp} value={editF.phone} onChange={function(e){setEditF(Object.assign({},editF,{phone:e.target.value}));}}/></div>
      <div style={S.fr}><div style={Object.assign({},S.fg,{flex:1})}><div style={S.lb}>Role</div><select style={S.inp} value={editF.role} onChange={function(e){setEditF(Object.assign({},editF,{role:e.target.value}));}}><option value="manager">Manager</option><option value="admin">Admin</option></select></div>
      <div style={Object.assign({},S.fg,{flex:1})}><div style={S.lb}>Store</div><select style={S.inp} value={editOtherStoreMode?"__other__":(editF.storeId||"")} onChange={function(e){
        if(e.target.value==="__other__"){setEditOtherStoreMode(true);}
        else{setEditOtherStoreMode(false);setEditF(Object.assign({},editF,{storeId:e.target.value}));}
      }}><option value="">No Store</option>{stores.map(function(s){return <option key={s.id} value={s.id}>{s.name}</option>;})}<option value="__other__">Other</option></select></div></div>
      {editOtherStoreMode&&<div style={S.fg}><div style={S.lb}>Other Store Type *</div><input style={S.inp} value={editCustomStore} onChange={function(e){setEditCustomStore(e.target.value);}} placeholder="Warehouse"/></div>}
      <div style={S.fg}><label style={{display:"flex",alignItems:"center",gap:8,cursor:"pointer"}}><input type="checkbox" checked={!!editF.active} onChange={function(e){setEditF(Object.assign({},editF,{active:e.target.checked}));}}/><span style={{fontSize:12}}>Active user</span></label></div>
      <div style={S.mA}><button style={Object.assign({},S.b,S.bS)} onClick={function(){setEditUserId(null);}}>Cancel</button><button style={Object.assign({},S.b,S.bP)} onClick={saveEdit}>Save</button></div></div></div>)}
  </div>);
}

/* ═══ SUPPLIER MANAGEMENT ═══ */
function SupplierMgmt({suppliers,setSuppliers,items,toast}){
  const supList = Array.isArray(suppliers) ? suppliers : [];
  var _a=useState(false),shA=_a[0],sA=_a[1];
  var _ed=useState(null),edSup=_ed[0],sEdSup=_ed[1];
  var _ef=useState({name:"",email:"",phone:""}),edF=_ef[0],sEdF=_ef[1];
  var _n=useState({id:"",name:"",email:"",phone:"",items:[]}),nS=_n[0],sNS=_n[1];
  var add=async function(){
      if(!nS.id||!nS.name||!nS.email){toast("ID, Name, Email required",true);return;}
      if(supList.find(function(s){return s.id===nS.id;})){toast("ID exists",true);return;}
      try{
        await apiClient.suppliers.create(nS);
        const all=await apiClient.suppliers.getAll();
        setSuppliers(all);
        sNS({id:"",name:"",email:"",phone:"",items:[]});
        sA(false);
        toast("Supplier added");
      }catch(e){toast(e.message,true);}    };
  var rm=async function(id){
      try{
        await apiClient.suppliers.delete(id);
        const all=await apiClient.suppliers.getAll();
        setSuppliers(all);
        toast("Removed");
      }catch(e){toast(e.message,true);}    };
  var startEdit=function(s){sEdSup(s.id);sEdF({name:s.name,email:s.email,phone:s.phone||""});};
  var saveEdit=async function(){
      if(!edF.name||!edF.email){toast("Name and Email required",true);return;}
      try{
        await apiClient.suppliers.update(edSup,{name:edF.name,email:edF.email,phone:edF.phone});
        const all=await apiClient.suppliers.getAll();
        setSuppliers(all);
        sEdSup(null);
        toast("Supplier updated");
      }catch(e){toast(e.message,true);}    };
  return(<div>
    <div style={S.card}><div style={S.cH}><div><div style={S.t}>Suppliers</div><div style={S.d}>{supList.length} suppliers</div></div><button style={Object.assign({},S.b,S.bP)} onClick={function(){sA(true);}}>+ Add</button></div>
      <div style={S.tw}><table style={S.tbl}><thead><tr><th style={S.th}>ID</th><th style={S.th}>Name</th><th style={S.th}>Email</th><th style={S.th}>Phone</th><th style={S.th}>Items</th><th style={Object.assign({},S.th,{width:200})}>Actions</th></tr></thead><tbody>
        {supList.map(function(s){return(<tr key={s.id}><td style={S.tm}>{s.id}</td><td style={Object.assign({},S.td,{fontWeight:500})}>{s.name}</td><td style={S.tm}>{s.email}</td><td style={S.tm}>{s.phone}</td><td style={S.td}><span style={Object.assign({},S.bg,S.bgB)}>{(s.items||[]).length} items</span></td>
          <td style={S.td}><div style={{display:"flex",gap:3}}><button style={Object.assign({},S.b,S.bS,{padding:"2px 6px",fontSize:10})} onClick={function(){startEdit(s);}}>Edit</button><button style={Object.assign({},S.b,S.bD,{padding:"2px 6px",fontSize:10})} onClick={function(){rm(s.id);}}>Del</button></div></td></tr>);})}</tbody></table></div></div>
    {shA&&(<div style={S.ov} onClick={function(){sA(false);}}><div style={S.mo} onClick={function(e){e.stopPropagation();}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:12}}>Add Supplier</div>
      <div style={S.fr}><div style={Object.assign({},S.fg,{flex:1})}><div style={S.lb}>ID *</div><input style={S.inp} value={nS.id} onChange={function(e){sNS(Object.assign({},nS,{id:e.target.value}));}} placeholder="SUP4"/></div>
        <div style={Object.assign({},S.fg,{flex:1})}><div style={S.lb}>Name *</div><input style={S.inp} value={nS.name} onChange={function(e){sNS(Object.assign({},nS,{name:e.target.value}));}}/></div></div>
      <div style={S.fr}><div style={Object.assign({},S.fg,{flex:1})}><div style={S.lb}>Email *</div><input style={S.inp} value={nS.email} onChange={function(e){sNS(Object.assign({},nS,{email:e.target.value}));}}/></div>
        <div style={Object.assign({},S.fg,{flex:1})}><div style={S.lb}>Phone</div><input style={S.inp} value={nS.phone} onChange={function(e){sNS(Object.assign({},nS,{phone:e.target.value}));}}/></div></div>
      <div style={S.mA}><button style={Object.assign({},S.b,S.bS)} onClick={function(){sA(false);}}>Cancel</button><button style={Object.assign({},S.b,S.bP)} onClick={add}>Add</button></div></div></div>)}
    {edSup&&(<div style={S.ov} onClick={function(){sEdSup(null);}}><div style={S.mo} onClick={function(e){e.stopPropagation();}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:12}}>Edit Supplier - {edSup}</div>
      <div style={S.fg}><div style={S.lb}>Name *</div><input style={S.inp} value={edF.name} onChange={function(e){sEdF(Object.assign({},edF,{name:e.target.value}));}}/></div>
      <div style={S.fr}><div style={Object.assign({},S.fg,{flex:1})}><div style={S.lb}>Email *</div><input style={S.inp} value={edF.email} onChange={function(e){sEdF(Object.assign({},edF,{email:e.target.value}));}}/></div>
        <div style={Object.assign({},S.fg,{flex:1})}><div style={S.lb}>Phone</div><input style={S.inp} value={edF.phone} onChange={function(e){sEdF(Object.assign({},edF,{phone:e.target.value}));}}/></div></div>
      <div style={S.mA}><button style={Object.assign({},S.b,S.bS)} onClick={function(){sEdSup(null);}}>Cancel</button><button style={Object.assign({},S.b,S.bP)} onClick={saveEdit}>Save</button></div></div></div>)}
  </div>);
}

/* ═══ NOTIFICATIONS ═══ */
function NotifMgmt({notifs,setNotifs,toast}){
  var _a=useState(false),sh=_a[0],sS=_a[1];var _t=useState(""),tx=_t[0],sT=_t[1];var _ty=useState("info"),ty=_ty[0],sTy=_ty[1];
  var add=async function(){
      if(!tx.trim()){toast("Text required",true);return;}
      try{
        await apiClient.notifications.create({text:tx.trim(),type:ty});
        const all=await apiClient.notifications.getAll();
        setNotifs(all);
        sT("");sS(false);
        toast("Posted");
      }catch(e){toast(e.message,true);}    };
  var rm=async function(id){
      try{
        await apiClient.notifications.delete(id);
        const all=await apiClient.notifications.getAll();
        setNotifs(all);
        toast("Removed");
      }catch(e){toast(e.message,true);}    };
  return(<div style={S.card}><div style={S.cH}><div><div style={S.t}>Notifications</div></div><button style={Object.assign({},S.b,S.bP)} onClick={function(){sS(true);}}>+ New</button></div>
    {notifs.length===0&&<div style={{textAlign:"center",padding:30,color:"#6B7186"}}>None</div>}
    {notifs.map(function(n){return(<div key={n.id} style={{display:"flex",alignItems:"center",gap:6,marginBottom:6}}><div style={Object.assign({},n.type==="promo"?S.nP:S.nI,{flex:1,marginBottom:0})}>{n.text}<span style={{float:"right",opacity:.6,fontSize:10}}>{n.date}</span></div><button style={Object.assign({},S.b,S.bD,{padding:"2px 6px",fontSize:10})} onClick={function(){rm(n.id);}}>Del</button></div>);})}
    {sh&&(<div style={S.ov} onClick={function(){sS(false);}}><div style={S.mo} onClick={function(e){e.stopPropagation();}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:12}}>Post Notification</div>
      <div style={S.fg}><div style={S.lb}>Type</div><select style={S.inp} value={ty} onChange={function(e){sTy(e.target.value);}}><option value="info">Info</option><option value="promo">Promo</option></select></div>
      <div style={S.fg}><div style={S.lb}>Message</div><textarea style={Object.assign({},S.inp,{minHeight:50})} value={tx} onChange={function(e){sT(e.target.value);}}/></div>
      <div style={S.mA}><button style={Object.assign({},S.b,S.bS)} onClick={function(){sS(false);}}>Cancel</button><button style={Object.assign({},S.b,S.bP)} onClick={add}>Post</button></div></div></div>)}
  </div>);
}

/* ═══ STORE LOCATIONS ═══ */
function StoreMgmt({stores,setStores,toast}){
  var _e=useState(null),eId=_e[0],sEId=_e[1];var _en=useState(""),eN=_en[0],sEN=_en[1];
  var _a=useState(false),sh=_a[0],sS=_a[1];var _n=useState({id:"",name:""}),ns=_n[0],sN=_n[1];
  var startE=function(s){sEId(s.id);sEN(s.name);};
  var saveE=async function(){
      if(!eN.trim()){toast("Name required",true);return;}
      try{
        await apiClient.stores.update(eId,{name:eN.trim()});
        const all=await apiClient.stores.getAll();
        setStores(all);
        sEId(null);
        toast("Updated");
      }catch(e){toast(e.message,true);}    };
  var addS=async function(){
      if(!ns.id||!ns.name){toast("ID and Name required",true);return;}
      if(stores.find(function(s){return s.id===ns.id;})){toast("ID exists",true);return;}
      try{
        await apiClient.stores.create({id:ns.id.trim(),name:ns.name.trim()});
        const all=await apiClient.stores.getAll();
        setStores(all);
        sN({id:"",name:""});sS(false);
        toast("Store added");
      }catch(e){toast(e.message,true);}    };
  var rmS=async function(id){
      if(stores.length<=1){toast("Keep at least 1",true);return;}
      try{
        await apiClient.stores.delete(id);
        const all=await apiClient.stores.getAll();
        setStores(all);
        toast("Removed");
      }catch(e){toast(e.message,true);}    };
  return(<div><div style={S.card}><div style={S.cH}><div><div style={S.t}>Store Locations</div></div><button style={Object.assign({},S.b,S.bP)} onClick={function(){sS(true);}}>+ Add</button></div>
    <div style={S.tw}><table style={S.tbl}><thead><tr><th style={S.th}>ID</th><th style={S.th}>Name</th><th style={Object.assign({},S.th,{width:140})}>Actions</th></tr></thead><tbody>
      {stores.map(function(s){return(<tr key={s.id}><td style={S.tm}>{s.id}</td><td style={S.td}>{eId===s.id?<div style={{display:"flex",gap:4,alignItems:"center"}}><input style={Object.assign({},S.inp,{flex:1})} value={eN} onChange={function(e){sEN(e.target.value);}} onKeyDown={function(e){if(e.key==="Enter")saveE();}}/><button style={Object.assign({},S.b,S.bG,{padding:"3px 8px"})} onClick={saveE}>Save</button><button style={Object.assign({},S.b,S.bS,{padding:"3px 8px"})} onClick={function(){sEId(null);}}>X</button></div>:<span style={{fontWeight:500}}>{s.name}</span>}</td>
        <td style={S.td}>{eId!==s.id&&<div style={{display:"flex",gap:3}}><button style={Object.assign({},S.b,S.bS,{padding:"2px 8px",fontSize:10})} onClick={function(){startE(s);}}>Edit</button><button style={Object.assign({},S.b,S.bD,{padding:"2px 8px",fontSize:10})} onClick={function(){rmS(s.id);}}>Del</button></div>}</td></tr>);})}</tbody></table></div></div>
    {sh&&(<div style={S.ov} onClick={function(){sS(false);}}><div style={S.mo} onClick={function(e){e.stopPropagation();}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:12}}>Add Store</div>
      <div style={S.fg}><div style={S.lb}>Store ID *</div><input style={S.inp} value={ns.id} onChange={function(e){sN(Object.assign({},ns,{id:e.target.value}));}} placeholder="S6"/></div>
      <div style={S.fg}><div style={S.lb}>Store Name *</div><input style={S.inp} value={ns.name} onChange={function(e){sN(Object.assign({},ns,{name:e.target.value}));}}/></div>
      <div style={S.mA}><button style={Object.assign({},S.b,S.bS)} onClick={function(){sS(false);}}>Cancel</button><button style={Object.assign({},S.b,S.bP)} onClick={addS}>Add</button></div></div></div>)}
  </div>);
}

/* ═══ REPORTS ═══ */
function Reports({orders,items,stores}){
  var _tab=useState("top"),tab=_tab[0],sTab=_tab[1];
  // Aggregate all order data
  var agg=useMemo(function(){
    var itemTotals={};var storeTotals={};var catTotals={};var orderCount=0;
    Object.entries(orders).forEach(function(e){var o=e[1];if(!o.items)return;orderCount++;
      var sid=o.store;if(!storeTotals[sid])storeTotals[sid]={submitted:0,processed:0,draft:0,total:0};storeTotals[sid][o.status]=(storeTotals[sid][o.status]||0)+1;storeTotals[sid].total++;
      Object.entries(o.items).forEach(function(ie){var code=ie[0],qty=ie[1];if(qty<=0)return;if(!itemTotals[code])itemTotals[code]={qty:0,orders:0};itemTotals[code].qty+=qty;itemTotals[code].orders++;
        var it=items.find(function(i){return i.code===code;});if(it){var cat=it.category||"Other";if(!catTotals[cat])catTotals[cat]={qty:0,items:{}};catTotals[cat].qty+=qty;catTotals[cat].items[code]=true;}});});
    // Top items sorted by qty
    var topItems=Object.entries(itemTotals).map(function(e){var it=items.find(function(i){return i.code===e[0];});return{code:e[0],codeDisplay:String(e[0]||"").indexOf("XLS::")===0?String(e[0]).slice(5):e[0],name:it?it.name:displayNameForOrderKey(e[0],items),category:it?it.category:"",qty:e[1].qty,orders:e[1].orders};}).sort(function(a,b){return b.qty-a.qty;});
    var catList=Object.entries(catTotals).map(function(e){return{category:e[0],qty:e[1].qty,uniqueItems:Object.keys(e[1].items).length};}).sort(function(a,b){return b.qty-a.qty;});
    var storeList=Object.entries(storeTotals).map(function(e){var st=stores.find(function(s){return s.id===e[0];});return Object.assign({id:e[0],name:st?st.name:e[0]},e[1]);});
    return{topItems:topItems,catList:catList,storeList:storeList,orderCount:orderCount};
  },[orders,items,stores]);

  return(<div>
    <div style={S.tabs}>
      {[["top","Top Items"],["category","By Category"],["store","By Store"]].map(function(t){return <button key={t[0]} style={Object.assign({},S.tab,tab===t[0]?S.tA:S.tI)} onClick={function(){sTab(t[0]);}}>{t[1]}</button>;})}
    </div>
    <div style={S.sg}>
      <div style={S.sc}><div style={S.sL}>Total Orders</div><div style={Object.assign({},S.sV,{color:"#166534"})}>{agg.orderCount}</div></div>
      <div style={S.sc}><div style={S.sL}>Unique Items Ordered</div><div style={Object.assign({},S.sV,{color:"#34D399"})}>{agg.topItems.length}</div></div>
      <div style={S.sc}><div style={S.sL}>Categories Active</div><div style={Object.assign({},S.sV,{color:"#FBBF24"})}>{agg.catList.length}</div></div>
    </div>

    {tab==="top"&&(<div style={S.card}><div style={S.t}>Most Ordered Items</div><div style={S.d}>Ranked by total quantity across all orders</div>
      {agg.topItems.length===0?<div style={{textAlign:"center",padding:30,color:"#6B7186"}}>No order data yet. Submit some orders first.</div>:
      <div style={Object.assign({},S.tw,{marginTop:10})}><table style={S.tbl}><thead><tr><th style={S.th}>#</th><th style={S.th}>Code</th><th style={S.th}>Item</th><th style={S.th}>Category</th><th style={Object.assign({},S.th,{textAlign:"right"})}>Total Qty</th><th style={Object.assign({},S.th,{textAlign:"right"})}>In Orders</th><th style={S.th}>Bar</th></tr></thead><tbody>
        {agg.topItems.slice(0,20).map(function(it,i){var maxQ=agg.topItems[0].qty;var pct=maxQ>0?Math.round(it.qty/maxQ*100):0;return(<tr key={it.code}><td style={Object.assign({},S.td,{fontWeight:700,color:"#6B7186"})}>{i+1}</td><td style={S.tm}>{it.codeDisplay}</td><td style={Object.assign({},S.td,{fontWeight:500})}>{it.name}</td><td style={Object.assign({},S.td,{color:"#64748B"})}>{it.category}</td>
          <td style={Object.assign({},S.td,{textAlign:"right",fontFamily:"monospace",fontWeight:700,color:"#166534"})}>{it.qty}</td>
          <td style={Object.assign({},S.td,{textAlign:"right",fontFamily:"monospace"})}>{it.orders}</td>
          <td style={Object.assign({},S.td,{width:120})}><div style={{height:8,borderRadius:4,background:"rgba(148,163,184,.22)",overflow:"hidden"}}><div style={{height:"100%",width:pct+"%",background:"linear-gradient(90deg,#16A34A,#22C55E)",borderRadius:4}}/></div></td></tr>);})}</tbody></table></div>}</div>)}

    {tab==="category"&&(<div style={S.card}><div style={S.t}>Orders by Category</div>
      {agg.catList.length===0?<div style={{textAlign:"center",padding:30,color:"#6B7186"}}>No data</div>:
      <div style={Object.assign({},S.tw,{marginTop:10})}><table style={S.tbl}><thead><tr><th style={S.th}>Category</th><th style={Object.assign({},S.th,{textAlign:"right"})}>Total Qty</th><th style={Object.assign({},S.th,{textAlign:"right"})}>Unique Items</th><th style={S.th}>Bar</th></tr></thead><tbody>
        {agg.catList.map(function(c){var maxQ=agg.catList[0].qty;var pct=maxQ>0?Math.round(c.qty/maxQ*100):0;return(<tr key={c.category}><td style={Object.assign({},S.td,{fontWeight:600})}>{c.category}</td>
          <td style={Object.assign({},S.td,{textAlign:"right",fontFamily:"monospace",fontWeight:700,color:"#34D399"})}>{c.qty}</td>
          <td style={Object.assign({},S.td,{textAlign:"right",fontFamily:"monospace"})}>{c.uniqueItems}</td>
          <td style={Object.assign({},S.td,{width:120})}><div style={{height:8,borderRadius:4,background:"rgba(148,163,184,.22)",overflow:"hidden"}}><div style={{height:"100%",width:pct+"%",background:"linear-gradient(90deg,#34D399,#059669)",borderRadius:4}}/></div></td></tr>);})}</tbody></table></div>}</div>)}

    {tab==="store"&&(<div style={S.card}><div style={S.t}>Orders by Store</div>
      {agg.storeList.length===0?<div style={{textAlign:"center",padding:30,color:"#6B7186"}}>No data</div>:
      <div style={Object.assign({},S.tw,{marginTop:10})}><table style={S.tbl}><thead><tr><th style={S.th}>Store</th><th style={Object.assign({},S.th,{textAlign:"center"})}>Total</th><th style={Object.assign({},S.th,{textAlign:"center"})}>Submitted</th><th style={Object.assign({},S.th,{textAlign:"center"})}>Processed</th><th style={Object.assign({},S.th,{textAlign:"center"})}>Drafts</th></tr></thead><tbody>
        {agg.storeList.map(function(s){return(<tr key={s.id}><td style={Object.assign({},S.td,{fontWeight:500})}>{s.name}</td>
          <td style={Object.assign({},S.td,{textAlign:"center",fontFamily:"monospace",fontWeight:700})}>{s.total}</td>
          <td style={Object.assign({},S.td,{textAlign:"center",fontFamily:"monospace",color:"#34D399"})}>{s.submitted||0}</td>
          <td style={Object.assign({},S.td,{textAlign:"center",fontFamily:"monospace",color:"#0F766E"})}>{s.processed||0}</td>
          <td style={Object.assign({},S.td,{textAlign:"center",fontFamily:"monospace",color:"#FBBF24"})}>{s.draft||0}</td></tr>);})}</tbody></table></div>}</div>)}
  </div>);
}

/* ═══ SETTINGS (editable schedule + order messages) ═══ */
function Settings({stores,schedule,setSchedule,manualOpenOrder,setManualOpenOrder,manualOpenSeq,setManualOpenSeq,orderMsgs,setOrderMsgs,toast,logo,setLogo,logoRef,handleLogo}){
  var _e=useState(null),ed=_e[0],sEd=_e[1];var _v=useState(0),eV=_v[0],sEV=_v[1];
  var _em=useState(null),emT=_em[0],sEmT=_em[1];var _emV=useState(""),emV=_emV[0],sEmV=_emV[1];
  var _mo=useState(manualOpenOrder||""),moType=_mo[0],sMoType=_mo[1];
  useEffect(function(){ sMoType(manualOpenOrder||""); },[manualOpenOrder]);
  var saveDay=async function(){
      if (eV === '' || eV === null) {
        toast('Please select a day', true);
        return;
      }
      var conflict=Object.keys(schedule).find(function(k){return k!==ed&&schedule[k]===eV;});
      if(conflict){toast("Day already used by Order "+conflict,true);return;}    
      try{
        console.log('saving schedule', ed, eV, 'via apiClient');
        const resp = await apiClient.settings.updateSchedule(ed,eV);
        if (resp.settings && resp.settings.schedule) {
          setSchedule(resp.settings.schedule);
        } else if (resp.settings) {
          // old format fallback, unlikely but keep for safety
          setSchedule(resp.settings);
        } else {
          // fallback to manual update if API didn't return full list
          setSchedule(function(p){var n=Object.assign({},p);n[ed]=eV;return n;});
        }
        toast("Schedule updated");
        sEd(null);
      }catch(e){
        console.error('schedule update failed',e);
        toast(e.message,true);
      }
    };
  var saveMsg=async function(){
      try{
        await apiClient.settings.updateMessage(emT, emV);
        setOrderMsgs(function(p){var n=Object.assign({},p);n[emT]=emV;return n;});
        toast("Message updated for Order "+emT);
        sEmT(null);
      }catch(e){toast(e.message,true);}  };
  var saveManualOpen=async function(){
      try{
        var resp=await apiClient.settings.updateManualOpen(moType||null);
        setManualOpenOrder(resp.manualOpenOrder||null);
        if(setManualOpenSeq) setManualOpenSeq(resp.manualOpenSeq!=null?Number(resp.manualOpenSeq):null);
        toast(resp.manualOpenOrder?("Manual open active: Order "+resp.manualOpenOrder):"Manual open cleared");
      }catch(e){toast(e.message,true);}  };
  return(<div>
    <div style={S.card}><div style={S.cH}><div><div style={S.t}>Order Schedule</div><div style={S.d}>Edit day for each order type</div></div></div>
      <div style={Object.assign({},S.tw,{marginTop:4})}><table style={S.tbl}><thead><tr><th style={S.th}>Order</th><th style={S.th}>Day</th><th style={Object.assign({},S.th,{width:120})}>Actions</th></tr></thead><tbody>
        {["A","B","C"].map(function(t){var isE=ed===t;return(<tr key={t}><td style={Object.assign({},S.td,{fontWeight:600,fontSize:13})}>Order {t}</td><td style={S.td}>{isE?<select style={Object.assign({},S.inp,{width:140})} value={eV} onChange={function(e){
                var v=e.target.value;
                sEV(v === "" ? "" : parseInt(v));
              }}>
                <option value="" disabled>Choose day</option>
                {DAYS.map(function(d,i){
                  // disable if another order already uses this day (except the one being edited)
                  var usedBy = Object.keys(schedule).find(function(k){return k!==t && schedule[k]===i;});
                  return <option key={i} value={i} disabled={!!usedBy}>{d}{usedBy?" (in use)":null}</option>;
                })}
              </select>:<span>{schedule[t]!=null?DAYS[schedule[t]]:"Unset"}</span>}</td>
          <td style={S.td}>{isE?<div style={{display:"flex",gap:3}}><button style={Object.assign({},S.b,S.bG,{padding:"3px 8px",fontSize:10})} onClick={saveDay}>Save</button><button style={Object.assign({},S.b,S.bS,{padding:"3px 8px",fontSize:10})} onClick={function(){sEd(null);}}>Cancel</button></div>:<button style={Object.assign({},S.b,S.bS,{padding:"3px 8px",fontSize:10})} onClick={function(){
                  sEd(t);
                  // initialize editor value; if unset then leave blank so placeholder shows
                  sEV(schedule[t] != null ? schedule[t] : "");
                }}><Ic type="edit" size={11}/> Edit</button>}</td></tr>);})}</tbody></table></div>
      <div style={{marginTop:10,paddingTop:10,borderTop:"1px solid rgba(148,163,184,.24)"}}>
        <div style={{fontSize:12,fontWeight:600,color:"#0F172A",marginBottom:4}}>Manual Open Override</div>
        <div style={{fontSize:11,color:"#64748B",marginBottom:8}}>Open an order for stores even when today is not its scheduled day.</div>
        <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
          <select style={Object.assign({},S.inp,{width:240})} value={moType} onChange={function(e){sMoType(e.target.value);}}>
            <option value="">No override (use schedule)</option>
            <option value="A">Open Order A</option>
            <option value="B">Open Order B</option>
            <option value="C">Open Order C</option>
          </select>
          <button style={Object.assign({},S.b,S.bG)} onClick={saveManualOpen}>Save Override</button>
          {manualOpenOrder&&<span style={Object.assign({},S.bg,S.bgW)}>Active: Order {manualOpenOrder}</span>}
        </div>
      </div>
    </div>

    <div style={S.card}><div style={S.cH}><div><div style={S.t}>Order Messages</div><div style={S.d}>Custom instructions shown to managers for each order type</div></div></div>
      {["A","B","C"].map(function(t){var isE=emT===t;return(<div key={t} style={{padding:"10px 0",borderBottom:"1px solid rgba(148,163,184,.24)"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
          <div style={{flex:1}}><div style={{fontSize:12,fontWeight:600,marginBottom:4}}>Order {t}</div>
            {isE?<textarea style={Object.assign({},S.inp,{minHeight:60})} value={emV} onChange={function(e){sEmV(e.target.value);}}/>
            :<div style={{fontSize:12,color:"#64748B",lineHeight:1.5}}>{orderMsgs[t]||"No message set"}</div>}</div>
          <div>{isE?<div style={{display:"flex",gap:3}}><button style={Object.assign({},S.b,S.bG,{padding:"3px 8px",fontSize:10})} onClick={saveMsg}>Save</button><button style={Object.assign({},S.b,S.bS,{padding:"3px 8px",fontSize:10})} onClick={function(){sEmT(null);}}>X</button></div>
            :<button style={Object.assign({},S.b,S.bS,{padding:"3px 8px",fontSize:10})} onClick={function(){sEmT(t);sEmV(orderMsgs[t]||"");}}><Ic type="edit" size={11}/> Edit</button>}</div></div></div>);})}</div>

    <div style={S.card}><div style={S.cH}><div><div style={S.t}>Company Logo</div><div style={S.d}>Upload your logo to replace the default "OM" icon (max 500KB)</div></div></div>
      <div style={{display:"flex",alignItems:"center",gap:14,marginTop:4}}>
        {logo?<img src={logo} alt="Logo" style={{width:48,height:48,borderRadius:10,objectFit:"cover",border:"1px solid rgba(148,163,184,.24)"}}/>:<div style={Object.assign({},S.logo,{width:48,height:48,fontSize:16})}>OM</div>}
        <div style={{display:"flex",gap:6}}>
          <button style={Object.assign({},S.b,S.bP)} onClick={function(){logoRef.current&&logoRef.current.click();}}>Upload Logo</button>
          {logo&&<button style={Object.assign({},S.b,S.bD)} onClick={async function(){setLogo(null);toast("Logo removed");try{await apiClient.settings.updateLogo(null);}catch(e){console.error('logo clear failed',e);toast('Unable to clear logo',true);} }}>Remove</button>}
        </div>
      </div></div>

    <div style={S.card}><div style={S.t}>Stores</div>
      <div style={Object.assign({},S.tw,{marginTop:8})}><table style={S.tbl}><thead><tr><th style={S.th}>ID</th><th style={S.th}>Name</th></tr></thead><tbody>
        {stores.map(function(s){return <tr key={s.id}><td style={S.tm}>{s.id}</td><td style={S.td}>{s.name}</td></tr>;})}</tbody></table></div></div>

    <div style={{marginTop:10,padding:12,background:"rgba(148,163,184,.22)",borderRadius:6,border:"1px solid rgba(148,163,184,.24)",fontSize:12,color:"#64748B"}}>
      <strong style={{color:"#0F172A"}}>OrderManager v3.1</strong> - Supplier edit, submit confirm, sort options, mailto emails, company logo, custom messages.</div>
  </div>);
}




