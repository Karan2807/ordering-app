import { useState, useCallback, useMemo, useRef, Fragment } from "react";

/* ═══ DATA ═══ */
var INIT_STORES=[{id:"S1",name:"Downtown Central"},{id:"S2",name:"Westside Mall"},{id:"S3",name:"Eastgate Plaza"},{id:"S4",name:"North Market"},{id:"S5",name:"Southpoint Hub"}];
var INIT_ITEMS=[
  {code:"ITM001",name:"Basmati Rice 5kg",category:"Grains",unit:"Bags"},
  {code:"ITM002",name:"Sunflower Oil 1L",category:"Oils",unit:"Bottles"},
  {code:"ITM003",name:"Whole Wheat Flour 2kg",category:"Grains",unit:"Packs"},
  {code:"ITM004",name:"Sugar 1kg",category:"Essentials",unit:"Packs"},
  {code:"ITM005",name:"Toor Dal 1kg",category:"Pulses",unit:"Packs"},
  {code:"ITM006",name:"Salt 1kg",category:"Essentials",unit:"Packs"},
  {code:"ITM007",name:"Tea Powder 500g",category:"Beverages",unit:"Packs"},
  {code:"ITM008",name:"Milk 1L",category:"Dairy",unit:"Packets"},
  {code:"ITM009",name:"Bread Loaf",category:"Bakery",unit:"Pieces"},
  {code:"ITM010",name:"Butter 500g",category:"Dairy",unit:"Packs"},
  {code:"ITM011",name:"Eggs 12 pack",category:"Dairy",unit:"Trays"},
  {code:"ITM012",name:"Tomato Ketchup 500g",category:"Condiments",unit:"Bottles"},
  {code:"ITM013",name:"Mixed Spice Box",category:"Spices",unit:"Boxes"},
  {code:"ITM014",name:"Dish Soap 750ml",category:"Cleaning",unit:"Bottles"},
  {code:"ITM015",name:"Paper Towels 6 roll",category:"Cleaning",unit:"Packs"},
];
var INIT_USERS=[
  {username:"admin",password:"admin123",role:"admin",storeId:null,name:"System Admin",phone:"555-0100",active:true},
  {username:"store1",password:"pass123",role:"manager",storeId:"S1",name:"Ravi Kumar",phone:"555-0101",active:true},
  {username:"store2",password:"pass123",role:"manager",storeId:"S2",name:"Priya Sharma",phone:"555-0102",active:true},
  {username:"store3",password:"pass123",role:"manager",storeId:"S3",name:"Amit Patel",phone:"555-0103",active:true},
  {username:"store4",password:"pass123",role:"manager",storeId:"S4",name:"Sara Nair",phone:"555-0104",active:true},
  {username:"store5",password:"pass123",role:"manager",storeId:"S5",name:"Vikram Singh",phone:"555-0105",active:true},
];
var INIT_NOTIFS=[
  {id:1,text:"Weekend Sale - extra beverages and snacks for Saturday rush!",type:"promo",date:"2026-02-06"},
  {id:2,text:"Delivery schedule changed: Tuesday orders arrive Wednesday this week.",type:"info",date:"2026-02-05"},
];
var INIT_SUPPLIERS=[
  {id:"SUP1",name:"Fresh Foods Co",email:"orders@freshfoods.com",phone:"555-9001",items:["ITM001","ITM003","ITM004","ITM005","ITM006"]},
  {id:"SUP2",name:"Pacific Beverages",email:"supply@pacbev.com",phone:"555-9002",items:["ITM002","ITM007","ITM008","ITM012"]},
  {id:"SUP3",name:"Metro Supplies",email:"orders@metrosup.com",phone:"555-9003",items:["ITM009","ITM010","ITM011","ITM013","ITM014","ITM015"]},
];
var DEFAULT_SCHED={A:5,B:0,C:4};
var DEFAULT_MSGS={
  A:"Order A has to send by Sunday, Monday pickup from Supplier in LA. Delivery to store will be on Wednesday.",
  B:"Order B has to send by Monday, Tuesday pickup from Supplier. Delivery to store will be on Thursday.",
  C:"Order C has to send by Friday, Saturday pickup from Supplier. Delivery to store will be on Monday.",
};
var DAYS=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

function activeType(sc){var t=new Date().getDay();for(var k in sc){if(sc[k]===t)return k;}return null;}
function weekNum(d){var dt=new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate()));dt.setUTCDate(dt.getUTCDate()+4-(dt.getUTCDay()||7));var ys=new Date(Date.UTC(dt.getUTCFullYear(),0,1));return Math.ceil(((dt-ys)/86400000+1)/7);}
function dateKey(type){var n=new Date();return n.getFullYear()+"-W"+String(weekNum(n)).padStart(2,"0")+"-"+type;}
function lastWeekKey(type){var n=new Date();return n.getFullYear()+"-W"+String(weekNum(n)-1).padStart(2,"0")+"-"+type;}
function sortItems(a){return a.slice().sort(function(x,y){var c=(x.category||"").localeCompare(y.category||"");return c!==0?c:x.name.localeCompare(y.name);});}
function fmtDT(iso){if(!iso)return"-";var d=new Date(iso);return d.toLocaleDateString()+" "+d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});}
function parseCSV(text){var lines=text.split(/\r?\n/).filter(function(l){return l.trim();});if(lines.length<2)return[];var hdr=lines[0].split(",").map(function(h){return h.trim().toLowerCase().replace(/[^a-z0-9]/g,"");});var ci=hdr.findIndex(function(h){return h.indexOf("code")>=0||h==="sku";});var ni=hdr.findIndex(function(h){return h.indexOf("name")>=0||h==="item"||h==="description";});var cti=hdr.findIndex(function(h){return h.indexOf("cat")>=0||h==="group";});var ui=hdr.findIndex(function(h){return h.indexOf("unit")>=0||h==="uom";});if(ni===-1)return[];var r=[];for(var i=1;i<lines.length;i++){var cols=lines[i].split(",").map(function(c){return c.trim().replace(/"/g,"");});if(!cols[ni])continue;r.push({code:ci>=0&&cols[ci]?cols[ci]:"CSV"+String(i).padStart(4,"0"),name:cols[ni],category:cti>=0?(cols[cti]||""):"",unit:ui>=0?(cols[ui]||""):"",});}return r;}

/* ═══ SEED DATA: Last week Order A submissions for all 5 stores ═══ */
var SEED_ORDERS=(function(){
  function wn(d){var dt=new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate()));dt.setUTCDate(dt.getUTCDate()+4-(dt.getUTCDay()||7));var ys=new Date(Date.UTC(dt.getUTCFullYear(),0,1));return Math.ceil(((dt-ys)/86400000+1)/7);}
  var n=new Date();var lw=n.getFullYear()+"-W"+String(wn(n)-1).padStart(2,"0")+"-A";
  var codes=["ITM001","ITM002","ITM003","ITM004","ITM005","ITM006","ITM007","ITM008","ITM009","ITM010","ITM011","ITM012","ITM013","ITM014","ITM015"];
  var rand=function(seed){return function(){seed=(seed*16807+0)%2147483647;return seed;};};
  var rng=rand(42);
  var orders={};
  ["S1","S2","S3","S4","S5"].forEach(function(sid){
    var items={};
    codes.forEach(function(c){var v=rng()%15;items[c]=v>3?v:0;});
    var lastFri=new Date(n);lastFri.setDate(lastFri.getDate()-7);
    orders[sid+"_"+lw]={items:items,status:"submitted",store:sid,type:"A",date:lastFri.toISOString()};
  });
  return orders;
})();


var S={
  page:{minHeight:"100vh",display:"flex",fontFamily:"-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",background:"#0F1117",color:"#E8EAF0"},
  sidebar:{width:240,minWidth:240,background:"#181B25",borderRight:"1px solid #2A2E3B",display:"flex",flexDirection:"column",height:"100vh",position:"sticky",top:0,overflowY:"auto"},
  sideHdr:{padding:"18px 14px",borderBottom:"1px solid #2A2E3B",display:"flex",alignItems:"center",gap:8},
  logo:{width:34,height:34,borderRadius:8,background:"linear-gradient(135deg,#4F8CFF,#7C5CFF)",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:700,fontSize:13,color:"#fff",flexShrink:0},
  navItem:{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",borderRadius:6,cursor:"pointer",fontSize:12.5,fontWeight:500,marginBottom:1},
  navA:{background:"rgba(79,140,255,0.15)",color:"#4F8CFF"},navI:{color:"#9BA1B5"},
  main:{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"},
  topbar:{height:52,minHeight:52,borderBottom:"1px solid #2A2E3B",display:"flex",alignItems:"center",justifyContent:"space-between",padding:"0 20px",background:"#181B25"},
  content:{flex:1,overflowY:"auto",padding:20},
  card:{background:"#181B25",border:"1px solid #2A2E3B",borderRadius:10,padding:18,marginBottom:14},
  cH:{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12,flexWrap:"wrap",gap:8},
  t:{fontSize:14,fontWeight:700},d:{fontSize:12,color:"#9BA1B5",marginTop:2},
  sg:{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))",gap:10,marginBottom:16},
  sc:{background:"#181B25",border:"1px solid #2A2E3B",borderRadius:10,padding:14},
  sL:{fontSize:10,color:"#6B7186",fontWeight:600,textTransform:"uppercase",letterSpacing:.5},
  sV:{fontSize:24,fontWeight:700,marginTop:3,fontFamily:"monospace"},sS:{fontSize:11,color:"#9BA1B5",marginTop:2},
  tw:{overflow:"auto",borderRadius:6,border:"1px solid #2A2E3B",maxHeight:"62vh"},
  th:{padding:"7px 10px",textAlign:"left",fontWeight:600,color:"#9BA1B5",fontSize:10.5,textTransform:"uppercase",letterSpacing:.5,whiteSpace:"nowrap",borderBottom:"1px solid #2A2E3B",background:"#1F2330",position:"sticky",top:0,zIndex:5},
  td:{padding:"7px 10px",borderBottom:"1px solid #2A2E3B",fontSize:12.5},
  tm:{padding:"7px 10px",borderBottom:"1px solid #2A2E3B",fontFamily:"monospace",fontSize:11.5,color:"#9BA1B5"},
  b:{display:"inline-flex",alignItems:"center",gap:4,padding:"7px 12px",borderRadius:6,fontSize:11.5,fontWeight:600,cursor:"pointer",border:"none",whiteSpace:"nowrap",fontFamily:"inherit"},
  bP:{background:"#4F8CFF",color:"#fff"},bS:{background:"#1F2330",color:"#E8EAF0",border:"1px solid #2A2E3B"},
  bD:{background:"rgba(248,113,113,0.1)",color:"#F87171",border:"1px solid rgba(248,113,113,0.2)"},
  bG:{background:"rgba(52,211,153,0.1)",color:"#34D399",border:"1px solid rgba(52,211,153,0.2)"},
  bW:{background:"rgba(251,191,36,0.1)",color:"#FBBF24",border:"1px solid rgba(251,191,36,0.2)"},
  bg:{display:"inline-flex",padding:"2px 8px",borderRadius:16,fontSize:10.5,fontWeight:600},
  bgG:{background:"rgba(52,211,153,0.1)",color:"#34D399"},bgY:{background:"rgba(251,191,36,0.1)",color:"#FBBF24"},
  bgR:{background:"rgba(248,113,113,0.1)",color:"#F87171"},bgB:{background:"rgba(79,140,255,0.15)",color:"#4F8CFF"},
  bgP:{background:"rgba(168,85,247,0.12)",color:"#A855F7"},
  inp:{width:"100%",padding:"7px 10px",borderRadius:6,border:"1px solid #2A2E3B",background:"#1F2330",color:"#E8EAF0",fontSize:12.5,outline:"none",fontFamily:"inherit"},
  ni:{width:70,padding:"5px 3px",textAlign:"center",fontFamily:"monospace",fontSize:12,borderRadius:6,border:"1px solid #2A2E3B",background:"#1F2330",color:"#E8EAF0",outline:"none"},
  ie:{width:60,padding:"4px",textAlign:"center",fontFamily:"monospace",fontSize:11.5,borderRadius:4,border:"1.5px solid #4F8CFF",background:"#0F1117",color:"#E8EAF0",outline:"none"},
  lb:{display:"block",fontSize:10.5,fontWeight:600,color:"#9BA1B5",marginBottom:3,textTransform:"uppercase",letterSpacing:.4},
  ov:{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16},
  mo:{background:"#181B25",border:"1px solid #2A2E3B",borderRadius:14,padding:22,width:500,maxWidth:"95vw",maxHeight:"82vh",overflowY:"auto"},
  mW:{width:750},mA:{display:"flex",gap:8,justifyContent:"flex-end",marginTop:14},
  fg:{marginBottom:12},fr:{display:"flex",gap:10},
  nI:{padding:"10px 14px",borderRadius:6,marginBottom:10,background:"rgba(79,140,255,0.1)",border:"1px solid rgba(79,140,255,0.2)",color:"#4F8CFF",fontSize:12.5},
  nP:{padding:"10px 14px",borderRadius:6,marginBottom:10,background:"rgba(251,191,36,0.08)",border:"1px solid rgba(251,191,36,0.2)",color:"#FBBF24",fontSize:12.5},
  nG:{padding:"10px 14px",borderRadius:6,marginBottom:10,background:"rgba(52,211,153,0.08)",border:"1px solid rgba(52,211,153,0.2)",color:"#34D399",fontSize:12.5},
  tabs:{display:"flex",gap:2,marginBottom:14,padding:2,background:"#1F2330",borderRadius:6,width:"fit-content"},
  tab:{padding:"5px 12px",borderRadius:5,fontSize:11.5,fontWeight:600,cursor:"pointer",border:"none",fontFamily:"inherit"},
  tA:{background:"#4F8CFF",color:"#fff"},tI:{background:"transparent",color:"#9BA1B5"},
  eB:{background:"none",border:"none",cursor:"pointer",color:"#6B7186",padding:2,borderRadius:4,display:"inline-flex",alignItems:"center"},
  cE:{background:"rgba(79,140,255,0.08)"},
  to:{position:"fixed",top:14,right:14,zIndex:2000,padding:"8px 16px",borderRadius:6,fontSize:12.5,fontWeight:500,color:"#34D399",background:"#065F46",border:"1px solid rgba(52,211,153,0.3)"},
  toE:{color:"#F87171",background:"#7F1D1D",border:"1px solid rgba(248,113,113,0.3)"},
  lP:{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"#0F1117"},
  lC:{width:360,maxWidth:"90vw",background:"#181B25",border:"1px solid #2A2E3B",borderRadius:14,padding:"28px 24px"},
  lE:{padding:"6px 10px",borderRadius:6,fontSize:11.5,background:"rgba(248,113,113,0.1)",color:"#F87171",border:"1px solid rgba(248,113,113,0.2)",marginBottom:10,textAlign:"center"},
  sB:{display:"flex",alignItems:"center",gap:5,padding:"5px 10px",background:"#1F2330",border:"1px solid #2A2E3B",borderRadius:6},
  sI:{border:"none",background:"none",padding:0,fontSize:12.5,color:"#E8EAF0",outline:"none",width:130,fontFamily:"inherit"},
  ft:{padding:12,borderTop:"1px solid #2A2E3B"},
  uC:{display:"flex",alignItems:"center",gap:7,padding:"7px 9px",borderRadius:6,background:"#1F2330"},
  av:{width:28,height:28,borderRadius:"50%",background:"linear-gradient(135deg,#34D399,#059669)",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:700,fontSize:11,color:"#fff",flexShrink:0},
  loB:{display:"flex",alignItems:"center",gap:4,marginTop:5,width:"100%",padding:"6px 9px",borderRadius:6,border:"1px solid #2A2E3B",background:"transparent",color:"#9BA1B5",fontSize:10.5,cursor:"pointer",fontFamily:"inherit"},
  tbl:{width:"100%",borderCollapse:"collapse"},
};

/* ═══ ICONS ═══ */
function Ic({type,size}){var z=size||16;var p={home:"M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",clip:"M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2 M8 2h8v4H8z",grid:"M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z",up:"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M17 8l-5-5-5 5 M12 3v12",users:"M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 7a4 4 0 1 0 0-0.01 M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75",bell:"M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9 M13.73 21a2 2 0 0 1-3.46 0",gear:"M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0",out:"M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9",check:"M20 6L9 17l-5-5",plus:"M12 5v14M5 12h14",trash:"M3 6h18 M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",search:"M11 11m-8 0a8 8 0 1 0 16 0a8 8 0 1 0-16 0 M21 21l-4.35-4.35",edit:"M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7 M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z",pin:"M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z M12 10m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0",lock:"M3 11h18v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V11z M7 11V7a5 5 0 0 1 10 0v4",save:"M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z M17 21v-8H7v8 M7 3v5h8",send:"M22 2L11 13 M22 2l-7 20-4-9-9-4 20-7z",eye:"M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0",x:"M18 6L6 18M6 6l12 12",menu:"M3 12h18M3 6h18M3 18h18",truck:"M1 3h15v13H1z M16 8h4l3 3v5h-7V8z M5.5 18.5a2.5 2.5 0 1 0 0-0.01 M18.5 18.5a2.5 2.5 0 1 0 0-0.01",chart:"M18 20V10 M12 20V4 M6 20v-6",mail:"M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M22 6l-10 7L2 6",phone:"M22 16.92v3a2 2 0 0 1-2.18 2A19.86 19.86 0 0 1 3.09 5.18 2 2 0 0 1 5.11 3h3a2 2 0 0 1 2 1.72c.13.81.36 1.6.68 2.34a2 2 0 0 1-.45 2.11L8.91 10.6a16 16 0 0 0 6.29 6.29l1.43-1.43a2 2 0 0 1 2.11-.45c.74.32 1.53.55 2.34.68a2 2 0 0 1 1.72 2v.23z"};return(<svg width={z} height={z} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{(p[type]||"").split(" M").map(function(s,i){return <path key={i} d={i===0?s:"M"+s}/>;})}</svg>);}

/* ═══ TOAST ═══ */
function Toast({msg,isErr}){if(!msg)return null;return <div style={Object.assign({},S.to,isErr?S.toE:{})}>{msg}</div>;}

/* ═══ LOGIN ═══ */
function Login({users,onLogin,logo}){
  var _a=useState(""),un=_a[0],sU=_a[1];var _b=useState(""),pw=_b[0],sP=_b[1];var _c=useState(""),err=_c[0],sE=_c[1];
  var go=function(){var u=users.find(function(u){return u.username===un&&u.password===pw&&u.active;});if(u)onLogin(u);else sE("Invalid credentials or account disabled.");};
  return(<div style={S.lP}><div style={S.lC}>
    <div style={{display:"flex",alignItems:"center",gap:8,justifyContent:"center",marginBottom:20}}>{logo?<img src={logo} alt="Logo" style={{width:34,height:34,borderRadius:8,objectFit:"cover"}}/>:<div style={S.logo}>OM</div>}<div><div style={{fontWeight:700,fontSize:16}}>OrderManager</div><div style={{fontSize:10,color:"#6B7186"}}>Multi-Store Platform v3</div></div></div>
    <div style={{textAlign:"center",fontSize:18,fontWeight:700,marginBottom:4}}>Welcome back</div>
    <div style={{textAlign:"center",fontSize:12,color:"#9BA1B5",marginBottom:16}}>Sign in to manage orders</div>
    {err&&<div style={S.lE}>{err}</div>}
    <div style={S.fg}><div style={S.lb}>Username</div><input style={S.inp} value={un} onChange={function(e){sU(e.target.value);}} placeholder="Enter username" onKeyDown={function(e){if(e.key==="Enter")go();}}/></div>
    <div style={S.fg}><div style={S.lb}>Password</div><input style={S.inp} type="password" value={pw} onChange={function(e){sP(e.target.value);}} placeholder="Enter password" onKeyDown={function(e){if(e.key==="Enter")go();}}/></div>
    <button style={Object.assign({},S.b,S.bP,{width:"100%",justifyContent:"center",padding:9})} onClick={go}>Sign In</button>
    <div style={{marginTop:14,padding:10,borderRadius:6,background:"#1F2330",border:"1px solid #2A2E3B"}}>
      <div style={{fontSize:9,color:"#6B7186",textTransform:"uppercase",letterSpacing:1,marginBottom:6,fontWeight:600}}>Demo Accounts</div>
      <div style={{fontSize:11,color:"#9BA1B5",fontFamily:"monospace"}}>Admin: admin / admin123</div>
      <div style={{fontSize:11,color:"#9BA1B5",fontFamily:"monospace"}}>Stores: store1-store5 / pass123</div>
    </div>
  </div></div>);
}

/* ════════ MAIN APP ════════ */
export default function App(){
  var _u=useState(null),user=_u[0],setUser=_u[1];
  var _p=useState("dashboard"),page=_p[0],setPage=_p[1];
  var _t=useState(""),tM=_t[0],sTM=_t[1];var _te=useState(false),tE=_te[0],sTE=_te[1];
  var _i=useState(function(){return sortItems(INIT_ITEMS);}),items=_i[0],setItemsR=_i[1];
  var _us=useState(INIT_USERS),users=_us[0],setUsers=_us[1];
  var _o=useState(SEED_ORDERS),orders=_o[0],setOrders=_o[1];
  var _n=useState(INIT_NOTIFS),notifs=_n[0],setNotifs=_n[1];
  var _s=useState(INIT_STORES),stores=_s[0],setStores=_s[1];
  var _sc=useState(DEFAULT_SCHED),schedule=_sc[0],setSchedule=_sc[1];
  var _om=useState(DEFAULT_MSGS),orderMsgs=_om[0],setOrderMsgs=_om[1];
  var _su=useState(INIT_SUPPLIERS),suppliers=_su[0],setSuppliers=_su[1];
  var _lg=useState(null),logo=_lg[0],setLogo=_lg[1];
  var tR=useRef(null);var logoRef=useRef(null);
  var toast=useCallback(function(m,e){sTM(m);sTE(!!e);if(tR.current)clearTimeout(tR.current);tR.current=setTimeout(function(){sTM("");},2500);},[]);
  var setItems=useCallback(function(up){setItemsR(function(p){var n=typeof up==="function"?up(p):up;return sortItems(n);});},[]);
  var handleLogo=function(e){var f=e.target.files&&e.target.files[0];if(!f)return;if(f.size>500000){toast("Logo must be under 500KB",true);return;}var r=new FileReader();r.onload=function(ev){setLogo(ev.target.result);toast("Logo updated");};r.readAsDataURL(f);e.target.value="";};
  var aot=activeType(schedule);var isA=user&&user.role==="admin";
  if(!user)return(<Fragment><input ref={logoRef} type="file" accept="image/*" style={{display:"none"}} onChange={handleLogo}/><Login users={users} onLogin={function(u){setUser(u);setPage("dashboard");}} logo={logo}/></Fragment>);
  var sN=user.storeId?(stores.find(function(s){return s.id===user.storeId;})||{}).name||user.storeId:"All Stores";
  // Check if current user's active order is already submitted
  var myOrderKey=user.storeId&&aot?user.storeId+"_"+dateKey(aot):null;
  var myOrderStatus=myOrderKey&&orders[myOrderKey]?orders[myOrderKey].status:null;

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
  var PP={orders:orders,setOrders:setOrders,items:items,setItems:setItems,users:users,setUsers:setUsers,notifs:notifs,setNotifs:setNotifs,stores:stores,setStores:setStores,user:user,aot:aot,toast:toast,setPage:setPage,schedule:schedule,setSchedule:setSchedule,orderMsgs:orderMsgs,setOrderMsgs:setOrderMsgs,suppliers:suppliers,setSuppliers:setSuppliers,logo:logo,setLogo:setLogo,logoRef:logoRef,handleLogo:handleLogo};
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
  // Topbar status: show submitted/processed if applicable
  var topBadge=null;
  if(aot){
    if(!isA&&myOrderStatus==="submitted")topBadge=<span style={Object.assign({},S.bg,S.bgG)}>Order {aot} Submitted</span>;
    else if(!isA&&myOrderStatus==="processed")topBadge=<span style={Object.assign({},S.bg,S.bgP)}>Order {aot} Processed</span>;
    else topBadge=<span style={Object.assign({},S.bg,S.bgG)}>Order {aot} Open</span>;
  }else{topBadge=<span style={Object.assign({},S.bg,S.bgY)}>No active order</span>;}

  return(<div style={S.page}><Toast msg={tM} isErr={tE}/>
    <input ref={logoRef} type="file" accept="image/*" style={{display:"none"}} onChange={handleLogo}/>
    <aside style={S.sidebar}>
      <div style={S.sideHdr}>{logo?<img src={logo} alt="Logo" style={{width:34,height:34,borderRadius:8,objectFit:"cover",flexShrink:0}}/>:<div style={S.logo}>OM</div>}<div><div style={{fontWeight:700,fontSize:13}}>OrderManager</div><div style={{fontSize:10,color:"#6B7186"}}>{sN}</div></div></div>
      <nav style={{flex:1,padding:"8px 6px",overflowY:"auto"}}>
        <div style={{fontSize:9,fontWeight:600,color:"#6B7186",textTransform:"uppercase",letterSpacing:1,padding:"8px 10px 3px"}}>Navigation</div>
        {navs.map(function(n){return(<div key={n.id} style={Object.assign({},S.navItem,page===n.id?S.navA:S.navI)} onClick={function(){setPage(n.id);}}><Ic type={n.ico} size={15}/><span>{n.label}</span></div>);})}
      </nav>
      <div style={S.ft}><div style={S.uC}><div style={S.av}>{user.name.charAt(0)}</div><div><div style={{fontSize:11,fontWeight:600}}>{user.name}</div><div style={{fontSize:9,color:"#6B7186"}}>{isA?"Admin":"Manager"}</div></div></div>
        <button style={S.loB} onClick={function(){setUser(null);}}><Ic type="out" size={13}/><span>Sign Out</span></button></div>
    </aside>
    <div style={S.main}>
      <header style={S.topbar}><div style={{fontSize:15,fontWeight:700}}>{(navs.find(function(n){return n.id===page;})||{}).label||"Dashboard"}</div>
        <div style={{display:"flex",gap:5}}>{topBadge}<span style={Object.assign({},S.bg,S.bgB)}>{DAYS[new Date().getDay()]}</span></div></header>
      <div style={S.content}>{rP()}</div>
    </div></div>);
}

/* ═══ ADMIN DASHBOARD ═══ */
function AdminDash({orders,users,items,notifs,aot,setPage,stores,schedule}){
  var wk="W"+String(weekNum(new Date())).padStart(2,"0");
  var tW=Object.keys(orders).filter(function(k){return k.indexOf(wk)>=0;});
  var sub=tW.filter(function(k){return orders[k].status==="submitted";}).length;
  var proc=tW.filter(function(k){return orders[k].status==="processed";}).length;
  // Pending reminders: managers who haven't submitted for active order
  var pendingAlerts=[];
  if(aot){var dk=dateKey(aot);stores.forEach(function(st){var k=st.id+"_"+dk;var o=orders[k];if(!o||o.status==="draft"){var mgr=users.find(function(u){return u.storeId===st.id&&u.role==="manager"&&u.active;});pendingAlerts.push({store:st.name,manager:mgr?mgr.name:"N/A",phone:mgr?mgr.phone:"N/A"});}});}
  return(<div>
    <div style={S.sg}>
      <div style={S.sc}><div style={S.sL}>Stores</div><div style={Object.assign({},S.sV,{color:"#34D399"})}>{stores.length}</div></div>
      <div style={S.sc}><div style={S.sL}>Items</div><div style={Object.assign({},S.sV,{color:"#4F8CFF"})}>{items.length}</div></div>
      <div style={S.sc}><div style={S.sL}>Submitted</div><div style={Object.assign({},S.sV,{color:"#FBBF24"})}>{sub}</div></div>
      <div style={S.sc}><div style={S.sL}>Processed</div><div style={Object.assign({},S.sV,{color:"#A855F7"})}>{proc}</div></div>
      <div style={S.sc}><div style={S.sL}>Today</div><div style={Object.assign({},S.sV,{color:"#FB923C",fontSize:18})}>{aot?"Order "+aot:"None"}</div></div>
    </div>
    {pendingAlerts.length>0&&aot&&(<div style={S.card}><div style={S.cH}><div><div style={Object.assign({},S.t,{color:"#F87171"})}>Pending Submissions - Order {aot}</div><div style={S.d}>These stores have not submitted yet. SMS reminder at 4 PM on {DAYS[schedule[aot]]}.</div></div></div>
      <div style={S.tw}><table style={S.tbl}><thead><tr><th style={S.th}>Store</th><th style={S.th}>Manager</th><th style={S.th}>Phone</th><th style={S.th}>Action</th></tr></thead><tbody>
        {pendingAlerts.map(function(a,i){return <tr key={i}><td style={S.td}>{a.store}</td><td style={S.td}>{a.manager}</td><td style={S.tm}>{a.phone}</td><td style={S.td}><span style={Object.assign({},S.bg,S.bgR)}>SMS Pending</span></td></tr>;})}
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
function MgrDash({user,orders,notifs,aot,setPage,stores,schedule,orderMsgs}){
  var sName=(stores.find(function(s){return s.id===user.storeId;})||{}).name||user.storeId;
  var my=Object.keys(orders).filter(function(k){return k.indexOf(user.storeId)===0;});
  var sub=my.filter(function(k){return orders[k].status==="submitted"||orders[k].status==="processed";}).length;
  var curKey=aot?user.storeId+"_"+dateKey(aot):null;
  var curOrder=curKey?orders[curKey]:null;
  var curStatus=curOrder?curOrder.status:null;
  return(<div>
    {notifs.map(function(n){return <div key={n.id} style={n.type==="promo"?S.nP:S.nI}>{n.text}</div>;})}
    <div style={S.sg}>
      <div style={S.sc}><div style={S.sL}>Your Store</div><div style={Object.assign({},S.sV,{color:"#4F8CFF",fontSize:16})}>{sName}</div></div>
      <div style={S.sc}><div style={S.sL}>Today</div><div style={Object.assign({},S.sV,{color:aot?"#34D399":"#6B7186",fontSize:18})}>{aot?"Order "+aot:"None"}</div></div>
      <div style={S.sc}><div style={S.sL}>Completed</div><div style={Object.assign({},S.sV,{color:"#FBBF24"})}>{sub}</div><div style={S.sS}>{my.length} total</div></div>
    </div>
    {aot&&(<div style={S.card}>
      <div style={S.cH}>
        <div>{curStatus==="submitted"?(<Fragment><div style={Object.assign({},S.t,{color:"#34D399"})}>Order {aot} is Submitted</div><div style={S.d}>Your order has been submitted successfully.</div></Fragment>)
          :curStatus==="processed"?(<Fragment><div style={Object.assign({},S.t,{color:"#A855F7"})}>Order {aot} is Processed</div><div style={S.d}>Admin has processed this order.</div></Fragment>)
          :(<Fragment><div style={Object.assign({},S.t,{color:"#FBBF24"})}>Order {aot} - Action Required</div><div style={S.d}>{orderMsgs[aot]||"Please submit your order."}</div></Fragment>)}</div>
        {curStatus!=="submitted"&&curStatus!=="processed"&&<button style={Object.assign({},S.b,S.bP)} onClick={function(){setPage("order-entry");}}>Place Order</button>}
      </div>
    </div>)}
  </div>);
}

/* ═══ ORDER ENTRY ═══ */
function OrderEntry({user,items,orders,setOrders,aot,toast,stores,schedule,orderMsgs}){
  var _s=useState(aot||"A"),sel=_s[0],setSel=_s[1];
  var _cf=useState(false),showConfirm=_cf[0],setShowConfirm=_cf[1];
  var _sort=useState("category"),sortBy=_sort[0],setSortBy=_sort[1];
  var oKey=user.storeId+"_"+dateKey(sel);var lwKey=user.storeId+"_"+lastWeekKey(sel);
  var ex=orders[oKey];var lw=orders[lwKey];var locked=sel!==aot;
  var done=ex&&(ex.status==="submitted"||ex.status==="processed");var ro=locked||done;
  var _q=useState(function(){return ex&&ex.items?Object.assign({},ex.items):items.reduce(function(a,it){a[it.code]=0;return a;},{});}),qty=_q[0],setQty=_q[1];
  var setQ=function(c,v){if(ro)return;setQty(function(p){var n=Object.assign({},p);n[c]=Math.max(0,parseInt(v)||0);return n;});};
  var save=function(){setOrders(function(p){var n=Object.assign({},p);n[oKey]={items:qty,status:"draft",store:user.storeId,type:sel,date:new Date().toISOString()};return n;});toast("Draft saved");};
  var doSubmit=function(){setOrders(function(p){var n=Object.assign({},p);n[oKey]={items:qty,status:"submitted",store:user.storeId,type:sel,date:new Date().toISOString()};return n;});setShowConfirm(false);toast("Order submitted!");};
  var sName=(stores.find(function(s){return s.id===user.storeId;})||{}).name||"";
  var filled=Object.values(qty).filter(function(v){return v>0;}).length;
  var sorted=useMemo(function(){return items.slice().sort(function(a,b){if(sortBy==="name")return a.name.localeCompare(b.name);if(sortBy==="code")return a.code.localeCompare(b.code);var c=(a.category||"").localeCompare(b.category||"");return c!==0?c:a.name.localeCompare(b.name);});},[items,sortBy]);
  return(<div>
    <div style={S.tabs}>{["A","B","C"].map(function(t){return <button key={t} style={Object.assign({},S.tab,sel===t?S.tA:S.tI)} onClick={function(){setSel(t);}}>Order {t}{t===aot?" *":""}</button>;})}</div>
    {locked&&<div style={S.nP}>Order {sel} is locked. Opens on {DAYS[schedule[sel]]||"Unset"}.</div>}
    {done&&<div style={S.nG}>Order {sel} has been {ex.status}. Read only.</div>}
    <div style={S.card}><div style={S.cH}>
      <div><div style={S.t}>Order {sel} - {sName}</div><div style={S.d}>{filled} items | {ex?ex.status:"New"}</div></div>
      <div style={{display:"flex",gap:5,alignItems:"center"}}>
        {!ro&&(<Fragment><button style={Object.assign({},S.b,S.bS)} onClick={save}>Save Draft</button><button style={Object.assign({},S.b,S.bP)} onClick={function(){setShowConfirm(true);}}>Submit</button></Fragment>)}
        <select style={Object.assign({},S.inp,{width:130,padding:"5px 8px",fontSize:11})} value={sortBy} onChange={function(e){setSortBy(e.target.value);}}>
          <option value="category">Sort: Category</option><option value="name">Sort: Name</option><option value="code">Sort: Code</option>
        </select>
      </div>
    </div>
    <div style={S.tw}><table style={S.tbl}>
      <thead><tr><th style={S.th}>Code</th><th style={S.th}>Item</th><th style={S.th}>Category</th><th style={S.th}>Unit</th><th style={Object.assign({},S.th,{textAlign:"center"})}>Last Wk</th><th style={Object.assign({},S.th,{textAlign:"center"})}>Qty</th></tr></thead>
      <tbody>{sorted.map(function(it){var lwQ=lw&&lw.items?lw.items[it.code]:null;return(<tr key={it.code}><td style={S.tm}>{it.code}</td><td style={Object.assign({},S.td,{fontWeight:500})}>{it.name}</td><td style={Object.assign({},S.td,{color:"#9BA1B5"})}>{it.category||"-"}</td><td style={Object.assign({},S.td,{color:"#9BA1B5"})}>{it.unit||"-"}</td><td style={{padding:"7px 10px",borderBottom:"1px solid #2A2E3B",textAlign:"center",fontFamily:"monospace",fontSize:11,color:"#6B7186"}}>{lwQ!=null?lwQ:"-"}</td><td style={Object.assign({},S.td,{textAlign:"center"})}><input style={Object.assign({},S.ni,ro?{opacity:.4}:{})} type="number" min="0" value={qty[it.code]||0} onChange={function(e){setQ(it.code,e.target.value);}} disabled={ro}/></td></tr>);})}</tbody>
    </table></div></div>
    {showConfirm&&(<div style={S.ov} onClick={function(){setShowConfirm(false);}}><div style={Object.assign({},S.mo,{width:420,textAlign:"center"})} onClick={function(e){e.stopPropagation();}}>
      <div style={{fontSize:40,marginBottom:8}}>⚠️</div>
      <div style={{fontSize:16,fontWeight:700,marginBottom:8}}>Submit Order {sel}?</div>
      <div style={{fontSize:13,color:"#9BA1B5",marginBottom:20,lineHeight:1.6}}>Are you sure you want to submit this order?<br/>Once submitted, you will <strong style={{color:"#F87171"}}>not be able to edit</strong> it.</div>
      <div style={{display:"flex",gap:8,justifyContent:"center"}}>
        <button style={Object.assign({},S.b,S.bS,{padding:"9px 24px"})} onClick={function(){setShowConfirm(false);}}>No, Go Back & Edit</button>
        <button style={Object.assign({},S.b,S.bP,{padding:"9px 24px"})} onClick={doSubmit}>Yes, Submit</button>
      </div>
    </div></div>)}
  </div>);
}

/* ═══ ORDER HISTORY ═══ */
function OrderHistory({user,orders,items}){
  var my=Object.entries(orders).filter(function(e){return e[0].indexOf(user.storeId)===0;}).sort(function(a,b){return new Date(b[1].date)-new Date(a[1].date);});
  var _s=useState(null),sel=_s[0],setSel=_s[1];
  var statusBg=function(st){return st==="processed"?S.bgP:st==="submitted"?S.bgG:S.bgY;};
  return(<div><div style={S.card}><div style={S.t}>Past Orders</div>
    {my.length===0?<div style={{textAlign:"center",padding:30,color:"#6B7186"}}>No orders yet</div>:
    <div style={Object.assign({},S.tw,{marginTop:8})}><table style={S.tbl}><thead><tr><th style={S.th}>Order</th><th style={S.th}>Date/Time</th><th style={S.th}>Status</th><th style={S.th}>Items</th><th style={S.th}></th></tr></thead><tbody>
      {my.map(function(e){var k=e[0],o=e[1];return(<tr key={k}><td style={Object.assign({},S.td,{fontWeight:600})}>Order {o.type}</td><td style={S.tm}>{fmtDT(o.date)}</td><td style={S.td}><span style={Object.assign({},S.bg,statusBg(o.status))}>{o.status}</span></td><td style={S.td}>{Object.values(o.items||{}).filter(function(v){return v>0;}).length}</td><td style={S.td}><button style={Object.assign({},S.b,S.bS,{padding:"3px 8px",fontSize:10.5})} onClick={function(){setSel(k);}}>View</button></td></tr>);})}</tbody></table></div>}</div>
    {sel&&orders[sel]&&(<div style={S.ov} onClick={function(){setSel(null);}}><div style={S.mo} onClick={function(e){e.stopPropagation();}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:12}}>Order {orders[sel].type} - {fmtDT(orders[sel].date)}</div>
      <div style={S.tw}><table style={S.tbl}><thead><tr><th style={S.th}>Item</th><th style={Object.assign({},S.th,{textAlign:"right"})}>Qty</th></tr></thead><tbody>
        {items.filter(function(it){return(orders[sel].items[it.code]||0)>0;}).map(function(it){return <tr key={it.code}><td style={S.td}>{it.name}</td><td style={Object.assign({},S.td,{textAlign:"right",fontFamily:"monospace"})}>{orders[sel].items[it.code]}</td></tr>;})}</tbody></table></div>
      <div style={S.mA}><button style={Object.assign({},S.b,S.bS)} onClick={function(){setSel(null);}}>Close</button></div></div></div>)}
  </div>);
}

/* ═══ ORDER MONITOR (with time + process button) ═══ */
function OrderMonitor({orders,setOrders,items,stores,aot,toast}){
  var _f=useState("all"),ft=_f[0],sFt=_f[1];
  var all=Object.entries(orders).sort(function(a,b){return new Date(b[1].date)-new Date(a[1].date);});
  var f=ft==="all"?all:all.filter(function(e){return e[1].type===ft;});
  var statusBg=function(st){return st==="processed"?S.bgP:st==="submitted"?S.bgG:S.bgY;};
  var processAll=function(type){
    var dk=dateKey(type);
    setOrders(function(prev){
      var n=Object.assign({},prev);
      stores.forEach(function(st){var k=st.id+"_"+dk;if(n[k]&&n[k].status==="submitted"){n[k]=Object.assign({},n[k],{status:"processed"});}});
      return n;
    });
    toast("Order "+type+" marked as processed for all stores");
  };
  return(<div>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8,marginBottom:14}}>
      <div style={S.tabs}>{["all","A","B","C"].map(function(t){return <button key={t} style={Object.assign({},S.tab,ft===t?S.tA:S.tI)} onClick={function(){sFt(t);}}>{t==="all"?"All":"Order "+t}</button>;})}</div>
      {ft!=="all"&&<button style={Object.assign({},S.b,S.bW)} onClick={function(){processAll(ft);}}>Process Order {ft} (All Stores)</button>}
    </div>
    <div style={S.card}><div style={S.t}>Submissions ({f.length})</div>
      {f.length===0?<div style={{textAlign:"center",padding:30,color:"#6B7186"}}>No orders</div>:
      <div style={Object.assign({},S.tw,{marginTop:8})}><table style={S.tbl}><thead><tr><th style={S.th}>Store</th><th style={S.th}>Order</th><th style={S.th}>Date / Time</th><th style={S.th}>Status</th><th style={S.th}>Filled</th><th style={S.th}>Action</th></tr></thead><tbody>
        {f.map(function(e){var k=e[0],o=e[1];var sn=(stores.find(function(s){return s.id===o.store;})||{}).name||o.store;return(<tr key={k}>
          <td style={Object.assign({},S.td,{fontWeight:500})}>{sn}</td><td style={S.td}>Order {o.type}</td>
          <td style={S.tm}>{fmtDT(o.date)}</td>
          <td style={S.td}><span style={Object.assign({},S.bg,statusBg(o.status))}>{o.status}</span></td>
          <td style={S.td}>{Object.values(o.items||{}).filter(function(v){return v>0;}).length}/{items.length}</td>
          <td style={S.td}>{o.status==="submitted"&&<button style={Object.assign({},S.b,S.bG,{padding:"3px 8px",fontSize:10})} onClick={function(){setOrders(function(p){var n=Object.assign({},p);n[k]=Object.assign({},n[k],{status:"processed"});return n;});toast("Processed");}}>Process</button>}</td>
        </tr>);})}</tbody></table></div>}</div>
  </div>);
}

/* ═══ CONSOLIDATED ═══ */
function Consolidated({orders,setOrders,items,aot,toast,stores}){
  var _v=useState(aot||"A"),vt=_v[0],sVt=_v[1];
  var _e=useState(null),eSt=_e[0],sES=_e[1];var _eq=useState({}),eQ=_eq[0],sEQ=_eq[1];
  var dk=dateKey(vt);
  var startE=function(sid){var k=sid+"_"+dk;var ex=orders[k]&&orders[k].items?orders[k].items:{};var q={};items.forEach(function(it){q[it.code]=ex[it.code]||0;});sEQ(q);sES(sid);};
  var saveE=function(){var k=eSt+"_"+dk;setOrders(function(p){var n=Object.assign({},p);n[k]=Object.assign({},p[k]||{},{items:Object.assign({},eQ),status:(p[k]||{}).status||"submitted",store:eSt,type:vt,date:(p[k]||{}).date||new Date().toISOString()});return n;});toast("Updated");sES(null);sEQ({});};
  var cancelE=function(){sES(null);sEQ({});};
  return(<div>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:6,marginBottom:14}}>
      <div style={S.tabs}>{["A","B","C"].map(function(t){return <button key={t} style={Object.assign({},S.tab,vt===t?S.tA:S.tI)} onClick={function(){sVt(t);cancelE();}}>Order {t}</button>;})}</div>
      <div style={{display:"flex",gap:5}}>{eSt&&<Fragment><button style={Object.assign({},S.b,S.bG)} onClick={saveE}>Save</button><button style={Object.assign({},S.b,S.bS)} onClick={cancelE}>Cancel</button></Fragment>}</div>
    </div>
    {eSt&&<div style={S.nI}>Editing: {(stores.find(function(s){return s.id===eSt;})||{}).name}</div>}
    <div style={Object.assign({},S.card,{padding:0})}>
      <div style={{padding:"12px 14px",borderBottom:"1px solid #2A2E3B"}}><div style={S.t}>Consolidated Order {vt}</div><div style={S.d}>Click edit icon on store column to modify</div></div>
      <div style={Object.assign({},S.tw,{border:"none",borderRadius:0})}><table style={S.tbl}><thead><tr><th style={S.th}>Code</th><th style={S.th}>Item</th>
        {stores.map(function(st){return(<th key={st.id} style={Object.assign({},S.th,{textAlign:"center",minWidth:80})}><div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:2}}><span>{st.name.split(" ")[0]}</span><button style={Object.assign({},S.eB,eSt===st.id?{color:"#4F8CFF"}:{})} onClick={function(){eSt===st.id?cancelE():startE(st.id);}}><Ic type="edit" size={11}/></button></div></th>);})}<th style={Object.assign({},S.th,{textAlign:"center",background:"#272B38"})}>Total</th></tr></thead>
        <tbody>{items.map(function(it){
          var qs=stores.map(function(st){if(eSt===st.id)return eQ[it.code]||0;var k=st.id+"_"+dk;return orders[k]&&orders[k].items?(orders[k].items[it.code]||0):0;});
          var tot=qs.reduce(function(a,b){return a+b;},0);
          return(<tr key={it.code}><td style={S.tm}>{it.code}</td><td style={Object.assign({},S.td,{fontWeight:500})}>{it.name}</td>
            {stores.map(function(st,idx){var isE=eSt===st.id;return(<td key={st.id} style={Object.assign({},S.td,{textAlign:"center"},isE?S.cE:{})}>
              {isE?<input style={S.ie} type="number" min="0" value={eQ[it.code]||0} onChange={function(e){var v=Math.max(0,parseInt(e.target.value)||0);sEQ(function(p){var n=Object.assign({},p);n[it.code]=v;return n;});}}/>
              :<span style={{fontFamily:"monospace",fontSize:11,color:qs[idx]>0?"#E8EAF0":"#6B7186"}}>{qs[idx]}</span>}</td>);})}
            <td style={Object.assign({},S.td,{textAlign:"center",fontFamily:"monospace",fontWeight:700,color:tot>0?"#4F8CFF":"#6B7186"})}>{tot}</td></tr>);
        })}</tbody></table></div></div>
  </div>);
}

/* ═══ SUPPLIER ORDERS (Split + Email) ═══ */
function SupplierOrders({orders,setOrders,items,aot,toast,stores,suppliers}){
  var _v=useState(aot||"A"),vt=_v[0],sVt=_v[1];
  var _sent=useState({}),sent=_sent[0],sSent=_sent[1];
  var dk=dateKey(vt);
  // Compute totals per item across all stores
  var totals=useMemo(function(){var t={};items.forEach(function(it){var sum=0;stores.forEach(function(st){var k=st.id+"_"+dk;sum+=(orders[k]&&orders[k].items?orders[k].items[it.code]:0)||0;});if(sum>0)t[it.code]=sum;});return t;},[items,stores,orders,dk]);
  // Group by supplier
  var supplierGroups=useMemo(function(){return suppliers.map(function(sup){var supItems=items.filter(function(it){return sup.items.indexOf(it.code)>=0&&totals[it.code]>0;});return{supplier:sup,items:supItems};}).filter(function(g){return g.items.length>0;});},[suppliers,items,totals]);
  // Unassigned items
  var assigned={};suppliers.forEach(function(s){s.items.forEach(function(c){assigned[c]=true;});});
  var unassigned=items.filter(function(it){return totals[it.code]>0&&!assigned[it.code];});

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
  var processOrder=function(){
    setOrders(function(prev){
      var n=Object.assign({},prev);
      stores.forEach(function(st){var k=st.id+"_"+dk;if(n[k]&&(n[k].status==="submitted"||n[k].status==="draft")){n[k]=Object.assign({},n[k],{status:"processed"});}});
      return n;
    });
    toast("Order "+vt+" marked processed for all stores");
  };
  var allSent=supplierGroups.every(function(g){return sent[g.supplier.id+"_"+vt];});

  return(<div>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:6,marginBottom:14}}>
      <div style={S.tabs}>{["A","B","C"].map(function(t){return <button key={t} style={Object.assign({},S.tab,vt===t?S.tA:S.tI)} onClick={function(){sVt(t);}}>Order {t}</button>;})}</div>
      {allSent&&supplierGroups.length>0&&<button style={Object.assign({},S.b,S.bG)} onClick={processOrder}>Mark All Processed</button>}
    </div>
    <div style={S.nI}>Split Order {vt} by supplier. Send emails, then mark as processed.</div>
    {supplierGroups.length===0&&<div style={S.card}><div style={{textAlign:"center",padding:30,color:"#6B7186"}}>No order data for Order {vt}. Submit orders first.</div></div>}
    {supplierGroups.map(function(g){
      var isSent=sent[g.supplier.id+"_"+vt];
      return(<div key={g.supplier.id} style={Object.assign({},S.card,{border:isSent?"1px solid rgba(52,211,153,0.3)":"1px solid #2A2E3B"})}>
        <div style={S.cH}>
          <div><div style={S.t}>{g.supplier.name}</div><div style={S.d}>{g.supplier.email} | {g.supplier.phone}</div></div>
          <div style={{display:"flex",gap:5,alignItems:"center"}}>
            {isSent?<span style={Object.assign({},S.bg,S.bgG)}>Email Sent</span>
            :<button style={Object.assign({},S.b,S.bP)} onClick={function(){sendEmail(g.supplier,g.items);}}><Ic type="mail" size={13}/>Send Email</button>}
          </div>
        </div>
        <div style={S.tw}><table style={S.tbl}><thead><tr><th style={S.th}>Code</th><th style={S.th}>Item</th><th style={S.th}>Category</th><th style={S.th}>Unit</th><th style={Object.assign({},S.th,{textAlign:"center"})}>Total Qty</th>
          {stores.map(function(st){return <th key={st.id} style={Object.assign({},S.th,{textAlign:"center",fontSize:9})}>{st.name.split(" ")[0]}</th>;})}</tr></thead>
          <tbody>{g.items.map(function(it){return(<tr key={it.code}><td style={S.tm}>{it.code}</td><td style={Object.assign({},S.td,{fontWeight:500})}>{it.name}</td><td style={Object.assign({},S.td,{color:"#9BA1B5"})}>{it.category}</td><td style={Object.assign({},S.td,{color:"#9BA1B5"})}>{it.unit}</td>
            <td style={Object.assign({},S.td,{textAlign:"center",fontFamily:"monospace",fontWeight:700,color:"#4F8CFF"})}>{totals[it.code]}</td>
            {stores.map(function(st){var k=st.id+"_"+dk;var q=orders[k]&&orders[k].items?orders[k].items[it.code]||0:0;return <td key={st.id} style={Object.assign({},S.td,{textAlign:"center",fontFamily:"monospace",fontSize:11,color:q>0?"#E8EAF0":"#353A4A"})}>{q}</td>;})}
          </tr>);})}</tbody></table></div>
      </div>);
    })}
    {unassigned.length>0&&(<div style={Object.assign({},S.card,{borderColor:"rgba(248,113,113,0.3)"})}><div style={S.cH}><div><div style={Object.assign({},S.t,{color:"#F87171"})}>Unassigned Items</div><div style={S.d}>These items are not mapped to any supplier. Assign in Supplier Management.</div></div></div>
      <div style={S.tw}><table style={S.tbl}><thead><tr><th style={S.th}>Code</th><th style={S.th}>Item</th><th style={Object.assign({},S.th,{textAlign:"center"})}>Total Qty</th></tr></thead><tbody>
        {unassigned.map(function(it){return <tr key={it.code}><td style={S.tm}>{it.code}</td><td style={S.td}>{it.name}</td><td style={Object.assign({},S.td,{textAlign:"center",fontFamily:"monospace",fontWeight:700})}>{totals[it.code]}</td></tr>;})}</tbody></table></div></div>)}
  </div>);
}

/* ═══ ITEM MASTER (no category rows) ═══ */
function ItemMaster({items,setItems,toast}){
  var _a=useState(false),shA=_a[0],sA=_a[1];var _u=useState(false),shU=_u[0],sU=_u[1];
  var _n=useState({code:"",name:"",category:"",unit:""}),nI=_n[0],sNI=_n[1];
  var _s=useState(""),sr=_s[0],sSr=_s[1];var _c=useState(null),csv=_c[0],sC=_c[1];var _m=useState("merge"),md=_m[0],sMd=_m[1];var fR=useRef(null);
  var _sort=useState("category"),sortBy=_sort[0],setSortBy=_sort[1];
  var fl=items.filter(function(it){var q=sr.toLowerCase();return it.name.toLowerCase().indexOf(q)>=0||it.code.toLowerCase().indexOf(q)>=0||(it.category||"").toLowerCase().indexOf(q)>=0;});
  var sorted=useMemo(function(){return fl.slice().sort(function(a,b){if(sortBy==="name")return a.name.localeCompare(b.name);if(sortBy==="code")return a.code.localeCompare(b.code);var c=(a.category||"").localeCompare(b.category||"");return c!==0?c:a.name.localeCompare(b.name);});},[fl,sortBy]);
  var add=function(){if(!nI.code||!nI.name){toast("Code and Name required",true);return;}if(items.find(function(i){return i.code===nI.code;})){toast("Code exists",true);return;}setItems(function(p){return p.concat([Object.assign({},nI)]);});sNI({code:"",name:"",category:"",unit:""});sA(false);toast("Item added");};
  var rm=function(c){setItems(function(p){return p.filter(function(i){return i.code!==c;});});toast("Removed");};
  var hF=function(e){var f=e.target.files&&e.target.files[0];if(!f)return;var r=new FileReader();r.onload=function(ev){var p=parseCSV(ev.target.result);if(!p.length){toast("Could not parse CSV",true);return;}sC(p);sU(true);};r.readAsText(f);e.target.value="";};
  var cfU=function(){if(!csv)return;if(md==="replace"){setItems(csv);toast("Replaced "+csv.length+" items");}else{setItems(function(p){var ex={};p.forEach(function(i){ex[i.code]=true;});return p.concat(csv.filter(function(i){return!ex[i.code];}));});toast("Merged "+csv.length+" items");}sC(null);sU(false);};
  return(<div><div style={S.card}><div style={S.cH}>
    <div><div style={S.t}>Item Master</div><div style={S.d}>{items.length} items</div></div>
    <div style={{display:"flex",gap:5,alignItems:"center",flexWrap:"wrap"}}>
      <div style={S.sB}><Ic type="search" size={13}/><input style={S.sI} placeholder="Search..." value={sr} onChange={function(e){sSr(e.target.value);}}/></div>
      <select style={Object.assign({},S.inp,{width:130,padding:"5px 8px",fontSize:11})} value={sortBy} onChange={function(e){setSortBy(e.target.value);}}>
        <option value="category">Sort: Category</option><option value="name">Sort: Name</option><option value="code">Sort: Code</option>
      </select>
      <button style={Object.assign({},S.b,S.bS)} onClick={function(){fR.current&&fR.current.click();}}>Upload CSV</button>
      <button style={Object.assign({},S.b,S.bP)} onClick={function(){sA(true);}}>+ Add</button>
      <input ref={fR} type="file" accept=".csv,.txt" style={{display:"none"}} onChange={hF}/>
    </div></div>
    <div style={S.tw}><table style={S.tbl}><thead><tr><th style={S.th}>Code</th><th style={S.th}>Name</th><th style={S.th}>Category</th><th style={S.th}>Unit</th><th style={Object.assign({},S.th,{width:40})}></th></tr></thead>
      <tbody>{sorted.map(function(it){return(<tr key={it.code}><td style={S.tm}>{it.code}</td><td style={Object.assign({},S.td,{fontWeight:500})}>{it.name}</td><td style={Object.assign({},S.td,{color:"#9BA1B5"})}>{it.category||"-"}</td><td style={Object.assign({},S.td,{color:"#9BA1B5"})}>{it.unit||"-"}</td><td style={S.td}><button style={Object.assign({},S.b,S.bD,{padding:"2px 6px",fontSize:10})} onClick={function(){rm(it.code);}}>Del</button></td></tr>);})}{sorted.length===0&&<tr><td colSpan={5} style={Object.assign({},S.td,{textAlign:"center",padding:24,color:"#6B7186"})}>No items</td></tr>}</tbody></table></div></div>
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
      <div style={{fontSize:11,color:"#9BA1B5",marginBottom:6}}>Preview (first 8):</div>
      <div style={Object.assign({},S.tw,{maxHeight:180})}><table style={S.tbl}><thead><tr><th style={S.th}>Code</th><th style={S.th}>Name</th><th style={S.th}>Category</th><th style={S.th}>Unit</th></tr></thead><tbody>
        {csv.slice(0,8).map(function(it,i){return <tr key={i}><td style={S.tm}>{it.code}</td><td style={S.td}>{it.name}</td><td style={S.td}>{it.category||"-"}</td><td style={S.td}>{it.unit||"-"}</td></tr>;})}</tbody></table></div>
      <div style={S.mA}><button style={Object.assign({},S.b,S.bS)} onClick={function(){sU(false);sC(null);}}>Cancel</button><button style={Object.assign({},S.b,S.bP)} onClick={cfU}>Confirm</button></div></div></div>)}
  </div>);
}

/* ═══ USER MANAGEMENT (with phone) ═══ */
function UserMgmt({users,setUsers,toast,stores}){
  var _a=useState(false),shA=_a[0],sA=_a[1];
  var _n=useState({username:"",password:"",name:"",phone:"",role:"manager",storeId:stores[0]?stores[0].id:"S1",active:true}),nu=_n[0],sN=_n[1];
  var _r=useState(null),rP=_r[0],sRP=_r[1];var _pw=useState(""),nPw=_pw[0],sNP=_pw[1];
  var add=function(){if(!nu.username||!nu.password||!nu.name||!nu.phone){toast("All fields including phone required",true);return;}if(users.find(function(u){return u.username===nu.username;})){toast("Username exists",true);return;}setUsers(function(p){return p.concat([Object.assign({},nu)]);});sN({username:"",password:"",name:"",phone:"",role:"manager",storeId:stores[0]?stores[0].id:"S1",active:true});sA(false);toast("User created");};
  var toggle=function(un){setUsers(function(p){return p.map(function(u){return u.username===un?Object.assign({},u,{active:!u.active}):u;});});toast("Updated");};
  var doReset=function(){if(nPw.length<6){toast("Min 6 chars",true);return;}setUsers(function(p){return p.map(function(u){return u.username===rP?Object.assign({},u,{password:nPw}):u;});});sRP(null);sNP("");toast("Password reset");};
  return(<div><div style={S.card}><div style={S.cH}><div><div style={S.t}>Users</div><div style={S.d}>{users.length} total</div></div><button style={Object.assign({},S.b,S.bP)} onClick={function(){sA(true);}}>+ Add</button></div>
    <div style={S.tw}><table style={S.tbl}><thead><tr><th style={S.th}>Name</th><th style={S.th}>Username</th><th style={S.th}>Phone</th><th style={S.th}>Role</th><th style={S.th}>Store</th><th style={S.th}>Status</th><th style={S.th}>Actions</th></tr></thead><tbody>
      {users.map(function(u){var sn=u.storeId?((stores.find(function(s){return s.id===u.storeId;})||{}).name||u.storeId):"-";return(<tr key={u.username}>
        <td style={Object.assign({},S.td,{fontWeight:500})}>{u.name}</td><td style={S.tm}>{u.username}</td><td style={S.tm}>{u.phone||"-"}</td>
        <td style={S.td}><span style={Object.assign({},S.bg,u.role==="admin"?S.bgB:S.bgG)}>{u.role}</span></td><td style={S.td}>{sn}</td>
        <td style={S.td}><span style={Object.assign({},S.bg,u.active?S.bgG:S.bgR)}>{u.active?"Active":"Off"}</span></td>
        <td style={S.td}><div style={{display:"flex",gap:3}}>
          <button style={Object.assign({},S.b,S.bS,{padding:"2px 6px",fontSize:10})} onClick={function(){toggle(u.username);}}>{u.active?"Disable":"Enable"}</button>
          <button style={Object.assign({},S.b,S.bS,{padding:"2px 6px",fontSize:10})} onClick={function(){sRP(u.username);sNP("");}}>Reset PW</button></div></td></tr>);})}</tbody></table></div></div>
    {shA&&(<div style={S.ov} onClick={function(){sA(false);}}><div style={S.mo} onClick={function(e){e.stopPropagation();}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:12}}>Create User</div>
      <div style={S.fg}><div style={S.lb}>Name *</div><input style={S.inp} value={nu.name} onChange={function(e){sN(Object.assign({},nu,{name:e.target.value}));}}/></div>
      <div style={S.fr}><div style={Object.assign({},S.fg,{flex:1})}><div style={S.lb}>Username *</div><input style={S.inp} value={nu.username} onChange={function(e){sN(Object.assign({},nu,{username:e.target.value}));}}/></div>
        <div style={Object.assign({},S.fg,{flex:1})}><div style={S.lb}>Password *</div><input style={S.inp} type="password" value={nu.password} onChange={function(e){sN(Object.assign({},nu,{password:e.target.value}));}}/></div></div>
      <div style={S.fr}><div style={Object.assign({},S.fg,{flex:1})}><div style={S.lb}>Phone *</div><input style={S.inp} value={nu.phone} onChange={function(e){sN(Object.assign({},nu,{phone:e.target.value}));}} placeholder="555-0100"/></div>
        <div style={Object.assign({},S.fg,{flex:1})}><div style={S.lb}>Role</div><select style={S.inp} value={nu.role} onChange={function(e){sN(Object.assign({},nu,{role:e.target.value}));}}><option value="manager">Manager</option><option value="admin">Admin</option></select></div></div>
      <div style={S.fg}><div style={S.lb}>Store</div><select style={S.inp} value={nu.storeId} onChange={function(e){sN(Object.assign({},nu,{storeId:e.target.value}));}}>{stores.map(function(s){return <option key={s.id} value={s.id}>{s.name}</option>;})}</select></div>
      <div style={S.mA}><button style={Object.assign({},S.b,S.bS)} onClick={function(){sA(false);}}>Cancel</button><button style={Object.assign({},S.b,S.bP)} onClick={add}>Create</button></div></div></div>)}
    {rP&&(<div style={S.ov} onClick={function(){sRP(null);}}><div style={S.mo} onClick={function(e){e.stopPropagation();}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:12}}>Reset Password - {rP}</div>
      <div style={S.fg}><div style={S.lb}>New Password (min 6)</div><input style={S.inp} type="password" value={nPw} onChange={function(e){sNP(e.target.value);}}/></div>
      <div style={S.mA}><button style={Object.assign({},S.b,S.bS)} onClick={function(){sRP(null);}}>Cancel</button><button style={Object.assign({},S.b,S.bP)} onClick={doReset}>Reset</button></div></div></div>)}
  </div>);
}

/* ═══ SUPPLIER MANAGEMENT ═══ */
function SupplierMgmt({suppliers,setSuppliers,items,toast}){
  var _a=useState(false),shA=_a[0],sA=_a[1];
  var _e=useState(null),eId=_e[0],sEId=_e[1];
  var _ed=useState(null),edSup=_ed[0],sEdSup=_ed[1];
  var _ef=useState({name:"",email:"",phone:""}),edF=_ef[0],sEdF=_ef[1];
  var _n=useState({id:"",name:"",email:"",phone:"",items:[]}),nS=_n[0],sNS=_n[1];
  var add=function(){if(!nS.id||!nS.name||!nS.email){toast("ID, Name, Email required",true);return;}if(suppliers.find(function(s){return s.id===nS.id;})){toast("ID exists",true);return;}setSuppliers(function(p){return p.concat([Object.assign({},nS)]);});sNS({id:"",name:"",email:"",phone:"",items:[]});sA(false);toast("Supplier added");};
  var rm=function(id){setSuppliers(function(p){return p.filter(function(s){return s.id!==id;});});toast("Removed");};
  var toggleItem=function(supId,itemCode){setSuppliers(function(p){return p.map(function(s){if(s.id!==supId)return s;var its=s.items.indexOf(itemCode)>=0?s.items.filter(function(c){return c!==itemCode;}):s.items.concat([itemCode]);return Object.assign({},s,{items:its});});});};
  var startEdit=function(s){sEdSup(s.id);sEdF({name:s.name,email:s.email,phone:s.phone||""});};
  var saveEdit=function(){if(!edF.name||!edF.email){toast("Name and Email required",true);return;}setSuppliers(function(p){return p.map(function(s){return s.id===edSup?Object.assign({},s,{name:edF.name,email:edF.email,phone:edF.phone}):s;});});sEdSup(null);toast("Supplier updated");};
  var editSup=eId?suppliers.find(function(s){return s.id===eId;}):null;
  return(<div>
    <div style={S.card}><div style={S.cH}><div><div style={S.t}>Suppliers</div><div style={S.d}>{suppliers.length} suppliers</div></div><button style={Object.assign({},S.b,S.bP)} onClick={function(){sA(true);}}>+ Add</button></div>
      <div style={S.tw}><table style={S.tbl}><thead><tr><th style={S.th}>ID</th><th style={S.th}>Name</th><th style={S.th}>Email</th><th style={S.th}>Phone</th><th style={S.th}>Items</th><th style={Object.assign({},S.th,{width:200})}>Actions</th></tr></thead><tbody>
        {suppliers.map(function(s){return(<tr key={s.id}><td style={S.tm}>{s.id}</td><td style={Object.assign({},S.td,{fontWeight:500})}>{s.name}</td><td style={S.tm}>{s.email}</td><td style={S.tm}>{s.phone}</td><td style={S.td}><span style={Object.assign({},S.bg,S.bgB)}>{s.items.length} items</span></td>
          <td style={S.td}><div style={{display:"flex",gap:3}}><button style={Object.assign({},S.b,S.bS,{padding:"2px 6px",fontSize:10})} onClick={function(){startEdit(s);}}>Edit</button><button style={Object.assign({},S.b,S.bS,{padding:"2px 6px",fontSize:10})} onClick={function(){sEId(s.id);}}>Assign</button><button style={Object.assign({},S.b,S.bD,{padding:"2px 6px",fontSize:10})} onClick={function(){rm(s.id);}}>Del</button></div></td></tr>);})}</tbody></table></div></div>
    {shA&&(<div style={S.ov} onClick={function(){sA(false);}}><div style={S.mo} onClick={function(e){e.stopPropagation();}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:12}}>Add Supplier</div>
      <div style={S.fr}><div style={Object.assign({},S.fg,{flex:1})}><div style={S.lb}>ID *</div><input style={S.inp} value={nS.id} onChange={function(e){sNS(Object.assign({},nS,{id:e.target.value}));}} placeholder="SUP4"/></div>
        <div style={Object.assign({},S.fg,{flex:1})}><div style={S.lb}>Name *</div><input style={S.inp} value={nS.name} onChange={function(e){sNS(Object.assign({},nS,{name:e.target.value}));}}/></div></div>
      <div style={S.fr}><div style={Object.assign({},S.fg,{flex:1})}><div style={S.lb}>Email *</div><input style={S.inp} value={nS.email} onChange={function(e){sNS(Object.assign({},nS,{email:e.target.value}));}}/></div>
        <div style={Object.assign({},S.fg,{flex:1})}><div style={S.lb}>Phone</div><input style={S.inp} value={nS.phone} onChange={function(e){sNS(Object.assign({},nS,{phone:e.target.value}));}}/></div></div>
      <div style={S.mA}><button style={Object.assign({},S.b,S.bS)} onClick={function(){sA(false);}}>Cancel</button><button style={Object.assign({},S.b,S.bP)} onClick={add}>Add</button></div></div></div>)}
    {editSup&&(<div style={S.ov} onClick={function(){sEId(null);}}><div style={Object.assign({},S.mo,S.mW)} onClick={function(e){e.stopPropagation();}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:12}}>Assign Items to {editSup.name}</div>
      <div style={{fontSize:11,color:"#9BA1B5",marginBottom:10}}>Check items this supplier provides:</div>
      <div style={Object.assign({},S.tw,{maxHeight:350})}><table style={S.tbl}><thead><tr><th style={Object.assign({},S.th,{width:40})}></th><th style={S.th}>Code</th><th style={S.th}>Name</th><th style={S.th}>Category</th></tr></thead><tbody>
        {items.map(function(it){var checked=editSup.items.indexOf(it.code)>=0;return(<tr key={it.code} style={checked?{background:"rgba(79,140,255,0.05)"}:{}}><td style={S.td}><input type="checkbox" checked={checked} onChange={function(){toggleItem(editSup.id,it.code);}}/></td><td style={S.tm}>{it.code}</td><td style={S.td}>{it.name}</td><td style={Object.assign({},S.td,{color:"#9BA1B5"})}>{it.category}</td></tr>);})}</tbody></table></div>
      <div style={S.mA}><button style={Object.assign({},S.b,S.bP)} onClick={function(){sEId(null);toast("Assignments saved");}}>Done</button></div></div></div>)}
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
  var add=function(){if(!tx.trim()){toast("Text required",true);return;}setNotifs(function(p){return[{id:Date.now(),text:tx.trim(),type:ty,date:new Date().toISOString().slice(0,10)}].concat(p);});sT("");sS(false);toast("Posted");};
  var rm=function(id){setNotifs(function(p){return p.filter(function(n){return n.id!==id;});});toast("Removed");};
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
  var startE=function(s){sEId(s.id);sEN(s.name);};var saveE=function(){if(!eN.trim()){toast("Name required",true);return;}setStores(function(p){return p.map(function(s){return s.id===eId?Object.assign({},s,{name:eN.trim()}):s;});});sEId(null);toast("Updated");};
  var addS=function(){if(!ns.id||!ns.name){toast("ID and Name required",true);return;}if(stores.find(function(s){return s.id===ns.id;})){toast("ID exists",true);return;}setStores(function(p){return p.concat([{id:ns.id.trim(),name:ns.name.trim()}]);});sN({id:"",name:""});sS(false);toast("Store added");};
  var rmS=function(id){if(stores.length<=1){toast("Keep at least 1",true);return;}setStores(function(p){return p.filter(function(s){return s.id!==id;});});toast("Removed");};
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
    var topItems=Object.entries(itemTotals).map(function(e){var it=items.find(function(i){return i.code===e[0];});return{code:e[0],name:it?it.name:e[0],category:it?it.category:"",qty:e[1].qty,orders:e[1].orders};}).sort(function(a,b){return b.qty-a.qty;});
    var catList=Object.entries(catTotals).map(function(e){return{category:e[0],qty:e[1].qty,uniqueItems:Object.keys(e[1].items).length};}).sort(function(a,b){return b.qty-a.qty;});
    var storeList=Object.entries(storeTotals).map(function(e){var st=stores.find(function(s){return s.id===e[0];});return Object.assign({id:e[0],name:st?st.name:e[0]},e[1]);});
    return{topItems:topItems,catList:catList,storeList:storeList,orderCount:orderCount};
  },[orders,items,stores]);

  return(<div>
    <div style={S.tabs}>
      {[["top","Top Items"],["category","By Category"],["store","By Store"]].map(function(t){return <button key={t[0]} style={Object.assign({},S.tab,tab===t[0]?S.tA:S.tI)} onClick={function(){sTab(t[0]);}}>{t[1]}</button>;})}
    </div>
    <div style={S.sg}>
      <div style={S.sc}><div style={S.sL}>Total Orders</div><div style={Object.assign({},S.sV,{color:"#4F8CFF"})}>{agg.orderCount}</div></div>
      <div style={S.sc}><div style={S.sL}>Unique Items Ordered</div><div style={Object.assign({},S.sV,{color:"#34D399"})}>{agg.topItems.length}</div></div>
      <div style={S.sc}><div style={S.sL}>Categories Active</div><div style={Object.assign({},S.sV,{color:"#FBBF24"})}>{agg.catList.length}</div></div>
    </div>

    {tab==="top"&&(<div style={S.card}><div style={S.t}>Most Ordered Items</div><div style={S.d}>Ranked by total quantity across all orders</div>
      {agg.topItems.length===0?<div style={{textAlign:"center",padding:30,color:"#6B7186"}}>No order data yet. Submit some orders first.</div>:
      <div style={Object.assign({},S.tw,{marginTop:10})}><table style={S.tbl}><thead><tr><th style={S.th}>#</th><th style={S.th}>Code</th><th style={S.th}>Item</th><th style={S.th}>Category</th><th style={Object.assign({},S.th,{textAlign:"right"})}>Total Qty</th><th style={Object.assign({},S.th,{textAlign:"right"})}>In Orders</th><th style={S.th}>Bar</th></tr></thead><tbody>
        {agg.topItems.slice(0,20).map(function(it,i){var maxQ=agg.topItems[0].qty;var pct=maxQ>0?Math.round(it.qty/maxQ*100):0;return(<tr key={it.code}><td style={Object.assign({},S.td,{fontWeight:700,color:"#6B7186"})}>{i+1}</td><td style={S.tm}>{it.code}</td><td style={Object.assign({},S.td,{fontWeight:500})}>{it.name}</td><td style={Object.assign({},S.td,{color:"#9BA1B5"})}>{it.category}</td>
          <td style={Object.assign({},S.td,{textAlign:"right",fontFamily:"monospace",fontWeight:700,color:"#4F8CFF"})}>{it.qty}</td>
          <td style={Object.assign({},S.td,{textAlign:"right",fontFamily:"monospace"})}>{it.orders}</td>
          <td style={Object.assign({},S.td,{width:120})}><div style={{height:8,borderRadius:4,background:"#1F2330",overflow:"hidden"}}><div style={{height:"100%",width:pct+"%",background:"linear-gradient(90deg,#4F8CFF,#7C5CFF)",borderRadius:4}}/></div></td></tr>);})}</tbody></table></div>}</div>)}

    {tab==="category"&&(<div style={S.card}><div style={S.t}>Orders by Category</div>
      {agg.catList.length===0?<div style={{textAlign:"center",padding:30,color:"#6B7186"}}>No data</div>:
      <div style={Object.assign({},S.tw,{marginTop:10})}><table style={S.tbl}><thead><tr><th style={S.th}>Category</th><th style={Object.assign({},S.th,{textAlign:"right"})}>Total Qty</th><th style={Object.assign({},S.th,{textAlign:"right"})}>Unique Items</th><th style={S.th}>Bar</th></tr></thead><tbody>
        {agg.catList.map(function(c){var maxQ=agg.catList[0].qty;var pct=maxQ>0?Math.round(c.qty/maxQ*100):0;return(<tr key={c.category}><td style={Object.assign({},S.td,{fontWeight:600})}>{c.category}</td>
          <td style={Object.assign({},S.td,{textAlign:"right",fontFamily:"monospace",fontWeight:700,color:"#34D399"})}>{c.qty}</td>
          <td style={Object.assign({},S.td,{textAlign:"right",fontFamily:"monospace"})}>{c.uniqueItems}</td>
          <td style={Object.assign({},S.td,{width:120})}><div style={{height:8,borderRadius:4,background:"#1F2330",overflow:"hidden"}}><div style={{height:"100%",width:pct+"%",background:"linear-gradient(90deg,#34D399,#059669)",borderRadius:4}}/></div></td></tr>);})}</tbody></table></div>}</div>)}

    {tab==="store"&&(<div style={S.card}><div style={S.t}>Orders by Store</div>
      {agg.storeList.length===0?<div style={{textAlign:"center",padding:30,color:"#6B7186"}}>No data</div>:
      <div style={Object.assign({},S.tw,{marginTop:10})}><table style={S.tbl}><thead><tr><th style={S.th}>Store</th><th style={Object.assign({},S.th,{textAlign:"center"})}>Total</th><th style={Object.assign({},S.th,{textAlign:"center"})}>Submitted</th><th style={Object.assign({},S.th,{textAlign:"center"})}>Processed</th><th style={Object.assign({},S.th,{textAlign:"center"})}>Drafts</th></tr></thead><tbody>
        {agg.storeList.map(function(s){return(<tr key={s.id}><td style={Object.assign({},S.td,{fontWeight:500})}>{s.name}</td>
          <td style={Object.assign({},S.td,{textAlign:"center",fontFamily:"monospace",fontWeight:700})}>{s.total}</td>
          <td style={Object.assign({},S.td,{textAlign:"center",fontFamily:"monospace",color:"#34D399"})}>{s.submitted||0}</td>
          <td style={Object.assign({},S.td,{textAlign:"center",fontFamily:"monospace",color:"#A855F7"})}>{s.processed||0}</td>
          <td style={Object.assign({},S.td,{textAlign:"center",fontFamily:"monospace",color:"#FBBF24"})}>{s.draft||0}</td></tr>);})}</tbody></table></div>}</div>)}
  </div>);
}

/* ═══ SETTINGS (editable schedule + order messages) ═══ */
function Settings({stores,schedule,setSchedule,orderMsgs,setOrderMsgs,toast,logo,setLogo,logoRef,handleLogo}){
  var _e=useState(null),ed=_e[0],sEd=_e[1];var _v=useState(0),eV=_v[0],sEV=_v[1];
  var _em=useState(null),emT=_em[0],sEmT=_em[1];var _emV=useState(""),emV=_emV[0],sEmV=_emV[1];
  var saveDay=function(){var conflict=Object.keys(schedule).find(function(k){return k!==ed&&schedule[k]===eV;});if(conflict){toast("Day used by Order "+conflict,true);return;}setSchedule(function(p){var n=Object.assign({},p);n[ed]=eV;return n;});toast("Schedule updated");sEd(null);};
  var saveMsg=function(){setOrderMsgs(function(p){var n=Object.assign({},p);n[emT]=emV;return n;});toast("Message updated for Order "+emT);sEmT(null);};
  return(<div>
    <div style={S.card}><div style={S.cH}><div><div style={S.t}>Order Schedule</div><div style={S.d}>Edit day for each order type</div></div></div>
      <div style={Object.assign({},S.tw,{marginTop:4})}><table style={S.tbl}><thead><tr><th style={S.th}>Order</th><th style={S.th}>Day</th><th style={Object.assign({},S.th,{width:120})}>Actions</th></tr></thead><tbody>
        {["A","B","C"].map(function(t){var isE=ed===t;return(<tr key={t}><td style={Object.assign({},S.td,{fontWeight:600,fontSize:13})}>Order {t}</td><td style={S.td}>{isE?<select style={Object.assign({},S.inp,{width:140})} value={eV} onChange={function(e){sEV(parseInt(e.target.value));}}>{DAYS.map(function(d,i){return <option key={i} value={i}>{d}</option>;})}</select>:<span>{DAYS[schedule[t]]||"Unset"}</span>}</td>
          <td style={S.td}>{isE?<div style={{display:"flex",gap:3}}><button style={Object.assign({},S.b,S.bG,{padding:"3px 8px",fontSize:10})} onClick={saveDay}>Save</button><button style={Object.assign({},S.b,S.bS,{padding:"3px 8px",fontSize:10})} onClick={function(){sEd(null);}}>Cancel</button></div>:<button style={Object.assign({},S.b,S.bS,{padding:"3px 8px",fontSize:10})} onClick={function(){sEd(t);sEV(schedule[t]);}}><Ic type="edit" size={11}/> Edit</button>}</td></tr>);})}</tbody></table></div></div>

    <div style={S.card}><div style={S.cH}><div><div style={S.t}>Order Messages</div><div style={S.d}>Custom instructions shown to managers for each order type</div></div></div>
      {["A","B","C"].map(function(t){var isE=emT===t;return(<div key={t} style={{padding:"10px 0",borderBottom:"1px solid #2A2E3B"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
          <div style={{flex:1}}><div style={{fontSize:12,fontWeight:600,marginBottom:4}}>Order {t}</div>
            {isE?<textarea style={Object.assign({},S.inp,{minHeight:60})} value={emV} onChange={function(e){sEmV(e.target.value);}}/>
            :<div style={{fontSize:12,color:"#9BA1B5",lineHeight:1.5}}>{orderMsgs[t]||"No message set"}</div>}</div>
          <div>{isE?<div style={{display:"flex",gap:3}}><button style={Object.assign({},S.b,S.bG,{padding:"3px 8px",fontSize:10})} onClick={saveMsg}>Save</button><button style={Object.assign({},S.b,S.bS,{padding:"3px 8px",fontSize:10})} onClick={function(){sEmT(null);}}>X</button></div>
            :<button style={Object.assign({},S.b,S.bS,{padding:"3px 8px",fontSize:10})} onClick={function(){sEmT(t);sEmV(orderMsgs[t]||"");}}><Ic type="edit" size={11}/> Edit</button>}</div></div></div>);})}</div>

    <div style={S.card}><div style={S.cH}><div><div style={S.t}>Company Logo</div><div style={S.d}>Upload your logo to replace the default "OM" icon (max 500KB)</div></div></div>
      <div style={{display:"flex",alignItems:"center",gap:14,marginTop:4}}>
        {logo?<img src={logo} alt="Logo" style={{width:48,height:48,borderRadius:10,objectFit:"cover",border:"1px solid #2A2E3B"}}/>:<div style={Object.assign({},S.logo,{width:48,height:48,fontSize:16})}>OM</div>}
        <div style={{display:"flex",gap:6}}>
          <button style={Object.assign({},S.b,S.bP)} onClick={function(){logoRef.current&&logoRef.current.click();}}>Upload Logo</button>
          {logo&&<button style={Object.assign({},S.b,S.bD)} onClick={function(){setLogo(null);toast("Logo removed");}}>Remove</button>}
        </div>
      </div></div>

    <div style={S.card}><div style={S.t}>Stores</div>
      <div style={Object.assign({},S.tw,{marginTop:8})}><table style={S.tbl}><thead><tr><th style={S.th}>ID</th><th style={S.th}>Name</th></tr></thead><tbody>
        {stores.map(function(s){return <tr key={s.id}><td style={S.tm}>{s.id}</td><td style={S.td}>{s.name}</td></tr>;})}</tbody></table></div></div>

    <div style={{marginTop:10,padding:12,background:"#1F2330",borderRadius:6,border:"1px solid #2A2E3B",fontSize:12,color:"#9BA1B5"}}>
      <strong style={{color:"#E8EAF0"}}>OrderManager v3.1</strong> - Supplier edit, submit confirm, sort options, mailto emails, company logo, custom messages.</div>
  </div>);
}
