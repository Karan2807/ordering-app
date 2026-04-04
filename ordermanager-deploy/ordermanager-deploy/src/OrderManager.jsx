import { useState, useCallback, useMemo, useRef, Fragment, useContext, useEffect } from "react";
import * as XLSX from 'xlsx';
import * as mammoth from 'mammoth';
import { AuthContext } from "./AuthContext";
import { apiClient } from "./api";

/* ═══ DATA HELPERS ═══ */
// utility arrays & functions used across components
var DAYS=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
var ORDER_CATEGORIES=[
  {id:"vegetables",label:"Vegetables"},
  {id:"leaves",label:"Leaves"},
  {id:"vendor_orders",label:"Vendor Orders"},
];
var CATEGORY_LABELS=ORDER_CATEGORIES.reduce(function(acc,c){acc[c.id]=c.label;return acc;},{});
var SUPPLIER_CATEGORY_OPTIONS=[
  {id:"vegetables",label:"Vegetables Orders"},
  {id:"vendor_orders",label:"Warehouse Orders"},
];

function activeTypes(sc, dayOverride){
  var t=Number.isInteger(dayOverride)?dayOverride:new Date().getDay();
  return ["A","B","C"].filter(function(k){return sc&&sc[k]===t;});
}
function activeType(sc, dayOverride){
  var list=activeTypes(sc,dayOverride);
  return list.length?list[0]:null;
}
function normalizeOpenOrderTypes(input){
  var values=Array.isArray(input)?input:[input];
  return values.map(function(v){return String(v||"").trim().toUpperCase();}).filter(function(v){return v==="A"||v==="B"||v==="C";});
}
function isAdminRole(user){return !!(user&&user.role==="admin");}
function isWarehouseRole(user){return !!(user&&user.role==="warehouse");}
function isPrivilegedRole(user){return isAdminRole(user)||isWarehouseRole(user);}
function displayRoleLabel(user){return isAdminRole(user)?"Admin":(isWarehouseRole(user)?"Warehouse":"Manager");}
function normalizeCategory(v){var raw=String(v||"").trim().toLowerCase();return ORDER_CATEGORIES.some(function(c){return c.id===raw;})?raw:"vegetables";}
function normalizeVendorKey(category,v){return normalizeCategory(category)==="vendor_orders"?(String(v||"").trim()||null):null;}
function extractVendorIdentifier(input){
  if(input==null) return "";
  if(typeof input==="string"||typeof input==="number"){
    var value=String(input).trim();
    if(!value) return "";
    if(value.toLowerCase()==="[object object]"||value.toLowerCase()==="[object set]") return "";
    return value;
  }
  if(Array.isArray(input)) return extractVendorIdentifier(input[0]);
  if(typeof input==="object"){
    var direct=extractVendorIdentifier(input.vendorKey);
    if(direct) return direct;
    var byId=extractVendorIdentifier(input.id);
    if(byId) return byId;
    var bySupplierId=extractVendorIdentifier(input.supplierId);
    if(bySupplierId) return bySupplierId;
    var byValue=extractVendorIdentifier(input.value);
    if(byValue) return byValue;
    var byKey=extractVendorIdentifier(input.key);
    if(byKey) return byKey;
    return "";
  }
  return "";
}
function listifyVendorInputs(input){
  if(Array.isArray(input)) return input.slice();
  if(input&&typeof input.values==="function"&&typeof input.size==="number"){
    try{return Array.from(input.values());}catch(_err){return [];}
  }
  if(input&&typeof input==="object"){
    if(input.vendorKey||input.id) return [input];
    return Object.keys(input).map(function(key){
      var value=input[key];
      if(value&&typeof value==="object"&&!Array.isArray(value)){
        return Object.assign({vendorKey:value.vendorKey||key},value);
      }
      return {vendorKey:key};
    });
  }
  return input==null||input===""?[]:[input];
}
function normalizeVendorOrderList(input){
  var normalized=listifyVendorInputs(input).map(function(v){
    return extractVendorIdentifier(v);
  }).filter(Boolean);
  return Array.from(new Set(normalized));
}
function parseOptionalDay(value){
  if(value==null||value==="") return null;
  var n=Number(value);
  if(!Number.isInteger(n)||n<0||n>6) return null;
  return n;
}
function parseOptionalTimestamp(value){
  if(value==null||value==="") return null;
  var d=new Date(value);
  return Number.isNaN(d.getTime())?null:d.toISOString();
}
function normalizeVendorOrderConfigs(input){
  var values=listifyVendorInputs(input);
  var byVendorKey={};
  values.forEach(function(entry){
    var raw=entry&&typeof entry==="object"?entry:{vendorKey:entry};
    var vendorKey=extractVendorIdentifier(raw);
    if(!vendorKey) return;
    var startDay=parseOptionalDay(raw.startDay);
    var endDay=parseOptionalDay(raw.endDay);
    var temporaryOpenUntil=parseOptionalTimestamp(raw.temporaryOpenUntil);
    var temporaryOpenCreatedAt=parseOptionalTimestamp(raw.temporaryOpenCreatedAt);
    var temporaryOpenOnly=raw.temporaryOpenOnly===true||raw.temporaryOpenOnly==="true"||raw.temporaryOpenOnly===1||raw.temporaryOpenOnly==="1";
    var seq=parseInt(raw.seq,10);
    if((startDay===null)!==(endDay===null)){
      startDay=null;
      endDay=null;
    }
    byVendorKey[vendorKey]={vendorKey:vendorKey,startDay:startDay,endDay:endDay,enabled:raw.enabled!==false,temporaryOpenUntil:temporaryOpenUntil,temporaryOpenCreatedAt:temporaryOpenCreatedAt,temporaryOpenOnly:temporaryOpenOnly,seq:seq>0?seq:1};
  });
  return Object.keys(byVendorKey).map(function(vendorKey){return byVendorKey[vendorKey];});
}
function isDayWithinRange(day,startDay,endDay){
  var start=parseOptionalDay(startDay);
  var end=parseOptionalDay(endDay);
  if(start===null||end===null) return false;
  if(!Number.isInteger(day)||day<0||day>6) return true;
  if(start<=end) return day>=start&&day<=end;
  return day>=start||day<=end;
}
function supplierNameById(list,vendorKey){
  var all=Array.isArray(list)?list:[];
  if(vendorKey&&typeof vendorKey==="object"&&vendorKey.name) return String(vendorKey.name);
  var normalizedKey=extractVendorIdentifier(vendorKey);
  if(!normalizedKey) return "";
  var found=all.find(function(v){return String(v&&v.id||"").trim()===normalizedKey;})||null;
  return found&&found.name?String(found.name):normalizedKey;
}
function vendorDisplayName(suppliers,vendorKey){
  return supplierNameById(suppliers,vendorKey)||extractVendorIdentifier(vendorKey)||"Vendor Order";
}
function summarizeVendorKeys(vendorKeys,suppliers){
  var ids=normalizeVendorOrderList(vendorKeys);
  if(!ids.length) return "Locked";
  if(ids.length===1) return vendorDisplayName(suppliers,ids[0]);
  return ids.map(function(id){return vendorDisplayName(suppliers,id);}).join(", ");
}
function vendorWindowText(startDay,endDay){
  var start=parseOptionalDay(startDay);
  var end=parseOptionalDay(endDay);
  if(start===null&&end===null) return "Not scheduled";
  if(start===null||end===null) return "Not scheduled";
  return (DAYS[start]||"Day "+start)+" to "+(DAYS[end]||"Day "+end);
}
var ORDER_UNIT_TYPES=[
  {value:"cas",label:"CASE"},
  {value:"pcs",label:"PIECES"},
  {value:"pallet",label:"PALLET"},
  {value:"master_case",label:"MASTER CASE"},
  {value:"other",label:"OTHER"},
];
function normalizeUnitType(v){return ORDER_UNIT_TYPES.some(function(o){return o.value===v;})?v:"cas";}
function normalizeOrderItemEntry(v){
  if(v&&typeof v==="object"&&!Array.isArray(v)){
    var q=Math.max(0,parseInt(v.qty!=null?v.qty:v.quantity)||0);
    var t=normalizeUnitType(v.unitType||v.type||"cas");
    var other=t==="other"?String(v.customUnit||v.otherUnit||"").trim():"";
    return {qty:q,unitType:t,customUnit:other};
  }
  return {qty:Math.max(0,parseInt(v)||0),unitType:"cas",customUnit:""};
}
function hasOrderItemQty(v){return normalizeOrderItemEntry(v).qty>0;}
function countFilledOrderItems(itemsMap){return Object.values(itemsMap||{}).filter(function(v){return hasOrderItemQty(v);}).length;}
function getOrderItemQty(itemsMap,code){return normalizeOrderItemEntry(itemsMap&&itemsMap[code]).qty;}
function getOrderItemUnitLabel(v){
  var d=normalizeOrderItemEntry(v);
  if(d.unitType==="pcs") return "PIECES";
  if(d.unitType==="pallet") return "PALLET";
  if(d.unitType==="master_case") return "MASTER CASE";
  if(d.unitType==="other") return d.customUnit||"OTHER";
  return "CASE";
}
function formatQtyWithUnit(v){var d=normalizeOrderItemEntry(v);return d.qty+" "+getOrderItemUnitLabel(d);}
function formatOrderItemQtyDisplay(v){var d=normalizeOrderItemEntry(v);return d.qty>0?formatQtyWithUnit(v):"0";}
function formatQtyValueWithUnit(qty,unitMeta){
  var safeQty=Math.max(0,parseInt(qty,10)||0);
  if(!safeQty) return "";
  return safeQty+" "+getOrderItemUnitLabel(unitMeta||{unitType:"cas",customUnit:""});
}
function formatQtySummaryByUnit(qtyByStoreId,orderUnitByStoreId){
  var totals={};
  Object.keys(qtyByStoreId||{}).forEach(function(storeId){
    var qty=Math.max(0,parseInt(qtyByStoreId[storeId],10)||0);
    if(!qty) return;
    var label=getOrderItemUnitLabel(orderUnitByStoreId&&orderUnitByStoreId[storeId]?orderUnitByStoreId[storeId]:{unitType:"cas",customUnit:""});
    totals[label]=(totals[label]||0)+qty;
  });
  return Object.keys(totals).map(function(label){return totals[label]+" "+label;}).join(", ");
}
function aggregateQtyUnit(itemsMapList){
  var units={};
  itemsMapList.forEach(function(v){var d=normalizeOrderItemEntry(v);if(d.qty>0)units[getOrderItemUnitLabel(d)]=true;});
  var keys=Object.keys(units);
  if(keys.length===0) return "CASE";
  if(keys.length===1) return keys[0];
  return "MIXED";
}
function isVendorConfigActiveNow(config, dayOverride, nowOverride){
  if(!config||config.enabled===false) return false;
  var now=nowOverride instanceof Date?nowOverride:new Date();
  var nowMs=now.getTime();
  var tempUntilMs=config.temporaryOpenUntil?new Date(config.temporaryOpenUntil).getTime():NaN;
  var tempActive=Number.isFinite(tempUntilMs)&&tempUntilMs>nowMs;
  if(config.temporaryOpenOnly) return tempActive;
  if(tempActive) return true;
  var day=Number.isInteger(dayOverride)?dayOverride:now.getDay();
  return isDayWithinRange(day,config.startDay,config.endDay);
}
function vendorConfigWindowText(config){
  if(!config) return "Not scheduled";
  var tempUntilMs=config.temporaryOpenUntil?new Date(config.temporaryOpenUntil).getTime():NaN;
  if(config.temporaryOpenOnly){
    if(Number.isFinite(tempUntilMs)&&tempUntilMs>Date.now()) return "Open for 24 hours";
    return "24-hour open expired";
  }
  return vendorWindowText(config.startDay,config.endDay);
}
function normalizeSupplierCategories(input){
  var values=Array.isArray(input)?input:[];
  var normalized=values.map(function(v){return String(v||"").trim().toLowerCase();}).filter(function(v){return SUPPLIER_CATEGORY_OPTIONS.some(function(opt){return opt.id===v;});});
  normalized=Array.from(new Set(normalized));
  return normalized;
}
function suppliersForCategory(list, category){
  var all=Array.isArray(list)?list:[];
  return all;
}
function cycleBaseKey(d){
  // Use UTC dates so week keys are consistent across time zones.
  var dt=d instanceof Date?new Date(d.getTime()):new Date(d);
  return dt.getUTCFullYear()+"-"+String(dt.getUTCMonth()+1).padStart(2,"0")+"-"+String(dt.getUTCDate()).padStart(2,"0");
}
function categoryKey(category,vendorKey){var cat=normalizeCategory(category);var vendor=normalizeVendorKey(cat,vendorKey);return vendor?cat+"-"+vendor:cat;}
function isCategoryOpenForType(category, type, aot, manualOpenLeaves){
  var openTypes=normalizeOpenOrderTypes(aot);
  var cat=normalizeCategory(category);
  if(cat==="leaves") return type==="B"&&(openTypes.indexOf("B")>=0||!!manualOpenLeaves);
  return openTypes.indexOf(String(type||"").toUpperCase())>=0;
}
function dateKey(type, category, vendorKey, manualOpenOrder, manualOpenSeq, vendorSeq){
  var base=cycleBaseKey(new Date());
  if(category==="vendor_orders"&&vendorKey){
    var seq=parseInt(vendorSeq)||1;
    return base+"-VS"+seq+"-"+type+"-"+categoryKey(category,vendorKey);
  }
  if(manualOpenOrder&&manualOpenSeq&&manualOpenOrder===type) return base+"-M"+manualOpenSeq+"-"+type+"-"+categoryKey(category,vendorKey);
  return base+"-"+type+"-"+categoryKey(category,vendorKey);
}
function getVendorSeqFromConfigs(vendorOrderConfigs,vendorKey){
  if(!vendorKey||!Array.isArray(vendorOrderConfigs)) return 1;
  var c=vendorOrderConfigs.find(function(cfg){return cfg&&cfg.vendorKey===vendorKey;});
  return (c&&parseInt(c.seq)>0)?parseInt(c.seq):1;
}
function getCurrentOrderForStoreType(orderMap, storeId, type, category, vendorKey, manualOpenOrder, manualOpenSeq, vendorSeq){
  var exactKey=storeId+"_"+dateKey(type,category,vendorKey,manualOpenOrder,manualOpenSeq,vendorSeq);
  var exactOrder=orderMap&&orderMap[exactKey]?orderMap[exactKey]:null;
  // For vendor orders: even if there is an exact-key match, it might be a plain
  // draft created after the UTC day boundary while the REAL submitted order lives
  // under a prior-day key. Recover only records for the SAME VS sequence so
  // Settings-driven reopen/cancel/open-24h starts a fresh cycle; older sequences
  // should only be revived by explicit reopen flows from Order Monitor.
  if(orderMap&&category==="vendor_orders"&&vendorKey){
    var suffix="-"+type+"-"+categoryKey(category,vendorKey);
    var requestedSeq=parseInt(vendorSeq,10);
    var bestSubmitted=null;
    var bestAny=null;
    var nowTs=Date.now();
    var maxAgeMs=7*24*60*60*1000;
    var keyPrefix=String(storeId||"")+"_";
    Object.keys(orderMap).forEach(function(k){
      if(k.indexOf(keyPrefix)!==0) return;
      if(k.indexOf("-VS")<0) return;
      if(!k.endsWith(suffix)) return;
      if(Number.isFinite(requestedSeq)&&requestedSeq>0){
        var seqMatch=String(k).match(/-VS(\d+)-/i);
        var foundSeq=seqMatch?parseInt(seqMatch[1],10):NaN;
        if(!Number.isFinite(foundSeq)||foundSeq!==requestedSeq) return;
      }
      var o=orderMap[k];
      if(!o) return;
      var ts=new Date(o.submittedAt||o.date||o.createdAt||0).getTime();
      if(!ts||Number.isNaN(ts)) return;
      if((nowTs-ts)>maxAgeMs) return;
      if(!bestAny||ts>bestAny.ts) bestAny={order:o,ts:ts};
      var st=String(o.status||"").toLowerCase();
      if(st==="submitted"||st==="processed"||st==="draft_shared"){
        if(!bestSubmitted||ts>bestSubmitted.ts) bestSubmitted={order:o,ts:ts};
      }
    });
    // A submitted/processed/draft_shared order always wins over any draft.
    if(bestSubmitted&&bestSubmitted.order) return bestSubmitted.order;
    // No visible order found in window — fall back to the exact-key result
    // (could be a draft) so the form still populates correctly.
    if(exactOrder) return exactOrder;
    if(bestAny&&bestAny.order) return bestAny.order;
    return null;
  }

  if(exactOrder) return exactOrder;
  return null;
}
function getDashboardOrderForStoreType(orderMap, storeId, referenceWeekKey, type, category, vendorKey, manualOpenOrder, manualOpenSeq, vendorSeq){
  var exact=getStoreOrderForWeek(orderMap,storeId,referenceWeekKey,type,category,vendorKey);
  if(exact) return exact;
  if(category==="vendor_orders"){
    return getCurrentOrderForStoreType(orderMap,storeId,type,category,vendorKey,manualOpenOrder,manualOpenSeq,vendorSeq);
  }
  var bestVisible=null;
  var bestAny=null;
  Object.values(orderMap||{}).forEach(function(o){
    if(!o) return;
    if(String(o.store||"")!==String(storeId||"")) return;
    if(String(o.type||"")!==String(type||"")) return;
    if(normalizeCategory(o.category||"vegetables")!==normalizeCategory(category)) return;
    if(normalizeVendorKey(category,o.vendorKey)!==normalizeVendorKey(category,vendorKey)) return;
    if(!isSameOrAdjacentDateWeekKey(o.week,referenceWeekKey)) return;
    var ts=orderTimestampMs(o);
    if(!bestAny||ts>bestAny.ts) bestAny={order:o,ts:ts};
    if(["submitted","processed","draft_shared"].indexOf(String(o.status||"").toLowerCase())>=0){
      if(!bestVisible||ts>bestVisible.ts) bestVisible={order:o,ts:ts};
    }
  });
  if(bestVisible&&bestVisible.order) return bestVisible.order;
  return bestAny&&bestAny.order?bestAny.order:null;
}
function lastWeekKey(type, category, vendorKey){
  var n=new Date();
  n.setDate(n.getDate()-7);
  return cycleBaseKey(n)+"-"+type+"-"+categoryKey(category,vendorKey);
}
function sortItems(a){
  return a.slice().sort(function(x,y){
    var xOrder=Number(x&&x.sortOrder);
    var yOrder=Number(y&&y.sortOrder);
    var xHasOrder=Number.isFinite(xOrder);
    var yHasOrder=Number.isFinite(yOrder);
    if(xHasOrder&&yHasOrder){
      if(xOrder!==yOrder) return xOrder-yOrder;
      return 0;
    }
    if(xHasOrder!==yHasOrder) return xHasOrder?-1:1;
    return 0;
  });
}
function sortItemsAlphabetical(a){
  return (Array.isArray(a)?a:[]).slice().sort(function(x,y){
    var xn=String(x&&x.name||"");
    var yn=String(y&&y.name||"");
    var byName=xn.localeCompare(yn,undefined,{sensitivity:"base"});
    if(byName!==0) return byName;
    return String(x&&x.code||"").localeCompare(String(y&&y.code||""),undefined,{sensitivity:"base"});
  });
}
var TEMPLATE_STORE_SLOTS=[
  {apna:"Apna 1",city:"Bellevue",aliases:["bel"]},
  {apna:"Apna 2",city:"Bothell",aliases:["bot"]},
  {apna:"Apna 3",city:"Sammamish",aliases:["sam"]},
  {apna:"Apna 4",city:"Kent",aliases:["ken"]},
  {apna:"Apna 5",city:"Redmond",aliases:["red"]},
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
function safeCodePrefix(category){
  return normalizeCategory(category).replace(/[^a-z0-9]/g,"_").toUpperCase();
}
function buildItemMasterCode(name, unit){
  var trimmedName=String(name||"").trim().replace(/\s+/g," ");
  var trimmedUnit=String(unit||"").trim().replace(/\s+/g," ");
  if(!trimmedName) return "";
  return trimmedUnit?trimmedName+":"+trimmedUnit:trimmedName;
}
function buildUniqueItemMasterCode(name, unit, usedCodes){
  var baseCode=buildItemMasterCode(name,unit);
  if(!baseCode) return "";
  var seen=usedCodes||{};
  var normalizedBase=baseCode.toLowerCase();
  if(!seen[normalizedBase]){
    seen[normalizedBase]=1;
    return baseCode;
  }
  var nextIndex=seen[normalizedBase]+1;
  var candidate=baseCode+" ("+String(nextIndex)+")";
  while(seen[String(candidate).toLowerCase()]){
    nextIndex+=1;
    candidate=baseCode+" ("+String(nextIndex)+")";
  }
  seen[normalizedBase]=nextIndex;
  seen[String(candidate).toLowerCase()]=1;
  return candidate;
}
function syntheticItemCode(category, vendorKey, name){
  var vendor=normalizeVendorKey(category,vendorKey);
  return safeCodePrefix(category)+(vendor?("__"+String(vendor).replace(/[^a-z0-9]/gi,"_").toUpperCase()):"")+"::"+String(name||"").trim().replace(/\s+/g," ").toUpperCase();
}
function detectTemplateSlotKey(label){
  var text=String(label||"").trim().toLowerCase();
  var token=cleanHeaderToken(text);
  var found=TEMPLATE_STORE_SLOTS.find(function(slot){
    var aliases=[slot.city,slot.apna].concat(Array.isArray(slot.aliases)?slot.aliases:[]);
    return aliases.some(function(alias){
      var aliasText=String(alias||"").trim().toLowerCase();
      var aliasToken=cleanHeaderToken(aliasText);
      if(!aliasText) return false;
      if(aliasToken&&token===aliasToken) return true;
      if(aliasToken&&token.indexOf(aliasToken)>=0) return true;
      return text.indexOf(aliasText)>=0;
    });
  });
  return found?found.apna:null;
}
function cleanHeaderToken(v){
  return String(v||"").trim().toLowerCase().replace(/[^a-z0-9]/g,"");
}
function isUnitLikeHeaderLabel(value){
  var token=cleanHeaderToken(value);
  return token==="unit"||token==="uom"||token.indexOf("size")>=0||token.indexOf("pack")>=0||token.indexOf("weight")>=0||token.indexOf("wt")>=0;
}
function looksLikeQtyHeaderToken(value){
  var token=cleanHeaderToken(value);
  if(!token) return false;
  return token==="qty"||token==="qtys"||token.indexOf("quantity")>=0||token.indexOf("orderqty")>=0||token==="ordqty"||token==="totalqty";
}
function looksLikeObviousHeadingText(value){
  var text=String(value||"").trim();
  if(!text) return false;
  if(/^total\b|^subtotal\b|^grand\s*total\b/i.test(text)) return true;
  return /\b(products?|items?|section|category|group)\b/i.test(text);
}
function findDateCell(rows, startRow, endRow){
  for(var r=Math.max(0,startRow||0);r<Math.min(rows.length,endRow||rows.length);r++){
    var row=rows[r]||[];
    for(var c=0;c<row.length;c++){
      var text=String(row[c]||"").trim();
      if(!text) continue;
      if(/date/i.test(text)) return {rowIndex:r,colIndex:c,prefix:text.replace(/date/i,"Date").replace(/\s*[:\-]?\s*$/," - ")||"Date - "};
    }
  }
  return null;
}
function buildTemplateUiHeaders(itemHeader, quantityHeader, noteHeader, totalHeader, dateHeader){
  return {
    item:String(itemHeader||"Item Name").trim()||"Item Name",
    quantity:String(quantityHeader||"Qty").trim()||"Qty",
    note:String(noteHeader||"Note").trim()||"Note",
    total:String(totalHeader||"Total Qty").trim()||"Total Qty",
    date:String(dateHeader||"Date").trim()||"Date",
  };
}
function parseTemplateItemSheet(rows, category, vendorKey, sourceFilename, sheetName, originalFile){
  if(!rows||!rows.length) return null;
  var cellText=function(r,c){
    if(r<0||c<0) return "";
    var row=rows[r]||[];
    return String(row[c]||"").trim();
  };
  var cellToken=function(r,c){
    return cleanHeaderToken(cellText(r,c));
  };
  var looksLikeItemHeader=function(token){
    return token==="item"||token==="items"||token.indexOf("itemname")>=0||token.indexOf("product")>=0||token.indexOf("description")>=0||token==="name";
  };
  var looksLikeUnitHeader=function(token){
    return token==="unit"||token==="uom"||token.indexOf("size")>=0||token.indexOf("pack")>=0||token.indexOf("weight")>=0||token.indexOf("wt")>=0;
  };
  var looksLikeTotalHeader=function(token){
    return token.indexOf("total")>=0;
  };
  var looksLikeHeadingRow=function(text){
    var v=String(text||"").trim();
    if(!v) return false;
    if(/^total\b|^subtotal\b|^grand\s*total\b/i.test(v)) return false;
    return true;
  };
  var headerRowIndex=-1;
  var storeColumns=[];
  for(var r=0;r<Math.min(rows.length,12);r++){
    var row=rows[r]||[];
    var detected=[];
    row.forEach(function(cell,idx){
      var slotKey=detectTemplateSlotKey(cell);
      if(slotKey) detected.push({slotKey:slotKey,header:String(cell||"").trim(),colIndex:idx});
    });
    if(detected.length>=2){
      headerRowIndex=r;
      storeColumns=detected;
      break;
    }
  }
  if(headerRowIndex!==-1&&storeColumns.length){
    var groupedColumns=[];
    storeColumns.slice().sort(function(a,b){return a.colIndex-b.colIndex;}).forEach(function(col){
      var lastGroup=groupedColumns.length?groupedColumns[groupedColumns.length-1]:null;
      if(!lastGroup||col.colIndex-lastGroup[lastGroup.length-1].colIndex>2){
        groupedColumns.push([col]);
      }else{
        lastGroup.push(col);
      }
    });
    var groups=groupedColumns.map(function(group,groupIdx){
      var firstCol=group[0]&&Number.isInteger(group[0].colIndex)?group[0].colIndex:0;
      var lastCol=group[group.length-1]&&Number.isInteger(group[group.length-1].colIndex)?group[group.length-1].colIndex:firstCol;
      var headerRows=[headerRowIndex,headerRowIndex-1,headerRowIndex-2].filter(function(v){return v>=0;});
      var itemCol=-1;
      var codeCol=-1;
      var unitCol=-1;
      var totalCol=-1;

      for(var c=Math.max(0,firstCol-5);c<firstCol;c++){
        var isItem=headerRows.some(function(hr){return looksLikeItemHeader(cellToken(hr,c));});
        var isCode=headerRows.some(function(hr){var tk=cellToken(hr,c);return tk.indexOf("code")>=0||tk==="sku";});
        var isUnit=headerRows.some(function(hr){return looksLikeUnitHeader(cellToken(hr,c));});
        if(itemCol===-1&&isItem) itemCol=c;
        if(codeCol===-1&&isCode) codeCol=c;
        if(unitCol===-1&&isUnit) unitCol=c;
      }
      if(itemCol===-1) itemCol=Math.max(0,firstCol-2);
      if(codeCol===-1&&itemCol>0) codeCol=itemCol-1;
      if(unitCol===-1&&itemCol+1<firstCol) unitCol=itemCol+1;

      for(var tc=lastCol+1;tc<=Math.min(lastCol+4,(rows[headerRowIndex]||[]).length-1);tc++){
        var hasTotalHeader=headerRows.some(function(hr){return looksLikeTotalHeader(cellToken(hr,tc));});
        if(hasTotalHeader){
          totalCol=tc;
          break;
        }
      }

      return {groupIndex:groupIdx,itemCol:itemCol,codeCol:codeCol,unitCol:unitCol,totalCol:totalCol,columns:group,firstCol:firstCol,lastCol:lastCol};
    });
    var itemRows=[];
    var items=[];
    var outline=[];
    var seenCodes={};
    var activeHeadingByGroup={};
    for(var i=headerRowIndex+1;i<rows.length;i++){
      groups.forEach(function(group){
        var cols=rows[i]||[];
        var rawCode=group.codeCol>=0?String(cols[group.codeCol]||"").trim():"";
        var labelStart=Math.max(0,Math.min(group.codeCol>=0?group.codeCol:group.itemCol,group.itemCol));
        var labelEnd=Math.max(group.firstCol-1,labelStart);
        var labelCells=[];
        for(var lc=labelStart;lc<=labelEnd;lc++){
          var txt=String(cols[lc]||"").trim();
          if(!txt) continue;
          labelCells.push({col:lc,text:txt,token:cleanHeaderToken(txt)});
        }
        var name=String(cols[group.itemCol]||"").trim();
        var hasExplicitItemCell=!!name;
        if(!name){
          var itemCell=labelCells.find(function(cell){
            if(!cell||!cell.text) return false;
            if(cell.col===group.codeCol||cell.col===group.unitCol) return false;
            if(cell.token==="item"||cell.token==="items"||cell.token==="unit"||cell.token==="uom"||cell.token.indexOf("total")>=0) return false;
            return true;
          });
          if(itemCell) name=itemCell.text;
        }
        var unitText=group.unitCol>=0?String(cols[group.unitCol]||"").trim():"";
        if(!unitText){
          var unitCell=labelCells.find(function(cell){
            if(!cell||!cell.text) return false;
            if(cell.col===group.codeCol) return false;
            return looksLikeUnitHeader(cell.token)||/(\d+\s*[xX]\s*\d+|\d+\s*(kg|g|lb|oz|l|ml|pcs|pc|ct|count))/i.test(cell.text);
          });
          if(unitCell) unitText=unitCell.text;
        }
        var hasStoreCell=group.columns.some(function(col){return String(cols[col.colIndex]||"").trim()!=="";});
        var totalText=group.totalCol>=0?String(cols[group.totalCol]||"").trim():"";
        var hasAnyCell=name!==""||rawCode!==""||unitText!==""||hasStoreCell||totalText!=="";
        if(!hasAnyCell) return;
        if(!name||/^date\b/i.test(name)) return;

        var hasDataCell=rawCode!==""||unitText!==""||hasStoreCell||totalText!=="";
        if(!hasDataCell){
          if(hasExplicitItemCell&&!looksLikeObviousHeadingText(name)){
            var codeNoData=buildUniqueItemMasterCode(name,unitText,seenCodes);
            var noDataSortOrder=itemRows.length;
            itemRows.push({code:codeNoData,name:name,rowIndex:i,colIndex:group.itemCol});
            items.push({
              code:codeNoData,
              name:name,
              category:normalizeCategory(category),
              vendorKey:normalizeVendorKey(category,vendorKey),
              unit:unitText,
              subheading:String(activeHeadingByGroup[group.groupIndex]||""),
              sortOrder:noDataSortOrder,
            });
            outline.push({type:"item",code:codeNoData,name:name,rowIndex:i,colIndex:group.itemCol});
            return;
          }
          var labelDataCount=labelCells.filter(function(cell){
            if(!cell||!cell.text) return false;
            if(cell.col===group.codeCol||cell.col===group.unitCol) return false;
            if(cell.token.indexOf("total")>=0||cell.token==="item"||cell.token==="items") return false;
            return true;
          }).length;
          if(!/^total\b|^subtotal\b|^grand\s*total\b/i.test(name)&&looksLikeHeadingRow(name)){
            if(labelDataCount<=1){
              activeHeadingByGroup[group.groupIndex]=name;
            }
            outline.push({type:"heading",text:name,rowIndex:i,colIndex:group.itemCol});
          }
          return;
        }
        var activeHeading=String(activeHeadingByGroup[group.groupIndex]||"");
        var code=buildUniqueItemMasterCode(name,unitText,seenCodes);
        var sortOrder=itemRows.length;
        itemRows.push({code:code,name:name,rowIndex:i,colIndex:group.itemCol});
        items.push({
          code:code,
          name:name,
          category:normalizeCategory(category),
          vendorKey:normalizeVendorKey(category,vendorKey),
          unit:unitText,
          subheading:activeHeading,
          sortOrder:sortOrder,
        });
        outline.push({type:"item",code:code,name:name,rowIndex:i,colIndex:group.itemCol});
      });
    }
    if(items.length){
      return {
        items:items,
        template:{
          kind:"matrix",
          sourceFilename:sourceFilename||"",
          sheetName:sheetName||"",
          originalFile:originalFile||null,
          headerRowIndex:headerRowIndex,
          dateCell:findDateCell(rows,0,headerRowIndex+1),
          rows:rows,
          outline:outline,
          itemRows:itemRows,
          storeColumns:storeColumns,
          quantityColumn:null,
          noteColumn:null,
          uiHeaders:buildTemplateUiHeaders("Item Name","Qty","Note","Total Qty","Date"),
        },
      };
    }
  }
  var tabHeaderRow=-1;
  var itemCol=-1;
  var codeCol=-1;
  var qtyCol=-1;
  var noteCol=-1;
  var unitCol=-1;
  var itemHeader="Item Name";
  var qtyHeader="Qty";
  var noteHeader="Note";
  for(var tr=0;tr<Math.min(rows.length,25);tr++){
    var row=(rows[tr]||[]);
    var normalized=row.map(cleanHeaderToken);
    var maybeItem=normalized.findIndex(function(h){return h==="item"||h==="items"||h.indexOf("itemname")>=0||h.indexOf("product")>=0||h.indexOf("description")>=0||h==="name"||h==="sku";});
    var maybeQty=normalized.findIndex(function(h){return looksLikeQtyHeaderToken(h);});
    if(maybeItem>=0){
      tabHeaderRow=tr;
      itemCol=maybeItem;
      codeCol=normalized.findIndex(function(h){return h.indexOf("code")>=0||h==="sku";});
      qtyCol=maybeQty;
      noteCol=normalized.findIndex(function(h){return h==="note"||h==="notes"||h.indexOf("remark")>=0||h.indexOf("comment")>=0||h.indexOf("memo")>=0;});
      unitCol=normalized.findIndex(function(h){return looksLikeUnitHeader(h);});
      itemHeader=String(row[itemCol]||"Item Name").trim()||"Item Name";
      if(qtyCol>=0) qtyHeader=String(row[qtyCol]||"Qty").trim()||"Qty";
      if(noteCol>=0) noteHeader=String(row[noteCol]||"Note").trim()||"Note";
      break;
    }
  }
  if(tabHeaderRow===-1||itemCol===-1) return null;
  var tabItems=[];
  var tabRows=[];
  var tabOutline=[];
  var activeHeading="";
  var seenCodes={};
  for(var ti=tabHeaderRow+1;ti<rows.length;ti++){
    var cols=rows[ti]||[];
    var itemName=String(cols[itemCol]||"").trim();
    var rawCode=String(codeCol>=0?cols[codeCol]||"":"").trim();
    var rawQty=qtyCol>=0?String(cols[qtyCol]||"").trim():"";
    var rawNote=noteCol>=0?String(cols[noteCol]||"").trim():"";
    var rawUnit=unitCol>=0?String(cols[unitCol]||"").trim():"";
    if(!itemName&&!rawQty&&!rawNote&&!rawUnit) continue;
    if(!itemName||/^date\b/i.test(itemName)) continue;
    if(!rawCode&&!rawQty&&!rawNote&&!rawUnit&&itemName){
      if(!looksLikeObviousHeadingText(itemName)){
        var itemCodeNoData=buildUniqueItemMasterCode(itemName,rawUnit,seenCodes);
        tabRows.push({code:itemCodeNoData,name:itemName,rowIndex:ti,colIndex:itemCol});
        tabItems.push({code:itemCodeNoData,name:itemName,category:normalizeCategory(category),vendorKey:normalizeVendorKey(category,vendorKey),unit:rawUnit,subheading:activeHeading,sortOrder:tabItems.length});
        tabOutline.push({type:"item",code:itemCodeNoData,name:itemName,rowIndex:ti,colIndex:itemCol});
        continue;
      }
      activeHeading=itemName;
      tabOutline.push({type:"heading",text:itemName,rowIndex:ti,colIndex:itemCol});
      continue;
    }
    var itemCode=buildUniqueItemMasterCode(itemName,rawUnit,seenCodes);
    tabRows.push({code:itemCode,name:itemName,rowIndex:ti,colIndex:itemCol});
    tabItems.push({code:itemCode,name:itemName,category:normalizeCategory(category),vendorKey:normalizeVendorKey(category,vendorKey),unit:rawUnit,subheading:activeHeading,sortOrder:tabItems.length});
    tabOutline.push({type:"item",code:itemCode,name:itemName,rowIndex:ti,colIndex:itemCol});
  }
  if(!tabItems.length) return null;
  return {
    items:tabItems,
    template:{
      kind:"tabular",
      sourceFilename:sourceFilename||"",
      sheetName:sheetName||"",
      originalFile:originalFile||null,
      headerRowIndex:tabHeaderRow,
      dateCell:findDateCell(rows,0,tabHeaderRow+1),
      rows:rows,
      outline:tabOutline,
      itemRows:tabRows,
      storeColumns:[],
      quantityColumn:qtyCol>=0?{header:qtyHeader,colIndex:qtyCol}:null,
      noteColumn:noteCol>=0?{header:noteHeader,colIndex:noteCol}:null,
      uiHeaders:buildTemplateUiHeaders(itemHeader,qtyHeader,noteHeader,"Total Qty","Date"),
    },
  };
}
function mergeParsedTemplateSheets(parsedSheets, category, vendorKey, sourceFilename, originalFile){
  var list=Array.isArray(parsedSheets)?parsedSheets.filter(function(p){return p&&Array.isArray(p.items)&&p.items.length&&p.template;}):[];
  if(!list.length) return null;
  var mergedItems=[];
  var mergedOutline=[];
  var mergedItemRows=[];
  var mergedMultiSheetItemRows=[];
  var seenCodes={};
  var order=0;

  list.forEach(function(entry, sheetIdx){
    var tpl=entry.template||{};
    var sheetName=String(tpl.sheetName||("Sheet "+String(sheetIdx+1))).trim()||("Sheet "+String(sheetIdx+1));
    var codeMap={};

    (entry.items||[]).forEach(function(it){
      var baseCode=String(it&&it.code||"").trim();
      if(!baseCode) return;
      var finalCode=baseCode;
      if(seenCodes[finalCode]) finalCode=finalCode+"__S"+String(sheetIdx+1)+"_"+String(order+1);
      while(seenCodes[finalCode]) finalCode=finalCode+"_x";
      seenCodes[finalCode]=true;
      codeMap[baseCode]=codeMap[baseCode]||[];
      codeMap[baseCode].push(finalCode);
      mergedItems.push(Object.assign({},it,{code:finalCode,sortOrder:order++,subheading:String(it&&it.subheading||"").trim()}));
    });

    var outlinePickIndex={};
    (tpl.outline||[]).forEach(function(row){
      if(!row||typeof row!=="object") return;
      if(row.type==="heading"){
        var headingText=String(row.text||"").trim();
        if(headingText) mergedOutline.push({type:"heading",text:headingText,rowIndex:row.rowIndex,colIndex:row.colIndex});
        return;
      }
      if(row.type!=="item") return;
      var oldCode=String(row.code||"").trim();
      var outlineIdx=outlinePickIndex[oldCode]||0;
      var codeCandidate=oldCode&&codeMap[oldCode]&&codeMap[oldCode].length?codeMap[oldCode][Math.min(outlineIdx,codeMap[oldCode].length-1)]:"";
      outlinePickIndex[oldCode]=outlineIdx+1;
      var name=String(row.name||"").trim();
      if(codeCandidate) mergedOutline.push({type:"item",code:codeCandidate,name:name,rowIndex:row.rowIndex,colIndex:row.colIndex});
    });

    var itemRowPickIndex={};
    (tpl.itemRows||[]).forEach(function(ir){
      var oldCode=String(ir&&ir.code||"").trim();
      var idx=itemRowPickIndex[oldCode]||0;
      var nextCode=oldCode&&codeMap[oldCode]&&codeMap[oldCode].length?codeMap[oldCode][Math.min(idx,codeMap[oldCode].length-1)]:"";
      itemRowPickIndex[oldCode]=idx+1;
      if(!nextCode) return;
      var name=String(ir&&ir.name||"").trim();
      mergedItemRows.push({code:nextCode,name:name,rowIndex:Number.isInteger(ir.rowIndex)?ir.rowIndex:0,colIndex:Number.isInteger(ir.colIndex)?ir.colIndex:0});
      mergedMultiSheetItemRows.push({code:nextCode,name:name,rowIndex:Number.isInteger(ir.rowIndex)?ir.rowIndex:0,colIndex:Number.isInteger(ir.colIndex)?ir.colIndex:0,sheetIndex:sheetIdx,sheetName:sheetName});
    });
  });

  var first=list[0].template||{};
  return {
    items:mergedItems,
    template:Object.assign({},first,{
      kind:String(first.kind||"matrix"),
      sourceFilename:sourceFilename||String(first.sourceFilename||""),
      sheetName:String(first.sheetName||""),
      originalFile:originalFile||first.originalFile||null,
      outline:mergedOutline,
      itemRows:mergedItemRows.length?mergedItemRows:mergedItems.map(function(it,idx){return {code:it.code,name:it.name,rowIndex:idx,colIndex:0};}),
      multiSheetItemRows:mergedMultiSheetItemRows.length?mergedMultiSheetItemRows:null,
      rows:Array.isArray(first.rows)?first.rows:[],
      storeColumns:Array.isArray(first.storeColumns)?first.storeColumns:[],
      quantityColumn:first.quantityColumn||null,
      noteColumn:first.noteColumn||null,
      uiHeaders:first.uiHeaders||buildTemplateUiHeaders("Item Name","Qty","Note","Total Qty","Date"),
    }),
  };
}
function parseLooseSheetItems(rows, category, vendorKey, sheetName, startOrder){
  var outItems=[];
  var outOutline=[];
  var order=Number.isFinite(Number(startOrder))?Number(startOrder):0;
  var currentHeading=String(sheetName||"").trim();
  var seenCodes={};
  if(currentHeading){
    outOutline.push({type:"heading",text:currentHeading,rowIndex:0,colIndex:0});
  }
  var headerWords={item:1,items:1,name:1,product:1,description:1,unit:1,uom:1,bel:1,bot:1,ken:1,red:1,sam:1,total:1,qty:1,quantity:1,code:1,sku:1};
  for(var r=0;r<(rows||[]).length;r++){
    var row=rows[r]||[];
    var cells=[];
    for(var c=0;c<row.length;c++){
      var text=String(row[c]||"").trim();
      if(text) cells.push({col:c,text:text,token:cleanHeaderToken(text)});
    }
    if(!cells.length) continue;
    var first=cells[0].text;
    var firstToken=cells[0].token;
    var nonHeaderCount=cells.filter(function(cell){return !headerWords[cell.token];}).length;
    var hasNumberish=cells.some(function(cell){return /\d/.test(cell.text);});
    if(firstToken==="total"||/^total\b|^grand\s*total\b|^subtotal\b/i.test(first)){
      continue;
    }
    if(nonHeaderCount<=1&&!hasNumberish){
      if(!looksLikeObviousHeadingText(first)){
        var looseCode=buildUniqueItemMasterCode(first,"",seenCodes);
        if(looseCode){
          outItems.push({
            code:looseCode,
            name:first,
            category:normalizeCategory(category),
            vendorKey:normalizeVendorKey(category,vendorKey),
            unit:"",
            subheading:currentHeading||String(sheetName||""),
            sortOrder:order++,
          });
          outOutline.push({type:"item",code:looseCode,name:first,rowIndex:r,colIndex:cells[0].col||0});
          continue;
        }
      }
      currentHeading=first;
      outOutline.push({type:"heading",text:first,rowIndex:r,colIndex:cells[0].col});
      continue;
    }
    var nameCell=cells.find(function(cell){
      if(!cell||!cell.text) return false;
      if(cell.token==="unit"||cell.token==="uom"||cell.token==="item"||cell.token==="items"||cell.token==="name") return false;
      return true;
    })||cells[0];
    var unitCell=cells.find(function(cell){
      if(!cell||!cell.text) return false;
      if(cell.col===nameCell.col) return false;
      return /(\d+\s*[xX]\s*\d+|\d+\s*(kg|g|lb|oz|l|ml|pcs|pc|ct|count))/i.test(cell.text)||cleanHeaderToken(cell.text)==="uom"||cleanHeaderToken(cell.text)==="unit";
    })||null;
    var name=String(nameCell&&nameCell.text||"").trim();
    if(!name) continue;
    var unit=String(unitCell&&unitCell.text||"").trim();
    var code=buildUniqueItemMasterCode(name,unit,seenCodes);
    outItems.push({
      code:code,
      name:name,
      category:normalizeCategory(category),
      vendorKey:normalizeVendorKey(category,vendorKey),
      unit:unit,
      subheading:currentHeading||String(sheetName||""),
      sortOrder:order++,
    });
    outOutline.push({type:"item",code:code,name:name,rowIndex:r,colIndex:nameCell.col||0});
  }
  return {items:outItems,outline:outOutline,nextOrder:order};
}
function normalizeRawGridTemplate(rawGrid){
  if(!rawGrid||typeof rawGrid!=="object"||!Array.isArray(rawGrid.sheets)) return null;
  var sheets=rawGrid.sheets.map(function(sheet,idx){
    var name=String(sheet&&sheet.name||("Sheet "+String(idx+1))).trim()||("Sheet "+String(idx+1));
    var rows=(sheet&&Array.isArray(sheet.rows)?sheet.rows:[]).map(function(row){
      return Array.isArray(row)?row.map(function(cell){return cell==null?"":String(cell);}):[];
    });
    return {name:name,rows:rows};
  }).filter(function(sheet){return Array.isArray(sheet.rows)&&sheet.rows.length>0;});
  if(!sheets.length) return null;
  return {sheets:sheets};
}
function buildRawGridTemplateFromWorkbook(workbook, sourceFilename, originalFile){
  var names=Array.isArray(workbook&&workbook.SheetNames)?workbook.SheetNames:[];
  var sheets=names.map(function(name){
    var ws=workbook&&workbook.Sheets?workbook.Sheets[name]:null;
    return {name:String(name||""),rows:worksheetToRows(ws)};
  }).filter(function(sheet){return sheet.rows&&sheet.rows.length>0;});
  if(!sheets.length) return null;
  return {
    kind:"raw_grid",
    sourceFilename:sourceFilename||"",
    sheetName:sheets[0].name||"",
    originalFile:originalFile||null,
    rows:sheets[0].rows,
    outline:[],
    itemRows:[],
    storeColumns:[],
    quantityColumn:null,
    noteColumn:null,
    uiHeaders:buildTemplateUiHeaders("Item Name","Qty","Note","Total Qty","Date"),
    rawGrid:{sheets:sheets},
  };
}
function buildRawGridTemplateFromSheets(sheets, sourceFilename, originalFile){
  var normalizedSheets=(Array.isArray(sheets)?sheets:[]).map(function(sheet,idx){
    return {
      name:String(sheet&&sheet.name||("Sheet "+String(idx+1))).trim()||("Sheet "+String(idx+1)),
      rows:normalizePreviewRows(sheet&&sheet.rows),
    };
  }).filter(function(sheet){return Array.isArray(sheet.rows)&&sheet.rows.length>0;});
  if(!normalizedSheets.length) return null;
  return {
    kind:"raw_grid",
    sourceFilename:sourceFilename||"",
    sheetName:normalizedSheets[0].name||"",
    originalFile:originalFile||null,
    rows:normalizedSheets[0].rows,
    outline:[],
    itemRows:[],
    storeColumns:[],
    quantityColumn:null,
    noteColumn:null,
    uiHeaders:buildTemplateUiHeaders("Item Name","Qty","Note","Total Qty","Date"),
    rawGrid:{sheets:normalizedSheets},
  };
}
function parseCategoryTemplateKey(templateKey){
  var parts=String(templateKey||"").trim().split(":");
  var category=normalizeCategory(parts[0]||"vegetables");
  var vendorKey=parts.length>1?normalizeVendorKey(category,parts.slice(1).join(":")):null;
  return {category:category,vendorKey:vendorKey};
}
function itemIdentitySignature(category, vendorKey, name, unit){
  return [
    normalizeCategory(category),
    normalizeVendorKey(category,vendorKey)||"",
    String(name||"").trim().replace(/\s+/g," ").toLowerCase(),
    String(unit||"").trim().replace(/\s+/g," ").toLowerCase(),
  ].join("|");
}
function buildTemplateCandidateFromSheets(sheets, category, vendorKey, sourceFilename, originalFile){
  var normalizedSheets=(Array.isArray(sheets)?sheets:[]).map(function(sheet,idx){
    return {
      name:String(sheet&&sheet.name||("Sheet "+String(idx+1))).trim()||("Sheet "+String(idx+1)),
      rows:normalizePreviewRows(sheet&&sheet.rows),
    };
  }).filter(function(sheet){return Array.isArray(sheet.rows)&&sheet.rows.length>0;});
  if(!normalizedSheets.length) return null;
  var rawGridTemplate=buildRawGridTemplateFromSheets(normalizedSheets,sourceFilename,originalFile);
  var parsedSheets=[];
  var looseItems=[];
  var looseOrder=0;
  normalizedSheets.forEach(function(sheet){
    var rows=sheet.rows;
    if(!rows.length) return;
    var parsedTemplate=parseTemplateItemSheet(rows,category,vendorKey,sourceFilename,sheet.name,originalFile);
    if(parsedTemplate&&parsedTemplate.items&&parsedTemplate.items.length){
      parsedSheets.push(parsedTemplate);
      return;
    }
    var loose=parseLooseSheetItems(rows,category,vendorKey,sheet.name,looseOrder);
    looseOrder=loose.nextOrder;
    if(loose.items&&loose.items.length){
      loose.items.forEach(function(it){looseItems.push(it);});
    }
  });
  if(!parsedSheets.length&&!looseItems.length) return null;
  var mergedParsed=parsedSheets.length?mergeParsedTemplateSheets(parsedSheets,category,vendorKey,sourceFilename,originalFile):null;
  var mergedItems=mergedParsed&&Array.isArray(mergedParsed.items)?mergedParsed.items.slice():[];
  var usedCodes={};
  mergedItems.forEach(function(it){
    var code=String(it&&it.code||"").trim();
    if(code) usedCodes[code]=true;
  });
  looseItems.forEach(function(it){
    var baseCode=String(it&&it.code||"").trim();
    if(!baseCode) return;
    var finalCode=baseCode;
    if(usedCodes[finalCode]) finalCode=finalCode+"__L"+String(mergedItems.length+1);
    while(usedCodes[finalCode]) finalCode=finalCode+"_x";
    usedCodes[finalCode]=true;
    mergedItems.push(Object.assign({},it,{code:finalCode}));
  });
  if(!mergedItems.length) return null;
  var nextTemplate=mergedParsed&&mergedParsed.template
    ?Object.assign({},mergedParsed.template,{rawGrid:rawGridTemplate&&rawGridTemplate.rawGrid?rawGridTemplate.rawGrid:null,originalFile:originalFile||mergedParsed.template.originalFile||null})
    :(rawGridTemplate||null);
  if(nextTemplate&&looseItems.length){
    var looseStart=Math.max(0,mergedItems.length-looseItems.length);
    var nextOutline=Array.isArray(nextTemplate.outline)?nextTemplate.outline.slice():[];
    var looseHeading="";
    looseItems.forEach(function(_it,idx){
      var finalItem=mergedItems[looseStart+idx];
      if(!finalItem) return;
      var heading=String(finalItem&&finalItem.subheading||"").trim();
      if(heading&&heading!==looseHeading){
        nextOutline.push({type:"heading",text:heading,rowIndex:idx,colIndex:0});
        looseHeading=heading;
      }
      nextOutline.push({type:"item",code:finalItem.code,name:finalItem.name,rowIndex:idx,colIndex:0});
    });
    nextTemplate=Object.assign({},nextTemplate,{outline:nextOutline});
  }
  return {
    items:mergedItems.map(function(it,idx){
      return Object.assign({},it,{sortOrder:idx,category:normalizeCategory(category),vendorKey:normalizeVendorKey(category,vendorKey)});
    }),
    template:nextTemplate,
  };
}
function buildItemsFromDocxTemplate(template, category, vendorKey){
  var outline=template&&template.docxMap&&Array.isArray(template.docxMap.outline)?template.docxMap.outline:[];
  var itemRows=template&&template.docxMap&&Array.isArray(template.docxMap.itemRows)?template.docxMap.itemRows:[];
  var headingByCode={};
  var currentHeading="";
  outline.forEach(function(entry){
    if(!entry||typeof entry!=="object") return;
    if(entry.type==="heading"){
      currentHeading=String(entry.text||"").trim();
      return;
    }
    if(entry.type!=="item") return;
    var code=String(entry.code||"").trim();
    if(code) headingByCode[code]=currentHeading;
  });
  var seen={};
  return itemRows.map(function(row,idx){
    var code=String(row&&row.code||"").trim();
    var name=String(row&&row.name||"").trim();
    if(!code||!name||seen[code]) return null;
    seen[code]=true;
    return {
      code:code,
      name:name,
      category:normalizeCategory(category),
      vendorKey:normalizeVendorKey(category,vendorKey),
      unit:"",
      subheading:String(headingByCode[code]||"").trim(),
      sortOrder:idx,
    };
  }).filter(function(it){return !!it;});
}
function buildTemplateCandidateFromStoredTemplate(template, category, vendorKey){
  if(!template||typeof template!=="object") return null;
  if(template.kind==="docx_vendor_form"){
    return {items:buildItemsFromDocxTemplate(template,category,vendorKey),template:template};
  }
  var normalizedRawGrid=normalizeRawGridTemplate(template.rawGrid);
  if(normalizedRawGrid&&Array.isArray(normalizedRawGrid.sheets)&&normalizedRawGrid.sheets.length){
    return buildTemplateCandidateFromSheets(normalizedRawGrid.sheets,category,vendorKey,template.sourceFilename||"",template.originalFile||null);
  }
  if(Array.isArray(template.rows)&&template.rows.length){
    return buildTemplateCandidateFromSheets([{name:String(template.sheetName||"").trim()||"Sheet 1",rows:template.rows}],category,vendorKey,template.sourceFilename||"",template.originalFile||null);
  }
  return null;
}
function remapTemplateCodes(template, codeMap){
  var keys=codeMap&&typeof codeMap==="object"?Object.keys(codeMap):[];
  if(!template||!keys.length) return template;
  if(template.kind==="docx_vendor_form"&&template.docxMap){
    return Object.assign({},template,{docxMap:Object.assign({},template.docxMap,{
      outline:Array.isArray(template.docxMap.outline)?template.docxMap.outline.map(function(entry){
        if(!entry||entry.type!=="item") return entry;
        var code=String(entry.code||"").trim();
        return codeMap[code]?Object.assign({},entry,{code:codeMap[code]}):entry;
      }):template.docxMap.outline,
      itemRows:Array.isArray(template.docxMap.itemRows)?template.docxMap.itemRows.map(function(row){
        var code=String(row&&row.code||"").trim();
        return codeMap[code]?Object.assign({},row,{code:codeMap[code]}):row;
      }):template.docxMap.itemRows,
    })});
  }
  return Object.assign({},template,{
    outline:Array.isArray(template.outline)?template.outline.map(function(entry){
      if(!entry||entry.type!=="item") return entry;
      var code=String(entry.code||"").trim();
      return codeMap[code]?Object.assign({},entry,{code:codeMap[code]}):entry;
    }):template.outline,
    itemRows:Array.isArray(template.itemRows)?template.itemRows.map(function(row){
      var code=String(row&&row.code||"").trim();
      return codeMap[code]?Object.assign({},row,{code:codeMap[code]}):row;
    }):template.itemRows,
    multiSheetItemRows:Array.isArray(template.multiSheetItemRows)?template.multiSheetItemRows.map(function(row){
      var code=String(row&&row.code||"").trim();
      return codeMap[code]?Object.assign({},row,{code:codeMap[code]}):row;
    }):template.multiSheetItemRows,
  });
}
function shouldPreferTemplateCandidate(currentTemplate, candidate){
  if(!candidate||!candidate.template) return false;
  if(!currentTemplate||typeof currentTemplate!=="object") return true;
  var currentOutline=currentTemplate.kind==="docx_vendor_form"&&currentTemplate.docxMap&&Array.isArray(currentTemplate.docxMap.outline)
    ?currentTemplate.docxMap.outline.length
    :(Array.isArray(currentTemplate.outline)?currentTemplate.outline.length:0);
  var nextOutline=candidate.template.kind==="docx_vendor_form"&&candidate.template.docxMap&&Array.isArray(candidate.template.docxMap.outline)
    ?candidate.template.docxMap.outline.length
    :(Array.isArray(candidate.template.outline)?candidate.template.outline.length:0);
  var currentItemRows=currentTemplate.kind==="docx_vendor_form"&&currentTemplate.docxMap&&Array.isArray(currentTemplate.docxMap.itemRows)
    ?currentTemplate.docxMap.itemRows.length
    :(Array.isArray(currentTemplate.itemRows)?currentTemplate.itemRows.length:0);
  var nextItemRows=candidate.template.kind==="docx_vendor_form"&&candidate.template.docxMap&&Array.isArray(candidate.template.docxMap.itemRows)
    ?candidate.template.docxMap.itemRows.length
    :(Array.isArray(candidate.template.itemRows)?candidate.template.itemRows.length:0);
  var currentQtyHeader=currentTemplate.quantityColumn&&currentTemplate.quantityColumn.header?String(currentTemplate.quantityColumn.header):"";
  var nextQtyHeader=candidate.template.quantityColumn&&candidate.template.quantityColumn.header?String(candidate.template.quantityColumn.header):"";
  if(currentTemplate.kind!=="docx_vendor_form"&&candidate.template.kind==="matrix"&&currentTemplate.kind!=="matrix") return true;
  if(isUnitLikeHeaderLabel(currentQtyHeader)&&!isUnitLikeHeaderLabel(nextQtyHeader)) return true;
  if(currentTemplate.kind==="raw_grid"&&candidate.template.kind!=="raw_grid") return true;
  if(nextItemRows>currentItemRows) return true;
  if(nextOutline>currentOutline) return true;
  return false;
}
function reconcileTemplateCandidate(candidate, existingItems, category, vendorKey){
  if(!candidate||!candidate.template) return null;
  var existingBySignature={};
  (Array.isArray(existingItems)?existingItems:[]).forEach(function(it){
    if(normalizeCategory(it&&it.category)!==normalizeCategory(category)) return;
    if(normalizeVendorKey(category,it&&it.vendorKey)!==normalizeVendorKey(category,vendorKey)) return;
    var sig=itemIdentitySignature(category,vendorKey,it&&it.name,it&&it.unit);
    if(sig&&!existingBySignature[sig]) existingBySignature[sig]=it;
  });
  var codeMap={};
  var seenCodes={};
  var items=(candidate.items||[]).map(function(item,idx){
    if(!item||!item.name) return null;
    var sig=itemIdentitySignature(category,vendorKey,item.name,item.unit);
    var existing=sig?existingBySignature[sig]:null;
    var nextCode=String(existing&&existing.code||item.code||"").trim();
    if(!nextCode) return null;
    if(String(item.code||"").trim()&&String(item.code||"").trim()!==nextCode) codeMap[String(item.code||"").trim()]=nextCode;
    if(seenCodes[nextCode]) return null;
    seenCodes[nextCode]=true;
    return Object.assign({},item,{code:nextCode,category:normalizeCategory(category),vendorKey:normalizeVendorKey(category,vendorKey),sortOrder:idx});
  }).filter(function(item){return !!item;});
  return {items:items,template:remapTemplateCodes(candidate.template,codeMap)};
}
function repairLoadedTemplatesAndItems(items, categoryTemplates){
  var nextItems=sortItems(Array.isArray(items)?items:[]);
  var inputTemplates=categoryTemplates&&typeof categoryTemplates==="object"?categoryTemplates:{};
  var nextTemplates={};
  Object.keys(inputTemplates).forEach(function(templateKey){
    var currentTemplate=inputTemplates[templateKey];
    var parts=parseCategoryTemplateKey(templateKey);
    var candidate=buildTemplateCandidateFromStoredTemplate(currentTemplate,parts.category,parts.vendorKey);
    var reconciled=reconcileTemplateCandidate(candidate,nextItems,parts.category,parts.vendorKey);
    var shouldUseCandidate=shouldPreferTemplateCandidate(currentTemplate,reconciled);
    nextTemplates[templateKey]=shouldUseCandidate&&reconciled&&reconciled.template?reconciled.template:currentTemplate;
    if(!shouldUseCandidate||!reconciled||!Array.isArray(reconciled.items)||!reconciled.items.length) return;
    var existingSignatures={};
    nextItems.forEach(function(it){
      existingSignatures[itemIdentitySignature(it&&it.category,it&&it.vendorKey,it&&it.name,it&&it.unit)]=true;
    });
    reconciled.items.forEach(function(item){
      var sig=itemIdentitySignature(item.category,item.vendorKey,item.name,item.unit);
      if(!sig||existingSignatures[sig]) return;
      existingSignatures[sig]=true;
      nextItems.push(item);
    });
    nextItems=sortItems(nextItems);
  });
  return {items:nextItems,categoryTemplates:nextTemplates};
}
function fmtDT(iso){if(!iso)return"-";var d=new Date(iso);return d.toLocaleDateString()+" "+d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});}
function parseCSV(text, forcedCategory){var lines=text.split(/\r?\n/).filter(function(l){return l.trim();});if(lines.length<2)return[];var hdr=lines[0].split(",").map(function(h){return h.trim().toLowerCase().replace(/[^a-z0-9]/g,"");});var ni=hdr.findIndex(function(h){return h.indexOf("name")>=0||h==="item"||h==="description";});var cti=hdr.findIndex(function(h){return h.indexOf("cat")>=0||h==="group";});var ui=hdr.findIndex(function(h){return h.indexOf("unit")>=0||h==="uom";});if(ni===-1)return[];var r=[];var usedCodes={};for(var i=1;i<lines.length;i++){var cols=lines[i].split(",").map(function(c){return c.trim().replace(/"/g,"");});if(!cols[ni])continue;var rowCategory=forcedCategory||(cti>=0?(cols[cti]||""):"vegetables");var unitText=ui>=0?(cols[ui]||""):"";r.push({code:buildUniqueItemMasterCode(cols[ni],unitText,usedCodes),name:cols[ni],category:normalizeCategory(rowCategory),unit:unitText,subheading:"",sortOrder:r.length});}return r;}
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
function parseItemSheetRows(rows, forcedCategory){
  if(!rows||rows.length<2)return[];
  var resolvedForcedCategory=normalizeCategory(forcedCategory||"vegetables");
  var headerBlocks=[];
  var headerRow=-1;
  for(var r=0;r<Math.min(rows.length,25);r++){
    var row=(rows[r]||[]);
    var normalized=row.map(cleanHeaderToken);
    var rowBlocks=[];
    normalized.forEach(function(token,colIdx){
      var isNameCol=token.indexOf("name")>=0||token==="item"||token==="items"||token==="description"||token==="product";
      if(!isNameCol) return;
      var codeCol=-1;
      var unitCol=-1;
      for(var c=Math.max(0,colIdx-2);c<=Math.min(normalized.length-1,colIdx+4);c++){
        if(c===colIdx) continue;
        var t=normalized[c];
        if(codeCol===-1&&(t.indexOf("code")>=0||t==="sku")) codeCol=c;
        if(unitCol===-1&&(t.indexOf("unit")>=0||t==="uom")) unitCol=c;
      }
      rowBlocks.push({itemCol:colIdx,codeCol:codeCol,unitCol:unitCol});
    });
    if(rowBlocks.length){
      headerRow=r;
      headerBlocks=rowBlocks.sort(function(a,b){return a.itemCol-b.itemCol;});
      break;
    }
  }
  if(headerRow===-1||!headerBlocks.length)return[];
  var out=[];
  var seenCodes={};
  var usedCodes={};
  headerBlocks.forEach(function(block){
    var currentSubheading="";
    for(var i=headerRow+1;i<rows.length;i++){
      var cols=rows[i]||[];
      var name=cols[block.itemCol]!=null?String(cols[block.itemCol]).trim():"";
      var codeText=block.codeCol>=0&&cols[block.codeCol]!=null?String(cols[block.codeCol]).trim():"";
      var unit=block.unitCol>=0&&cols[block.unitCol]!=null?String(cols[block.unitCol]).trim():"";
      if(!name&&!codeText&&!unit) continue;
      if(!name||/^date\b/i.test(name)) continue;
      if(cleanHeaderToken(name)==="item"||cleanHeaderToken(name)==="items"||cleanHeaderToken(name)==="name") continue;
      if(resolvedForcedCategory==="vendor_orders"&&!codeText&&!unit&&name){
        if(block.codeCol>=0){
          currentSubheading=name;
          continue;
        }
        var nextText=String((rows[i+1]&&rows[i+1][block.itemCol])||"").trim();
        if(nextText){
          currentSubheading=name;
          continue;
        }
      }
      var category=resolvedForcedCategory;
      var baseCode=buildUniqueItemMasterCode(name,unit,usedCodes);
      if(!baseCode||seenCodes[baseCode]) continue;
      seenCodes[baseCode]=true;
      out.push({code:baseCode,name:name,category:category,unit:unit,subheading:currentSubheading,sortOrder:out.length});
    }
  });
  return out;
}
function normLabel(v){return String(v||"").toLowerCase().replace(/[^a-z0-9]/g,"").trim();}
function syntheticOrderKeyFromName(name, category, vendorKey){return syntheticItemCode(category||"vegetables",vendorKey,name);}
function displayNameForOrderKey(code, items){
  var found=(items||[]).find(function(it){return it.code===code;});
  if(found&&found.name)return found.name;
  if(String(code||"").indexOf("XLS::")===0)return String(code).slice(5);
  return String(code||"");
}
function normalizeCatalogAliasToken(value){
  return String(value||"").trim().toLowerCase().replace(/\s+/g," ");
}
function buildCatalogAliasCodeMap(items, category, vendorKey){
  var resolvedCategory=normalizeCategory(category||"vegetables");
  var resolvedVendorKey=normalizeVendorKey(resolvedCategory,vendorKey);
  var aliasBuckets={};
  (items||[]).forEach(function(it){
    if(normalizeCategory(it&&it.category||"vegetables")!==resolvedCategory) return;
    if(normalizeVendorKey(resolvedCategory,it&&it.vendorKey)!==resolvedVendorKey) return;
    var code=String(it&&it.code||"").trim();
    var name=String(it&&it.name||"").trim();
    var unit=String(it&&it.unit||"").trim();
    if(!code) return;
    [
      code,
      name,
      buildItemMasterCode(name,unit),
      formatItemDetailName(name,unit),
      name?"XLS::"+name:"",
    ].forEach(function(alias){
      var token=normalizeCatalogAliasToken(alias);
      if(!token) return;
      if(!aliasBuckets[token]) aliasBuckets[token]={};
      aliasBuckets[token][code]=true;
    });
  });
  return Object.keys(aliasBuckets).reduce(function(out,token){
    var codes=Object.keys(aliasBuckets[token]);
    out[token]=codes.length===1?codes[0]:null;
    return out;
  },{});
}
function resolveCanonicalOrderCode(code, items, category, vendorKey, aliasCodeMap){
  var normalizedCode=String(code||"").trim();
  var resolvedCategory=normalizeCategory(category||"vegetables");
  var resolvedVendorKey=normalizeVendorKey(resolvedCategory,vendorKey);
  if(!normalizedCode) return "";
  var exact=(items||[]).some(function(it){
    return String(it&&it.code||"").trim()===normalizedCode
      && normalizeCategory(it&&it.category||"vegetables")===resolvedCategory
      && normalizeVendorKey(resolvedCategory,it&&it.vendorKey)===resolvedVendorKey;
  });
  if(exact) return normalizedCode;
  var suffixTrimmed=normalizedCode.replace(/\s*\(\d+\)$/,""
  );
  var candidates=[
    normalizedCode,
    String(normalizedCode).indexOf("XLS::")===0?String(normalizedCode).slice(5):"",
    suffixTrimmed,
    suffixTrimmed&&String(suffixTrimmed).indexOf("XLS::")!==0?"XLS::"+suffixTrimmed:"",
  ].filter(function(value,idx,list){return !!value&&list.indexOf(value)===idx;});
  for(var i=0;i<candidates.length;i+=1){
    var token=normalizeCatalogAliasToken(candidates[i]);
    if(token&&aliasCodeMap&&aliasCodeMap[token]) return aliasCodeMap[token];
  }
  return normalizedCode;
}
function mergeCanonicalOrderItemValues(currentValue, nextValue){
  var current=normalizeOrderItemEntry(currentValue);
  var next=normalizeOrderItemEntry(nextValue);
  var unitType=current.qty>0?current.unitType:next.unitType;
  if(current.qty>0&&next.qty>0&&current.unitType!==next.unitType){
    unitType=current.unitType;
  }
  return {
    qty:current.qty+next.qty,
    unitType:unitType,
    customUnit:unitType==="other"?(current.customUnit||next.customUnit||""):"",
  };
}
function mergeCanonicalOrderNotes(currentNote, nextNote){
  var current=String(currentNote||"").trim();
  var next=String(nextNote||"").trim();
  if(!current) return next;
  if(!next) return current;
  var parts=current.split(" | ");
  if(parts.indexOf(next)>=0) return current;
  return current+" | "+next;
}
function isIgnorableLegacyOrderCode(code, items, category, vendorKey){
  var normalizedCode=String(code||"").trim();
  var resolvedCategory=normalizeCategory(category||"vegetables");
  var resolvedVendorKey=normalizeVendorKey(resolvedCategory,vendorKey);
  if(!normalizedCode||resolvedCategory==="vendor_orders") return false;
  if(!/^\d+$/.test(normalizedCode)) return false;
  return !(items||[]).some(function(it){
    return String(it&&it.code||"").trim()===normalizedCode
      && normalizeCategory(it&&it.category||"vegetables")===resolvedCategory
      && normalizeVendorKey(resolvedCategory,it&&it.vendorKey)===resolvedVendorKey;
  });
}
function sanitizeOrderCodeMaps(itemMap, noteMap, items, category, vendorKey){
  var sanitizedItems={};
  var sanitizedNotes={};
  var aliasCodeMap=buildCatalogAliasCodeMap(items,category,vendorKey);
  Object.keys(itemMap||{}).forEach(function(code){
    if(isIgnorableLegacyOrderCode(code,items,category,vendorKey)) return;
    var resolvedCode=resolveCanonicalOrderCode(code,items,category,vendorKey,aliasCodeMap);
    if(!resolvedCode) return;
    sanitizedItems[resolvedCode]=sanitizedItems[resolvedCode]==null
      ?itemMap[code]
      :mergeCanonicalOrderItemValues(sanitizedItems[resolvedCode],itemMap[code]);
  });
  Object.keys(noteMap||{}).forEach(function(code){
    if(isIgnorableLegacyOrderCode(code,items,category,vendorKey)) return;
    var resolvedCode=resolveCanonicalOrderCode(code,items,category,vendorKey,aliasCodeMap);
    if(!resolvedCode) return;
    sanitizedNotes[resolvedCode]=mergeCanonicalOrderNotes(sanitizedNotes[resolvedCode],noteMap[code]);
  });
  return {items:sanitizedItems,notes:sanitizedNotes};
}
function formatItemDetailName(name, unit){
  var trimmedName=String(name||"").trim();
  var trimmedUnit=String(unit||"").trim();
  if(!trimmedUnit) return trimmedName;
  if(!trimmedName) return trimmedUnit;
  var lowerName=trimmedName.toLowerCase();
  var lowerUnit=trimmedUnit.toLowerCase();
  if(lowerName.endsWith("("+lowerUnit+")")||lowerName.endsWith("["+lowerUnit+"]")) return trimmedName;
  return trimmedName+" ("+trimmedUnit+")";
}
function buildOrderItemDetails(codes, orderedRows, items, template){
  var details={};
  var codeToHeading={};
  if(template){
     var displayRows=buildTemplateDisplayRows(template,items);
     var currentHeading="";
     displayRows.forEach(function(r){
       if(r&&r.type==="heading"&&r.text) currentHeading=String(r.text).trim();
       else if(r&&r.type==="item"&&r.item&&r.item.code) codeToHeading[r.item.code]=currentHeading;
     });
  }
  (orderedRows||[]).forEach(function(it){
    if(!it||!it.code) return;
    var itemUnit=String(it.unit||"").trim();
    details[it.code]={name:formatItemDetailName(it.name||displayNameForOrderKey(it.code,items),itemUnit),unit:itemUnit,subheading:codeToHeading[it.code]||String(it.subheading||"").trim()};
  });
  (codes||[]).forEach(function(code){
    if(!code||details[code]) return;
    var found=(items||[]).find(function(it){return it.code===code;});
    var unit=String(found&&found.unit||"").trim();
    details[code]={name:formatItemDetailName(found&&found.name?found.name:displayNameForOrderKey(code,items),unit),unit:unit,subheading:codeToHeading[code]||String(found&&found.subheading||"").trim()};
  });
  return details;
}
function supplierEmailsArray(supplier){
  var arr=Array.isArray(supplier&&supplier.emails)?supplier.emails:[];
  var email=typeof (supplier&&supplier.email)==="string"?supplier.email:"";
  return Array.from(new Set(arr.concat(email?email.split(/[,\n;]/):[]).map(function(v){return String(v||"").trim();}).filter(function(v){return !!v;})));
}
function supplierEmailsText(supplier){
  return supplierEmailsArray(supplier).join(", ");
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
function normalizePreviewRows(rows){
  if(!Array.isArray(rows)) return [];
  return rows.map(function(row){
    var cells=Array.isArray(row)?row:[];
    return cells.map(function(cell){return cell==null?"":String(cell);});
  });
}
var REOPEN_TARGET_STORAGE_KEY="consolidatedReopenTargetV1";
function loadPersistedReopenTarget(){
  if(typeof window==="undefined"||!window.sessionStorage) return null;
  try{
    var raw=window.sessionStorage.getItem(REOPEN_TARGET_STORAGE_KEY);
    if(!raw) return null;
    var parsed=JSON.parse(raw);
    if(!parsed||typeof parsed!=="object") return null;
    return {
      type:String(parsed.type||""),
      category:normalizeCategory(parsed.category||"vegetables"),
      vendorKey:String(parsed.vendorKey||""),
      week:String(parsed.week||""),
      reopenedFromId:String(parsed.reopenedFromId||""),
    };
  }catch(_e){return null;}
}
function persistReopenTarget(target){
  if(typeof window==="undefined"||!window.sessionStorage) return;
  try{
    if(!target){
      window.sessionStorage.removeItem(REOPEN_TARGET_STORAGE_KEY);
      return;
    }
    window.sessionStorage.setItem(REOPEN_TARGET_STORAGE_KEY,JSON.stringify({
      type:String(target.type||""),
      category:normalizeCategory(target.category||"vegetables"),
      vendorKey:String(target.vendorKey||""),
      week:String(target.week||""),
      reopenedFromId:String(target.reopenedFromId||""),
    }));
  }catch(_e){}
}
function ExcelSheetPreviewTable({rows,maxHeight}){
  var safeRows=normalizePreviewRows(rows);
  if(!safeRows.length){
    return <div style={{textAlign:"center",padding:24,color:"#64748B"}}>No sheet rows available.</div>;
  }
  return (
    <div style={Object.assign({},S.tw,{maxHeight:maxHeight||420,overflow:"auto"})}>
      <table style={Object.assign({},S.tbl,{tableLayout:"fixed",minWidth:Math.max(720,(safeRows[0]||[]).length*110)})}>
        <tbody>
          {safeRows.map(function(row,rowIdx){
            return <tr key={"r_"+rowIdx}>{row.map(function(cell,colIdx){
              return <td key={"c_"+rowIdx+"_"+colIdx} style={Object.assign({},S.td,{whiteSpace:"pre-wrap",verticalAlign:"top",fontSize:11.5,minWidth:96})}>{cell}</td>;
            })}</tr>;
          })}
        </tbody>
      </table>
    </div>
  );
}
function buildOrderStateMap(list, catalogItems){
  var orderMap={};
  (Array.isArray(list)?list:[]).forEach(function(o){
    var category=normalizeCategory(o.category);
    var vendorKey=normalizeVendorKey(category,o.vendorKey);
    var sanitized=sanitizeOrderCodeMaps(o.items||{},o.notes||{},catalogItems,category,vendorKey);
    var key=o.storeId+"_"+o.week+"-"+o.type+"-"+categoryKey(category,vendorKey);
    orderMap[key]={id:o.id,items:sanitized.items,notes:sanitized.notes,status:o.status,store:o.storeId,type:o.type,category:category,vendorKey:vendorKey,week:o.week||null,date:o.date||o.submittedAt||o.createdAt||new Date().toISOString(),submittedAt:o.submittedAt||null,createdAt:o.createdAt||null};
  });
  return orderMap;
}
function orderStateKey(storeId, week, type, category, vendorKey){
  return String(storeId||"")+"_"+String(week||"")+"-"+String(type||"")+"-"+categoryKey(category,vendorKey);
}
function getStoreOrderForWeek(orderMap, storeId, week, type, category, vendorKey){
  if(!storeId||!week) return null;
  var key=orderStateKey(storeId,week,type,category,vendorKey);
  return orderMap&&orderMap[key]?orderMap[key]:null;
}
function orderTimestampMs(order){
  var raw=order&&(order.submittedAt||order.date||order.createdAt);
  var ts=new Date(raw||0).getTime();
  return Number.isNaN(ts)?0:ts;
}
function parseDateWeekKey(value){
  var match=String(value||"").trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:-(?:M\d+|VS\d+))?$/);
  if(!match) return null;
  var year=parseInt(match[1],10);
  var month=parseInt(match[2],10)-1;
  var day=parseInt(match[3],10);
  var ts=Date.UTC(year,month,day);
  return Number.isNaN(ts)?null:ts;
}
function extractWeekKeyCycleSuffix(value){
  var match=String(value||"").trim().match(/(-M\d+|-VS\d+)$/);
  return match?match[1]:"";
}
function isSameOrAdjacentDateWeekKey(left,right){
  if(String(left||"")===String(right||"")) return true;
  var leftTs=parseDateWeekKey(left);
  var rightTs=parseDateWeekKey(right);
  if(leftTs==null||rightTs==null) return false;
  var diff=Math.abs(leftTs-rightTs);
  var leftSuffix=extractWeekKeyCycleSuffix(left);
  var rightSuffix=extractWeekKeyCycleSuffix(right);
  if(leftSuffix&&rightSuffix&&leftSuffix===rightSuffix){
    return diff<=7*24*60*60*1000;
  }
  if(leftSuffix!==rightSuffix) return false;
  return diff<=24*60*60*1000;
}
function findLatestMatchingOrder(orderMap, storeIds, type, category, vendorKey, statusMap, maxAgeMs){
  var ids=Array.isArray(storeIds)?storeIds.filter(Boolean).map(function(v){return String(v);}):[];
  var filterByStore=ids.length>0;
  var byStore={};
  ids.forEach(function(id){byStore[id]=true;});
  var nowTs=Date.now();
  var best=null;
  Object.values(orderMap||{}).forEach(function(o){
    if(!o) return;
    if(filterByStore&&!byStore[String(o.store||"")]) return;
    if(String(o.type||"")!==String(type||"")) return;
    if(normalizeCategory(o.category||"vegetables")!==normalizeCategory(category)) return;
    if(normalizeVendorKey(category,o.vendorKey)!==normalizeVendorKey(category,vendorKey)) return;
    if(statusMap&&!statusMap[String(o.status||"")]) return;
    var ts=orderTimestampMs(o);
    if(!ts) return;
    if(maxAgeMs!=null&&(nowTs-ts)>maxAgeMs) return;
    if(!best||ts>best.ts){
      best={order:o,ts:ts,week:o.week||null};
    }
  });
  return best;
}
function activeWeekLookupKey(type, category, vendorKey, manualOpenOrder, manualOpenSeq, vendorSeq){
  var fullKey=dateKey(type,category,vendorKey,manualOpenOrder,manualOpenSeq,vendorSeq);
  var suffix="-"+String(type||"")+"-"+categoryKey(category,vendorKey);
  return fullKey.endsWith(suffix)?fullKey.slice(0,fullKey.length-suffix.length):fullKey;
}
function getTemplateForCategory(categoryTemplates, category, vendorKey){
  var cat=normalizeCategory(category);
  var vendor=normalizeVendorKey(cat,vendorKey);
  if(!categoryTemplates||typeof categoryTemplates!=="object") return null;
  if(vendor&&categoryTemplates[cat+":"+vendor]) return categoryTemplates[cat+":"+vendor];
  return categoryTemplates[cat]||null;
}
function buildTemplateDisplayRows(template, itemList){
  var itemsOnly=Array.isArray(itemList)?itemList.filter(function(it){return !!it&&!!it.code;}):[];
  var outline=template&&template.kind==="docx_vendor_form"&&template.docxMap&&Array.isArray(template.docxMap.outline)
    ?template.docxMap.outline
    :(template&&Array.isArray(template.outline)?template.outline:[]);
  var itemRows=template&&template.kind==="docx_vendor_form"&&template.docxMap&&Array.isArray(template.docxMap.itemRows)?template.docxMap.itemRows:[];
  if(!outline.length){
    if(itemRows.length){
      var itemByCodeNoOutline={};
      var usedNoOutline={};
      var rowsNoOutline=[];
      itemsOnly.forEach(function(it){
        if(!itemByCodeNoOutline[it.code]) itemByCodeNoOutline[it.code]=it;
      });
      itemRows.forEach(function(row, idx){
        var code=String(row&&row.code||"").trim();
        var item=itemByCodeNoOutline[code];
        if(!item||usedNoOutline[code]) return;
        rowsNoOutline.push({type:"item",key:item.code||("item-"+idx),item:item});
        usedNoOutline[code]=true;
      });
      itemsOnly.forEach(function(it){
        if(usedNoOutline[it.code]) return;
        rowsNoOutline.push({type:"item",key:it.code,item:it});
      });
      return rowsNoOutline;
    }
    var rowsBySubheading=[];
    var currentSubheading=null;
    itemsOnly.forEach(function(it,idx){
      var nextSubheading=String(it&&it.subheading||"").trim();
      if(nextSubheading&&nextSubheading!==currentSubheading){
        rowsBySubheading.push({type:"heading",key:"subheading-"+idx+"-"+nextSubheading,text:nextSubheading});
        currentSubheading=nextSubheading;
      }
      rowsBySubheading.push({type:"item",key:it.code,item:it});
    });
    return rowsBySubheading;
  }
  var itemByCode={};
  itemsOnly.forEach(function(it){
    if(!itemByCode[it.code]) itemByCode[it.code]=it;
  });
  var used={};
  var rows=[];
  var pendingHeading=null;
  outline.forEach(function(entry, idx){
    if(!entry||typeof entry!=="object") return;
    if(entry.type==="heading"){
      var headingText=String(entry.text||"").trim();
      pendingHeading=headingText?{type:"heading",key:"heading-"+idx+"-"+headingText,text:headingText}:null;
      return;
    }
    if(entry.type!=="item") return;
    var code=String(entry.code||"").trim();
    var item=itemByCode[code];
    if(!item||used[code]) return;
    if(pendingHeading){
      rows.push(pendingHeading);
      pendingHeading=null;
    }
    rows.push({type:"item",key:item.code,item:item});
    used[code]=true;
  });
  itemsOnly.forEach(function(it){
    if(used[it.code]) return;
    rows.push({type:"item",key:it.code,item:it});
  });
  return rows;
}
function orderRowsByTemplate(template, rows){
  var list=Array.isArray(rows)?rows.slice():[];
  if(!list.length) return list;
  var orderedCodes=buildTemplateDisplayRows(template,list.map(function(row){return {code:row.code,name:row.name};}))
    .filter(function(row){return row&&row.type==="item"&&row.item&&row.item.code;})
    .map(function(row){return row.item.code;});
  if(!orderedCodes.length) return list;
  var orderIndex={};
  orderedCodes.forEach(function(code, idx){
    if(orderIndex[code]==null) orderIndex[code]=idx;
  });
  return list.slice().sort(function(a,b){
    var ai=orderIndex[a.code]!=null?orderIndex[a.code]:Number.MAX_SAFE_INTEGER;
    var bi=orderIndex[b.code]!=null?orderIndex[b.code]:Number.MAX_SAFE_INTEGER;
    if(ai!==bi) return ai-bi;
    return String(a&&a.name||"").localeCompare(String(b&&b.name||""),undefined,{sensitivity:"base"});
  });
}
function buildTemplateDataRows(template, rows){
  var rowList=Array.isArray(rows)?rows:[];
  var rowByCode={};
  rowList.forEach(function(row){
    if(row&&row.code&&rowByCode[row.code]==null) rowByCode[row.code]=row;
  });
  return buildTemplateDisplayRows(template,rowList.map(function(row){return {code:row.code,name:row.name};}))
    .map(function(entry){
      if(!entry) return null;
      if(entry.type==="heading") return entry;
      var code=entry.item&&entry.item.code;
      return rowByCode[code]?{type:"item",key:entry.key,row:rowByCode[code]}:null;
    })
    .filter(function(entry){return !!entry;});
}
function isVendorOrderType(type){
  return String(type||"").toUpperCase()==="VENDOR";
}
function stopNumberWheelChange(e){
  e.preventDefault();
  if(e.currentTarget&&typeof e.currentTarget.blur==="function") e.currentTarget.blur();
}
function focusGridCell(navGroup,row,col){
  if(typeof document==="undefined") return;
  var selector='input[data-nav-group="'+String(navGroup)+'"][data-nav-row="'+String(row)+'"][data-nav-col="'+String(col)+'"]';
  var node=document.querySelector(selector);
  if(node&&typeof node.focus==="function"){
    node.focus();
    if(typeof node.select==="function") node.select();
  }
}
function handleGridNavigation(e,navGroup,row,col,maxRow,maxCol){
  var key=String(e&&e.key||"");
  var nextRow=row;
  var nextCol=col;
  if(key==="ArrowRight") nextCol=Math.min(maxCol,col+1);
  else if(key==="ArrowLeft") nextCol=Math.max(0,col-1);
  else if(key==="ArrowDown"||key==="Enter") nextRow=Math.min(maxRow,row+1);
  else if(key==="ArrowUp") nextRow=Math.max(0,row-1);
  else return;
  if(nextRow===row&&nextCol===col) return;
  e.preventDefault();
  focusGridCell(navGroup,nextRow,nextCol);
}
function downloadBase64File(fileBase64, filename, contentType){
  if(!fileBase64) throw new Error("No file data returned");
  var bytes=decodeBase64Bytes(fileBase64);
  var blob=new Blob([bytes],{type:contentType||"application/octet-stream"});
  var url=URL.createObjectURL(blob);
  var a=document.createElement("a");
  a.href=url;
  a.download=filename||"download";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function(){URL.revokeObjectURL(url);},1000);
}
function decodeBase64Bytes(fileBase64){
  var bin=atob(String(fileBase64||""));
  var bytes=new Uint8Array(bin.length);
  for(var i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
  return bytes;
}
function bytesToArrayBuffer(bytes){
  if(bytes instanceof ArrayBuffer) return bytes;
  var view=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes||[]);
  return view.buffer.slice(view.byteOffset,view.byteOffset+view.byteLength);
}
function escapePrintHtml(value){
  return String(value==null?"":value)
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/\"/g,"&quot;")
    .replace(/'/g,"&#39;");
}
function trimPrintableRows(rows){
  var normalized=normalizePreviewRows(rows);
  var lastRow=-1;
  var lastCol=-1;
  normalized.forEach(function(row,rowIdx){
    (row||[]).forEach(function(cell,colIdx){
      if(String(cell||"").trim()){lastRow=Math.max(lastRow,rowIdx);lastCol=Math.max(lastCol,colIdx);}
    });
  });
  if(lastRow<0||lastCol<0) return [];
  return normalized.slice(0,lastRow+1).map(function(row){return row.slice(0,lastCol+1);});
}
function buildPrintableTableHtml(rows){
  var trimmed=trimPrintableRows(rows);
  if(!trimmed.length) return '<div class="print-empty">No printable rows available.</div>';
  var bodyRows=trimmed.map(function(row){
    return '<tr>'+row.map(function(cell){return '<td>'+escapePrintHtml(cell)+"</td>";}).join("")+'</tr>';
  }).join("");
  return '<table class="print-table"><tbody>'+bodyRows+'</tbody></table>';
}
function buildPrintDocumentHtml(title, sectionsHtml){
  return '<!doctype html><html><head><meta charset="utf-8"/><title>'+escapePrintHtml(title)+'</title><style>'+
    '@page{margin:12mm;}'+
    'body{font-family:"Segoe UI",Arial,sans-serif;color:#0f172a;margin:0;padding:18px;background:#fff;}'+
    'h1{font-size:20px;margin:0 0 18px;}'+
    'h2{font-size:14px;margin:0 0 10px;color:#334155;text-transform:uppercase;letter-spacing:.04em;}'+
    '.print-section{margin:0 0 24px;page-break-after:always;}'+
    '.print-section:last-child{page-break-after:auto;}'+
    '.print-table{width:100%;border-collapse:collapse;table-layout:auto;}'+
    '.print-table td,.print-table th{border:1px solid #cbd5e1;padding:6px 8px;font-size:12px;vertical-align:top;word-break:break-word;white-space:pre-wrap;}'+
    '.print-docx{font-size:12px;line-height:1.45;}'+
    '.print-docx table{width:100%;border-collapse:collapse;}'+
    '.print-docx td,.print-docx th{border:1px solid #cbd5e1;padding:6px 8px;vertical-align:top;}'+
    '.print-empty{padding:16px;border:1px dashed #cbd5e1;color:#64748b;font-size:12px;}'+
    '</style></head><body><h1>'+escapePrintHtml(title)+'</h1>'+sectionsHtml+'</body></html>';
}
function openPendingPrintWindow(title){
  var win=window.open("","_blank","width=1200,height=900");
  if(!win) throw new Error("Allow pop-ups to print documents.");
  win.document.open();
  win.document.write(buildPrintDocumentHtml(title,'<div class="print-empty">Preparing print preview...</div>'));
  win.document.close();
  return win;
}
function finalizePrintWindow(win, title, sectionsHtml){
  if(!win||win.closed) throw new Error("Print window was closed before the preview was ready.");
  win.document.open();
  win.document.write(buildPrintDocumentHtml(title,sectionsHtml));
  win.document.close();
  return new Promise(function(resolve,reject){
    var done=false;
    var trigger=function(){
      if(done) return;
      done=true;
      setTimeout(function(){
        try{
          win.focus();
          win.print();
          resolve(true);
        }catch(err){reject(err);}
      },200);
    };
    if(win.document.readyState==="complete") trigger();
    else win.onload=trigger;
  });
}
async function printSheetSections(title, sheets, printWindow){
  var sections=(Array.isArray(sheets)?sheets:[]).map(function(sheet,idx){
    var sheetName=String(sheet&&sheet.name||("Sheet "+String(idx+1))).trim()||("Sheet "+String(idx+1));
    return '<section class="print-section"><h2>'+escapePrintHtml(sheetName)+'</h2>'+buildPrintableTableHtml(sheet&&sheet.rows)+'</section>';
  }).join("");
  return finalizePrintWindow(printWindow||openPendingPrintWindow(title),title,sections||'<div class="print-empty">No printable rows available.</div>');
}
async function printBase64File(fileBase64, filename, contentType, printWindow){
  if(!fileBase64) throw new Error("No file data returned");
  var safeFilename=String(filename||"document").trim()||"document";
  var lowerName=safeFilename.toLowerCase();
  var lowerType=String(contentType||"").toLowerCase();
  var bytes=decodeBase64Bytes(fileBase64);
  var arrayBuffer=bytesToArrayBuffer(bytes);
  if(lowerType.indexOf("spreadsheetml")>=0||/\.xlsx?$/.test(lowerName)){
    var workbook=XLSX.read(arrayBuffer,{type:'array'});
    var sections=(Array.isArray(workbook&&workbook.SheetNames)?workbook.SheetNames:[]).map(function(sheetName){
      return {name:sheetName,rows:worksheetToRows(workbook.Sheets[sheetName])};
    });
    return printSheetSections(safeFilename,sections,printWindow);
  }
  if(lowerType.indexOf("wordprocessingml")>=0||/\.docx$/.test(lowerName)){
    var result=await mammoth.convertToHtml({arrayBuffer:arrayBuffer});
    var warnings=(result&&Array.isArray(result.messages)?result.messages:[]).map(function(msg){return '<div>'+escapePrintHtml(msg.message||msg.value||"")+'</div>';}).join("");
    var sectionsHtml='<section class="print-section"><div class="print-docx">'+String(result&&result.value||"")+'</div>'+(warnings?('<div class="print-empty" style="margin-top:12px;">'+warnings+'</div>'):"")+'</section>';
    return finalizePrintWindow(printWindow||openPendingPrintWindow(safeFilename),safeFilename,sectionsHtml);
  }
  throw new Error("Printing is supported for Excel and Word documents only.");
}




var S={
  page:{minHeight:"100vh",display:"flex",fontFamily:"'Segoe UI',-apple-system,BlinkMacSystemFont,sans-serif",background:"#ECEFF3",color:"#111827"},
  sidebar:{width:240,minWidth:240,background:"rgba(250,250,247,.78)",backdropFilter:"blur(10px)",WebkitBackdropFilter:"blur(10px)",borderRight:"1px solid rgba(148,163,184,.28)",display:"flex",flexDirection:"column",height:"100vh",position:"sticky",top:0,overflowY:"auto"},
  sideHdr:{padding:"14px 12px",borderBottom:"1px solid rgba(148,163,184,.22)",display:"flex",alignItems:"center",gap:8},
  logo:{width:34,height:34,borderRadius:8,background:"linear-gradient(135deg,#22C55E,#15803D)",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:700,fontSize:13,color:"#fff",flexShrink:0},
  navItem:{display:"flex",alignItems:"center",gap:8,padding:"7px 8px",borderRadius:6,cursor:"pointer",fontSize:13.5,fontWeight:500,marginBottom:1},
  navA:{background:"#DCFCE7",color:"#166534"},navI:{color:"#475569"},
  main:{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"},
  topbar:{height:48,minHeight:48,borderBottom:"1px solid rgba(148,163,184,.22)",display:"flex",alignItems:"center",justifyContent:"space-between",padding:"0 16px",background:"rgba(252,252,250,.72)",backdropFilter:"blur(10px)",WebkitBackdropFilter:"blur(10px)"},
  content:{flex:1,overflowY:"auto",padding:14},
  card:{background:"rgba(255,255,255,.72)",backdropFilter:"blur(8px)",WebkitBackdropFilter:"blur(8px)",border:"1px solid rgba(148,163,184,.24)",borderRadius:10,padding:14,marginBottom:10,boxShadow:"0 8px 20px rgba(15,23,42,.06)"},
  cH:{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8,flexWrap:"wrap",gap:6},
  t:{fontSize:16,fontWeight:700,color:"#0F172A"},d:{fontSize:13,color:"#64748B",marginTop:2},
  sg:{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))",gap:8,marginBottom:12},
  sc:{background:"rgba(255,255,255,.72)",border:"1px solid rgba(148,163,184,.24)",borderRadius:10,padding:11,backdropFilter:"blur(6px)",WebkitBackdropFilter:"blur(6px)"},
  sL:{fontSize:10,color:"#64748B",fontWeight:600,textTransform:"uppercase",letterSpacing:.5},
  sV:{fontSize:24,fontWeight:700,marginTop:3,fontFamily:"monospace",color:"#0F172A"},sS:{fontSize:11,color:"#64748B",marginTop:2},
  tw:{overflow:"auto",borderRadius:8,border:"1px solid rgba(148,163,184,.25)",maxHeight:"62vh",background:"rgba(255,255,255,.58)"},
  th:{padding:"7px 8px",textAlign:"left",fontWeight:600,color:"#334155",fontSize:11,textTransform:"uppercase",letterSpacing:.5,whiteSpace:"nowrap",borderBottom:"1px solid rgba(148,163,184,.24)",background:"rgba(241,245,249,.8)",position:"sticky",top:0,zIndex:5},
  td:{padding:"7px 8px",borderBottom:"1px solid rgba(148,163,184,.22)",fontSize:13,color:"#0F172A"},
  tm:{padding:"7px 8px",borderBottom:"1px solid rgba(148,163,184,.22)",fontFamily:"monospace",fontSize:12,color:"#475569"},
  b:{display:"inline-flex",alignItems:"center",gap:4,padding:"6px 10px",borderRadius:6,fontSize:12.5,fontWeight:600,cursor:"pointer",border:"none",whiteSpace:"nowrap",fontFamily:"inherit"},
  bP:{background:"#16A34A",color:"#fff"},bS:{background:"rgba(255,255,255,.72)",color:"#0F172A",border:"1px solid rgba(148,163,184,.34)"},
  bD:{background:"rgba(248,113,113,0.1)",color:"#F87171",border:"1px solid rgba(248,113,113,0.2)"},
  bG:{background:"rgba(22,163,74,0.1)",color:"#166534",border:"1px solid rgba(22,163,74,0.25)"},
  bW:{background:"rgba(251,191,36,0.1)",color:"#FBBF24",border:"1px solid rgba(251,191,36,0.2)"},
  bg:{display:"inline-flex",padding:"2px 8px",borderRadius:16,fontSize:10.5,fontWeight:600},
  bgG:{background:"rgba(22,163,74,0.12)",color:"#166534"},bgY:{background:"rgba(251,191,36,0.14)",color:"#92400E"},
  bgR:{background:"rgba(248,113,113,0.12)",color:"#B91C1C"},bgB:{background:"rgba(34,197,94,0.12)",color:"#166534"},
  bgP:{background:"rgba(168,85,247,0.12)",color:"#0F766E"},
  inp:{width:"100%",padding:"6px 8px",borderRadius:7,border:"1px solid rgba(148,163,184,.34)",background:"rgba(255,255,255,.82)",color:"#0F172A",fontSize:13,outline:"none",fontFamily:"inherit"},
  ni:{width:64,padding:"4px 2px",textAlign:"center",fontFamily:"monospace",fontSize:12.5,borderRadius:7,border:"1px solid rgba(148,163,184,.34)",background:"rgba(255,255,255,.82)",color:"#0F172A",outline:"none"},
  ie:{width:56,padding:"3px",textAlign:"center",fontFamily:"monospace",fontSize:12,borderRadius:4,border:"1.5px solid #16A34A",background:"#FFFFFF",color:"#0F172A",outline:"none"},
  lb:{display:"block",fontSize:11,fontWeight:600,color:"#475569",marginBottom:2,textTransform:"uppercase",letterSpacing:.4},
  ov:{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:12},
  mo:{background:"rgba(255,255,255,.86)",backdropFilter:"blur(12px)",WebkitBackdropFilter:"blur(12px)",border:"1px solid rgba(148,163,184,.28)",borderRadius:12,padding:16,width:500,maxWidth:"95vw",maxHeight:"82vh",overflowY:"auto",color:"#0F172A",boxShadow:"0 20px 40px rgba(15,23,42,.14)"},
  mW:{width:750},mA:{display:"flex",gap:6,justifyContent:"flex-end",marginTop:10},
  fg:{marginBottom:8},fr:{display:"flex",gap:8},
  nI:{padding:"8px 10px",borderRadius:6,marginBottom:8,background:"rgba(22,163,74,0.08)",border:"1px solid rgba(22,163,74,0.2)",color:"#166534",fontSize:12.5},
  nP:{padding:"8px 10px",borderRadius:6,marginBottom:8,background:"rgba(251,191,36,0.1)",border:"1px solid rgba(251,191,36,0.25)",color:"#92400E",fontSize:12.5},
  nG:{padding:"8px 10px",borderRadius:6,marginBottom:8,background:"rgba(22,163,74,0.08)",border:"1px solid rgba(22,163,74,0.22)",color:"#166534",fontSize:12.5},
  tabs:{display:"flex",gap:2,marginBottom:10,padding:1,background:"rgba(241,245,249,.86)",borderRadius:8,width:"fit-content",border:"1px solid rgba(148,163,184,.28)",backdropFilter:"blur(6px)",WebkitBackdropFilter:"blur(6px)"},
  tab:{padding:"4px 10px",borderRadius:5,fontSize:12,fontWeight:600,cursor:"pointer",border:"none",fontFamily:"inherit"},
  tA:{background:"#16A34A",color:"#fff"},tI:{background:"transparent",color:"#475569"},
  dWrap:{display:"flex",gap:8,flexWrap:"wrap",alignItems:"flex-start"},
  dCard:{minWidth:180,background:"rgba(255,255,255,.72)",border:"1px solid rgba(148,163,184,.24)",borderRadius:10,padding:8,backdropFilter:"blur(6px)",WebkitBackdropFilter:"blur(6px)"},
  dTitle:{fontSize:11,color:"#64748B",fontWeight:700,textTransform:"uppercase",letterSpacing:.45,marginBottom:5},
  dBtn:{display:"block",width:"100%",textAlign:"left",padding:"6px 8px",borderRadius:7,border:"none",background:"transparent",fontSize:13.5,fontWeight:600,color:"#334155",cursor:"pointer",marginBottom:3,fontFamily:"inherit"},
  dBtnA:{background:"rgba(22,163,74,.12)",color:"#166534"},
  dBtnD:{opacity:.45,cursor:"not-allowed"},
  dSub:{paddingLeft:8,borderLeft:"2px solid rgba(148,163,184,.3)",marginLeft:4,marginTop:2},
  eB:{background:"none",border:"none",cursor:"pointer",color:"#64748B",padding:2,borderRadius:4,display:"inline-flex",alignItems:"center"},
  cE:{background:"rgba(22,163,74,0.08)"},
  to:{position:"fixed",top:14,right:14,zIndex:2000,padding:"8px 16px",borderRadius:6,fontSize:13.5,fontWeight:500,color:"#34D399",background:"#065F46",border:"1px solid rgba(52,211,153,0.3)"},
  toE:{color:"#F87171",background:"#7F1D1D",border:"1px solid rgba(248,113,113,0.3)"},
  lP:{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"#ECEFF3"},
  lC:{width:540,maxWidth:"94vw",background:"rgba(255,255,255,.74)",backdropFilter:"blur(14px)",WebkitBackdropFilter:"blur(14px)",border:"1px solid rgba(15,23,42,.12)",borderRadius:22,padding:"32px 28px",boxShadow:"0 24px 48px rgba(15,23,42,.14)"},
  lE:{padding:"6px 10px",borderRadius:6,fontSize:11.5,background:"rgba(248,113,113,0.1)",color:"#F87171",border:"1px solid rgba(248,113,113,0.2)",marginBottom:10,textAlign:"center"},
  sB:{display:"flex",alignItems:"center",gap:4,padding:"4px 8px",background:"rgba(255,255,255,.8)",border:"1px solid rgba(148,163,184,.34)",borderRadius:8},
  sI:{border:"none",background:"none",padding:0,fontSize:13.5,color:"#0F172A",outline:"none",width:130,fontFamily:"inherit"},
  ft:{padding:10,borderTop:"1px solid rgba(148,163,184,.22)"},
  uC:{display:"flex",alignItems:"center",gap:7,padding:"6px 8px",borderRadius:8,background:"rgba(241,245,249,.72)"},
  av:{width:28,height:28,borderRadius:"50%",background:"linear-gradient(135deg,#34D399,#059669)",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:700,fontSize:11,color:"#fff",flexShrink:0},
  loB:{display:"flex",alignItems:"center",gap:4,marginTop:5,width:"100%",padding:"5px 8px",borderRadius:8,border:"1px solid rgba(148,163,184,.32)",background:"rgba(255,255,255,.5)",color:"#475569",fontSize:10.5,cursor:"pointer",fontFamily:"inherit"},
  tbl:{width:"100%",borderCollapse:"collapse"},
};

/* ═══ ICONS ═══ */
function Ic({type,size}){var z=size||16;var p={home:"M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",clip:"M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2 M8 2h8v4H8z",grid:"M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z",up:"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M17 8l-5-5-5 5 M12 3v12",users:"M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 7a4 4 0 1 0 0-0.01 M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75",bell:"M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9 M13.73 21a2 2 0 0 1-3.46 0",gear:"M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0",out:"M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9",check:"M20 6L9 17l-5-5",plus:"M12 5v14M5 12h14",trash:"M3 6h18 M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",search:"M11 11m-8 0a8 8 0 1 0 16 0a8 8 0 1 0-16 0 M21 21l-4.35-4.35",edit:"M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7 M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z",pin:"M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z M12 10m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0",lock:"M3 11h18v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V11z M7 11V7a5 5 0 0 1 10 0v4",save:"M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z M17 21v-8H7v8 M7 3v5h8",send:"M22 2L11 13 M22 2l-7 20-4-9-9-4 20-7z",eye:"M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0",x:"M18 6L6 18M6 6l12 12",menu:"M3 12h18M3 6h18M3 18h18",truck:"M1 3h15v13H1z M16 8h4l3 3v5h-7V8z M5.5 18.5a2.5 2.5 0 1 0 0-0.01 M18.5 18.5a2.5 2.5 0 1 0 0-0.01",chart:"M18 20V10 M12 20V4 M6 20v-6",mail:"M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M22 6l-10 7L2 6",phone:"M22 16.92v3a2 2 0 0 1-2.18 2A19.86 19.86 0 0 1 3.09 5.18 2 2 0 0 1 5.11 3h3a2 2 0 0 1 2 1.72c.13.81.36 1.6.68 2.34a2 2 0 0 1-.45 2.11L8.91 10.6a16 16 0 0 0 6.29 6.29l1.43-1.43a2 2 0 0 1 2.11-.45c.74.32 1.53.55 2.34.68a2 2 0 0 1 1.72 2v.23z"};return(<svg width={z} height={z} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{(p[type]||"").split(" M").map(function(s,i){return <path key={i} d={i===0?s:"M"+s}/>;})}</svg>);}

/* ═══ TOAST ═══ */
function Toast({msg,isErr}){if(!msg)return null;return <div style={Object.assign({},S.to,isErr?S.toE:{})}>{msg}</div>;}

function OrderDrawerNav({selCategory,setSelCategory,orderType,setOrderType,getCategoryDisabled,getOrderTypeDisabled,orderTypeSuffix,onCategoryChanged,categories}){
  var mainCats=categories||[
    {id:"vegetables",label:"Vegetables"},
    {id:"leaves",label:"Leaves"},
    {id:"vendor_orders",label:"Vendors"},
  ];
  return(<div style={S.dWrap}>
    <div style={S.dCard}>
      <div style={S.dTitle}>Order Categories</div>
      {mainCats.map(function(cat){
        var disabled=!!(getCategoryDisabled&&getCategoryDisabled(cat.id));
        var isActive=selCategory===cat.id;
        return <button key={cat.id} disabled={disabled} style={Object.assign({},S.dBtn,isActive?S.dBtnA:{},disabled?S.dBtnD:{})} onClick={function(){if(disabled)return;setSelCategory(cat.id);if(onCategoryChanged) onCategoryChanged(cat.id);}}>{cat.label}</button>;
      })}
    </div>
    {selCategory==="vegetables"&&<div style={S.dCard}>
      <div style={S.dTitle}>Vegetables Orders</div>
      <div style={S.dSub}>
        {["A","B","C"].map(function(t){
          var disabled=!!(getOrderTypeDisabled&&getOrderTypeDisabled(t));
          var active=orderType===t;
          var suffix=(orderTypeSuffix&&orderTypeSuffix(t))||"";
          return <button key={t} disabled={disabled} style={Object.assign({},S.dBtn,active?S.dBtnA:{},disabled?S.dBtnD:{})} onClick={function(){if(disabled)return;if(setOrderType)setOrderType(t);}}>{"Order "+t+suffix}</button>;
        })}
      </div>
    </div>}
  </div>);
}

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
  var _mw=useState(typeof window!=="undefined"?window.innerWidth<=900:false),isMobile=_mw[0],setIsMobile=_mw[1];
  var _mn=useState(false),showMobileNav=_mn[0],setShowMobileNav=_mn[1];
  var _p=useState("dashboard"),page=_p[0],setPage=_p[1];
  var _t=useState(""),tM=_t[0],sTM=_t[1];var _te=useState(false),tE=_te[0],sTE=_te[1];
  var _dr=useState(null),draftRequest=_dr[0],setDraftRequest=_dr[1];
  var _i=useState([]),items=_i[0],setItems=_i[1];
  var _us=useState([]),users=_us[0],setUsers=_us[1];
  var _o=useState({}),orders=_o[0],setOrders=_o[1];
  var _n=useState([]),notifs=_n[0],setNotifs=_n[1];
  var _s=useState([]),stores=_s[0],setStores=_s[1];
  var _sc=useState({}),schedule=_sc[0],setSchedule=_sc[1];
  var _sct=useState(null),scheduleToday=_sct[0],setScheduleToday=_sct[1];
  var _mo=useState(null),manualOpenOrder=_mo[0],setManualOpenOrder=_mo[1];
  var _ms=useState(null),manualOpenSeq=_ms[0],setManualOpenSeq=_ms[1];
  var _mol=useState(false),manualOpenLeaves=_mol[0],setManualOpenLeaves=_mol[1];
  var _voc=useState([]),vendorOrderConfigs=_voc[0],setVendorOrderConfigs=_voc[1];
  var _vov=useState([]),vendorOrdersOpenVendors=_vov[0],setVendorOrdersOpenVendors=_vov[1];
  var _avo=useState(null),serverActiveVendorOrderIds=_avo[0],setServerActiveVendorOrderIds=_avo[1];
  var _vws=useState(null),vendorOrdersWindowStartDay=_vws[0],setVendorOrdersWindowStartDay=_vws[1];
  var _vwe=useState(null),vendorOrdersWindowEndDay=_vwe[0],setVendorOrdersWindowEndDay=_vwe[1];
  var _cts=useState({}),categoryTemplates=_cts[0],setCategoryTemplates=_cts[1];
  var _ct=useState(null),consolidatedType=_ct[0],setConsolidatedType=_ct[1];
  var _cr=useState(null),consolidatedRequest=_cr[0],setConsolidatedRequest=_cr[1];
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
  useEffect(function(){
    if(typeof window==="undefined") return;
    var onResize=function(){setIsMobile(window.innerWidth<=900);};
    onResize();
    window.addEventListener("resize",onResize);
    return function(){window.removeEventListener("resize",onResize);};
  },[]);
  useEffect(function(){if(!isMobile)setShowMobileNav(false);},[isMobile]);
  
  // Reset UI/data immediately when auth user changes to avoid showing previous user's screen/state.
  useEffect(function(){
    setPage("dashboard");
    setLoadError(null);
    setConsolidatedType(null);
    setEntryType(null);
    setDraftRequest(null);
    setReopenedFromId(null);
    setOrders({});
    setNotifs([]);
    setUsers([]);
    setSuppliers([]);
    if(!user){
      setItems([]);
      setStores([]);
      setSchedule({});
      setScheduleToday(null);
      setOrderMsgs({});
      setManualOpenOrder(null);
      setManualOpenSeq(null);
      setVendorOrderConfigs([]);
      setVendorOrdersOpenVendors([]);
      setServerActiveVendorOrderIds(null);
      setVendorOrdersWindowStartDay(null);
      setVendorOrdersWindowEndDay(null);
      setCategoryTemplates({});
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
        var isA=isPrivilegedRole(user);
        var fetches={
          items:apiClient.items.getAll(),
          stores:apiClient.stores.getAll(),
          notifs:apiClient.notifications.getAll(),
          orders:apiClient.orders.getAll(isA?null:user.storeId),
          settings:apiClient.settings.getAll(),
        };
        fetches.suppliers=apiClient.suppliers.getAll();
        if(isA){fetches.users=apiClient.users.getAll();}
        var results=await Promise.all(Object.values(fetches));
        if(cancelled) return;
        var keys=Object.keys(fetches);
        var data={};keys.forEach(function(k,i){data[k]=results[i];});
        setLoadError(null);
        
        var nextItems=sortItems(data.items||[]);
        var nextStores=data.stores||[];
        var nextNotifs=data.notifs||[];
        setStores(function(prev){return sameJson(prev,nextStores)?prev:nextStores;});
        setNotifs(function(prev){return sameJson(prev,nextNotifs)?prev:nextNotifs;});
        // server now returns nested objects to avoid collisions between
        // schedule and message keys.  each is keyed by order type (A/B/C).
        var settings = data.settings || {};
        var serverSched = settings.schedule || {};
        var serverScheduleToday=Number.isInteger(settings.scheduleToday)?settings.scheduleToday:null;
        var serverMsg = settings.message || {};
        var serverManualOpen = settings.manualOpenOrder || null;
        var serverManualOpenSeq = settings.manualOpenSeq != null ? Number(settings.manualOpenSeq) : null;
        var serverManualOpenLeaves = !!settings.manualOpenLeaves;
        var serverVendorOrderConfigs=normalizeVendorOrderConfigs(settings.vendorOrderConfigs);
        var serverVendorOrdersOpenVendors = normalizeVendorOrderList(settings.vendorOrdersOpenVendors||[]);
        var serverActiveVendorIds = normalizeVendorOrderList(settings.activeVendorOrders||[]);
        var serverVendorOrdersWindowStartDay = parseOptionalDay(settings.vendorOrdersWindowStartDay);
        var serverVendorOrdersWindowEndDay = parseOptionalDay(settings.vendorOrdersWindowEndDay);
        var serverCategoryTemplates=settings.categoryTemplates&&typeof settings.categoryTemplates==="object"?settings.categoryTemplates:{};
        var repairedTemplateState=repairLoadedTemplatesAndItems(nextItems,serverCategoryTemplates);
        nextItems=repairedTemplateState.items;
        serverCategoryTemplates=repairedTemplateState.categoryTemplates;
        setItems(function(prev){return sameJson(prev,nextItems)?prev:nextItems;});
        setScheduleToday(function(prev){return prev===serverScheduleToday?prev:serverScheduleToday;});
        var nextMsgs={A:serverMsg.A||"",B:serverMsg.B||"",C:serverMsg.C||""};
        var nextManualSeq=Number.isNaN(serverManualOpenSeq)?null:serverManualOpenSeq;
        setOrderMsgs(function(prev){return sameJson(prev,nextMsgs)?prev:nextMsgs;});
        setManualOpenOrder(function(prev){return prev===serverManualOpen?prev:serverManualOpen;});
        setManualOpenSeq(function(prev){return prev===nextManualSeq?prev:nextManualSeq;});
        setManualOpenLeaves(function(prev){return prev===serverManualOpenLeaves?prev:serverManualOpenLeaves;});
        setVendorOrderConfigs(function(prev){return sameJson(prev,serverVendorOrderConfigs)?prev:serverVendorOrderConfigs;});
        setVendorOrdersOpenVendors(function(prev){return sameJson(prev,serverVendorOrdersOpenVendors)?prev:serverVendorOrdersOpenVendors;});
        setServerActiveVendorOrderIds(function(prev){return sameJson(prev,serverActiveVendorIds)?prev:serverActiveVendorIds;});
        setVendorOrdersWindowStartDay(function(prev){return prev===serverVendorOrdersWindowStartDay?prev:serverVendorOrdersWindowStartDay;});
        setVendorOrdersWindowEndDay(function(prev){return prev===serverVendorOrdersWindowEndDay?prev:serverVendorOrdersWindowEndDay;});
        setCategoryTemplates(function(prev){return sameJson(prev,serverCategoryTemplates)?prev:serverCategoryTemplates;});
        // pull logo value too (may be null)
        var nextLogo=settings.logo || null;
        setLogo(function(prev){return prev===nextLogo?prev:nextLogo;});
        // ensure schedule values are explicit null when not set
        var schedMap={
          A: serverSched.A != null ? serverSched.A : null,
          B: serverSched.B != null ? serverSched.B : null,
          C: serverSched.C != null ? serverSched.C : null,
        };
        setSchedule(function(prev){return sameJson(prev,schedMap)?prev:schedMap;});
        if(data.orders&&Array.isArray(data.orders)){
          var orderMap=buildOrderStateMap(data.orders,nextItems);
          setOrders(function(prev){return sameJson(prev,orderMap)?prev:orderMap;});
        }else{
          setOrders(function(prev){return Object.keys(prev||{}).length?{}:prev;});
        }
        var nextSuppliers=data.suppliers||[];
        setSuppliers(function(prev){return sameJson(prev,nextSuppliers)?prev:nextSuppliers;});
        if(isA){
          var nextUsers=data.users||[];
          setUsers(function(prev){return sameJson(prev,nextUsers)?prev:nextUsers;});
        }
        else {
          setUsers(function(prev){return prev.length?[]:prev;});
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
    var pullMs=10000;
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
  var refreshOrders=useCallback(async function(storeId){
    var isAdminUser=isPrivilegedRole(user);
    var requestedStoreId=(typeof storeId==="string"&&storeId)?storeId:null;
    var raw=await apiClient.orders.getAll(isAdminUser?requestedStoreId:(user&&user.storeId?user.storeId:null));
    var orderMap=buildOrderStateMap(raw,items);
    setOrders(function(prev){return sameJson(prev,orderMap)?prev:orderMap;});
    
    // For vendor orders, also refresh settings to ensure vendorOrderConfigs are current
    // This prevents seq mismatches from causing orders not to be found after submission
    try{
      var latestSettings=await apiClient.settings.getAll();
      if(latestSettings){
        var serverVendorOrderConfigs=normalizeVendorOrderConfigs(latestSettings.vendorOrderConfigs);
        setVendorOrderConfigs(function(prev){return sameJson(prev,serverVendorOrderConfigs)?prev:serverVendorOrderConfigs;});
      }
    }catch(settingsErr){
      console.warn("Settings refresh during order refresh failed (non-critical):", settingsErr);
    }
    
    return orderMap;
  },[userKey,items]);
  useEffect(function(){
    // Keep reopen state until explicitly cleared by send/clear/settings close.
    setConsolidatedType(manualOpenOrder||null);
  },[manualOpenOrder,manualOpenSeq]);
  
  if(auth.loading){return <div style={Object.assign({},S.lP,{justifyContent:"center"})}><div style={{color:"#64748B"}}>Loading...</div></div>;}
  if(!user){return(<Fragment><input ref={logoRef} type="file" accept="image/*" style={{display:"none"}} onChange={function(e){
      var f=e.target.files&&e.target.files[0];if(!f)return;if(f.size>500000){toast("Logo must be under 500KB",true);return;}var r=new FileReader();r.onload=function(ev){setLogo(ev.target.result);toast("Logo updated");saveLogoToServer(ev.target.result);};r.readAsDataURL(f);e.target.value="";}}/><Login logo={logo}/></Fragment>);}
  
  if(isLoading||loadError){return <div style={Object.assign({},S.lP,{justifyContent:"center"})}><div style={{color:loadError?"#F87171":"#64748B"}}>{loadError?loadError:"Loading..."}</div></div>;}
  
  var sN=user.storeId?(stores.find(function(s){return s.id===user.storeId;})||{}).name||user.storeId:"All Stores";
  var isA=isPrivilegedRole(user);
  var isWarehouseUser=isWarehouseRole(user);
  var isAdminOnly=isAdminRole(user);
  var openOrderTypes=manualOpenOrder?[manualOpenOrder]:activeTypes(schedule,scheduleToday);
  var aot=openOrderTypes.length?openOrderTypes[0]:null;
  var effectiveToday=Number.isInteger(scheduleToday)?scheduleToday:new Date().getDay();
  var knownSupplierIds=normalizeVendorOrderList((suppliers||[]).map(function(s){return s&&s.id;}));
  var usableVendorConfigs=normalizeVendorOrderConfigs(vendorOrderConfigs).filter(function(config){
    return config&&config.enabled!==false&&knownSupplierIds.indexOf(String(config.vendorKey||""))>=0;
  });
  var calculatedActiveVendorOrderIds=normalizeVendorOrderList(usableVendorConfigs.filter(function(config){return isVendorConfigActiveNow(config,effectiveToday);}).map(function(config){return config.vendorKey;}));
  var activeVendorOrderIds=Array.isArray(serverActiveVendorOrderIds)
    ?normalizeVendorOrderList(serverActiveVendorOrderIds).filter(function(vendorKey){return knownSupplierIds.indexOf(vendorKey)>=0;})
    :calculatedActiveVendorOrderIds;
  var vendorOrdersWindowOpen=activeVendorOrderIds.length>0;
  var navs=isAdminOnly?[
    {id:"dashboard",label:"Dashboard",ico:"home"},{id:"orders",label:"Order Monitor",ico:"clip"},
    {id:"consolidated",label:"Consolidated",ico:"grid"},{id:"supplier-orders",label:"Supplier Orders",ico:"truck"},
    {id:"items",label:"Item Master",ico:"up"},{id:"users",label:"Users",ico:"users"},
    {id:"suppliers",label:"Suppliers",ico:"truck"},{id:"notifications",label:"Notifications",ico:"bell"},
    {id:"stores",label:"Stores",ico:"pin"},{id:"reports",label:"Reports",ico:"chart"},
    {id:"settings",label:"Settings",ico:"gear"},
  ]:isWarehouseUser?[
    {id:"dashboard",label:"Dashboard",ico:"home"},{id:"orders",label:"Order Monitor",ico:"clip"},
    {id:"consolidated",label:"Consolidated",ico:"grid"},{id:"supplier-orders",label:"Supplier Orders",ico:"truck"},
    {id:"items",label:"Item Master",ico:"up"},{id:"suppliers",label:"Suppliers",ico:"truck"},
    {id:"notifications",label:"Notifications",ico:"bell"},{id:"reports",label:"Reports",ico:"chart"},
    {id:"settings",label:"Settings",ico:"gear"},
  ]:[
    {id:"dashboard",label:"Dashboard",ico:"home"},{id:"order-entry",label:"Place Order",ico:"clip"},
    {id:"history",label:"Order History",ico:"eye"},
  ];
  var PP={aot:aot,openOrderTypes:openOrderTypes,manualOpenOrder:manualOpenOrder,setManualOpenOrder:setManualOpenOrder,manualOpenSeq:manualOpenSeq,setManualOpenSeq:setManualOpenSeq,manualOpenLeaves:manualOpenLeaves,setManualOpenLeaves:setManualOpenLeaves,vendorOrderConfigs:vendorOrderConfigs,setVendorOrderConfigs:setVendorOrderConfigs,vendorOrdersOpenVendors:vendorOrdersOpenVendors,setVendorOrdersOpenVendors:setVendorOrdersOpenVendors,setServerActiveVendorOrderIds:setServerActiveVendorOrderIds,vendorOrdersWindowStartDay:vendorOrdersWindowStartDay,setVendorOrdersWindowStartDay:setVendorOrdersWindowStartDay,vendorOrdersWindowEndDay:vendorOrdersWindowEndDay,setVendorOrdersWindowEndDay:setVendorOrdersWindowEndDay,vendorOrdersWindowOpen:vendorOrdersWindowOpen,activeVendorOrderIds:activeVendorOrderIds,scheduleToday:scheduleToday,categoryTemplates:categoryTemplates,setCategoryTemplates:setCategoryTemplates,entryType:entryType,setEntryType:setEntryType,draftRequest:draftRequest,setDraftRequest:setDraftRequest,consolidatedType:consolidatedType,setConsolidatedType:setConsolidatedType,consolidatedRequest:consolidatedRequest,setConsolidatedRequest:setConsolidatedRequest,reopenedFromId:reopenedFromId,setReopenedFromId:setReopenedFromId,orders:orders,setOrders:setOrders,refreshOrders:refreshOrders,items:items,setItems:setItems,users:users,setUsers:setUsers,notifs:notifs,setNotifs:setNotifs,stores:stores,setStores:setStores,user:user,toast:toast,setPage:setPage,schedule:schedule,setSchedule:setSchedule,orderMsgs:orderMsgs,setOrderMsgs:setOrderMsgs,suppliers:suppliers,setSuppliers:setSuppliers,logo:logo,setLogo:setLogo,logoRef:logoRef};
  var sidebarStyle=isMobile?Object.assign({},S.sidebar,{position:"fixed",top:0,left:0,bottom:0,height:"100vh",zIndex:1200,transform:showMobileNav?"translateX(0)":"translateX(-110%)",transition:"transform 0.2s ease",boxShadow:"0 20px 40px rgba(15,23,42,.22)"}):S.sidebar;
  var topbarStyle=isMobile?Object.assign({},S.topbar,{padding:"0 12px",gap:8}):S.topbar;
  var contentStyle=isMobile?Object.assign({},S.content,{padding:12}):S.content;
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
    {isMobile&&showMobileNav&&<div style={Object.assign({},S.ov,{background:"rgba(15,23,42,0.35)",zIndex:1150,padding:0})} onClick={function(){setShowMobileNav(false);}}/>}
    <input ref={logoRef} type="file" accept="image/*" style={{display:"none"}} onChange={function(e){var f=e.target.files&&e.target.files[0];if(!f)return;if(f.size>500000){toast("Logo must be under 500KB",true);return;}var r=new FileReader();r.onload=function(ev){setLogo(ev.target.result);toast("Logo updated");saveLogoToServer(ev.target.result);};r.readAsDataURL(f);e.target.value="";}}/><aside style={sidebarStyle}>
      <div style={S.sideHdr}>{logo?<img src={logo} alt="Logo" style={{width:34,height:34,borderRadius:8,objectFit:"cover",flexShrink:0}}/>:<div style={S.logo}>OM</div>}<div><div style={{fontWeight:700,fontSize:13}}>OrderManager</div><div style={{fontSize:10,color:"#6B7186"}}>{sN}</div></div></div>
      <nav style={{flex:1,padding:"8px 6px",overflowY:"auto"}}>
        <div style={{fontSize:9,fontWeight:600,color:"#6B7186",textTransform:"uppercase",letterSpacing:1,padding:"8px 10px 3px"}}>Navigation</div>
        {navs.map(function(n){return(<div key={n.id} style={Object.assign({},S.navItem,page===n.id?S.navA:S.navI)} onClick={function(){setPage(n.id);if(isMobile)setShowMobileNav(false);}}><Ic type={n.ico} size={15}/><span>{n.label}</span></div>);})}
      </nav>
      <div style={S.ft}><div style={S.uC}><div style={S.av}>{(user?.name || user?.username || "?").charAt(0)}</div><div><div style={{fontSize:11,fontWeight:600}}>{user.name||user.username}</div><div style={{fontSize:9,color:"#6B7186"}}>{displayRoleLabel(user)}</div></div></div>
        <button style={S.loB} onClick={function(){auth.logout();}}><Ic type="out" size={13}/><span>Sign Out</span></button></div>
    </aside>
    <div style={S.main}>
      <header style={topbarStyle}>
        <div style={{display:"flex",alignItems:"center",gap:8,minWidth:0}}>
          {isMobile&&<button style={Object.assign({},S.b,S.bS,{padding:"6px 8px"})} onClick={function(){setShowMobileNav(true);}}><Ic type="menu" size={15}/></button>}
          <div style={{fontSize:isMobile?14:15,fontWeight:700,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{(navs.find(function(n){return n.id===page;})||{}).label||"Dashboard"}</div>
        </div>
      </header>
      <div style={contentStyle}>{rP()}</div>
    </div></div>);
}

/* ═══ ADMIN DASHBOARD ═══ */
function AdminDash({orders,users,items,notifs,aot,openOrderTypes,setPage,stores,schedule,toast,manualOpenOrder,manualOpenSeq,activeVendorOrderIds,suppliers,setConsolidatedRequest,vendorOrderConfigs,user}){
  var _adlogs=useState([]),adminLogs=_adlogs[0],setAdminLogs=_adlogs[1];
  var isWarehouseUser=isWarehouseRole(user);
  var todayKey=cycleBaseKey(new Date());
  var todayKeyM=manualOpenOrder&&manualOpenSeq?(todayKey+"-M"+manualOpenSeq):null;
  var cycleOrders=Object.values(orders).filter(function(o){
    if(!o) return false;
    if(isSameOrAdjacentDateWeekKey(o.week,todayKey)) return true;
    if(todayKeyM&&isSameOrAdjacentDateWeekKey(o.week,todayKeyM)) return true;
    return false;
  });
  var vendorCycleOrders=cycleOrders.filter(function(o){return normalizeCategory(o&&o.category||"vegetables")==="vendor_orders";});
  var summaryOrders=isWarehouseUser?vendorCycleOrders:cycleOrders;
  var sub=summaryOrders.filter(function(o){return o.status==="submitted"||o.status==="draft_shared";}).length;
  var proc=summaryOrders.filter(function(o){return o.status==="processed";}).length;
  var vendorSummary=summarizeVendorKeys(activeVendorOrderIds,suppliers);
  useEffect(function(){
    var cancelled=false;
    apiClient.supplierOrders.getAll().then(function(list){
      if(cancelled) return;
      setAdminLogs(Array.isArray(list)?list:[]);
    }).catch(function(){});
    return function(){cancelled=true;};
  },[]);
  var isStoreOrderSent=function(o){
    if(!o) return false;
    return o.status==="submitted"||o.status==="processed"||o.status==="draft_shared";
  };
  var openTypes=normalizeOpenOrderTypes(openOrderTypes&&openOrderTypes.length?openOrderTypes:aot);
  var dashboardTypes=openTypes;
  var pendingGroups=dashboardTypes.map(function(openType){
    var pendingByStore={};
    var vegetablesWeekKey=activeWeekLookupKey(openType,"vegetables",null,manualOpenOrder,manualOpenSeq);
    stores.forEach(function(st){
      var o=getDashboardOrderForStoreType(orders,st.id,vegetablesWeekKey,openType,"vegetables",null,manualOpenOrder,manualOpenSeq);
      if(!isStoreOrderSent(o)){
        var mgr=users.find(function(u){return u.storeId===st.id&&u.role==="manager"&&u.active;});
        pendingByStore[st.id]={storeId:st.id,store:st.name,manager:mgr?mgr.name:"N/A",phone:mgr?mgr.phone:"N/A",missing:["vegetables"]};
      }
    });
    if(openType==="B"){
      var leavesWeekKey=activeWeekLookupKey("B","leaves",null,manualOpenOrder,manualOpenSeq);
      stores.forEach(function(st){
        var leavesOrder=getDashboardOrderForStoreType(orders,st.id,leavesWeekKey,"B","leaves",null,manualOpenOrder,manualOpenSeq);
        if(!isStoreOrderSent(leavesOrder)){
          if(pendingByStore[st.id]) pendingByStore[st.id].missing.push("leaves");
          else {
            var leavesMgr=users.find(function(u){return u.storeId===st.id&&u.role==="manager"&&u.active;});
            pendingByStore[st.id]={storeId:st.id,store:st.name,manager:leavesMgr?leavesMgr.name:"N/A",phone:leavesMgr?leavesMgr.phone:"N/A",missing:["leaves"]};
          }
        }
      });
    }
    return {type:openType,pendingAlerts:Object.values(pendingByStore)};
  });
  var pendingTotal=pendingGroups.reduce(function(acc,group){return acc+group.pendingAlerts.length;},0);
  var vendorGroups=normalizeVendorOrderList(activeVendorOrderIds).map(function(vendorKey){
    var vendorName=vendorDisplayName(suppliers,vendorKey);
    var pending=[];
    stores.forEach(function(st){
      var o=getCurrentOrderForStoreType(orders,st.id,"VENDOR","vendor_orders",vendorKey,manualOpenOrder,manualOpenSeq,getVendorSeqFromConfigs(vendorOrderConfigs,vendorKey));
      if(!isStoreOrderSent(o)){
        var mgr=users.find(function(u){return u.storeId===st.id&&u.role==="manager"&&u.active;});
        pending.push({storeId:st.id,store:st.name,manager:mgr?mgr.name:"N/A"});
      }
    });
    return {vendorKey:vendorKey,vendorName:vendorName,pendingAlerts:pending};
  });
  var vendorPendingTotal=vendorGroups.reduce(function(acc,group){return acc+group.pendingAlerts.length;},0);
  var vendorStatValue=!vendorGroups.length?"Locked":(vendorGroups.length===1?vendorGroups[0].vendorName:(vendorGroups.length+" Open"));
  var openVendorOrdersPage=function(vendorKey){
    if(vendorKey&&setConsolidatedRequest){
      setConsolidatedRequest({category:"vendor_orders",vendorKey:vendorKey});
    }
    setPage("consolidated");
  };
  var sendOneReminder=async function(row,orderType){
    try{
      if(!orderType) return;
      var resp=await apiClient.orders.sendReminder(orderType,row.storeId);
      if((resp.sent||0)>0){toast("SMS sent: "+(resp.sent||0));}
      else if((resp.failed||0)>0){
        var msg=(resp.errors&&resp.errors[0]&&resp.errors[0].error)?resp.errors[0].error:"SMS failed";
        toast("SMS failed: "+msg,true);
      } else {
        toast("No pending target for SMS",true);
      }
    }catch(e){toast(e.message,true);}
  };
  var sendAllReminders=async function(orderType){
    try{
      if(!orderType) return;
      var resp=await apiClient.orders.sendReminder(orderType);
      if((resp.sent||0)>0){toast("SMS sent: "+(resp.sent||0)+" / "+(resp.total||0));}
      else if((resp.failed||0)>0){
        var msg=(resp.errors&&resp.errors[0]&&resp.errors[0].error)?resp.errors[0].error:"SMS failed";
        toast("SMS failed: "+msg,true);
      } else {
        toast("No pending targets for SMS",true);
      }
    }catch(e){toast(e.message,true);}
  };
  var sendOneVendorReminder=async function(row,vendorKey){
    try{
      if(!vendorKey) return;
      var resp=await apiClient.orders.sendReminder("VENDOR",row.storeId,"vendor_orders",vendorKey);
      if((resp.sent||0)>0){toast("SMS sent: "+(resp.sent||0));}
      else if((resp.failed||0)>0){
        var msg=(resp.errors&&resp.errors[0]&&resp.errors[0].error)?resp.errors[0].error:"SMS failed";
        toast("SMS failed: "+msg,true);
      } else {
        toast("No pending target for SMS",true);
      }
    }catch(e){toast(e.message,true);}
  };
  var sendAllVendorReminders=async function(vendorKey){
    try{
      if(!vendorKey) return;
      var resp=await apiClient.orders.sendReminder("VENDOR",null,"vendor_orders",vendorKey);
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
      {!isWarehouseUser&&<div style={S.sc}><div style={S.sL}>Stores</div><div style={Object.assign({},S.sV,{color:"#34D399"})}>{stores.length}</div></div>}
      {!isWarehouseUser&&<div style={S.sc}><div style={S.sL}>Items</div><div style={Object.assign({},S.sV,{color:"#166534"})}>{items.length}</div></div>}
      <div style={S.sc}><div style={S.sL}>{isWarehouseUser?"Vendor Submitted":"Submitted"}</div><div style={Object.assign({},S.sV,{color:"#FBBF24"})}>{sub}</div></div>
      <div style={S.sc}><div style={S.sL}>{isWarehouseUser?"Vendor Processed":"Processed"}</div><div style={Object.assign({},S.sV,{color:"#0F766E"})}>{proc}</div></div>
      <div style={S.sc}><div style={S.sL}>{isWarehouseUser?"Vendor Pending":"Pending"}</div><div style={Object.assign({},S.sV,{color:"#F87171"})}>{isWarehouseUser?vendorPendingTotal:(dashboardTypes.length?pendingTotal:"-")}</div></div>
      {!isWarehouseUser&&<div style={S.sc}><div style={S.sL}>Today</div><div style={Object.assign({},S.sV,{color:"#FB923C",fontSize:18})}>{openTypes.length?openTypes.map(function(t){return "Order "+t;}).join(", "):"None"}</div><div style={S.sS}>{openTypes.length?"Currently open":"No active cycle"}</div></div>}
      <div style={S.sc}><div style={S.sL}>Open Suppliers</div><div style={Object.assign({},S.sV,{color:vendorGroups.length?"#16A34A":"#6B7280",fontSize:18})}>{vendorStatValue}</div><div style={S.sS}>{vendorGroups.length?vendorSummary:"No suppliers open"}</div></div>
    </div>
    {!isWarehouseUser&&pendingGroups.map(function(group){return(<div key={group.type} style={S.card}><div style={S.cH}><div><div style={Object.assign({},S.t,{color:"#F87171"})}>Pending Submissions - Order {group.type}</div><div style={S.d}>These stores have not submitted yet. Auto SMS runs in final 1 hour window every 30 minutes.</div></div>{group.pendingAlerts.length>0&&<button style={Object.assign({},S.b,S.bW)} onClick={function(){sendAllReminders(group.type);}}>Send Reminder to All</button>}</div>
      {group.pendingAlerts.length>0&&<div style={S.tw}><table style={S.tbl}><thead><tr><th style={S.th}>Store</th><th style={S.th}>Manager</th><th style={S.th}>Phone</th><th style={S.th}>Missing</th><th style={S.th}>Action</th></tr></thead><tbody>
        {group.pendingAlerts.map(function(row){return <tr key={group.type+"-"+row.storeId}><td style={S.td}>{row.store}</td><td style={S.td}>{row.manager}</td><td style={S.tm}>{row.phone}</td><td style={S.td}>{(row.missing||[]).map(function(m){return m.charAt(0).toUpperCase()+m.slice(1);}).join(", ")||"—"}</td><td style={S.td}><button style={Object.assign({},S.b,S.bS,{padding:"3px 8px",fontSize:10.5})} onClick={function(){sendOneReminder(row,group.type);}}>Send SMS</button></td></tr>;})}
      </tbody></table></div>}
      {group.pendingAlerts.length===0&&<div style={Object.assign({},S.nG,{marginBottom:0})}>All stores have submitted Order {group.type}.</div>}
    </div>);})}
    {vendorGroups.map(function(group){return(<div key={group.vendorKey} style={S.card}>
      <div style={S.cH}>
        <div>
          <div style={Object.assign({},S.t,{color:"#166534"})}>{group.vendorName} Order Active</div>
          <div style={S.d}>{group.pendingAlerts.length} stores still need to place this vendor order.</div>
        </div>
        <div style={{display:"flex",gap:6,alignItems:"center"}}>
          {group.pendingAlerts.length>0&&<button style={Object.assign({},S.b,S.bW)} onClick={function(){sendAllVendorReminders(group.vendorKey);}}>Send Reminder to All</button>}
          <button style={Object.assign({},S.b,S.bP)} onClick={function(){openVendorOrdersPage(group.vendorKey);}}>Open {group.vendorName}</button>
        </div>
      </div>
      {group.pendingAlerts.length>0&&<div style={S.tw}><table style={S.tbl}><thead><tr><th style={S.th}>Store</th><th style={S.th}>Manager</th><th style={S.th}>Action</th></tr></thead><tbody>
        {group.pendingAlerts.map(function(row){return <tr key={row.storeId}><td style={S.td}>{row.store}</td><td style={S.td}>{row.manager}</td><td style={S.td}><button style={Object.assign({},S.b,S.bS,{padding:"3px 8px",fontSize:10.5})} onClick={function(){sendOneVendorReminder(row,group.vendorKey);}}>Send SMS</button></td></tr>;})}
      </tbody></table></div>}
      {group.pendingAlerts.length===0&&<div style={Object.assign({},S.nG,{marginBottom:0})}>All stores have submitted the active vendor order.</div>}
    </div>);})}
    {!isWarehouseUser&&notifs.map(function(n){return <div key={n.id} style={n.type==="promo"?S.nP:S.nI}>{n.text}</div>;})}
    <div style={S.card}><div style={S.cH}><div style={S.t}>Quick Actions</div></div>
      <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
        <button style={Object.assign({},S.b,S.bP)} onClick={function(){setPage("consolidated");}}>Consolidated</button>
        {vendorGroups.map(function(group){return <button key={group.vendorKey} style={Object.assign({},S.b,S.bS)} onClick={function(){openVendorOrdersPage(group.vendorKey);}}>{group.vendorName}</button>;})}
        <button style={Object.assign({},S.b,S.bS)} onClick={function(){setPage("supplier-orders");}}>Supplier Orders</button>
        <button style={Object.assign({},S.b,S.bS)} onClick={function(){setPage("reports");}}>Reports</button>
        {!isWarehouseUser&&<button style={Object.assign({},S.b,S.bS)} onClick={function(){setPage("items");}}>Items</button>}
        {!isWarehouseUser&&<button style={Object.assign({},S.b,S.bS)} onClick={function(){setPage("users");}}>Users</button>}
      </div></div>
    {!isWarehouseUser&&<div style={S.card}><div style={S.t}>Order Schedule</div>
      <div style={Object.assign({},S.tw,{marginTop:8})}><table style={S.tbl}><thead><tr><th style={S.th}>Order</th><th style={S.th}>Day</th><th style={S.th}>Status</th></tr></thead><tbody>
        {["A","B","C"].map(function(t){var open=openTypes.indexOf(t)>=0;return(<tr key={t}><td style={Object.assign({},S.td,{fontWeight:600})}>Order {t}</td><td style={S.td}>{DAYS[schedule[t]]||"Unset"}</td><td style={S.td}><span style={Object.assign({},S.bg,open?S.bgG:S.bgY)}>{open?"Open":"Locked"}</span></td></tr>);})}</tbody></table></div></div>}
  </div>);
}

/* ═══ MANAGER DASHBOARD ═══ */
function MgrDash({user,orders,notifs,aot,openOrderTypes,setPage,stores,schedule,orderMsgs,manualOpenOrder,manualOpenSeq,manualOpenLeaves,activeVendorOrderIds,suppliers,setDraftRequest,vendorOrderConfigs}){
  var sName=(stores.find(function(s){return s.id===user.storeId;})||{}).name||user.storeId;
  var my=Object.keys(orders).filter(function(k){return k.indexOf(user.storeId)===0;});
  var sub=my.filter(function(k){return orders[k].status==="submitted"||orders[k].status==="processed";}).length;
  var openTypes=normalizeOpenOrderTypes(openOrderTypes&&openOrderTypes.length?openOrderTypes:aot);
  var dashboardTypes=openTypes;
  var openTypeGroups=dashboardTypes.map(function(type){
    var currentWeekKey=activeWeekLookupKey(type,"vegetables",null,manualOpenOrder,manualOpenSeq);
    var currentOrder=getDashboardOrderForStoreType(orders,user.storeId,currentWeekKey,type,"vegetables",null,manualOpenOrder,manualOpenSeq);
    return {type:type,status:currentOrder?currentOrder.status:null,isCurrentlyOpen:openTypes.indexOf(type)>=0};
  });
  // Leaves order (only open on type B)
  var leavesWeekKey=activeWeekLookupKey("B","leaves",null,manualOpenOrder,manualOpenSeq);
  var leavesOrder=openTypes.indexOf("B")>=0?getDashboardOrderForStoreType(orders,user.storeId,leavesWeekKey,"B","leaves",null,manualOpenOrder,manualOpenSeq):null;
  var leavesStatus=leavesOrder?leavesOrder.status:null;
  var leavesOpen=isCategoryOpenForType("leaves","B",openTypes,manualOpenLeaves);
  var showLeavesCard=leavesOpen;
  var vendorGroups=normalizeVendorOrderList(activeVendorOrderIds).map(function(vendorKey){
    var vendorName=vendorDisplayName(suppliers,vendorKey);
    var vendorOrder=getCurrentOrderForStoreType(orders,user.storeId,"VENDOR","vendor_orders",vendorKey,manualOpenOrder,manualOpenSeq,getVendorSeqFromConfigs(vendorOrderConfigs,vendorKey));
    return {vendorKey:vendorKey,vendorName:vendorName,vendorStatus:vendorOrder?vendorOrder.status:null};
  });
  var vendorSummary=summarizeVendorKeys(activeVendorOrderIds,suppliers);
  var vendorStatValue=!vendorGroups.length?"Locked":(vendorGroups.length===1?vendorGroups[0].vendorName:(vendorGroups.length+" Open"));
  var openVendorOrder=function(vendorKey){
    if(setDraftRequest) setDraftRequest({type:"VENDOR",category:"vendor_orders",vendorKey:vendorKey});
    setPage("order-entry");
  };
  return(<div>
    {notifs.map(function(n){return <div key={n.id} style={n.type==="promo"?S.nP:S.nI}>{n.text}</div>;})}
    <div style={S.sg}>
      <div style={S.sc}><div style={S.sL}>Your Store</div><div style={Object.assign({},S.sV,{color:"#166534",fontSize:16})}>{sName}</div></div>
      <div style={S.sc}><div style={S.sL}>Today</div><div style={Object.assign({},S.sV,{color:openTypes.length?"#34D399":"#6B7280",fontSize:18})}>{openTypes.length?openTypes.map(function(t){return "Order "+t;}).join(", "):"None"}</div><div style={S.sS}>{openTypes.length?"Currently open":"No active cycle"}</div></div>
      <div style={S.sc}><div style={S.sL}>Completed</div><div style={Object.assign({},S.sV,{color:"#FBBF24"})}>{sub}</div><div style={S.sS}>{my.length} total</div></div>
      <div style={S.sc}><div style={S.sL}>Open Suppliers</div><div style={Object.assign({},S.sV,{color:vendorGroups.length?"#16A34A":"#6B7280",fontSize:18})}>{vendorStatValue}</div><div style={S.sS}>{vendorGroups.length?vendorSummary:"No suppliers open"}</div></div>
    </div>
    {openTypeGroups.map(function(group){return(<div key={group.type} style={S.card}>
      <div style={S.cH}>
        <div>{group.status==="submitted"?(<Fragment><div style={Object.assign({},S.t,{color:"#34D399"})}>Order {group.type} is Submitted</div><div style={S.d}>Your order has been submitted successfully.</div></Fragment>)
          :group.status==="processed"?(<Fragment><div style={Object.assign({},S.t,{color:"#0F766E"})}>Order {group.type} is Processed</div><div style={S.d}>Admin has processed this order.</div></Fragment>)
          :group.status==="draft"||group.status==="draft_shared"?(<Fragment><div style={Object.assign({},S.t,{color:"#F59E0B"})}>Order {group.type} is Draft</div><div style={S.d}>Draft saved. Open Place Order to edit draft or submit final.</div></Fragment>)
          :(<Fragment><div style={Object.assign({},S.t,{color:"#FBBF24"})}>Order {group.type} - Action Required</div><div style={S.d}>{orderMsgs[group.type]||"Please submit your order."}</div></Fragment>)}</div>
        {group.isCurrentlyOpen&&group.status!=="submitted"&&group.status!=="processed"&&<button style={Object.assign({},S.b,S.bP)} onClick={function(){if(setDraftRequest)setDraftRequest({type:group.type,category:"vegetables"});setPage("order-entry");}}>{group.status==="draft"||group.status==="draft_shared"?"Open Draft":"Place Order"}</button>}
      </div>
    </div>);})}
    {showLeavesCard&&(<div style={S.card}>
      <div style={S.cH}>
        <div>{leavesStatus==="submitted"?(<Fragment><div style={Object.assign({},S.t,{color:"#34D399"})}>Leaves Order is Submitted</div><div style={S.d}>Your leaves order has been submitted successfully.</div></Fragment>)
          :leavesStatus==="processed"?(<Fragment><div style={Object.assign({},S.t,{color:"#0F766E"})}>Leaves Order is Processed</div><div style={S.d}>Admin has processed this leaves order.</div></Fragment>)
          :leavesStatus==="draft"||leavesStatus==="draft_shared"?(<Fragment><div style={Object.assign({},S.t,{color:"#F59E0B"})}>Leaves Order is Draft</div><div style={S.d}>Draft saved. Open to edit or submit final.</div></Fragment>)
          :(<Fragment><div style={Object.assign({},S.t,{color:"#16A34A"})}>Leaves Order - Action Required</div><div style={S.d}>Leaves order is open. Please submit your order.</div></Fragment>)}</div>
        {leavesOpen&&leavesStatus!=="submitted"&&leavesStatus!=="processed"&&<button style={Object.assign({},S.b,S.bP)} onClick={function(){if(setDraftRequest)setDraftRequest({type:"B",category:"leaves"});setPage("order-entry");}}>{leavesStatus==="draft"||leavesStatus==="draft_shared"?"Open Leaves Draft":"Place Leaves Order"}</button>}
      </div>
    </div>)}
    {vendorGroups.map(function(group){return(<div key={group.vendorKey} style={S.card}>
      <div style={S.cH}>
        <div>{group.vendorStatus==="submitted"?(<Fragment><div style={Object.assign({},S.t,{color:"#34D399"})}>{group.vendorName} is Submitted</div><div style={S.d}>Your {group.vendorName} order has been submitted.</div></Fragment>)
          :group.vendorStatus==="processed"?(<Fragment><div style={Object.assign({},S.t,{color:"#0F766E"})}>{group.vendorName} is Processed</div><div style={S.d}>Admin has processed this vendor order.</div></Fragment>)
          :group.vendorStatus==="draft"||group.vendorStatus==="draft_shared"?(<Fragment><div style={Object.assign({},S.t,{color:"#F59E0B"})}>{group.vendorName} is Draft</div><div style={S.d}>Draft saved for {group.vendorName}.</div></Fragment>)
          :(<Fragment><div style={Object.assign({},S.t,{color:"#166534"})}>{group.vendorName} - Action Required</div><div style={S.d}>{group.vendorName} is open for ordering.</div></Fragment>)}</div>
        {group.vendorStatus!=="submitted"&&group.vendorStatus!=="processed"&&<button style={Object.assign({},S.b,S.bP)} onClick={function(){openVendorOrder(group.vendorKey);}}>{group.vendorStatus==="draft"||group.vendorStatus==="draft_shared"?("Open "+group.vendorName+" Draft"):("Place "+group.vendorName+" Order")}</button>}
      </div>
    </div>);})}
  </div>);
}

/* ═══ ORDER ENTRY ═══ */
function OrderEntry({user,items,orders,setOrders,refreshOrders,aot,openOrderTypes,toast,stores,schedule,orderMsgs,manualOpenOrder,manualOpenSeq,manualOpenLeaves,activeVendorOrderIds,categoryTemplates,entryType,setEntryType,draftRequest,setDraftRequest,notifs,suppliers,vendorOrderConfigs}){
  var resolvedOpenTypes=normalizeOpenOrderTypes(openOrderTypes&&openOrderTypes.length?openOrderTypes:aot);
  var _s=useState(entryType||aot||resolvedOpenTypes[0]||"A"),sel=_s[0],setSel=_s[1];
  var _cat=useState("vegetables"),selCategory=_cat[0],setSelCategory=_cat[1];
  var _vk=useState(null),selectedVendorKey=_vk[0],setSelectedVendorKey=_vk[1];
  var _cf=useState(false),showConfirm=_cf[0],setShowConfirm=_cf[1];
  var _ed=useState(false),isEditingDraft=_ed[0],setIsEditingDraft=_ed[1];
  var _dl=useState({}),draftLockByKey=_dl[0],setDraftLockByKey=_dl[1];
  var unsavedByOrderKeyRef=useRef({});
  var isAdmin=isPrivilegedRole(user);
  var vendorOptions=Array.isArray(suppliers)?suppliers:[];
  var activeVendorIds=normalizeVendorOrderList(activeVendorOrderIds);
  var activeVendorIdsKey=activeVendorIds.join("|");
  var visibleVendorOptions=isAdmin?vendorOptions:vendorOptions.filter(function(v){return activeVendorIds.indexOf(v.id)>=0;});
  useEffect(function(){
    if(selCategory==="vendor_orders"){
      return;
    }else if(selectedVendorKey){
      setSelectedVendorKey(null);
    }
  },[selCategory,selectedVendorKey]);
  useEffect(function(){
    if(!activeVendorIds.length&&selCategory==="vendor_orders"&&!isAdmin){
      setSelCategory("vegetables");
      setSelectedVendorKey(null);
    }
  },[activeVendorIdsKey,selCategory,isAdmin]);
  useEffect(function(){
    if(isAdmin) return;
    if(selCategory!=="vendor_orders") return;
    if(!activeVendorIds.length){
      if(selectedVendorKey) setSelectedVendorKey(null);
      return;
    }
    if(selectedVendorKey&&activeVendorIds.indexOf(selectedVendorKey)>=0) return;
    if(activeVendorIds.length===1){
      setSelectedVendorKey(activeVendorIds[0]);
      return;
    }
    if(selectedVendorKey){
      setSelectedVendorKey(null);
    }
  },[activeVendorIdsKey,selCategory,selectedVendorKey,isAdmin]);
  var resolvedVendorKey=normalizeVendorKey(selCategory,selectedVendorKey);
  var activeTemplate=getTemplateForCategory(categoryTemplates,selCategory,resolvedVendorKey);
  var templateHeaders=activeTemplate&&activeTemplate.uiHeaders?activeTemplate.uiHeaders:null;
  var itemHeader=selCategory==="vendor_orders"&&templateHeaders&&templateHeaders.item?templateHeaders.item:"Item Name";
  var qtyHeader=selCategory==="vendor_orders"?"Qty":(templateHeaders&&templateHeaders.quantity?templateHeaders.quantity:"Qty");
  var noteHeader=selCategory==="vendor_orders"&&templateHeaders&&templateHeaders.note?templateHeaders.note:"Note";
  var showQtyType=selCategory==="vendor_orders";
  var showNoteColumn=selCategory!=="vendor_orders";
  var currentType=selCategory==="vendor_orders"?"VENDOR":sel;
  var itemList=useMemo(function(){
    var filtered=items.filter(function(it){return normalizeCategory(it.category)===normalizeCategory(selCategory)&&normalizeVendorKey(selCategory,it.vendorKey)===resolvedVendorKey;});
    return selCategory==="vendor_orders"?orderRowsByTemplate(activeTemplate,filtered):sortItemsAlphabetical(filtered);
  },[items,selCategory,resolvedVendorKey,activeTemplate]);
  var oKey=user.storeId+"_"+dateKey(currentType,selCategory,resolvedVendorKey,manualOpenOrder,manualOpenSeq,getVendorSeqFromConfigs(vendorOrderConfigs,resolvedVendorKey));var lwKey=user.storeId+"_"+lastWeekKey(currentType,selCategory,resolvedVendorKey);
  var vendorLocked=selCategory==="vendor_orders"&&!isAdmin&&(!resolvedVendorKey||activeVendorIds.indexOf(resolvedVendorKey)<0);
  var ex=getCurrentOrderForStoreType(orders,user.storeId,currentType,selCategory,resolvedVendorKey,manualOpenOrder,manualOpenSeq,getVendorSeqFromConfigs(vendorOrderConfigs,resolvedVendorKey));var lw=orders[lwKey];var locked=selCategory==="vendor_orders"?vendorLocked:!isCategoryOpenForType(selCategory,sel,resolvedOpenTypes,manualOpenLeaves);
  // Draft and draft_shared remain editable; only submitted/processed are read-only.
  var done=ex&&(ex.status==="submitted"||ex.status==="processed");
  var hasServerDraft=!!(ex&&(ex.status==="draft"||ex.status==="draft_shared"));
  var isDraftOrder=hasServerDraft||!!draftLockByKey[oKey];
  var ro=locked||done||(isDraftOrder&&!isEditingDraft)||(selCategory==="vendor_orders"&&!resolvedVendorKey);
  var _q=useState(function(){return ex&&ex.items?Object.assign({},ex.items):itemList.reduce(function(a,it){a[it.code]={qty:0,unitType:"cas",customUnit:""};return a;},{});}),qty=_q[0],setQty=_q[1];
  var _n=useState(function(){return ex&&ex.notes?Object.assign({},ex.notes):itemList.reduce(function(a,it){a[it.code]="";return a;},{});}),notes=_n[0],setNotes=_n[1];
  var notePayload=showNoteColumn?notes:{};
  useEffect(function(){
    var cached=unsavedByOrderKeyRef.current[oKey]||null;
    var sourceItems=(ex&&ex.items)?ex.items:((cached&&cached.items)||{});
    var sourceNotes=(ex&&ex.notes)?ex.notes:((cached&&cached.notes)||{});
    var known={};
    itemList.forEach(function(it){known[it.code]=true;});
    var extraCodes=Object.keys(Object.assign({},sourceItems,sourceNotes)).filter(function(code){
      if(known[code]) return false;
      return normalizeOrderItemEntry(sourceItems[code]).qty>0 || String(sourceNotes[code]||"").trim();
    });
    var allCodes=itemList.map(function(it){return it.code;}).concat(extraCodes);
    setQty(function(prev){
      return allCodes.reduce(function(a,code){
        a[code]=normalizeOrderItemEntry(sourceItems&&sourceItems[code]);
        return a;
      },{});
    });
    setNotes(function(prev){
      return allCodes.reduce(function(a,code){
        if(sourceNotes&&sourceNotes[code]){a[code]=String(sourceNotes[code]);}
        else{a[code]="";}
        return a;
      },{});
    });
  },[oKey,itemList,ex&&ex.id]);
  useEffect(function(){
    setIsEditingDraft(false);
  },[oKey]);
  useEffect(function(){
    unsavedByOrderKeyRef.current[oKey]={items:Object.assign({},qty),notes:Object.assign({},notes)};
  },[oKey,qty,notes]);
  useEffect(function(){
    if(entryType==="VENDOR"){
      setSelCategory("vendor_orders");
      if(!isAdmin&&activeVendorIds.length===1){setSelectedVendorKey(activeVendorIds[0]);}
      if(!isAdmin&&!activeVendorIds.length){setSelectedVendorKey(null);}
    }else if(entryType&&entryType!==sel){
      setSel(entryType);
    }
    if(entryType&&setEntryType){setEntryType(null);}
  },[entryType,isAdmin,activeVendorIdsKey,sel]);
  useEffect(function(){
    if(!draftRequest) return;
    var nextCategory=normalizeCategory(draftRequest.category||"vegetables");
    var nextVendorKey=normalizeVendorKey(nextCategory,draftRequest.vendorKey||null);
    setSelCategory(nextCategory);
    setSelectedVendorKey(nextVendorKey);
    if(nextCategory!=="vendor_orders"&&draftRequest.type&&draftRequest.type!==sel){
      setSel(draftRequest.type);
    }
    if(nextCategory==="vendor_orders"&&draftRequest.type!=="VENDOR"&&draftRequest.type){
      setSel(draftRequest.type);
    }
    if(setDraftRequest) setDraftRequest(null);
  },[draftRequest]);
  useEffect(function(){
    if(ex&& (ex.status==="submitted"||ex.status==="processed")){
      setDraftLockByKey(function(prev){
        if(!prev[oKey]) return prev;
        var n=Object.assign({},prev);delete n[oKey];return n;
      });
    }
  },[oKey,ex&&ex.status]);
  var setQ=function(c,v){
    if(ro)return;
    setQty(function(p){
      var n=Object.assign({},p);
      var current=normalizeOrderItemEntry(n[c]);
      n[c]={qty:Math.max(0,parseInt(v,10)||0),unitType:current.unitType,customUnit:current.customUnit};
      unsavedByOrderKeyRef.current[oKey]=Object.assign({},unsavedByOrderKeyRef.current[oKey]||{},{
        items:n,
        notes:Object.assign({},notes),
      });
      return n;
    });
  };
  var setQType=function(c,v){
    if(ro)return;
    setQty(function(p){
      var n=Object.assign({},p);
      var current=normalizeOrderItemEntry(n[c]);
      var newType=normalizeUnitType(v);
      n[c]={qty:current.qty,unitType:newType,customUnit:newType==="other"?current.customUnit:""};
      unsavedByOrderKeyRef.current[oKey]=Object.assign({},unsavedByOrderKeyRef.current[oKey]||{},{
        items:n,
        notes:Object.assign({},notes),
      });
      return n;
    });
  };
  var setQOther=function(c,v){
    if(ro)return;
    setQty(function(p){
      var n=Object.assign({},p);
      var current=normalizeOrderItemEntry(n[c]);
      if(current.unitType==="other"){
        n[c]={qty:current.qty,unitType:"other",customUnit:String(v||"")};
        unsavedByOrderKeyRef.current[oKey]=Object.assign({},unsavedByOrderKeyRef.current[oKey]||{},{
          items:n,
          notes:Object.assign({},notes),
        });
      }
      return n;
    });
  };
  var setN=function(c,v){
    if(ro)return;
    setNotes(function(p){
      var n=Object.assign({},p);
      n[c]=v;
      unsavedByOrderKeyRef.current[oKey]=Object.assign({},unsavedByOrderKeyRef.current[oKey]||{},{
        items:Object.assign({},qty),
        notes:n,
      });
      return n;
    });
  };
  var sName=(stores.find(function(s){return s.id===user.storeId;})||{}).name||"";
  var activeVendorName=vendorDisplayName(suppliers,resolvedVendorKey);
  var downloadOrderExcel=async function(payload){
    try{
      var po=payload||{};
      var itemSource=po.items||qty;
      var noteSource=po.notes||notePayload;
      var activeCodes=Object.keys(Object.assign({},itemSource,noteSource)).filter(function(code){return normalizeOrderItemEntry(itemSource[code]).qty>0 || String(noteSource[code]||"").trim();});
      var itemDetailsByCode=buildOrderItemDetails(activeCodes,sorted,items,activeTemplate);
      var itemNamesByCode={};
      Object.keys(itemDetailsByCode).forEach(function(code){itemNamesByCode[code]=itemDetailsByCode[code].name;});
      var resp=await apiClient.orders.storeOrderExcelPreview(currentType,selCategory,resolvedVendorKey,itemSource,noteSource,user.storeId,po.date||new Date().toISOString(),itemNamesByCode,itemDetailsByCode);
      downloadBase64File(resp&&((resp.fileBase64)||(resp.excelBase64)),resp&&resp.filename,resp&&resp.contentType);
    }catch(e){toast(e.message||"Failed to generate document",true);}
  };
  var printOrderDocument=async function(payload){
    var printWindow;
    try{
      printWindow=openPendingPrintWindow("Preparing document...");
      var po=payload||{};
      var itemSource=po.items||qty;
      var noteSource=po.notes||notePayload;
      var activeCodes=Object.keys(Object.assign({},itemSource,noteSource)).filter(function(code){return normalizeOrderItemEntry(itemSource[code]).qty>0 || String(noteSource[code]||"").trim();});
      var itemDetailsByCode=buildOrderItemDetails(activeCodes,sorted,items,activeTemplate);
      var itemNamesByCode={};
      Object.keys(itemDetailsByCode).forEach(function(code){itemNamesByCode[code]=itemDetailsByCode[code].name;});
      var resp=await apiClient.orders.storeOrderExcelPreview(currentType,selCategory,resolvedVendorKey,itemSource,noteSource,user.storeId,po.date||new Date().toISOString(),itemNamesByCode,itemDetailsByCode);
      await printBase64File(resp&&((resp.fileBase64)||(resp.excelBase64)),resp&&resp.filename,resp&&resp.contentType,printWindow);
      toast("Print dialog opened");
    }catch(e){
      if(printWindow&&!printWindow.closed) printWindow.close();
      toast(e.message||"Failed to print document",true);
    }
  };
  var save=async function(){
    var buildWritePayload=function(nextStatus,forcedWeek){
      var payload={type:currentType,category:selCategory,vendorKey:resolvedVendorKey,items:qty,notes:notePayload,status:nextStatus,storeId:user.storeId};
      if(selCategory==="vendor_orders"){
        var activeWeek=String(forcedWeek||((ex&&ex.week)||"")||"").trim();
        if(activeWeek) payload.week=activeWeek;
      }
      return payload;
    };
    try{
      var resp=await apiClient.orders.create(buildWritePayload("draft"));
      if(refreshOrders) await refreshOrders(user.storeId);
      unsavedByOrderKeyRef.current[oKey]={items:Object.assign({},qty),notes:Object.assign({},notes)};
      setDraftLockByKey(function(prev){var n=Object.assign({},prev);n[oKey]=true;return n;});
      setIsEditingDraft(false);
      toast("Draft saved");
    }catch(e){
      // Reopen flow can hit 409 if client week and existing submitted week diverge.
      // Retry once against backend-provided week so reopened vendor orders submit normally.
      if(selCategory==="vendor_orders"&&e&&e.status===409){
        var retryWeek=String(e&&e.responseData&&e.responseData.existingWeek||"").trim();
        if(retryWeek){
          try{
            await apiClient.orders.create(buildWritePayload("draft",retryWeek));
            if(refreshOrders) await refreshOrders(user.storeId);
            unsavedByOrderKeyRef.current[oKey]={items:Object.assign({},qty),notes:Object.assign({},notes)};
            setDraftLockByKey(function(prev){var n=Object.assign({},prev);n[oKey]=true;return n;});
            setIsEditingDraft(false);
            toast("Draft saved");
            return;
          }catch(_retryErr){}
        }
        toast("Your order was already submitted. Loading it now...");
        if(refreshOrders) await refreshOrders(user.storeId).catch(function(){});
      }else{
        toast(e.message,true);
      }
    }
  };
  var doSubmit=async function(){
    var buildWritePayload=function(nextStatus,forcedWeek){
      var payload={type:currentType,category:selCategory,vendorKey:resolvedVendorKey,items:qty,notes:notePayload,status:nextStatus,storeId:user.storeId};
      if(selCategory==="vendor_orders"){
        var activeWeek=String(forcedWeek||((ex&&ex.week)||"")||"").trim();
        if(activeWeek) payload.week=activeWeek;
      }
      return payload;
    };
    try{
      var resp=await apiClient.orders.create(buildWritePayload("submitted"));
      if(refreshOrders) await refreshOrders(user.storeId);
      unsavedByOrderKeyRef.current[oKey]={items:Object.assign({},qty),notes:Object.assign({},notes)};
      setDraftLockByKey(function(prev){if(!prev[oKey]) return prev;var n=Object.assign({},prev);delete n[oKey];return n;});
      setIsEditingDraft(false);
      setShowConfirm(false);
      toast("Order submitted!");
    }catch(e){
      // Reopen flow can hit 409 if client week and existing submitted week diverge.
      // Retry once against backend-provided week so reopened vendor orders submit normally.
      if(selCategory==="vendor_orders"&&e&&e.status===409){
        var retryWeek=String(e&&e.responseData&&e.responseData.existingWeek||"").trim();
        if(retryWeek){
          try{
            await apiClient.orders.create(buildWritePayload("submitted",retryWeek));
            if(refreshOrders) await refreshOrders(user.storeId);
            unsavedByOrderKeyRef.current[oKey]={items:Object.assign({},qty),notes:Object.assign({},notes)};
            setDraftLockByKey(function(prev){if(!prev[oKey]) return prev;var n=Object.assign({},prev);delete n[oKey];return n;});
            setIsEditingDraft(false);
            setShowConfirm(false);
            toast("Order submitted!");
            return;
          }catch(_retryErr){}
        }
        toast("Your order was already submitted. Loading it now...");
        if(refreshOrders) await refreshOrders(user.storeId).catch(function(){});
      }else{
        toast(e.message,true);
      }
      setShowConfirm(false);
    }
  };
  var filled=Object.values(qty).filter(function(v){return normalizeOrderItemEntry(v).qty>0;}).length;
  var totalCases=Object.values(qty).reduce(function(a,b){return a+normalizeOrderItemEntry(b).qty;},0);
  var hasLines=Object.keys(Object.assign({},qty,notePayload)).some(function(code){return normalizeOrderItemEntry(qty[code]).qty>0 || String(notePayload[code]||"").trim();});
  var actionBlocked=locked||(selCategory==="vendor_orders"&&!resolvedVendorKey);
  var sorted=useMemo(function(){
    var known=itemList.slice();
    var knownCodes={};known.forEach(function(it){knownCodes[it.code]=true;});
    var extraCodes=Object.keys(Object.assign({},qty,notePayload)).filter(function(code){return !knownCodes[code]&&(normalizeOrderItemEntry(qty[code]).qty>0||(notePayload[code]||"").trim());});
    var extras=extraCodes.map(function(code){return {code:code,name:displayNameForOrderKey(code,items),category:selCategory,unit:"",_extra:true};});
    var merged=known.concat(extras);
    return selCategory==="vendor_orders"?orderRowsByTemplate(activeTemplate,merged):sortItemsAlphabetical(merged);
  },[itemList,items,qty,notePayload,selCategory,activeTemplate]);
  var displayRows=useMemo(function(){return buildTemplateDisplayRows(activeTemplate,sorted);},[activeTemplate,sorted]);
  var placeOrderNavGroup="place-order-"+oKey;
  var placeOrderMaxRow=Math.max(0,sorted.length-1);
  var placeOrderNavMaxCol=showNoteColumn?1:0;
  return(<div>
    {(notifs||[]).map(function(n){return <div key={n.id} style={n.type==="promo"?S.nP:S.nI}>{n.text}</div>;})}
    <div style={{marginBottom:12}}>
      <OrderDrawerNav
        selCategory={selCategory}
        setSelCategory={setSelCategory}
        orderType={sel}
        setOrderType={setSel}
        getCategoryDisabled={function(catId){return catId==="vendor_orders"?(!activeVendorIds.length&&!isAdmin):!isCategoryOpenForType(catId,sel,resolvedOpenTypes,manualOpenLeaves);}}
        getOrderTypeDisabled={function(t){return !isAdmin&&resolvedOpenTypes.indexOf(t)<0;}}
        orderTypeSuffix={function(t){return resolvedOpenTypes.indexOf(t)>=0?" *":"";}}
      />
    </div>
    {selCategory==="vendor_orders"&&<div style={S.card}><div style={S.lb}>Supplier</div><select style={Object.assign({},S.inp,{maxWidth:320})} value={selectedVendorKey||""} onChange={function(e){setSelectedVendorKey(e.target.value||null);}} disabled={!isAdmin&&visibleVendorOptions.length===1&&!!selectedVendorKey}><option value="">Select supplier</option>{visibleVendorOptions.map(function(v){return <option key={v.id} value={v.id}>{v.name}</option>;})}</select>{!isAdmin&&visibleVendorOptions.length>0&&<div style={{display:"flex",gap:6,flexWrap:"wrap",marginTop:8}}>{visibleVendorOptions.map(function(v){var isSelected=selectedVendorKey===v.id;return <button key={v.id} style={Object.assign({},S.b,isSelected?S.bP:S.bS,{padding:"4px 10px",fontSize:10.5})} onClick={function(){setSelectedVendorKey(v.id);}}>{v.name}</button>;})}</div>}{!isAdmin&&activeVendorIds.length===1&&selectedVendorKey&&<div style={Object.assign({},S.d,{marginTop:6})}>Admin opened {activeVendorName}. This store can place that supplier order now.</div>}{!isAdmin&&activeVendorIds.length>1&&<div style={Object.assign({},S.d,{marginTop:6})}>Admin opened multiple supplier orders. Select one of the open suppliers: {summarizeVendorKeys(activeVendorIds,suppliers)}.</div>}</div>}
    {locked&&<div style={S.nP}>{selCategory==="vendor_orders"?"Vendor orders stay locked until admin/warehouse activates vendor access for stores.":(resolvedOpenTypes.length===0?("No vegetables order type is open right now."):(CATEGORY_LABELS[selCategory]+" for Order "+sel+" is locked. "+(selCategory==="leaves"?"Leaves opens automatically with VEG Order B, or when Leaves manual override is enabled in Settings.":("Open now: "+resolvedOpenTypes.map(function(t){return "Order "+t;}).join(", ")+"."))))}</div>}
    {selCategory==="vendor_orders"&&!resolvedVendorKey&&<div style={S.nP}>Select a vendor to work with vendor-specific orders.</div>}
    {done&&<div style={S.nG}>{selCategory==="vendor_orders"?("Vendor Order for "+activeVendorName):(""+CATEGORY_LABELS[selCategory]+" Order "+sel)} has been {ex.status}. Read only.</div>}
    {isDraftOrder&&!isEditingDraft&&<div style={S.nP}>Draft saved only. It has not been sent yet. Click Edit Draft to modify it, or click Submit to send it to admin/consolidated and lock editing.</div>}
    {isDraftOrder&&isEditingDraft&&<div style={S.nI}>Editing draft. You can save draft again multiple times before final submit.</div>}
    <div style={S.card}><div style={S.cH}>
      <div><div style={S.t}>{selCategory==="vendor_orders"?("Vendor Orders - "+activeVendorName+" - "+sName):(CATEGORY_LABELS[selCategory]+" - Order "+sel+" - "+sName)}</div><div style={S.d}>{filled} items | {ex?ex.status:"New"}</div></div>
      <div style={{display:"flex",gap:5,alignItems:"center",flexWrap:"wrap"}}>
        <button style={Object.assign({},S.b,S.bS)} onClick={function(){downloadOrderExcel({items:qty,notes:notePayload,status:(ex&&ex.status)||"draft",date:(ex&&ex.date)||new Date().toISOString()});}} disabled={!hasLines}>Download Document</button>
        <button style={Object.assign({},S.b,S.bS)} onClick={function(){printOrderDocument({items:qty,notes:notePayload,status:(ex&&ex.status)||"draft",date:(ex&&ex.date)||new Date().toISOString()});}} disabled={!hasLines}>Print</button>
        {done?null:(isDraftOrder&&!isEditingDraft?<Fragment><button style={Object.assign({},S.b,S.bS)} onClick={function(){setIsEditingDraft(true);}} disabled={locked}>Edit Draft</button><button style={Object.assign({},S.b,S.bP)} onClick={function(){setShowConfirm(true);}} disabled={actionBlocked}>Submit</button></Fragment>:<Fragment><button style={Object.assign({},S.b,S.bS)} onClick={save} disabled={actionBlocked}>Save Draft</button><button style={Object.assign({},S.b,S.bP)} onClick={function(){setShowConfirm(true);}} disabled={actionBlocked}>Submit</button></Fragment>)}
      </div>
    </div>
    <div style={Object.assign({},S.card,{padding:"10px 14px"})}>
      <div style={{display:"flex",gap:16,flexWrap:"wrap",alignItems:"center"}}>
        <div style={{fontSize:12.5}}><span style={{color:"#64748B"}}>Total Cases:</span> <strong style={{color:"#0F172A",fontFamily:"monospace"}}>{totalCases}</strong></div>
      </div>
    </div>
    <div style={Object.assign({},S.tw,{display:"inline-block",width:"fit-content",maxWidth:"100%",minWidth:0,verticalAlign:"top"})}><table style={Object.assign({},S.tbl,{tableLayout:"auto",width:"auto",minWidth:0})}>
      <thead><tr><th style={Object.assign({},S.th,{whiteSpace:"nowrap"})}>{itemHeader}</th><th style={Object.assign({},S.th,{width:showQtyType?"136px":"108px",whiteSpace:"nowrap"})}>Unit</th><th style={Object.assign({},S.th,{textAlign:"center",width:showQtyType?"196px":"104px",whiteSpace:"nowrap"})}>{qtyHeader}</th>{showNoteColumn&&<th style={Object.assign({},S.th,{width:"300px",whiteSpace:"nowrap"})}>{noteHeader}</th>}</tr></thead>
      <tbody>{(function(){
        var navRow=-1;
        return displayRows.map(function(row){
        if(row.type==="heading"){
          return <tr key={row.key}><td colSpan={showNoteColumn?4:3} style={Object.assign({},S.td,{fontWeight:700,color:"#0F172A",background:"rgba(226,232,240,.42)"})}>{row.text}</td></tr>;
        }
        var it=row.item;
        navRow+=1;
        var currentRow=navRow;
        var cur=normalizeOrderItemEntry(qty[it.code]);
        return(<tr key={row.key}><td style={Object.assign({},S.td,{fontWeight:500,whiteSpace:"nowrap",padding:"7px 6px"})}>{it.name}</td><td style={Object.assign({},S.td,{color:"#64748B",whiteSpace:"nowrap",padding:"7px 6px"})}>{it.unit||"-"}</td><td style={Object.assign({},S.td,{textAlign:"center",padding:"7px 6px"})}><div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:2,flexWrap:"nowrap"}}><input style={Object.assign({},S.ni,ro?{opacity:.4}:{})} type="text" inputMode="numeric" pattern="[0-9]*" value={cur.qty} onChange={function(e){setQ(it.code,e.target.value);}} onKeyDown={function(e){if(ro) return;handleGridNavigation(e,placeOrderNavGroup,currentRow,0,placeOrderMaxRow,placeOrderNavMaxCol);}} data-nav-group={placeOrderNavGroup} data-nav-row={currentRow} data-nav-col={0} onWheel={stopNumberWheelChange} disabled={ro}/>{showQtyType&&<select style={Object.assign({},S.inp,{width:96,padding:"5px 6px",fontSize:11,opacity:ro?0.6:1})} value={cur.unitType} onChange={function(e){setQType(it.code,e.target.value);}} disabled={ro}>{ORDER_UNIT_TYPES.map(function(opt){return <option key={opt.value} value={opt.value}>{opt.label}</option>;})}</select>}{showQtyType&&cur.unitType==="other"&&<input style={Object.assign({},S.inp,{width:88,padding:"5px 6px",fontSize:11,opacity:ro?0.6:1})} value={cur.customUnit} onChange={function(e){setQOther(it.code,e.target.value);}} placeholder="Type" disabled={ro}/>}</div></td>{showNoteColumn&&<td style={Object.assign({},S.td,{padding:"7px 6px"})}><input style={Object.assign({},S.inp,ro?{opacity:.5}:{},{padding:"5px 8px",fontSize:13})} value={notes[it.code]||""} onChange={function(e){setN(it.code,e.target.value);}} onKeyDown={function(e){if(ro) return;handleGridNavigation(e,placeOrderNavGroup,currentRow,1,placeOrderMaxRow,placeOrderNavMaxCol);}} data-nav-group={placeOrderNavGroup} data-nav-row={currentRow} data-nav-col={1} placeholder="note" disabled={ro}/></td>}</tr>);
      });
      })()}
      {sorted.length===0&&<tr><td colSpan={showNoteColumn?4:3} style={Object.assign({},S.td,{textAlign:"center",padding:24,color:"#6B7186"})}>No items in {CATEGORY_LABELS[selCategory]}.</td></tr>}</tbody>
    </table></div></div>
    {showConfirm&&(<div style={S.ov} onClick={function(){setShowConfirm(false);}}><div style={Object.assign({},S.mo,{width:420,textAlign:"center"})} onClick={function(e){e.stopPropagation();}}>
      <div style={{fontSize:40,marginBottom:8}}>⚠️</div>
      <div style={{fontSize:16,fontWeight:700,marginBottom:8}}>Submit {selCategory==="vendor_orders"?("Vendor Order for "+activeVendorName):(CATEGORY_LABELS[selCategory]+" Order "+sel)}?</div>
      <div style={{fontSize:13,color:"#64748B",marginBottom:20,lineHeight:1.6}}>Are you sure you want to submit this order?<br/>This will send it to admin/consolidated and you will <strong style={{color:"#F87171"}}>not be able to edit</strong> it after submission.</div>
      <div style={{display:"flex",gap:8,justifyContent:"center"}}>
        <button style={Object.assign({},S.b,S.bS,{padding:"9px 24px"})} onClick={function(){setShowConfirm(false);}}>No, Go Back & Edit</button>
        <button style={Object.assign({},S.b,S.bP,{padding:"9px 24px"})} onClick={doSubmit} disabled={actionBlocked}>Yes, Submit</button>
      </div>
    </div></div>)}
  </div>);
}

/* ═══ ORDER HISTORY ═══ */
function OrderHistory({user,orders,items,setOrders,refreshOrders,toast,setPage,aot,manualOpenOrder,manualOpenSeq,manualOpenLeaves,setEntryType,setDraftRequest,vendorOrderConfigs,categoryTemplates,suppliers}){
  var my=Object.entries(orders).filter(function(e){return e[0].indexOf(user.storeId)===0;}).sort(function(a,b){return new Date(b[1].date)-new Date(a[1].date);});
  var vegOrders=my.filter(function(e){return normalizeCategory((e[1]&&e[1].category)||"vegetables")==="vegetables";});
  var leavesOrders=my.filter(function(e){return normalizeCategory((e[1]&&e[1].category)||"vegetables")==="leaves";});
  var vendorOrders=my.filter(function(e){return normalizeCategory((e[1]&&e[1].category)||"vegetables")==="vendor_orders";});
  var _s=useState(null),sel=_s[0],setSel=_s[1];
  var statusBg=function(st){return st==="processed"?S.bgP:st==="submitted"?S.bgG:S.bgY;};
  var historyOrderLabel=function(o){
    if(!o) return "Order -";
    if(normalizeCategory(o.category||"vegetables")==="vendor_orders") return vendorDisplayName(suppliers,o.vendorKey||null)+"_Order";
    return "Order "+String(o.type||"");
  };
  var openType=manualOpenOrder||aot||null;
  var canReopenAsDraft=function(k,o){
    if(!o||o.status!=="submitted") return false;
    if(!openType) return false;
    if(o.type!==openType) return false;
    if(!isCategoryOpenForType(o.category||"vegetables",openType,openType,manualOpenLeaves)) return false;
    var openKey=user.storeId+"_"+dateKey(o.type,o.category||"vegetables",o.vendorKey||null,manualOpenOrder,manualOpenSeq,getVendorSeqFromConfigs(vendorOrderConfigs,o.vendorKey||null));
    if(k!==openKey) return false;
    return true;
  };
  var downloadHistoryExcel=async function(o){
    try{
      if(!o){toast("Order not found",true);return;}
      var historyCodes=Object.keys(Object.assign({},o.items||{},o.notes||{})).filter(function(code){return hasOrderItemQty((o.items||{})[code]) || String((o.notes||{})[code]||"").trim();});
      var historyRows=(items||[]).filter(function(it){return historyCodes.indexOf(it.code)>=0;});
      var tpl=getTemplateForCategory(categoryTemplates,o.category||"vegetables",normalizeVendorKey(o.category||"vegetables",o.vendorKey||null));
      var historyItemDetails=buildOrderItemDetails(historyCodes,historyRows,items,tpl);
      var historyItemNames={};
      Object.keys(historyItemDetails).forEach(function(code){historyItemNames[code]=historyItemDetails[code].name;});
      var resp=await apiClient.orders.storeOrderExcelPreview(o.type||"A",o.category||"vegetables",o.vendorKey||null,o.items||{},o.notes||{},o.store||user.storeId,o.date||new Date().toISOString(),historyItemNames,historyItemDetails);
      downloadBase64File(resp&&((resp.fileBase64)||(resp.excelBase64)),resp&&resp.filename,resp&&resp.contentType);
      toast("Document downloaded");
    }catch(e){toast(e.message||"Failed to generate document",true);}
  };
  var printHistoryExcel=async function(o){
    var printWindow;
    try{
      if(!o){toast("Order not found",true);return;}
      printWindow=openPendingPrintWindow("Preparing document...");
      var historyCodes=Object.keys(Object.assign({},o.items||{},o.notes||{})).filter(function(code){return hasOrderItemQty((o.items||{})[code]) || String((o.notes||{})[code]||"").trim();});
      var historyRows=(items||[]).filter(function(it){return historyCodes.indexOf(it.code)>=0;});
      var tpl=getTemplateForCategory(categoryTemplates,o.category||"vegetables",normalizeVendorKey(o.category||"vegetables",o.vendorKey||null));
      var historyItemDetails=buildOrderItemDetails(historyCodes,historyRows,items,tpl);
      var historyItemNames={};
      Object.keys(historyItemDetails).forEach(function(code){historyItemNames[code]=historyItemDetails[code].name;});
      var resp=await apiClient.orders.storeOrderExcelPreview(o.type||"A",o.category||"vegetables",o.vendorKey||null,o.items||{},o.notes||{},o.store||user.storeId,o.date||new Date().toISOString(),historyItemNames,historyItemDetails);
      await printBase64File(resp&&((resp.fileBase64)||(resp.excelBase64)),resp&&resp.filename,resp&&resp.contentType,printWindow);
      toast("Print dialog opened");
    }catch(e){
      if(printWindow&&!printWindow.closed) printWindow.close();
      toast(e.message||"Failed to print document",true);
    }
  };
  var reopenAsDraft=async function(o){
    try{
      if(!openType){toast("No order is open right now",true);return;}
      if(!o||o.type!==openType){toast("Only currently open Order "+openType+" can be reopened as draft",true);return;}
      var category=o.category||"vegetables";
      if(!isCategoryOpenForType(category,openType,openType,manualOpenLeaves)){toast(CATEGORY_LABELS[category]+" is not open right now",true);return;}
      await apiClient.orders.create({type:o.type,category:category,vendorKey:o.vendorKey||null,items:o.items||{},notes:o.notes||{},status:"draft",storeId:user.storeId});
      if(refreshOrders) await refreshOrders(user.storeId);
      if(setEntryType) setEntryType(o.type);
      if(setPage) setPage("order-entry");
      toast("Submitted order reopened as draft");
    }catch(e){toast(e.message,true);}
  };
  var openDraft=function(o){
    if(!o||o.status!=="draft") return;
    if(setDraftRequest){
      setDraftRequest({type:o.type,category:o.category||"vegetables",vendorKey:o.vendorKey||null});
    }else if(setEntryType){
      setEntryType(o.type);
    }
    if(setPage) setPage("order-entry");
  };
  var renderHistorySection=function(title,rows){
    return(<div style={Object.assign({},S.card,{marginTop:10})}>
      <div style={S.t}>{title} ({rows.length})</div>
      {rows.length===0?<div style={{textAlign:"center",padding:18,color:"#6B7186"}}>No orders</div>:
      <div style={Object.assign({},S.tw,{marginTop:8})}><table style={S.tbl}><thead><tr><th style={S.th}>Order</th><th style={S.th}>Date/Time</th><th style={S.th}>Status</th><th style={S.th}>Items</th><th style={S.th}></th></tr></thead><tbody>
        {rows.map(function(e){var k=e[0],o=e[1];var canReopen=canReopenAsDraft(k,o);var openKey=user.storeId+"_"+dateKey(o.type,o.category||"vegetables",o.vendorKey||null,manualOpenOrder,manualOpenSeq,getVendorSeqFromConfigs(vendorOrderConfigs,o.vendorKey||null));var reopenTip=!openType?"No order is open right now":(o.type!==openType?("Only Order "+openType+" can be reopened now"):((k!==openKey)?"Only the current open-slot submitted order can be reopened":""));return(<tr key={k}><td style={Object.assign({},S.td,{fontWeight:600})}>{historyOrderLabel(o)}</td><td style={S.tm}>{fmtDT(o.date)}</td><td style={S.td}><span style={Object.assign({},S.bg,statusBg(o.status))}>{o.status}</span></td><td style={S.td}>{countFilledOrderItems(o.items||{})}</td><td style={S.td}><div style={{display:"flex",gap:4,flexWrap:"wrap"}}><button style={Object.assign({},S.b,S.bS,{padding:"3px 8px",fontSize:10.5})} onClick={function(){setSel(k);}}>View</button><button style={Object.assign({},S.b,S.bS,{padding:"3px 8px",fontSize:10.5})} onClick={function(){downloadHistoryExcel(o);}}>Download File</button><button style={Object.assign({},S.b,S.bS,{padding:"3px 8px",fontSize:10.5})} onClick={function(){printHistoryExcel(o);}}>Print</button>{o.status==="submitted"&&<button title={reopenTip} style={Object.assign({},S.b,S.bW,{padding:"3px 8px",fontSize:10.5},canReopen?{}:{opacity:.45,cursor:"not-allowed"})} onClick={function(){if(!canReopen)return;reopenAsDraft(o);}} disabled={!canReopen}>Reopen as Draft</button>}{o.status==="draft"&&<button style={Object.assign({},S.b,S.bG,{padding:"3px 8px",fontSize:10.5})} onClick={function(){openDraft(o);}}>Open Draft</button>}</div></td></tr>);})}
      </tbody></table></div>}
    </div>);
  };
  return(<div><div style={S.card}><div style={S.t}>Past Orders</div>
    <div style={S.d}>Reopen as Draft is only enabled for currently open Order {openType||"-"} and only once. Draft rows can be opened in Place Order and submitted from there.</div>
    {my.length===0?<div style={{textAlign:"center",padding:30,color:"#6B7186"}}>No orders yet</div>:
    <Fragment>{renderHistorySection("Vegetable Orders",vegOrders)}{renderHistorySection("Leaves Orders",leavesOrders)}{renderHistorySection("Vendor Orders",vendorOrders)}</Fragment>}</div>
    {sel&&orders[sel]&&(<div style={S.ov} onClick={function(){setSel(null);}}><div style={S.mo} onClick={function(e){e.stopPropagation();}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:12}}>{normalizeCategory(orders[sel].category||"vegetables")==="vendor_orders"?historyOrderLabel(orders[sel]):(CATEGORY_LABELS[orders[sel].category||"vegetables"]+" Order "+orders[sel].type)} - {fmtDT(orders[sel].date)}</div>
      <div style={S.tw}><table style={S.tbl}><thead><tr><th style={S.th}>Item</th><th style={Object.assign({},S.th,{textAlign:"right"})}>Qty</th><th style={S.th}>Note</th></tr></thead><tbody>
        {Object.keys(Object.assign({},orders[sel].items||{},orders[sel].notes||{})).filter(function(code){return hasOrderItemQty((orders[sel].items||{})[code])||((orders[sel].notes||{})[code]);}).map(function(code){return <tr key={code}><td style={S.td}>{displayNameForOrderKey(code,items)}</td><td style={Object.assign({},S.td,{textAlign:"right",fontFamily:"monospace"})}>{formatOrderItemQtyDisplay((orders[sel].items||{})[code])}</td><td style={S.td}>{((orders[sel].notes||{})[code])||"-"}</td></tr>;})}</tbody></table></div>
      <div style={S.mA}><button style={Object.assign({},S.b,S.bS)} onClick={function(){setSel(null);}}>Close</button></div></div></div>)}
  </div>);
}

/* ═══ ORDER MONITOR (with time + process button) ═══ */
function OrderMonitor({orders,setOrders,refreshOrders,items,stores,aot,toast,setPage,setConsolidatedType,setConsolidatedRequest,setReopenedFromId,suppliers,user}){
  var _f=useState("all"),ft=_f[0],sFt=_f[1];
  var isWarehouseUser=isWarehouseRole(user);
  var _cl=useState([]),completedLogs=_cl[0],setCompletedLogs=_cl[1];
  var _sd=useState(null),selDone=_sd[0],setSelDone=_sd[1];
  var _sp=useState({}),sheetPreviewById=_sp[0],setSheetPreviewById=_sp[1];
  var _spl=useState({}),sheetPreviewLoadingById=_spl[0],setSheetPreviewLoadingById=_spl[1];
  var _ch=useState([]),consolidatedHistory=_ch[0],setConsolidatedHistory=_ch[1];
  var _sh=useState(null),selHistory=_sh[0],setSelHistory=_sh[1];
  var _hl=useState(false),historyLoading=_hl[0],setHistoryLoading=_hl[1];
  var _hd=useState({}),historyDownloading=_hd[0],setHistoryDownloading=_hd[1];
  var _hsp=useState({}),historySheetPreviewById=_hsp[0],setHistorySheetPreviewById=_hsp[1];
  var _hspl=useState({}),historySheetPreviewLoadingById=_hspl[0],setHistorySheetPreviewLoadingById=_hspl[1];
  var all=Object.entries(orders).sort(function(a,b){return new Date(b[1].date)-new Date(a[1].date);});
  var f=(ft==="all"||ft==="completed")?all:all.filter(function(e){return e[1].type===ft;});
  var monitorTabs=isWarehouseUser?["all","completed"]:["all","A","B","C","completed"];
  var vegSubmissions=f.filter(function(e){return normalizeCategory((e[1]&&e[1].category)||"vegetables")==="vegetables";});
  var leavesSubmissions=f.filter(function(e){return normalizeCategory((e[1]&&e[1].category)||"vegetables")==="leaves";});
  var vendorSubmissions=f.filter(function(e){return normalizeCategory((e[1]&&e[1].category)||"vegetables")==="vendor_orders";});
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
  var loadSheetPreviewForLog=async function(log){
    if(!log) return null;
    var isVendorLog=normalizeCategory(log.category||"vegetables")==="vendor_orders";
    var id=isVendorLog?historyGroupKey(log):String(log._id||"");
    if(!id) return null;
    if(!isVendorLog&&!log.hasExcel) return null;
    if(sheetPreviewById[id]) return sheetPreviewById[id];
    try{
      setSheetPreviewLoadingById(function(prev){var n=Object.assign({},prev);n[id]=true;return n;});
      var resp=isVendorLog
        ? await apiClient.orders.consolidatedHistorySheetPreview(log.week,log.type,log.category||"vegetables",log.vendorKey||null)
        : await apiClient.supplierOrders.previewExcel(id);
      var next={sheetName:resp&&resp.sheetName?resp.sheetName:"Sheet1",rows:normalizePreviewRows(resp&&resp.rows)};
      setSheetPreviewById(function(prev){var n=Object.assign({},prev);n[id]=next;return n;});
      return next;
    }catch(e){toast(e.message||"Failed to load stored sheet",true);return null;}
    finally{setSheetPreviewLoadingById(function(prev){var n=Object.assign({},prev);delete n[id];return n;});}
  };
  var refreshConsolidatedHistory=async function(){
    try{
      setHistoryLoading(true);
      var list=await apiClient.orders.getConsolidatedHistory(7);
      setConsolidatedHistory(Array.isArray(list)?list:[]);
    }catch(e){
      setConsolidatedHistory([]);
    }finally{
      setHistoryLoading(false);
    }
  };
  var historyCategoryLabel=function(cat){
    return CATEGORY_LABELS[normalizeCategory(cat||"vegetables")]||cat||"-";
  };
  var historyVendorLabel=function(vendorKey){
    if(!vendorKey) return "-";
    var supplier=(suppliers||[]).find(function(s){return s.id===vendorKey;});
    return supplier&&supplier.name?supplier.name:vendorKey;
  };
  var historyGroupKey=function(rec){
    return String(rec&&rec.week||"")+"::"+String(rec&&rec.type||"")+"::"+String(normalizeCategory(rec&&rec.category||"vegetables"))+"::"+String(normalizeVendorKey(rec&&rec.category,rec&&rec.vendorKey)||"");
  };
  var loadSheetPreviewForHistory=async function(rec){
    if(!rec||!rec.week||!rec.type) return null;
    var k=historyGroupKey(rec);
    if(historySheetPreviewById[k]) return historySheetPreviewById[k];
    try{
      setHistorySheetPreviewLoadingById(function(prev){var n=Object.assign({},prev);n[k]=true;return n;});
      var resp=await apiClient.orders.consolidatedHistorySheetPreview(rec.week,rec.type,rec.category||"vegetables",rec.vendorKey||null);
      var next={sheetName:resp&&resp.sheetName?resp.sheetName:"Sheet1",rows:normalizePreviewRows(resp&&resp.rows)};
      setHistorySheetPreviewById(function(prev){var n=Object.assign({},prev);n[k]=next;return n;});
      return next;
    }catch(e){toast(e.message||"Failed to load history sheet preview",true);return null;}
    finally{setHistorySheetPreviewLoadingById(function(prev){var n=Object.assign({},prev);delete n[k];return n;});}
  };
  var downloadConsolidatedHistoryExcel=async function(rec){
    if(!rec||!rec.week||!rec.type){toast("Missing history record details",true);return;}
    var k=historyGroupKey(rec);
    try{
      setHistoryDownloading(function(prev){var n=Object.assign({},prev);n[k]=true;return n;});
      var resp=await apiClient.orders.consolidatedHistoryExcel(rec.week,rec.type,rec.category||"vegetables",rec.vendorKey||null);
      if(!resp||!resp.excelBase64) throw new Error("No Excel data returned");
      var bin=atob(resp.excelBase64);
      var bytes=new Uint8Array(bin.length);
      for(var i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
      var blob=new Blob([bytes],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
      var url=URL.createObjectURL(blob);
      var a=document.createElement("a");
      a.href=url;
      a.download=resp.filename||("consolidated-history-"+String(rec.type||"X")+"-"+String(rec.week||"").replace(/[^A-Za-z0-9_-]/g,"_")+".xlsx");
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function(){URL.revokeObjectURL(url);},1000);
      toast("Consolidated sheet downloaded");
    }catch(e){toast(e.message||"Failed to download sheet",true);}
    finally{
      setHistoryDownloading(function(prev){var n=Object.assign({},prev);delete n[k];return n;});
    }
  };
  var printConsolidatedHistoryExcel=async function(rec){
    var printWindow;
    try{
      if(!rec||!rec.week||!rec.type){toast("Missing history record details",true);return;}
      printWindow=openPendingPrintWindow("Preparing document...");
      var resp=await apiClient.orders.consolidatedHistoryExcel(rec.week,rec.type,rec.category||"vegetables",rec.vendorKey||null);
      await printBase64File(resp&&resp.excelBase64,resp&&resp.filename,resp&&resp.contentType,printWindow);
      toast("Print dialog opened");
    }catch(e){
      if(printWindow&&!printWindow.closed) printWindow.close();
      toast(e.message||"Failed to print document",true);
    }
  };
  useEffect(function(){
    if(ft==="completed") refreshCompletedLogs();
  },[ft]);
  useEffect(function(){
    if(ft==="completed") refreshConsolidatedHistory();
  },[ft]);
  useEffect(function(){
    if(monitorTabs.indexOf(ft)>=0) return;
    sFt("all");
  },[ft,isWarehouseUser]);
  var reopenCompleted=async function(log){
    try{
      await apiClient.supplierOrders.reopen(log._id);
      await refreshCompletedLogs();
      var reopenedCategory=normalizeCategory(log&&log.category||"vegetables");
      var isVendorLog=reopenedCategory==="vendor_orders";
      var reopenMeta={
        type:log&&log.type?log.type:null,
        category:reopenedCategory,
        vendorKey:log&&log.vendorKey?log.vendorKey:null,
        week:log&&log.week?log.week:null,
        reopenedFromId:log&&log._id?log._id:null,
      };
      persistReopenTarget(reopenMeta);
      if(setConsolidatedRequest) setConsolidatedRequest({
        category:reopenedCategory,
        vendorKey:log&&log.vendorKey?log.vendorKey:null,
        week:log&&log.week?log.week:null,
        type:log&&log.type?log.type:null,
        reopenedFromId:log&&log._id?log._id:null,
      });
      if(setConsolidatedType) setConsolidatedType(isVendorLog?null:log.type);
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
    if(!window.confirm("Submit this draft now? This will send it into admin consolidated flow and lock store editing.")) return;
    try{
      await apiClient.orders.create({type:o.type,category:o.category||"vegetables",vendorKey:o.vendorKey||null,items:o.items||{},notes:o.notes||{},status:"submitted",storeId:o.store});
      if(refreshOrders) await refreshOrders();
      toast("Draft submitted");
    }catch(e){toast(e.message,true);}
  };
  var renderSubmissionSection=function(title,rows){
    return(<div style={Object.assign({},S.card,{marginTop:10})}><div style={S.t}>{title} ({rows.length})</div>
      {rows.length===0?<div style={{textAlign:"center",padding:24,color:"#6B7186"}}>No orders</div>:
      <div style={Object.assign({},S.tw,{marginTop:8})}><table style={S.tbl}><thead><tr><th style={S.th}>Store</th><th style={S.th}>Order</th><th style={S.th}>Date / Time</th><th style={S.th}>Status</th><th style={S.th}>Action</th></tr></thead><tbody>
        {rows.map(function(e){var k=e[0],o=e[1];var sn=(stores.find(function(s){return s.id===o.store;})||{}).name||o.store;return(<tr key={k}>
          <td style={Object.assign({},S.td,{fontWeight:500})}>{sn}</td><td style={S.td}>Order {o.type}</td>
          <td style={S.tm}>{fmtDT(o.date)}</td>
          <td style={S.td}><span style={Object.assign({},S.bg,statusBg(o.status))}>{statusLabel(o.status)}</span></td>
          <td style={S.td}>{isReceived(o.status)&&o.id&&<button style={Object.assign({},S.b,S.bG,{padding:"3px 8px",fontSize:10})} onClick={async function(){
              try{await apiClient.orders.process(o.id);
                setOrders(function(p){var n=Object.assign({},p);n[k]=Object.assign({},n[k],{status:"processed"});return n;});
                toast("Processed");
              }catch(err){toast(err.message,true);} }}>Process</button>}{o.status==="draft"&&<button style={Object.assign({},S.b,S.bW,{padding:"3px 8px",fontSize:10,marginLeft:4})} onClick={function(){closeDraftFromAdmin(k,o);}}>Submit Draft</button>}</td>
        </tr>);})}</tbody></table></div>}
    </div>);
  };
  var completedVegetableLogs=completedLogs.filter(function(l){return normalizeCategory((l&&l.category)||"vegetables")==="vegetables";});
  var completedLeavesLogs=completedLogs.filter(function(l){return normalizeCategory((l&&l.category)||"vegetables")==="leaves";});
  var completedVendorLogs=completedLogs.filter(function(l){return normalizeCategory((l&&l.category)||"vegetables")==="vendor_orders";});
  var visibleConsolidatedHistory=isWarehouseUser?consolidatedHistory.filter(function(r){return normalizeCategory((r&&r.category)||"vegetables")==="vendor_orders";}):consolidatedHistory;
  var renderCompletedSection=function(title,rows){
    return(<div style={S.card}><div style={S.t}>{title} ({rows.length})</div>
      {rows.length===0?<div style={{textAlign:"center",padding:24,color:"#6B7186"}}>No completed orders</div>:
      <div style={Object.assign({},S.tw,{marginTop:8})}><table style={S.tbl}><thead><tr><th style={S.th}>Date</th><th style={S.th}>Order</th><th style={S.th}>Supplier</th><th style={S.th}>Email</th><th style={S.th}>Week</th><th style={S.th}>Details</th><th style={S.th}>Status</th><th style={S.th}>Actions</th></tr></thead><tbody>
        {rows.map(function(l){
          var canReopen=true;
          var rowKey=historyGroupKey(l);
          var isDownloading=!!historyDownloading[rowKey];
          return(<tr key={l._id||l.sentAt}>
            <td style={S.tm}>{fmtDT(l.sentAt)}</td>
            <td style={S.td}>Order {l.type}</td>
            <td style={S.td}>{l.supplierName}</td>
            <td style={S.tm}>{l.email}</td>
            <td style={S.tm}>{l.week}</td>
            <td style={S.td}><button style={Object.assign({},S.b,S.bS,{padding:"3px 8px",fontSize:10})} onClick={function(){setSelDone(l);loadSheetPreviewForLog(l);}}>View Details</button></td>
            <td style={S.td}><span style={Object.assign({},S.bg,l.finished===false?S.bgW:S.bgG)}>{l.finished===false?"reopened":"completed"}</span></td>
            <td style={S.td}><div style={{display:"flex",gap:4,flexWrap:"wrap"}}>{l.week&&l.type&&<button style={Object.assign({},S.b,S.bS,{padding:"3px 8px",fontSize:10})} onClick={function(){downloadConsolidatedHistoryExcel({week:l.week,type:l.type,category:l.category||"vegetables",vendorKey:l.vendorKey||null});}} disabled={isDownloading}>{isDownloading?"Downloading...":"Download Document"}</button>}{l.week&&l.type&&<button style={Object.assign({},S.b,S.bS,{padding:"3px 8px",fontSize:10})} onClick={function(){printConsolidatedHistoryExcel({week:l.week,type:l.type,category:l.category||"vegetables",vendorKey:l.vendorKey||null});}}>Print</button>}{canReopen?<button style={Object.assign({},S.b,S.bW,{padding:"3px 8px",fontSize:10})} onClick={function(){reopenCompleted(l);}}>{l.finished===false?"Open / Resend":"Reopen / Resend"}</button>:null}</div></td>
          </tr>);
        })}
      </tbody></table></div>}
    </div>);
  };
  return(<div>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8,marginBottom:14}}>
      <div style={S.tabs}>{monitorTabs.map(function(t){return <button key={t} style={Object.assign({},S.tab,ft===t?S.tA:S.tI)} onClick={function(){sFt(t);}}>{t==="all"?(isWarehouseUser?"Vendor Orders":"All"):t==="completed"?"Completed":"Order "+t}</button>;})}</div>
      {ft!=="all"&&ft!=="completed"&&<button style={Object.assign({},S.b,S.bW)} onClick={function(){processAll(ft);}}>Process Order {ft} (All Stores)</button>}
    </div>
    {ft==="completed" ? (
      <Fragment>
        <div style={S.card}>
          <div style={S.cH}>
            <div><div style={S.t}>{isWarehouseUser?"Vendor Consolidated History (Last 7 Days)":"Consolidated History (Last 7 Days)"}</div><div style={S.d}>{isWarehouseUser?"Vendor consolidated groups with sent/not sent status and store-level order details.":"All consolidated groups with sent/not sent status and store-level order details."}</div></div>
            <button style={Object.assign({},S.b,S.bS)} onClick={refreshConsolidatedHistory} disabled={historyLoading}>{historyLoading?"Refreshing...":"Refresh"}</button>
          </div>
          {historyLoading?<div style={{textAlign:"center",padding:24,color:"#6B7186"}}>Loading consolidated history...</div>:
          visibleConsolidatedHistory.length===0?<div style={{textAlign:"center",padding:30,color:"#6B7186"}}>No consolidated records in the last 7 days</div>:
          <div style={Object.assign({},S.tw,{marginTop:8})}><table style={S.tbl}><thead><tr><th style={S.th}>Latest</th><th style={S.th}>Week</th><th style={S.th}>Type</th><th style={S.th}>Category</th><th style={S.th}>Vendor</th><th style={S.th}>Stores</th><th style={S.th}>Sent</th><th style={S.th}>Actions</th></tr></thead><tbody>
            {visibleConsolidatedHistory.map(function(r){
              var rowKey=historyGroupKey(r);
              var isDownloading=!!historyDownloading[rowKey];
              return(<tr key={rowKey}>
                <td style={S.tm}>{fmtDT(r.latestAt)}</td>
                <td style={S.tm}>{r.week||"-"}</td>
                <td style={S.td}>Order {r.type||"-"}</td>
                <td style={S.td}>{historyCategoryLabel(r.category)}</td>
                <td style={S.td}>{historyVendorLabel(r.vendorKey)}</td>
                <td style={Object.assign({},S.td,{textAlign:"center"})}>{r.storeCount||0}</td>
                <td style={S.td}><span style={Object.assign({},S.bg,r.sent?S.bgG:S.bgY)}>{r.sent?("Sent ("+(r.sentCount||0)+")"):"Not sent"}</span></td>
                <td style={S.td}><div style={{display:"flex",gap:4,flexWrap:"wrap"}}><button style={Object.assign({},S.b,S.bS,{padding:"3px 8px",fontSize:10})} onClick={function(){setSelHistory(r);loadSheetPreviewForHistory(r);}}>View</button><button style={Object.assign({},S.b,S.bS,{padding:"3px 8px",fontSize:10})} onClick={function(){downloadConsolidatedHistoryExcel(r);}} disabled={isDownloading}>{isDownloading?"Downloading...":"Download Sheet"}</button><button style={Object.assign({},S.b,S.bS,{padding:"3px 8px",fontSize:10})} onClick={function(){printConsolidatedHistoryExcel(r);}}>Print</button></div></td>
              </tr>);
            })}
          </tbody></table></div>}
        </div>
        {!isWarehouseUser&&renderCompletedSection("Completed Vegetable Orders",completedVegetableLogs)}
        {!isWarehouseUser&&renderCompletedSection("Completed Leaves Orders",completedLeavesLogs)}
        {renderCompletedSection("Completed Vendor Orders",completedVendorLogs)}
      </Fragment>
    ) : (<Fragment>{!isWarehouseUser&&renderSubmissionSection("Vegetable Orders",vegSubmissions)}{!isWarehouseUser&&renderSubmissionSection("Leaves Orders",leavesSubmissions)}{renderSubmissionSection("Vendor Orders",vendorSubmissions)}</Fragment>)}
    {selDone&&(<div style={S.ov} onClick={function(){setSelDone(null);}}><div style={Object.assign({},S.mo,S.mW)} onClick={function(e){e.stopPropagation();}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:10}}>Sent Consolidated Order {selDone.type} - {fmtDT(selDone.sentAt)}</div>
      <div style={{fontSize:12,color:"#64748B",marginBottom:8}}>Supplier: {selDone.supplierName} | {selDone.email} | Week: {selDone.week}</div>
      {selDone._id&&sheetPreviewLoadingById[String(selDone._id)]&&<div style={Object.assign({},S.nI,{marginBottom:8})}>Loading stored Excel view...</div>}
      {selDone._id&&sheetPreviewById[String(selDone._id)]&&sheetPreviewById[String(selDone._id)].rows&&sheetPreviewById[String(selDone._id)].rows.length>0?
        <ExcelSheetPreviewTable rows={sheetPreviewById[String(selDone._id)].rows} maxHeight={420}/>
      :(selDone.snapshotLines&&selDone.snapshotLines.length>0?
        <div style={Object.assign({},S.tw,{maxHeight:420})}><pre style={{margin:0,padding:12,whiteSpace:"pre-wrap",fontFamily:"ui-monospace, SFMono-Regular, Menlo, monospace",fontSize:11.5,color:"#0F172A"}}>{selDone.snapshotLines.join("\n")}</pre></div>
      :<div style={Object.assign({},S.nI,{marginBottom:0})}>No stored sent details for this record (older history entry).</div>)}
      <div style={S.mA}><button style={Object.assign({},S.b,S.bS)} onClick={function(){setSelDone(null);}}>Close</button></div>
    </div></div>)}
    {selHistory&&(<div style={S.ov} onClick={function(){setSelHistory(null);}}><div style={Object.assign({},S.mo,S.mW)} onClick={function(e){e.stopPropagation();}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:8}}>Consolidated Week {selHistory.week} - Order {selHistory.type}</div>
      <div style={{fontSize:12,color:"#64748B",marginBottom:10}}>{historyCategoryLabel(selHistory.category)} | Vendor: {historyVendorLabel(selHistory.vendorKey)} | Sent: {selHistory.sent?("Yes ("+(selHistory.sentCount||0)+")"):"No"}</div>
      {(function(){
        var hk=historyGroupKey(selHistory);
        var hprev=historySheetPreviewById[hk];
        var hloading=historySheetPreviewLoadingById[hk];
        if(hloading) return <div style={Object.assign({},S.nI,{marginBottom:0})}>Loading sheet preview…</div>;
        if(hprev&&hprev.rows&&hprev.rows.length>0) return <ExcelSheetPreviewTable rows={hprev.rows} maxHeight={420}/>;
        return(<div style={Object.assign({},S.tw,{maxHeight:420})}><table style={S.tbl}><thead><tr><th style={S.th}>Store</th><th style={S.th}>Status</th><th style={S.th}>Order Date</th><th style={S.th}>Item</th><th style={S.th}>Qty</th><th style={S.th}>Note</th></tr></thead><tbody>
          {(selHistory.storeOrders||[]).map(function(so){
            var list=(so.items&&so.items.length>0)?so.items:[{itemName:"-",quantity:0,note:""}];
            return list.map(function(line,idx){
              var rowKey=String(so.storeId||so.storeName||"-")+"_"+String(idx);
              return(<tr key={rowKey}>
                <td style={S.td}>{so.storeName||so.storeId||"-"}</td>
                <td style={S.td}><span style={Object.assign({},S.bg,so.status==="processed"?S.bgP:(so.status==="submitted"||so.status==="draft_shared")?S.bgG:S.bgY)}>{so.status||"draft"}</span></td>
                <td style={S.tm}>{fmtDT(so.submittedAt)}</td>
                <td style={S.td}>{line.itemName||line.itemCode||"-"}</td>
                <td style={Object.assign({},S.td,{textAlign:"right",fontFamily:"monospace"})}>{line.quantity||0}</td>
                <td style={S.td}>{line.note||"-"}</td>
              </tr>);
            });
          })}
        </tbody></table></div>);
      })()}
      <div style={S.mA}><button style={Object.assign({},S.b,S.bS)} onClick={function(){setSelHistory(null);}}>Close</button></div>
    </div></div>)}
  </div>);
}

/* ═══ CONSOLIDATED ═══ */
function Consolidated({orders,setOrders,items,aot,manualOpenOrder,manualOpenSeq,manualOpenLeaves,toast,stores,suppliers,categoryTemplates,vendorOrdersOpenVendors,setVendorOrdersOpenVendors,setServerActiveVendorOrderIds,vendorOrderConfigs,setVendorOrderConfigs,consolidatedType,setConsolidatedType,consolidatedRequest,setConsolidatedRequest,reopenedFromId,setReopenedFromId,user}){
  var _v=useState(consolidatedType||aot||"A"),vt=_v[0],sVt=_v[1];
  var isWarehouseUser=isWarehouseRole(user);
  var _cat=useState(isWarehouseUser?"vendor_orders":"vegetables"),selCategory=_cat[0],setSelCategory=_cat[1];
  var _vk=useState(null),selectedVendorKey=_vk[0],setSelectedVendorKey=_vk[1];
  var _ea=useState(false),editingAll=_ea[0],setEditingAll=_ea[1];
  var _eb=useState({}),editQtyByStore=_eb[0],setEditQtyByStore=_eb[1];
  var _ec=useState({}),editNotesByStore=_ec[0],setEditNotesByStore=_ec[1];
  var _sa=useState(false),savingAll=_sa[0],setSavingAll=_sa[1];
  var _emg=useState(false),eMailing=_emg[0],sEMailing=_emg[1];
  var _dls=useState({}),downloadingSplit=_dls[0],setDownloadingSplit=_dls[1];
  var _st=useState(1),step=_st[0],setStep=_st[1];
  var _sv=useState([]),savedRows=_sv[0],setSavedRows=_sv[1];
  var _sp=useState([]),splitSupplierIds=_sp[0],setSplitSupplierIds=_sp[1];
  var _ov=useState({}),itemOverrides=_ov[0],setItemOverrides=_ov[1];
  var _ss=useState({}),sentSplitBySupplier=_ss[0],setSentSplitBySupplier=_ss[1];
  var _fl=useState(false),forceCompletedLock=_fl[0],setForceCompletedLock=_fl[1];
  var _logs=useState([]),logs=_logs[0],setLogs=_logs[1];
  var _sq=useState(""),supplierSearch=_sq[0],setSupplierSearch=_sq[1];
  var _vsm=useState("individual"),vendorSendMode=_vsm[0],setVendorSendMode=_vsm[1];
  var _vsp=useState(null),vendorPreviewStoreId=_vsp[0],setVendorPreviewStoreId=_vsp[1];
  var _vsr=useState(null),vendorStoreDialogRow=_vsr[0],setVendorStoreDialogRow=_vsr[1];
  var _vse=useState(false),vendorStoreDialogEditing=_vse[0],setVendorStoreDialogEditing=_vse[1];
  var _vsq=useState({}),vendorStoreDialogQty=_vsq[0],setVendorStoreDialogQty=_vsq[1];
  var _vsn=useState({}),vendorStoreDialogNotes=_vsn[0],setVendorStoreDialogNotes=_vsn[1];
  var _vss=useState(false),savingVendorStoreDialog=_vss[0],setSavingVendorStoreDialog=_vss[1];
  var _vsri=useState(0),vendorStoreRawSheetIdx=_vsri[0],setVendorStoreRawSheetIdx=_vsri[1];
  var _dlc=useState(false),downloadingVendorConsolidated=_dlc[0],setDownloadingVendorConsolidated=_dlc[1];
  var _rt=useState(function(){return loadPersistedReopenTarget();}),reopenTarget=_rt[0],setReopenTarget=_rt[1];
  var resolvedVendorKey=normalizeVendorKey(selCategory,selectedVendorKey);
  var activeTemplate=getTemplateForCategory(categoryTemplates,selCategory,resolvedVendorKey);
  var consolidatedRawGrid=normalizeRawGridTemplate(activeTemplate&&activeTemplate.rawGrid?activeTemplate.rawGrid:null);
  var consolidatedRawSheets=consolidatedRawGrid&&Array.isArray(consolidatedRawGrid.sheets)?consolidatedRawGrid.sheets:[];
  var templateHeaders=activeTemplate&&activeTemplate.uiHeaders?activeTemplate.uiHeaders:null;
  var itemHeader=selCategory==="vendor_orders"&&templateHeaders&&templateHeaders.item?templateHeaders.item:"PRODUCT";
  var qtyHeader=selCategory==="vendor_orders"?"QTY":(templateHeaders&&templateHeaders.quantity?templateHeaders.quantity:"QTY");
  var totalHeader=selCategory==="vendor_orders"&&templateHeaders&&templateHeaders.total?templateHeaders.total:"TOTAL QTY";
  var noteHeader=selCategory==="vendor_orders"&&templateHeaders&&templateHeaders.note?templateHeaders.note:"NOTE";
  var currentType=selCategory==="vendor_orders"?"VENDOR":vt;
  var isLeavesFlow=selCategory==="leaves";
  var slotHeaderForIndex=function(slot,idx){
    if(selCategory==="vendor_orders"){
      if(slot&&slot.store&&slot.store.name) return slot.store.name;
      if(slot&&slot.store&&slot.store.id) return slot.store.id;
    }
    if(selCategory==="vendor_orders"&&activeTemplate&&activeTemplate.kind==="matrix"&&Array.isArray(activeTemplate.storeColumns)&&activeTemplate.storeColumns[idx]&&activeTemplate.storeColumns[idx].header){
      return activeTemplate.storeColumns[idx].header;
    }
    return slot.apna+vt;
  };
  var slotQtyHeaderForIndex=function(slot,idx){
    if(selCategory==="vendor_orders"){
      return "QTY";
    }
    if(activeTemplate&&activeTemplate.kind==="matrix"&&activeTemplate.storeColumns&&activeTemplate.storeColumns[idx]&&activeTemplate.storeColumns[idx].header){
      return activeTemplate.storeColumns[idx].header;
    }
    return (templateHeaders&&templateHeaders.quantity?templateHeaders.quantity:"QTY");
  };
  var scheduledGroupKey=dateKey(currentType,selCategory,resolvedVendorKey,manualOpenOrder,manualOpenSeq,getVendorSeqFromConfigs(vendorOrderConfigs,resolvedVendorKey));
  var isSingleVendorFlow=selCategory==="vendor_orders";
  var logKeySuffix="-"+currentType+"-"+categoryKey(selCategory,resolvedVendorKey);
  var scheduledWeekKey=scheduledGroupKey.endsWith(logKeySuffix)?scheduledGroupKey.slice(0,scheduledGroupKey.length-logKeySuffix.length):scheduledGroupKey;
  var storesForConsolidated=useMemo(function(){
    var map={};
    (stores||[]).forEach(function(st){
      if(!st||!st.id) return;
      map[st.id]={id:st.id,name:st.name||st.id};
    });
    Object.values(orders||{}).forEach(function(o){
      if(!o||!o.store) return;
      if(String(o.type||"")!==String(currentType||"")) return;
      if(normalizeCategory(o.category||"vegetables")!==normalizeCategory(selCategory)) return;
      if(normalizeVendorKey(selCategory,o.vendorKey)!==resolvedVendorKey) return;
      if(!map[o.store]){
        map[o.store]={id:o.store,name:o.store};
      }
    });
    return Object.values(map).sort(function(a,b){return String(a.name||a.id||"").localeCompare(String(b.name||b.id||""),undefined,{sensitivity:"base"});});
  },[stores,orders,currentType,selCategory,resolvedVendorKey]);
  var slots=useMemo(function(){return mapStoresToTemplateSlots(storesForConsolidated);},[storesForConsolidated]);
  var visibleStoreIds=useMemo(function(){
    return (slots||[]).filter(function(sl){return !!(sl&&sl.store&&sl.store.id);}).map(function(sl){return sl.store.id;});
  },[slots]);
  var supplierList=suppliersForCategory(suppliers,selCategory);
  var filteredSupplierList=useMemo(function(){
    var q=String(supplierSearch||"").trim().toLowerCase();
    if(!q) return supplierList;
    return supplierList.filter(function(s){
      return String(s.name||"").toLowerCase().indexOf(q)>=0
        || String(s.id||"").toLowerCase().indexOf(q)>=0
        || supplierEmailsText(s).toLowerCase().indexOf(q)>=0;
    });
  },[supplierList,supplierSearch]);
  var configuredVendorOrderIds=normalizeVendorOrderList(vendorOrdersOpenVendors);
  var configuredVendorOrderIdsKey=configuredVendorOrderIds.join("|");
  var reopenedVendorKeyForAccess=useMemo(function(){
    if(consolidatedRequest&&consolidatedRequest.reopenedFromId){
      return normalizeVendorKey("vendor_orders",consolidatedRequest.vendorKey||null);
    }
    if(reopenTarget&&reopenTarget.reopenedFromId){
      return normalizeVendorKey("vendor_orders",reopenTarget.vendorKey||null);
    }
    return null;
  },[consolidatedRequest,reopenTarget]);
  var visibleVendorOptions=supplierList.filter(function(v){
    if(selCategory!=="vendor_orders") return true;
    return configuredVendorOrderIds.indexOf(v.id)>=0||v.id===reopenedVendorKeyForAccess;
  });
  var visibleVendorOptionsKey=visibleVendorOptions.map(function(v){return v.id;}).join("|");
  var syncVendorStateFromResponse=function(resp){
    if(!resp) return;
    if(setVendorOrdersOpenVendors&&Object.prototype.hasOwnProperty.call(resp,"vendorOrdersOpenVendors")){
      setVendorOrdersOpenVendors(normalizeVendorOrderList(resp.vendorOrdersOpenVendors||[]));
    }
    if(setServerActiveVendorOrderIds&&Object.prototype.hasOwnProperty.call(resp,"activeVendorOrders")){
      setServerActiveVendorOrderIds(normalizeVendorOrderList(resp.activeVendorOrders||[]));
    }
    if(setVendorOrderConfigs&&Object.prototype.hasOwnProperty.call(resp,"vendorOrderConfigs")){
      setVendorOrderConfigs(normalizeVendorOrderConfigs(resp.vendorOrderConfigs));
      return;
    }
  };
  useEffect(function(){
    if(!isWarehouseUser) return;
    if(selCategory==="vendor_orders") return;
    setSelCategory("vendor_orders");
  },[isWarehouseUser,selCategory]);
  useEffect(function(){
    if(selCategory==="vendor_orders"){
      return;
    }else if(selectedVendorKey){
      setSelectedVendorKey(null);
    }
  },[selCategory,selectedVendorKey]);
  useEffect(function(){
    if(selCategory!=="vendor_orders") return;
    if(selectedVendorKey&&visibleVendorOptions.every(function(v){return v.id!==selectedVendorKey;})){
      setSelectedVendorKey(null);
      return;
    }
    if(selectedVendorKey) return;
    if(configuredVendorOrderIds.length===1){
      setSelectedVendorKey(configuredVendorOrderIds[0]);
    } else if(visibleVendorOptions.length===1){
      setSelectedVendorKey(visibleVendorOptions[0].id);
    }
  },[selCategory,selectedVendorKey,configuredVendorOrderIdsKey,visibleVendorOptionsKey]);
  useEffect(function(){
    persistReopenTarget(reopenTarget);
  },[reopenTarget]);
  useEffect(function(){
    if(!setReopenedFromId) return;
    if(reopenedFromId) return;
    if(!reopenTarget||!reopenTarget.reopenedFromId) return;
    setReopenedFromId(reopenTarget.reopenedFromId);
  },[reopenTarget,reopenedFromId,setReopenedFromId]);
  useEffect(function(){
    if(!consolidatedRequest) return;
    var nextCategory=normalizeCategory(consolidatedRequest.category||"vegetables");
    if(isWarehouseUser&&nextCategory!=="vendor_orders"){
      nextCategory="vendor_orders";
    }
    var nextVendorKey=normalizeVendorKey(nextCategory,consolidatedRequest.vendorKey||null);
    setSelCategory(nextCategory);
    setSelectedVendorKey(nextVendorKey);
    if(consolidatedRequest.reopenedFromId&&setReopenedFromId){
      setReopenedFromId(consolidatedRequest.reopenedFromId);
    }
    if(consolidatedRequest.week||consolidatedRequest.type){
      setReopenTarget({
        type:String(consolidatedRequest.type||""),
        category:nextCategory,
        vendorKey:String(nextVendorKey||""),
        week:String(consolidatedRequest.week||""),
        reopenedFromId:String(consolidatedRequest.reopenedFromId||""),
      });
    }
    setStep(1);
    if(setConsolidatedRequest) setConsolidatedRequest(null);
  },[consolidatedRequest,isWarehouseUser]);
  var supplierById=useMemo(function(){var m={};supplierList.forEach(function(s){m[s.id]=s;});return m;},[supplierList]);
  var selectedVendor=supplierById[resolvedVendorKey]||null;
  var reopenedRequestedType=(reopenedFromId&&consolidatedType)?consolidatedType:null;
  var primaryOpenType=(reopenedRequestedType||aot||null);
  var visibleStatus={submitted:true,draft_shared:true,processed:true};
  var hasFinishedLogForWeek=function(type,week){
    return (logs||[]).some(function(l){
      return l
        && String(l.type||"")===String(type||"")
        && normalizeCategory(l.category||"vegetables")===normalizeCategory(selCategory)
        && String(l.week||"")===String(week||"")
        && String(l.vendorKey||"")===String(resolvedVendorKey||"")
        && l.finished===true;
    });
  };
  var latestCurrentTypeInfo=useMemo(function(){
    return findLatestMatchingOrder(orders,visibleStoreIds,currentType,selCategory,resolvedVendorKey,visibleStatus,7*24*60*60*1000);
  },[orders,visibleStoreIds,currentType,selCategory,resolvedVendorKey]);
  var reopenedLog=useMemo(function(){
    if(!reopenedFromId) return null;
    return (logs||[]).find(function(l){return String(l&&l._id||"")===String(reopenedFromId);})||null;
  },[reopenedFromId,logs]);
  var reopenedWeekForCurrentGroup=useMemo(function(){
    if(reopenTarget){
      var sameTargetType=String(reopenTarget.type||"")===String(currentType||"");
      var sameTargetCategory=normalizeCategory(reopenTarget.category||"vegetables")===normalizeCategory(selCategory);
      var sameTargetVendor=String(reopenTarget.vendorKey||"")===String(resolvedVendorKey||"");
      var targetWeek=String(reopenTarget.week||"").trim();
      if(sameTargetType&&sameTargetCategory&&sameTargetVendor&&targetWeek) return targetWeek;
    }
    if(!reopenedLog) return null;
    var sameType=String(reopenedLog.type||"")===String(currentType||"");
    var sameCategory=normalizeCategory(reopenedLog.category||"vegetables")===normalizeCategory(selCategory);
    var sameVendor=String(reopenedLog.vendorKey||"")===String(resolvedVendorKey||"");
    var week=String(reopenedLog.week||"").trim();
    if(!sameType||!sameCategory||!sameVendor||!week) return null;
    return week;
  },[reopenTarget,reopenedLog,currentType,selCategory,resolvedVendorKey]);
  var preferScheduledNewGroup=useMemo(function(){
    if(isSingleVendorFlow) return false;
    if(!manualOpenOrder) return false;
    if(String(currentType||"")!==String(manualOpenOrder||"")) return false;
    return !reopenedWeekForCurrentGroup;
  },[isSingleVendorFlow,manualOpenOrder,currentType,reopenedWeekForCurrentGroup]);
  var activeWeekKey=useMemo(function(){
    if(reopenedWeekForCurrentGroup) return reopenedWeekForCurrentGroup;
    if(isSingleVendorFlow){
      if(latestCurrentTypeInfo&&latestCurrentTypeInfo.week&&String(latestCurrentTypeInfo.week||"")===String(scheduledWeekKey||"")){
        if(!hasFinishedLogForWeek(currentType,latestCurrentTypeInfo.week)) return latestCurrentTypeInfo.week;
      }
      return scheduledWeekKey;
    }
    if(preferScheduledNewGroup) return scheduledWeekKey;
    if(!latestCurrentTypeInfo||!latestCurrentTypeInfo.week) return scheduledWeekKey;
    if(String(latestCurrentTypeInfo.week||"")===String(scheduledWeekKey||"")) return latestCurrentTypeInfo.week;
    if(hasFinishedLogForWeek(currentType,latestCurrentTypeInfo.week)) return scheduledWeekKey;
    return latestCurrentTypeInfo.week;
  },[reopenedWeekForCurrentGroup,isSingleVendorFlow,preferScheduledNewGroup,scheduledWeekKey,latestCurrentTypeInfo,currentType,logs,selCategory,resolvedVendorKey]);
  var activeGroupKey=activeWeekKey+logKeySuffix;
  var storeOrderInfoById=useMemo(function(){
    var out={};
    (slots||[]).forEach(function(sl){
      if(!sl||!sl.store||!sl.store.id) return;
      var sid=sl.store.id;
      var exact=getStoreOrderForWeek(orders,sid,activeWeekKey,currentType,selCategory,resolvedVendorKey);
      var exactStatus=String(exact&&exact.status||"").toLowerCase();
      var exactVisible=!!(exact&&visibleStatus[exactStatus]);
      if(exactVisible){
        out[sid]={order:exact,week:exact.week||activeWeekKey};
        return;
      }
      if(isSingleVendorFlow){
        var vendorOrder=getCurrentOrderForStoreType(orders,sid,currentType,selCategory,resolvedVendorKey,manualOpenOrder,manualOpenSeq,getVendorSeqFromConfigs(vendorOrderConfigs,resolvedVendorKey));
        out[sid]={order:vendorOrder,week:vendorOrder&&vendorOrder.week||activeWeekKey};
        return;
      }
      if(preferScheduledNewGroup){
        out[sid]={order:exact||null,week:(exact&&exact.week)||activeWeekKey};
        return;
      }
      var fallback=findLatestMatchingOrder(orders,[sid],currentType,selCategory,resolvedVendorKey,visibleStatus,7*24*60*60*1000);
      if(fallback&&fallback.order&&isSameOrAdjacentDateWeekKey(fallback.week,activeWeekKey)){
        out[sid]={order:fallback.order,week:fallback.week||activeWeekKey};
        return;
      }
      out[sid]={order:exact||null,week:(exact&&exact.week)||activeWeekKey};
    });
    return out;
  },[slots,orders,activeWeekKey,currentType,selCategory,resolvedVendorKey,isSingleVendorFlow,preferScheduledNewGroup,manualOpenOrder,manualOpenSeq,vendorOrderConfigs]);
  var getStoreOrder=function(storeId){
    return storeOrderInfoById[storeId]&&storeOrderInfoById[storeId].order?storeOrderInfoById[storeId].order:null;
  };
  var getStoreOrderWeek=function(storeId){
    return storeOrderInfoById[storeId]&&storeOrderInfoById[storeId].week?storeOrderInfoById[storeId].week:activeWeekKey;
  };
  var carryOpenType=useMemo(function(){
    if(selCategory==="vendor_orders") return null;
    var bestType=null;
    var bestTs=0;
    ["A","B","C"].forEach(function(t){
      if(primaryOpenType&&t===primaryOpenType) return;
      var latestInfo=findLatestMatchingOrder(orders,visibleStoreIds,t,selCategory,resolvedVendorKey,visibleStatus,7*24*60*60*1000);
      if(!latestInfo||!latestInfo.week) return;
      if(hasFinishedLogForWeek(t,latestInfo.week)) return;
      if(latestInfo.ts>bestTs){bestTs=latestInfo.ts;bestType=t;}
    });
    return bestType;
  },[selCategory,resolvedVendorKey,primaryOpenType,logs,visibleStoreIds,orders]);
  var allowedOpenTypes=useMemo(function(){
    var out=[];
    if(primaryOpenType) out.push(primaryOpenType);
    if(carryOpenType&&out.indexOf(carryOpenType)<0) out.push(carryOpenType);
    return out;
  },[primaryOpenType,carryOpenType]);
  var hasAccessibleOpenType=selCategory==="vendor_orders"||allowedOpenTypes.length>0;
  useEffect(function(){ if(consolidatedType&&consolidatedType!==vt) sVt(consolidatedType); },[consolidatedType]);
  useEffect(function(){
    var onlyOpen = primaryOpenType;
    if(selCategory==="vendor_orders") return;
    if(onlyOpen && vt!==onlyOpen && (!carryOpenType||vt!==carryOpenType)){
      sVt(onlyOpen);
      setEditingAll(false);setEditQtyByStore({});setEditNotesByStore({});
    }
  },[primaryOpenType,carryOpenType,selCategory,vt]);
  useEffect(function(){
    setStep(1);setSavedRows([]);setSplitSupplierIds([]);setItemOverrides({});setSentSplitBySupplier({});
    setEditingAll(false);setEditQtyByStore({});setEditNotesByStore({});
    setVendorSendMode("individual");
  },[activeGroupKey]);
  useEffect(function(){ setSupplierSearch(""); },[selCategory,vt,resolvedVendorKey,step]);
  useEffect(function(){
    if(selCategory==="vendor_orders") return;
    if(!isCategoryOpenForType(selCategory,vt,consolidatedType||aot||vt,manualOpenLeaves)){
      setSelCategory(vt==="B"?"vegetables":"vegetables");
    }
  },[selCategory,vt,consolidatedType,aot]);
  useEffect(function(){
    let cancelled=false;
    apiClient.supplierOrders.getAll().then(function(h){if(!cancelled) setLogs(h||[]);}).catch(function(){});
    return function(){cancelled=true;};
  },[]);

  var baseRows=useMemo(function(){
    var categoryItems=items.filter(function(it){return normalizeCategory(it.category)===normalizeCategory(selCategory)&&normalizeVendorKey(selCategory,it.vendorKey)===resolvedVendorKey;});
    var knownCodes={};categoryItems.forEach(function(it){knownCodes[it.code]=true;});
    var dynamicCodes={};
    slots.forEach(function(sl){
      if(!sl.store) return;
      var o=getStoreOrder(sl.store.id)||{};
      Object.keys(Object.assign({},o.items||{},o.notes||{})).forEach(function(code){dynamicCodes[code]=true;});
    });
    var rows=categoryItems.slice();
    Object.keys(dynamicCodes).forEach(function(code){
      if(!knownCodes[code]) rows.push({code:code,name:displayNameForOrderKey(code,items),category:"",unit:"",_extra:true});
    });
    rows=selCategory==="vendor_orders"?orderRowsByTemplate(activeTemplate,rows):rows.sort(function(a,b){return String(a.name||"").localeCompare(String(b.name||""));});
    return rows.map(function(it){
      var qtyByStoreId={};var total=0;var noteParts=[];var orderUnitByStoreId={};
      slots.forEach(function(sl){
        if(!sl.store) return;
        var so=getStoreOrder(sl.store.id);var entry=normalizeOrderItemEntry(so&&so.items?so.items[it.code]:0);var q=entry.qty;
        var noteTxt=so&&so.notes?String(so.notes[it.code]||"").trim():"";
        if(noteTxt&&noteParts.indexOf(noteTxt)===-1) noteParts.push(noteTxt);
        qtyByStoreId[sl.store.id]=q;if(selCategory==="vendor_orders")orderUnitByStoreId[sl.store.id]={unitType:entry.unitType,customUnit:entry.customUnit||""};total+=q;
      });
      return {code:it.code,name:it.name,unit:it.unit||"",qtyByStoreId:qtyByStoreId,orderUnitByStoreId:orderUnitByStoreId,total:total,totalDisplay:selCategory==="vendor_orders"?formatQtySummaryByUnit(qtyByStoreId,orderUnitByStoreId):String(total||""),note:noteParts.join(" | ")};
    });
  },[items,orders,slots,currentType,selCategory,manualOpenOrder,manualOpenSeq,resolvedVendorKey,activeTemplate,activeWeekKey]);
  var editableStoreSlots=useMemo(function(){
    return (slots||[]).filter(function(sl){return !!(sl&&sl.store&&sl.store.id);});
  },[slots]);
  var editableStoreIndexById=useMemo(function(){
    var out={};
    editableStoreSlots.forEach(function(sl,idx){out[sl.store.id]=idx;});
    return out;
  },[editableStoreSlots]);
  var baseRowByCode=useMemo(function(){
    var out={};
    baseRows.forEach(function(row){out[row.code]=row;});
    return out;
  },[baseRows]);
  var nonVendorStoreStatusRows=useMemo(function(){
    if(isSingleVendorFlow) return [];
    return (slots||[]).filter(function(sl){return !!(sl&&sl.store&&sl.store.id);}).map(function(sl){
      var order=getStoreOrder(sl.store.id);
      var rawStatus=String(order&&order.status||"").toLowerCase();
      var status=rawStatus||"pending";
      return {
        store:sl.store,
        order:order,
        status:status,
        label:status==="pending"?"pending":status
      };
    });
  },[isSingleVendorFlow,slots,orders,currentType,selCategory,resolvedVendorKey,activeWeekKey]);
  var vendorStoreDocs=useMemo(function(){
    if(!isSingleVendorFlow||!resolvedVendorKey) return [];
    return (slots||[]).filter(function(sl){return !!(sl&&sl.store);}).map(function(sl){
      var order=getStoreOrder(sl.store.id);
      var status=String(order&&order.status||"");
      var hasVisible=["submitted","draft_shared","processed"].indexOf(status)>=0;
      var lineCount=order?Object.keys(Object.assign({},order.items||{},order.notes||{})).filter(function(code){
        return normalizeOrderItemEntry((order.items||{})[code]).qty>0 || String((order.notes||{})[code]||"").trim();
      }).length:0;
      return {slot:sl,store:sl.store,order:order,lineCount:lineCount,ready:hasVisible&&lineCount>0};
    }).filter(function(row){return row.ready;});
  },[isSingleVendorFlow,resolvedVendorKey,slots,orders,currentType,selCategory,manualOpenOrder,manualOpenSeq,activeWeekKey]);
  var vendorPendingCount=useMemo(function(){
    if(!isSingleVendorFlow||!resolvedVendorKey) return 0;
    return (slots||[]).filter(function(sl){
      if(!sl||!sl.store) return false;
      var order=getStoreOrder(sl.store.id);
      return !(order&&["submitted","draft_shared","processed"].indexOf(String(order.status||""))>=0);
    }).length;
  },[isSingleVendorFlow,resolvedVendorKey,slots,orders,currentType,selCategory,manualOpenOrder,manualOpenSeq,activeWeekKey]);
  useEffect(function(){
    if(!isSingleVendorFlow){
      setVendorPreviewStoreId(null);
      return;
    }
    if(vendorStoreDocs.some(function(row){return String(row.store&&row.store.id||"")===String(vendorPreviewStoreId||"");})) return;
    setVendorPreviewStoreId(vendorStoreDocs.length?String(vendorStoreDocs[0].store&&vendorStoreDocs[0].store.id||""):null);
  },[isSingleVendorFlow,vendorStoreDocs,vendorPreviewStoreId]);
  var selectedVendorPreviewRow=useMemo(function(){
    if(!vendorStoreDocs.length) return null;
    return vendorStoreDocs.find(function(row){return String(row.store&&row.store.id||"")===String(vendorPreviewStoreId||"");})||vendorStoreDocs[0]||null;
  },[vendorStoreDocs,vendorPreviewStoreId]);
  var vendorIndividualPreviewDisplayRows=useMemo(function(){
    if(!selectedVendorPreviewRow||!selectedVendorPreviewRow.store) return [];
    var order=(selectedVendorPreviewRow&&selectedVendorPreviewRow.order)||{};
    return baseRows.map(function(r){
      var orderItemEntry=normalizeOrderItemEntry((order.items||{})[r.code]);
      return {
        type:"item",
        key:r.code,
        row:{
          code:r.code,
          name:r.name,
          unit:r.unit||"",
          qtyDisplay:formatQtyValueWithUnit(orderItemEntry.qty,orderItemEntry),
          note:String((order.notes||{})[r.code]||""),
        }
      };
    }).filter(function(entry){
      return String(entry.row.qtyDisplay||"").trim()||String(entry.row.note||"").trim();
    });
  },[selectedVendorPreviewRow,baseRows]);
  var vendorStoreDialogDisplayRows=useMemo(function(){
    if(!vendorStoreDialogRow||!vendorStoreDialogRow.store) return [];
    var sid=vendorStoreDialogRow.store.id;
    var sourceRows=baseRows.map(function(r){
      var orderItemEntry=normalizeOrderItemEntry(((vendorStoreDialogRow.order&&vendorStoreDialogRow.order.items)||{})[r.code]);
      return {
        code:r.code,
        name:r.name,
        unit:r.unit||"",
        qty:(vendorStoreDialogEditing?Number(vendorStoreDialogQty[r.code])||0:Number(r.qtyByStoreId&&r.qtyByStoreId[sid])||0),
        qtyDisplay:formatQtyValueWithUnit(vendorStoreDialogEditing?(vendorStoreDialogQty[r.code]||0):orderItemEntry.qty,orderItemEntry),
        orderUnit:orderItemEntry,
        note:vendorStoreDialogEditing?String(vendorStoreDialogNotes[r.code]||""):String(((vendorStoreDialogRow.order&&vendorStoreDialogRow.order.notes)||{})[r.code]||""),
      };
    });
    return buildTemplateDataRows(activeTemplate,sourceRows.map(function(r){return {code:r.code,name:r.name};})).map(function(entry){
      if(entry.type==="heading") return entry;
      var row=sourceRows.find(function(src){return src.code===entry.row.code;});
      return row?{type:"item",key:entry.key,row:row}:null;
    }).filter(function(entry){return !!entry;});
  },[vendorStoreDialogRow,vendorStoreDialogEditing,vendorStoreDialogQty,vendorStoreDialogNotes,baseRows,activeTemplate]);

  var vsDialogOverlay=useMemo(function(){
    var overlay={};
    if(!vendorStoreDialogRow||!vendorStoreDialogRow.store) return overlay;
    var sid=vendorStoreDialogRow.store.id;
    var matchSlot=(slots||[]).find(function(sl){return sl.store&&sl.store.id===sid;});
    var qtyColIdx=-1;
    if(activeTemplate&&activeTemplate.kind==="tabular"&&activeTemplate.quantityColumn&&Number.isInteger(activeTemplate.quantityColumn.colIndex)){
      qtyColIdx=activeTemplate.quantityColumn.colIndex;
    }else if(matchSlot&&activeTemplate&&Array.isArray(activeTemplate.storeColumns)){
      var matchCol=activeTemplate.storeColumns.find(function(col){return col.slotKey===matchSlot.apna;});
      if(matchCol&&Number.isInteger(matchCol.colIndex)) qtyColIdx=matchCol.colIndex;
    }
    var noteColIdx=(activeTemplate&&activeTemplate.noteColumn&&Number.isInteger(activeTemplate.noteColumn.colIndex))?activeTemplate.noteColumn.colIndex:-1;
    var allItemRows=Array.isArray(activeTemplate&&activeTemplate.multiSheetItemRows)&&(activeTemplate.multiSheetItemRows||[]).length
      ?activeTemplate.multiSheetItemRows
      :(Array.isArray(activeTemplate&&activeTemplate.itemRows)
        ?(activeTemplate.itemRows||[]).map(function(ir){return Object.assign({},ir,{sheetName:activeTemplate&&activeTemplate.sheetName||"",sheetIndex:0});})
        :[]);
    var orderItems=(vendorStoreDialogRow.order&&vendorStoreDialogRow.order.items)||{};
    var orderNotes=(vendorStoreDialogRow.order&&vendorStoreDialogRow.order.notes)||{};
    allItemRows.forEach(function(ir){
      var shKey=String(ir.sheetName||ir.sheetIndex||0);
      if(!overlay[shKey]) overlay[shKey]={};
      var ri=ir.rowIndex;
      if(!Number.isInteger(ri)) return;
      var qty=normalizeOrderItemEntry(orderItems[ir.code]).qty;
      var note=String(orderNotes[ir.code]||"").trim();
      if(qtyColIdx>=0){
        if(!overlay[shKey][ri]) overlay[shKey][ri]={};
        overlay[shKey][ri][qtyColIdx]=qty>0?String(qty):"";
      }
      if(noteColIdx>=0&&note){
        if(!overlay[shKey][ri]) overlay[shKey][ri]={};
        overlay[shKey][ri][noteColIdx]=note;
      }
    });
    return overlay;
  },[vendorStoreDialogRow,activeTemplate,slots]);

  var buildStoreItemsPayload=function(storeId, qtyMap, existingItems){
    var payload={};
    var sourceQty=qtyMap&&typeof qtyMap==="object"?qtyMap:{};
    var sourceItems=existingItems&&typeof existingItems==="object"?existingItems:{};
    var codes=Object.keys(Object.assign({},baseRowByCode,sourceItems,sourceQty));
    codes.forEach(function(code){
      var rawEditedItem=sourceQty[code];
      var editedEntry=normalizeOrderItemEntry(rawEditedItem);
      var qtyValue=editedEntry.qty;
      if(selCategory==="vendor_orders"){
        var rawSourceItem=sourceItems[code];
        var hasStructuredMeta=!!(rawSourceItem&&typeof rawSourceItem==="object"&&!Array.isArray(rawSourceItem));
        var hasEditedMeta=!!(rawEditedItem&&typeof rawEditedItem==="object"&&!Array.isArray(rawEditedItem));
        var fallbackMeta=baseRowByCode[code]&&baseRowByCode[code].orderUnitByStoreId&&baseRowByCode[code].orderUnitByStoreId[storeId]
          ?baseRowByCode[code].orderUnitByStoreId[storeId]
          : {unitType:"cas",customUnit:""};
        var currentMeta=normalizeOrderItemEntry(sourceItems[code]);
        var resolvedUnitType=hasEditedMeta
          ?(editedEntry.unitType||fallbackMeta.unitType||currentMeta.unitType||"cas")
          :(hasStructuredMeta
            ?(currentMeta.unitType||fallbackMeta.unitType||editedEntry.unitType||"cas")
            :(fallbackMeta.unitType||currentMeta.unitType||editedEntry.unitType||"cas"));
        var resolvedCustomUnit="";
        if(resolvedUnitType==="other"){
          resolvedCustomUnit=hasEditedMeta?String(editedEntry.customUnit||"").trim():"";
          if(!resolvedCustomUnit&&hasStructuredMeta) resolvedCustomUnit=String(currentMeta.customUnit||"").trim();
          if(!resolvedCustomUnit) resolvedCustomUnit=String(fallbackMeta.customUnit||"").trim();
        }
        payload[code]={
          qty:qtyValue,
          unitType:resolvedUnitType,
          customUnit:resolvedCustomUnit,
        };
        return;
      }
      payload[code]=qtyValue;
    });
    return payload;
  };

  var getEditableStoreEntry=function(storeId, code, fallbackMeta){
    var raw=((editQtyByStore[storeId]||{})[code]);
    if(selCategory!=="vendor_orders") return {qty:Math.max(0,parseInt(raw,10)||0),unitType:"cas",customUnit:""};
    var entry=normalizeOrderItemEntry(raw);
    var hasStructured=!!(raw&&typeof raw==="object"&&!Array.isArray(raw));
    var fallback=fallbackMeta&&typeof fallbackMeta==="object"?fallbackMeta:{unitType:"cas",customUnit:""};
    if(!hasStructured){
      entry.unitType=fallback.unitType||entry.unitType||"cas";
      entry.customUnit=String(fallback.customUnit||entry.customUnit||"").trim();
    }
    if(entry.unitType!=="other") entry.customUnit="";
    return entry;
  };

  var updateEditableStoreEntry=function(storeId, code, updater){
    setEditQtyByStore(function(prev){
      var next=Object.assign({},prev);
      var storeMap=Object.assign({},next[storeId]||{});
      var current=selCategory==="vendor_orders"
        ?normalizeOrderItemEntry(storeMap[code])
        :{qty:Math.max(0,parseInt(storeMap[code],10)||0),unitType:"cas",customUnit:""};
      var updated=updater(Object.assign({},current))||current;
      if(selCategory==="vendor_orders"){
        var normalized=normalizeOrderItemEntry(updated);
        if(normalized.unitType!=="other") normalized.customUnit="";
        storeMap[code]=normalized;
      }else{
        storeMap[code]=Math.max(0,parseInt(updated.qty,10)||0);
      }
      next[storeId]=storeMap;
      return next;
    });
  };

  var getEditableVendorRowState=function(row){
    var qtyByStoreId={};
    var orderUnitByStoreId={};
    var entries=[];
    editableStoreSlots.forEach(function(sl){
      var sid=sl.store.id;
      var fallbackMeta=row&&row.orderUnitByStoreId&&row.orderUnitByStoreId[sid]
        ?row.orderUnitByStoreId[sid]
        :{unitType:"cas",customUnit:""};
      var entry=getEditableStoreEntry(sid,row.code,fallbackMeta);
      qtyByStoreId[sid]=entry.qty;
      orderUnitByStoreId[sid]={unitType:entry.unitType,customUnit:entry.customUnit||""};
      entries.push(entry);
    });
    return {
      qtyByStoreId:qtyByStoreId,
      orderUnitByStoreId:orderUnitByStoreId,
      totalQty:entries.reduce(function(sum,entry){return sum+entry.qty;},0),
      totalDisplay:formatQtySummaryByUnit(qtyByStoreId,orderUnitByStoreId),
      unitLabel:aggregateQtyUnit(entries),
    };
  };

  var renderVendorQtyEditor=function(storeId, code, fallbackMeta, rowIdx, colIdx){
    var entry=getEditableStoreEntry(storeId,code,fallbackMeta);
    return <div style={{display:"grid",gap:4}}>
      <input
        style={Object.assign({},S.ie,{width:"100%",minWidth:0})}
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        value={entry.qty}
        onChange={function(e){
          var value=Math.max(0,parseInt(e.target.value,10)||0);
          updateEditableStoreEntry(storeId,code,function(current){current.qty=value;return current;});
        }}
        onKeyDown={colIdx==null?undefined:function(e){handleGridNavigation(e,consolidatedNavGroup,rowIdx,colIdx,consolidatedNavMaxRow,consolidatedNavMaxCol);}}
        onWheel={stopNumberWheelChange}
        data-nav-group={colIdx==null?undefined:consolidatedNavGroup}
        data-nav-row={colIdx==null?undefined:rowIdx}
        data-nav-col={colIdx==null?undefined:colIdx}
        disabled={isCompletedLocked||savingAll}
      />
      <select
        style={Object.assign({},S.inp,{width:"100%",minWidth:0,padding:"4px 6px",fontSize:10.5,minHeight:26})}
        value={entry.unitType}
        onChange={function(e){
          var value=normalizeUnitType(e.target.value);
          updateEditableStoreEntry(storeId,code,function(current){current.unitType=value;if(value!=="other") current.customUnit="";return current;});
        }}
        disabled={isCompletedLocked||savingAll}
      >
        {ORDER_UNIT_TYPES.map(function(opt){return <option key={opt.value} value={opt.value}>{opt.label}</option>;})}
      </select>
      {entry.unitType==="other"&&<input
        style={Object.assign({},S.inp,{width:"100%",minWidth:0,padding:"4px 6px",fontSize:10.5,minHeight:26})}
        value={entry.customUnit}
        onChange={function(e){
          var value=e.target.value;
          updateEditableStoreEntry(storeId,code,function(current){current.unitType="other";current.customUnit=value;return current;});
        }}
        placeholder="Custom unit"
        disabled={isCompletedLocked||savingAll}
      />}
    </div>;
  };

  var startEditAll=function(){
    if(selCategory!=="vendor_orders"&&!hasAccessibleOpenType){toast("No consolidated order is open right now",true);return;}
    if(isCompletedLocked){toast("This consolidated order is completed and locked. Reopen from Order Monitor to edit.",true);return;}
    var next={};var nextNotes={};
    slots.forEach(function(sl){
      if(!sl.store) return;
      var sid=sl.store.id;
      var rowMap={};var noteMap={};
      var current=getStoreOrder(sid)||{};
      baseRows.forEach(function(r){
        if(selCategory==="vendor_orders"){
          var fallbackMeta=r.orderUnitByStoreId&&r.orderUnitByStoreId[sid]?r.orderUnitByStoreId[sid]:{unitType:"cas",customUnit:""};
          var currentEntry=normalizeOrderItemEntry(current.items&&current.items[r.code]);
          rowMap[r.code]={
            qty:currentEntry.qty,
            unitType:currentEntry.unitType||fallbackMeta.unitType||"cas",
            customUnit:currentEntry.unitType==="other"?(currentEntry.customUnit||fallbackMeta.customUnit||""):"",
          };
        }else{
          rowMap[r.code]=Number(r.qtyByStoreId&&r.qtyByStoreId[sid])||0;
        }
      });
      var currentNotes=current.notes||{};
      baseRows.forEach(function(r){noteMap[r.code]=String(currentNotes[r.code]||"");});
      next[sid]=rowMap;
      nextNotes[sid]=noteMap;
    });
    setEditQtyByStore(next);
    setEditNotesByStore(nextNotes);
    setEditingAll(true);
  };
  var saveAllEdits=async function(){
    if(!editingAll) return;
    try{
      setSavingAll(true);
      var targets=slots.filter(function(sl){return !!sl.store;}).map(function(sl){return sl.store.id;});
      var results=await Promise.all(targets.map(async function(sid){
        var existing=getStoreOrder(sid)||{};
        var qty=buildStoreItemsPayload(sid,Object.assign({},editQtyByStore[sid]||{}),existing.items||{});
        var notes=Object.assign({},editNotesByStore[sid]||{});
        var targetWeek=getStoreOrderWeek(sid);
        var nextStatus=(existing.status==="submitted"||existing.status==="processed"||existing.status==="draft_shared")?existing.status:"draft";
        var resp=await apiClient.orders.create({type:currentType,category:selCategory,vendorKey:resolvedVendorKey,items:qty,notes:notes,status:nextStatus,storeId:sid,week:targetWeek});
        return {sid:sid,orderId:resp&&resp.orderId,qty:qty,notes:notes,status:nextStatus,existing:existing,targetWeek:targetWeek};
      }));
      setOrders(function(prev){
        var n=Object.assign({},prev);
        results.forEach(function(r){
          var k=orderStateKey(r.sid,r.targetWeek,currentType,selCategory,resolvedVendorKey);
          n[k]=Object.assign({},prev[k]||{},{
            id:r.orderId||(prev[k]||{}).id||((r.existing&&r.existing.id)||null),
            items:Object.assign({},r.qty),
            notes:Object.assign({},r.notes),
            status:r.status,
            store:r.sid,
            type:currentType,
            category:selCategory,
            vendorKey:resolvedVendorKey,
            week:r.targetWeek,
            date:(prev[k]||{}).date||(r.existing&&r.existing.date)||new Date().toISOString(),
            submittedAt:(prev[k]||{}).submittedAt||((r.existing&&r.existing.submittedAt)||null),
            createdAt:(prev[k]||{}).createdAt||((r.existing&&r.existing.createdAt)||null)
          });
        });
        return n;
      });
      setEditingAll(false);
      setEditQtyByStore({});
      setEditNotesByStore({});
      toast("Consolidated quantities saved");
    }catch(e){toast(e.message,true);}
    finally{setSavingAll(false);}
  };

  var latestTypeLog=useMemo(function(){
    var filtered=(logs||[]).filter(function(l){
      if(!l) return false;
      var sameType=String(l.type||"")===String(currentType||"");
      var sameCategory=normalizeCategory(l.category||"vegetables")===normalizeCategory(selCategory);
      var sameWeek=String(l.week||"")===String(activeWeekKey||"");
      var sameVendor=String(l.vendorKey||"")===String(resolvedVendorKey||"");
      return sameType&&sameCategory&&sameWeek&&sameVendor;
    });
    filtered.sort(function(a,b){return new Date(b.sentAt||0)-new Date(a.sentAt||0);});
    return filtered[0]||null;
  },[logs,currentType,selCategory,activeWeekKey,resolvedVendorKey]);
  var leavesSentThisWeek=useMemo(function(){
    return (logs||[]).some(function(l){
      return l
        && String(l.type||"") === "B"
        && normalizeCategory(l.category||"vegetables") === "leaves"
        && String(l.week||"")===String(activeWeekKey||"")
        && l.finished===true;
    });
  },[logs,activeWeekKey]);
  var latestVisibleOrderAt=useMemo(function(){
    var latest=0;
    slots.forEach(function(sl){
      if(!sl.store) return;
      var so=getStoreOrder(sl.store.id);
      if(!so) return;
      if(["submitted","draft_shared","processed"].indexOf(String(so.status||""))<0) return;
      var ts=orderTimestampMs(so);
      if(ts>latest) latest=ts;
    });
    return latest>0?latest:null;
  },[slots,orders,currentType,selCategory,resolvedVendorKey,activeWeekKey]);
  var usesUnsentGraceWindow=selCategory!=="vendor_orders";
  var unsentLockExpired=useMemo(function(){
    if(!usesUnsentGraceWindow) return false;
    if(latestTypeLog&&latestTypeLog.finished===true) return false;
    if(!latestVisibleOrderAt) return false;
    return (Date.now()-latestVisibleOrderAt)>(48*60*60*1000);
  },[usesUnsentGraceWindow,latestTypeLog,latestVisibleOrderAt]);
  var unsentHoursLeft=useMemo(function(){
    if(!usesUnsentGraceWindow) return null;
    if(latestTypeLog&&latestTypeLog.finished===true) return null;
    if(!latestVisibleOrderAt) return null;
    var remainMs=(48*60*60*1000)-(Date.now()-latestVisibleOrderAt);
    if(remainMs<=0) return 0;
    return Math.ceil(remainMs/(60*60*1000));
  },[usesUnsentGraceWindow,latestTypeLog,latestVisibleOrderAt]);
  var reopenedForCurrentGroup=useMemo(function(){
    if(reopenTarget){
      return String(reopenTarget.type||"")===String(currentType||"")
        && normalizeCategory(reopenTarget.category||"vegetables")===normalizeCategory(selCategory)
        && String(reopenTarget.week||"")===String(activeWeekKey||"")
        && String(reopenTarget.vendorKey||"")===String(resolvedVendorKey||"");
    }
    if(!reopenedLog) return false;
    return String(reopenedLog.type||"")===String(currentType||"")
      && normalizeCategory(reopenedLog.category||"vegetables")===normalizeCategory(selCategory)
      && String(reopenedLog.week||"")===String(activeWeekKey||"")
      && String(reopenedLog.vendorKey||"")===String(resolvedVendorKey||"");
  },[reopenTarget,reopenedLog,currentType,selCategory,activeWeekKey,resolvedVendorKey]);
  var isCompletedLocked=(forceCompletedLock||!!(latestTypeLog&&latestTypeLog.finished===true)||unsentLockExpired)&&!reopenedForCurrentGroup;
  var consolidatedNavGroup="consolidated-edit-"+activeGroupKey;
  var consolidatedNavMaxRow=Math.max(0,baseRows.length-1);
  var consolidatedNavMaxCol=Math.max(0,(editableStoreSlots.length*2)-1);
  useEffect(function(){ setForceCompletedLock(false); },[currentType,selCategory,activeWeekKey]);
  useEffect(function(){ if(isCompletedLocked&&step!==1){ setStep(1); } },[isCompletedLocked,step]);
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
  var splitPresetStorageKey=function(){
    if(selCategory!=="vegetables") return null;
    if(vt!=="A"&&vt!=="B"&&vt!=="C") return null;
    return "om:splitPreset:vegetables:"+vt;
  };
  var loadSplitPreset=function(){
    var key=splitPresetStorageKey();
    if(!key||typeof window==="undefined"||!window.localStorage) return {};
    try{
      var raw=window.localStorage.getItem(key);
      if(!raw) return {};
      var parsed=JSON.parse(raw);
      if(parsed&&typeof parsed==="object"&&!Array.isArray(parsed)){
        if(parsed.version===2&&parsed.rows&&typeof parsed.rows==="object"&&!Array.isArray(parsed.rows)) return parsed.rows;
        return parsed;
      }
      return {};
    }catch(_e){return {};}
  };
  var saveSplitPreset=function(nextOverrides){
    var key=splitPresetStorageKey();
    if(!key||typeof window==="undefined"||!window.localStorage) return;
    try{
      var existingRaw=window.localStorage.getItem(key);
      var existingParsed=existingRaw?JSON.parse(existingRaw):{};
      var existingRows=(existingParsed&&existingParsed.version===2&&existingParsed.rows&&typeof existingParsed.rows==="object"&&!Array.isArray(existingParsed.rows))
        ? existingParsed.rows
        : (existingParsed&&typeof existingParsed==="object"&&!Array.isArray(existingParsed)?existingParsed:{});
      var mergedRows=Object.assign({},existingRows,(nextOverrides||{}));
      var payload={version:2,supplierIds:(splitSupplierIds||[]).slice(),rows:mergedRows,updatedAt:new Date().toISOString()};
      window.localStorage.setItem(key,JSON.stringify(payload));
    }catch(_e){}
  };
  useEffect(function(){
    if(selCategory!=="vegetables") return;
    if(vt!=="A"&&vt!=="B"&&vt!=="C") return;
    if(!splitSupplierIds.length) return;
    if(!savedRows.length) return;
    saveSplitPreset(itemOverrides);
  },[itemOverrides,selCategory,vt,splitSupplierIds,savedRows]);
  var beginSplit=function(){
    if(selCategory!=="vendor_orders"&&!hasAccessibleOpenType){toast("No consolidated order is open right now",true);return;}
    if(isCompletedLocked){toast("This consolidated order is completed and locked. Reopen from Order Monitor to edit.",true);return;}
    if(editingAll){toast("Save edited quantities before continuing",true);return;}
    if(isSingleVendorFlow&&(!resolvedVendorKey||!selectedVendor)){toast("Select a vendor first",true);return;}
    if(isSingleVendorFlow&&vendorStoreDocs.length<1){toast("No submitted store orders are ready for this vendor yet",true);return;}
    var snap=baseRows.map(function(r){return {code:r.code,name:r.name,unit:r.unit||"",note:r.note||"",total:r.total,totalDisplay:r.totalDisplay||"",qtyByStoreId:Object.assign({},r.qtyByStoreId),orderUnitByStoreId:Object.assign({},r.orderUnitByStoreId||{})};});
    var ids=isSingleVendorFlow?(resolvedVendorKey?[resolvedVendorKey]:[]):(isLeavesFlow?[]:supplierList.map(function(s){return s.id;}));
    if(isSingleVendorFlow&&ids.length<1){toast("Add a supplier first",true);return;}
    if(!isSingleVendorFlow&&!isLeavesFlow&&ids.length<1){toast("Add at least one supplier first",true);return;}
    var preset=loadSplitPreset();
    var nextOverrides={};
    snap.forEach(function(r){
      nextOverrides[r.code]=normalizeSplit(ids,(preset&&preset[r.code])||defaultSplitMap(ids));
    });
    setSavedRows(snap);
    setSplitSupplierIds(ids);
    setItemOverrides(nextOverrides);
    setStep(2);
  };
  var chooseSingleSupplier=function(sid){
    setSplitSupplierIds(sid?[sid]:[]);
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
    setItemOverrides(function(prev){
      var next={};
      savedRows.forEach(function(r){
        next[r.code]=normalizeSplit(splitSupplierIds,(prev&&prev[r.code])||defaultSplitMap(splitSupplierIds));
      });
      return next;
    });
  },[splitSupplierIds,savedRows]);

  var splitRowsBySupplier=useMemo(function(){
    var out={};if(!splitSupplierIds.length||!savedRows.length) return out;
    splitSupplierIds.forEach(function(sid){out[sid]=[];});
    savedRows.forEach(function(r){
      var pcts=normalizeSplit(splitSupplierIds,(itemOverrides&&itemOverrides[r.code])||defaultSplitMap(splitSupplierIds));
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
        out[sid].push({code:r.code,name:r.name,unit:r.unit||"",note:r.note||"",qtyByStoreId:perSupplier[sid],orderUnitByStoreId:Object.assign({},r.orderUnitByStoreId||{}),total:total,totalDisplay:formatQtySummaryByUnit(perSupplier[sid],r.orderUnitByStoreId||{})});
      });
    });
    return out;
  },[savedRows,splitSupplierIds,itemOverrides,slots]);
  var vendorPreviewRows=useMemo(function(){
    if(!isSingleVendorFlow||!splitSupplierIds.length) return [];
    var sid=splitSupplierIds[0];
    return splitRowsBySupplier[sid]||[];
  },[isSingleVendorFlow,splitSupplierIds,splitRowsBySupplier]);
  var vendorPreviewDisplayRows=useMemo(function(){
    if(!isSingleVendorFlow) return [];
    return buildTemplateDataRows(activeTemplate,vendorPreviewRows);
  },[isSingleVendorFlow,activeTemplate,vendorPreviewRows]);
  var vendorConsolidatedDisplayRows=useMemo(function(){
    if(!isSingleVendorFlow) return [];
    return buildTemplateDataRows(activeTemplate,baseRows);
  },[isSingleVendorFlow,activeTemplate,baseRows]);
  var getVendorConsolidatedDocumentMode=function(){
    return vendorSendMode==="consolidated_with_details"?"monitor":null;
  };
  var buildSplitPayload=function(rows,isFinal){
    var payloadRows=(rows||[]).map(function(r){
      return {itemCode:r.code,itemName:r.name,itemUnit:r.unit||"",note:r.note||"",total:r.total||0,totalDisplay:r.totalDisplay||"",qtyByStoreId:r.qtyByStoreId,orderUnitByStoreId:r.orderUnitByStoreId||{}};
    });
    var payload={rows:payloadRows};
    if(typeof isFinal==="boolean") payload.finished=isFinal;
    if(!isSingleVendorFlow) return payload;
    var slotStoreIds=slots.map(function(sl){return sl&&sl.store&&sl.store.id?String(sl.store.id):"";});
    var slotHeaders=slots.map(function(sl,idx){return String(slotHeaderForIndex(sl,idx)||"");});
    var slotQtyHeaders=slots.map(function(sl,idx){return String(slotQtyHeaderForIndex(sl,idx)||"");});
    var useConsolidatedPreviewRows=rows===baseRows||!splitSupplierIds.length;
    var sourceDisplayRows=(useConsolidatedPreviewRows?vendorConsolidatedDisplayRows:vendorPreviewDisplayRows)||[];
    var previewRows=sourceDisplayRows.map(function(entry){
      if(!entry) return null;
      if(entry.type==="heading") return {type:"heading",text:String(entry.text||"")};
      var r=entry.row||{};
      return {
        type:"item",
        itemName:r.name||"",
        itemUnit:r.unit||"",
        note:r.note||"",
        total:r.total||0,
        totalDisplay:r.totalDisplay||"",
        qtyByStoreId:r.qtyByStoreId||{},
        orderUnitByStoreId:r.orderUnitByStoreId||{},
      };
    }).filter(function(entry){return !!entry;});
    payload.previewLayout={
      dateLabel:"Date: "+new Date().toLocaleDateString(),
      itemHeader:itemHeader,
      totalHeader:totalHeader,
      noteHeader:noteHeader,
      slotStoreIds:slotStoreIds,
      slotHeaders:slotHeaders,
      slotQtyHeaders:slotQtyHeaders,
      rows:previewRows,
    };
    return payload;
  };

  var sendSplitEmail=async function(sid){
    var supplier=supplierById[sid]||null;
    var recipientEmails=supplierEmailsArray(supplier);
    var rows=splitRowsBySupplier[sid]||[];
    if(isCompletedLocked){toast("This consolidated order is completed and locked. Reopen from Order Monitor to edit.",true);return;}
    if(!supplier||recipientEmails.length===0){toast("Supplier email missing",true);return;}
    saveSplitPreset(itemOverrides);
    sEMailing(true);
    try{
      var nextSent=Object.assign({},sentSplitBySupplier);nextSent[sid]=true;
      var isFinal=splitSupplierIds.length>0 && splitSupplierIds.every(function(id){return nextSent[id];});
      var splitPayload=buildSplitPayload(rows,isFinal);
      if(isSingleVendorFlow){
        var documentMode=getVendorConsolidatedDocumentMode();
        if(documentMode) splitPayload.documentMode=documentMode;
      }
      var resp=await apiClient.orders.emailConsolidated(currentType,selCategory,resolvedVendorKey,recipientEmails,supplier.name,reopenedForCurrentGroup?reopenedFromId:null,splitPayload,activeWeekKey);
      toast("Email sent to "+recipientEmails.join(", "));
      var latestLogs=await apiClient.supplierOrders.getAll();
      setLogs(latestLogs||[]);
      setSentSplitBySupplier(nextSent);
      if(isSingleVendorFlow){
        syncVendorStateFromResponse(resp);
      }
      if(isFinal){
        setForceCompletedLock(true);
        setStep(1);
        if(selCategory==="vegetables"&&vt==="B"&&!leavesSentThisWeek){
          setForceCompletedLock(false);
          setSelCategory("leaves");
          sVt("B");
          if(setConsolidatedType) setConsolidatedType("B");
          toast("Leaves order is pending. Switched to Leaves Order B.");
        }
      }
      if(setReopenedFromId) setReopenedFromId(null);
      setReopenTarget(null);
    }catch(e){toast(e.message,true);}finally{sEMailing(false);}
  };
  var downloadVendorStoreDocument=async function(row){
    if(!row||!row.order||!row.store){toast("Store document not available",true);return;}
    try{
      setDownloadingSplit(function(prev){var n=Object.assign({},prev);n[String(row.store.id||"")]=true;return n;});
      var rowCodes=Object.keys(Object.assign({},row.order.items||{},row.order.notes||{}));
      var rowItems=(items||[]).filter(function(it){return rowCodes.indexOf(it.code)>=0;});
      var itemDetailsByCode=buildOrderItemDetails(rowCodes,rowItems,items,activeTemplate);
      var itemNamesByCode={};
      Object.keys(itemDetailsByCode).forEach(function(code){itemNamesByCode[code]=itemDetailsByCode[code].name;});
      var resp=await apiClient.orders.storeOrderExcelPreview(currentType,selCategory,resolvedVendorKey,row.order.items||{},row.order.notes||{},row.store.id,row.order.date||new Date().toISOString(),itemNamesByCode,itemDetailsByCode);
      downloadBase64File(resp&&((resp.fileBase64)||(resp.excelBase64)),resp&&resp.filename,resp&&resp.contentType);
      toast("Document downloaded for "+(row.store.name||row.store.id));
    }catch(e){toast(e.message||"Failed to download document",true);}
    finally{
      setDownloadingSplit(function(prev){var n=Object.assign({},prev);delete n[String(row.store.id||"")];return n;});
    }
  };
  var printVendorStoreDocument=async function(row){
    var printWindow;
    try{
      if(!row||!row.order||!row.store){toast("Store document not available",true);return;}
      printWindow=openPendingPrintWindow("Preparing document...");
      var rowCodes=Object.keys(Object.assign({},row.order.items||{},row.order.notes||{}));
      var rowItems=(items||[]).filter(function(it){return rowCodes.indexOf(it.code)>=0;});
      var itemDetailsByCode=buildOrderItemDetails(rowCodes,rowItems,items,activeTemplate);
      var itemNamesByCode={};
      Object.keys(itemDetailsByCode).forEach(function(code){itemNamesByCode[code]=itemDetailsByCode[code].name;});
      var resp=await apiClient.orders.storeOrderExcelPreview(currentType,selCategory,resolvedVendorKey,row.order.items||{},row.order.notes||{},row.store.id,row.order.date||new Date().toISOString(),itemNamesByCode,itemDetailsByCode);
      await printBase64File(resp&&((resp.fileBase64)||(resp.excelBase64)),resp&&resp.filename,resp&&resp.contentType,printWindow);
      toast("Print dialog opened");
    }catch(e){
      if(printWindow&&!printWindow.closed) printWindow.close();
      toast(e.message||"Failed to print document",true);
    }
  };
  var openVendorStoreDialog=function(row, editing){
    if(!row||!row.store){toast("Store order not available",true);return;}
    var order=row.order||{};
    var qtyMap={};
    var noteMap={};
    baseRows.forEach(function(r){
      qtyMap[r.code]=normalizeOrderItemEntry(order.items&&order.items[r.code]).qty;
      noteMap[r.code]=String(order.notes&&order.notes[r.code]||"");
    });
    setVendorStoreDialogRow(row);
    setVendorStoreDialogEditing(!!editing);
    setVendorStoreDialogQty(qtyMap);
    setVendorStoreDialogNotes(noteMap);
  };
  var closeVendorStoreDialog=function(){
    setVendorStoreDialogRow(null);
    setVendorStoreDialogEditing(false);
    setVendorStoreDialogQty({});
    setVendorStoreDialogNotes({});
  };
  var saveVendorStoreDialog=async function(){
    if(!vendorStoreDialogRow||!vendorStoreDialogRow.store){return;}
    try{
      setSavingVendorStoreDialog(true);
      var existing=vendorStoreDialogRow.order||{};
      var nextStatus=(existing.status==="submitted"||existing.status==="processed"||existing.status==="draft_shared")?existing.status:"draft";
      var itemPayload=buildStoreItemsPayload(vendorStoreDialogRow.store.id,vendorStoreDialogQty,existing.items||{});
      await apiClient.orders.create({
        type:currentType,
        category:selCategory,
        vendorKey:resolvedVendorKey,
        items:itemPayload,
        notes:vendorStoreDialogNotes,
        status:nextStatus,
        storeId:vendorStoreDialogRow.store.id,
        week:activeWeekKey
      });
      setOrders(function(prev){
        var n=Object.assign({},prev);
        var key=vendorStoreDialogRow.store.id+"_"+activeGroupKey;
        n[key]=Object.assign({},prev[key]||{},{
          id:(prev[key]||{}).id||existing.id,
          items:Object.assign({},itemPayload),
          notes:Object.assign({},vendorStoreDialogNotes),
          status:nextStatus,
          store:vendorStoreDialogRow.store.id,
          type:currentType,
          category:selCategory,
          vendorKey:resolvedVendorKey,
          week:activeWeekKey,
          date:(prev[key]||{}).date||existing.date||new Date().toISOString(),
          submittedAt:(prev[key]||{}).submittedAt||(existing.submittedAt||null),
          createdAt:(prev[key]||{}).createdAt||(existing.createdAt||null)
        });
        return n;
      });
      toast("Store order updated");
      setVendorStoreDialogRow(null);
      setVendorStoreDialogEditing(false);
      setVendorStoreDialogQty({});
      setVendorStoreDialogNotes({});
    }catch(e){toast(e.message||"Failed to update store order",true);}
    finally{setSavingVendorStoreDialog(false);}
  };
  var sendVendorIndividualDocs=async function(){
    if(!selectedVendor){toast("Select a vendor first",true);return;}
    var recipientEmails=supplierEmailsArray(selectedVendor);
    if(!recipientEmails.length){toast("Vendor email missing",true);return;}
    if(!vendorStoreDocs.length){toast("No submitted store documents ready for this vendor",true);return;}
    sEMailing(true);
    try{
      var resp=await apiClient.orders.emailVendorIndividual(selectedVendor.id,recipientEmails,selectedVendor.name);
      var latestLogs=await apiClient.supplierOrders.getAll();
      setLogs(latestLogs||[]);
      syncVendorStateFromResponse(resp);
      if(setReopenedFromId) setReopenedFromId(null);
      setReopenTarget(null);
      toast("Individual store documents sent to "+selectedVendor.name);
      setStep(1);
    }catch(e){toast(e.message||"Failed to send vendor documents",true);}
    finally{sEMailing(false);}
  };
  var processOrder=async function(){
    try{
      var processedStoreIds={};
      var tasks=(vendorStoreDocs||[]).filter(function(row){
        var order=row&&row.order;
        return !!(row&&row.store&&order&&order.id&&(order.status==="submitted"||order.status==="draft_shared"));
      }).map(function(row){
        processedStoreIds[row.store.id]=true;
        return apiClient.orders.process(row.order.id);
      });
      if(!tasks.length){
        toast("All ready store orders are already processed");
        return;
      }
      await Promise.all(tasks);
      setOrders(function(prev){
        var n=Object.assign({},prev);
        Object.keys(processedStoreIds).forEach(function(storeId){
          var key=storeId+"_"+activeGroupKey;
          if(n[key]){
            n[key]=Object.assign({},n[key],{status:"processed"});
          }
        });
        return n;
      });
      toast((selectedVendor&&selectedVendor.name?selectedVendor.name+" store orders":"Store orders")+" marked processed");
    }catch(e){toast(e.message||"Failed to mark store orders processed",true);}
  };
  var downloadSplitExcel=async function(sid){
    var rows=splitRowsBySupplier[sid]||[];
    if(isCompletedLocked){toast("This consolidated order is completed and locked. Reopen from Order Monitor to edit.",true);return;}
    if(!rows.length){toast("No split rows available for download",true);return;}
    try{
      setDownloadingSplit(function(prev){var n=Object.assign({},prev);n[sid]=true;return n;});
      var splitPayload=buildSplitPayload(rows);
      if(isSingleVendorFlow){
        var documentMode=getVendorConsolidatedDocumentMode();
        if(documentMode) splitPayload.documentMode=documentMode;
      }
      var resp=await apiClient.orders.consolidatedExcelPreview(currentType,selCategory,resolvedVendorKey,splitPayload,activeWeekKey);
      if(!resp||!resp.excelBase64) throw new Error("No Excel data returned");
      var b64=resp.excelBase64;
      var bin=atob(b64);
      var bytes=new Uint8Array(bin.length);
      for(var i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
      var blob=new Blob([bytes],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
      var url=URL.createObjectURL(blob);
      var a=document.createElement("a");
      a.href=url;
      a.download=resp.filename||("consolidated-order-"+currentType+".xlsx");
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function(){URL.revokeObjectURL(url);},1000);
      toast("Excel downloaded");
    }catch(e){toast(e.message||"Failed to download Excel",true);}
    finally{
      setDownloadingSplit(function(prev){var n=Object.assign({},prev);delete n[sid];return n;});
    }
  };
  var printSplitExcel=async function(sid){
    var printWindow;
    try{
      var rows=splitRowsBySupplier[sid]||[];
      if(!rows.length){toast("No split rows available for print",true);return;}
      printWindow=openPendingPrintWindow("Preparing document...");
      var splitPayload=buildSplitPayload(rows);
      if(isSingleVendorFlow){
        var documentMode=getVendorConsolidatedDocumentMode();
        if(documentMode) splitPayload.documentMode=documentMode;
      }
      var resp=await apiClient.orders.consolidatedExcelPreview(currentType,selCategory,resolvedVendorKey,splitPayload,activeWeekKey);
      await printBase64File(resp&&resp.excelBase64,resp&&resp.filename,resp&&resp.contentType,printWindow);
      toast("Print dialog opened");
    }catch(e){
      if(printWindow&&!printWindow.closed) printWindow.close();
      toast(e.message||"Failed to print document",true);
    }
  };
  var downloadVendorConsolidatedDocument=async function(){
    if(!isSingleVendorFlow){toast("This download is only available for vendor consolidated orders",true);return;}
    if(!selectedVendor||!resolvedVendorKey){toast("Select a vendor first",true);return;}
    try{
      setDownloadingVendorConsolidated(true);
      var livePayload=buildSplitPayload(baseRows);
      livePayload.documentMode="monitor";
      var resp=await apiClient.orders.consolidatedExcelPreview(currentType,selCategory,resolvedVendorKey,livePayload,activeWeekKey);
      if(!resp||!resp.excelBase64) throw new Error("No Excel data returned");
      var bin=atob(resp.excelBase64);
      var bytes=new Uint8Array(bin.length);
      for(var i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
      var blob=new Blob([bytes],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
      var url=URL.createObjectURL(blob);
      var a=document.createElement("a");
      a.href=url;
      a.download=resp.filename||("consolidated-order-"+currentType+".xlsx");
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function(){URL.revokeObjectURL(url);},1000);
      toast("Consolidated document downloaded");
    }catch(e){toast(e.message||"Failed to download consolidated document",true);}
    finally{setDownloadingVendorConsolidated(false);}
  };
  var printVendorConsolidatedDocument=async function(){
    var printWindow;
    try{
      if(!isSingleVendorFlow){toast("This print action is only available for vendor consolidated orders",true);return;}
      if(!selectedVendor||!resolvedVendorKey){toast("Select a vendor first",true);return;}
      printWindow=openPendingPrintWindow("Preparing document...");
      var livePayload=buildSplitPayload(baseRows);
      livePayload.documentMode="monitor";
      var resp=await apiClient.orders.consolidatedExcelPreview(currentType,selCategory,resolvedVendorKey,livePayload,activeWeekKey);
      await printBase64File(resp&&resp.excelBase64,resp&&resp.filename,resp&&resp.contentType,printWindow);
      toast("Print dialog opened");
    }catch(e){
      if(printWindow&&!printWindow.closed) printWindow.close();
      toast(e.message||"Failed to print document",true);
    }
  };

  var tCellBase={border:"1px solid #B9BEC9",padding:"5px 6px",fontFamily:"Calibri,'Segoe UI',Arial,sans-serif",fontSize:12.5,color:"#111827",lineHeight:1.2,height:24};
  var tHeadTop=Object.assign({},tCellBase,{fontWeight:700,background:"#FFFFFF",textAlign:"left",position:"sticky",top:0,zIndex:8});
  var tHeadTopCenter=Object.assign({},tHeadTop,{textAlign:"center"});
  var tHeadSub=Object.assign({},tCellBase,{fontWeight:700,background:"#D9D9D9",textAlign:"center",textTransform:"uppercase",position:"sticky",top:26,zIndex:9});
  var tProductCell=Object.assign({},tCellBase,{fontWeight:600,background:"#FFFFFF",textAlign:"left"});
  var tQtyCell=Object.assign({},tCellBase,{background:"#FFFFFF",textAlign:"center"});
  var itemNameWithUnit=function(row){
    var name=String(row&&row.name||"").trim();
    var unit=String(row&&row.unit||"").trim();
    if(!name) return "";
    if(selCategory!=="vendor_orders") return name;
    return unit?(name+" ("+unit+")"):name;
  };
  var onlyOpen=(allowedOpenTypes[0]||vt);

  return(<div>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:6,marginBottom:14}}>
      <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"flex-start"}}>
      <OrderDrawerNav
        selCategory={selCategory}
        setSelCategory={setSelCategory}
        orderType={vt}
        setOrderType={function(t){if(editingAll){toast("Save quantities before switching order type",true);return;}sVt(t);if(setConsolidatedType)setConsolidatedType(t);}}
        categories={isWarehouseUser?[{id:"vendor_orders",label:"Vendors"}]:null}
        getCategoryDisabled={function(catId){return catId==="vendor_orders"?visibleVendorOptions.length===0:!isCategoryOpenForType(catId,vt,onlyOpen||vt,manualOpenLeaves);}}
        getOrderTypeDisabled={function(t){return allowedOpenTypes.length>0?allowedOpenTypes.indexOf(t)<0:true;}}
        onCategoryChanged={function(){setStep(1);}}
      />
      {selCategory==="vendor_orders"&&<select style={Object.assign({},S.inp,{width:220})} value={selectedVendorKey||""} onChange={function(e){setSelectedVendorKey(e.target.value||null);setStep(1);}}><option value="">Select vendor</option>{visibleVendorOptions.map(function(v){return <option key={v.id} value={v.id}>{v.name}</option>;})}</select>}
      </div>
      <div style={{display:"flex",gap:6}}>
        {isSingleVendorFlow?(<Fragment>
          <span style={Object.assign({},S.bg,step===1?S.bgG:S.bgY)}>1. Store Orders</span>
          <span style={Object.assign({},S.bg,step===2?S.bgG:S.bgY)}>2. Send Mode</span>
          <span style={Object.assign({},S.bg,step===3?S.bgG:S.bgY)}>3. Consolidated Preview</span>
        </Fragment>):(<Fragment>
          <span style={Object.assign({},S.bg,step===1?S.bgG:S.bgY)}>1. Consolidated</span>
          <span style={Object.assign({},S.bg,step===2?S.bgG:S.bgY)}>2. Split</span>
          <span style={Object.assign({},S.bg,step===3?S.bgG:S.bgY)}>3. Preview/Send</span>
        </Fragment>)}
      </div>
    </div>
    {selCategory!=="vendor_orders"&&primaryOpenType&&<div style={S.nI}>{manualOpenOrder?("Manual override active: only Order "+primaryOpenType+" is open right now."):(reopenedRequestedType?("Reopened mode active for Order "+primaryOpenType+"."):("Schedule mode active: only Order "+primaryOpenType+" is open right now."))}</div>}
    {selCategory!=="vendor_orders"&&carryOpenType&&carryOpenType!==primaryOpenType&&<div style={S.nI}>Order {carryOpenType} remains available for up to 48 hours because supplier email has not been sent yet.</div>}
    {selCategory!=="vendor_orders"&&!primaryOpenType&&!carryOpenType&&<div style={S.nP}>No consolidated order is open right now. The next order will open on its scheduled day unless an override or reopen is used.</div>}
    {selCategory==="vendor_orders"&&!selectedVendorKey&&visibleVendorOptions.length===0&&<div style={S.nP}>No vendor orders are currently configured. Reopen a vendor order from Order Monitor to edit or resend it.</div>}
    {selCategory==="leaves"&&vt==="B"&&!leavesSentThisWeek&&<div style={S.nP}>Leaves Order B is pending. Send supplier email to complete it.</div>}
    {!latestTypeLog&&unsentHoursLeft!==null&&unsentHoursLeft>0&&<div style={S.nI}>This consolidated order remains open for {unsentHoursLeft} more hour(s) because supplier email has not been sent yet.</div>}
    {!latestTypeLog&&unsentHoursLeft===0&&<div style={S.nP}>This consolidated order is now locked because 48 hours elapsed without sending supplier email.</div>}
    {isCompletedLocked&&<div style={S.nG}>{selCategory==="vendor_orders"?"Vendor Orders":"Consolidated Order "+vt} is completed and locked. {selCategory==="vendor_orders"?"Reopen from Settings to edit/send again.":"Reopen from Order Monitor to edit/send again."}</div>}
    {reopenedForCurrentGroup&&<div style={Object.assign({},S.nP,{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10})}><span>Resend mode active. This send will be stored as a reopened resend history entry.</span><button style={Object.assign({},S.b,S.bS,{padding:"4px 10px",fontSize:11})} onClick={function(){if(setReopenedFromId) setReopenedFromId(null);setReopenTarget(null);}}>Clear</button></div>}
    {editingAll&&<div style={S.nI}>Editing quantities, qty types, and notes for all stores. Click Save when finished.</div>}

    {step===1&&(isSingleVendorFlow?(<div style={Object.assign({},S.card,{padding:0})}>
      <div style={{padding:"12px 14px",borderBottom:"1px solid rgba(148,163,184,.24)",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
        <div><div style={S.t}>{selectedVendor?(selectedVendor.name+" - Consolidated Vendor Orders"):"Vendor Consolidated Orders"}</div><div style={S.d}>All store quantities are consolidated below with total qty, while keeping the uploaded template format.</div></div>
        <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap",justifyContent:"flex-end"}}>
          {(latestTypeLog&&vendorStoreDocs.length>0)&&<button style={Object.assign({},S.b,S.bG)} onClick={processOrder}>Mark All Processed</button>}
          {!editingAll&&<button style={Object.assign({},S.b,S.bS)} onClick={startEditAll} disabled={isCompletedLocked||!selectedVendor||vendorStoreDocs.length<1}>Edit All Stores</button>}
          {editingAll&&<button style={Object.assign({},S.b,S.bP)} onClick={saveAllEdits} disabled={savingAll||isCompletedLocked||!selectedVendor||vendorStoreDocs.length<1}>{savingAll?"Saving...":"Save"}</button>}
          <button style={Object.assign({},S.b,S.bS)} onClick={downloadVendorConsolidatedDocument} disabled={downloadingVendorConsolidated||!selectedVendor||baseRows.length<1}>{downloadingVendorConsolidated?"Downloading...":"Download Document"}</button>
          <button style={Object.assign({},S.b,S.bS)} onClick={printVendorConsolidatedDocument} disabled={!selectedVendor||baseRows.length<1}>Print</button>
          <button style={Object.assign({},S.b,S.bP)} onClick={beginSplit} disabled={isCompletedLocked||editingAll||savingAll||!selectedVendor||vendorStoreDocs.length<1}>Next</button>
        </div>
      </div>
      <div style={{padding:"12px 14px"}}>
        <div style={S.d}>{vendorStoreDocs.length} ready store document(s){vendorPendingCount>0?(" | "+vendorPendingCount+" store(s) still pending submission"):""}</div>
      </div>
      <div style={Object.assign({},S.tw,{border:"none",borderRadius:0})}><table style={Object.assign({},S.tbl,{borderCollapse:"collapse",tableLayout:"fixed"})}><thead>
        <tr><th style={Object.assign({},tHeadTop,{minWidth:240})}>{selectedVendor&&selectedVendor.name?selectedVendor.name:("Date: "+new Date().toLocaleDateString())}</th><th style={Object.assign({},tHeadTopCenter,{minWidth:78})}></th><th style={Object.assign({},tHeadTopCenter,{minWidth:120})}></th>{slots.map(function(sl,idx){return <th key={sl.apna} style={Object.assign({},tHeadTopCenter,{minWidth:96})}>{slotHeaderForIndex(sl,idx)}</th>;})}</tr>
        <tr><th style={Object.assign({},tHeadSub,{textAlign:"left"})}>{itemHeader}</th><th style={Object.assign({},tHeadSub,{minWidth:78})}>UNIT</th><th style={Object.assign({},tHeadSub,{minWidth:120})}>{totalHeader}</th>{slots.map(function(sl,idx){return <th key={sl.apna+"_q"} style={Object.assign({},tHeadSub,{minWidth:96})}>{slotQtyHeaderForIndex(sl,idx)}</th>;})}</tr>
      </thead><tbody>
        {vendorConsolidatedDisplayRows.map(function(entry,rowIdx){
          if(entry.type==="heading"){
            return <tr key={entry.key}><td colSpan={slots.length+3} style={Object.assign({},tProductCell,{background:"rgba(226,232,240,.42)",fontWeight:700})}>{entry.text}</td></tr>;
          }
          var r=entry.row;
          var liveVendorState=editingAll?getEditableVendorRowState(r):null;
          var totalDisplay=editingAll?(liveVendorState.totalDisplay||""):(r.totalDisplay||"");
          return <tr key={entry.key}><td style={tProductCell}>{r.name||""}</td><td style={tQtyCell}>{r.unit||""}</td><td style={Object.assign({},tQtyCell,{fontWeight:700,color:"#166534"})}>{totalDisplay}</td>{slots.map(function(sl){var sid=sl.store&&sl.store.id;var q=sid?((r.qtyByStoreId&&r.qtyByStoreId[sid])||0):0;var unitMeta=sid?((r.orderUnitByStoreId&&r.orderUnitByStoreId[sid])||{unitType:"cas",customUnit:""}):{unitType:"cas",customUnit:""};return <td key={sl.apna} style={Object.assign({},tQtyCell,editingAll&&sid?S.cE:{})}>{editingAll&&sid?renderVendorQtyEditor(sid,r.code,unitMeta,rowIdx,editableStoreIndexById[sid]):<span style={{fontFamily:"Calibri,'Segoe UI',Arial,sans-serif",fontSize:11,color:q>0?"#0F172A":"#64748B"}}>{formatQtyValueWithUnit(q,unitMeta)}</span>}</td>;})}</tr>;
        })}
      </tbody></table></div>
      {vendorStoreDocs.length===0?<div style={{textAlign:"center",padding:"8px 14px 22px",color:"#6B7186"}}>{selectedVendor?"No submitted store orders are ready for this vendor yet.":"Select a vendor to review store orders."}</div>:
      <div style={Object.assign({},S.tw,{border:"none",borderRadius:0})}><table style={S.tbl}><thead><tr><th style={S.th}>Store</th><th style={S.th}>Status</th><th style={S.th}>Submitted</th><th style={S.th}>Lines</th><th style={S.th}>Document</th><th style={S.th}>Actions</th></tr></thead><tbody>
        {vendorStoreDocs.map(function(row){
          var downloadKey=String(row.store.id||"");
          return <tr key={downloadKey}><td style={Object.assign({},S.td,{fontWeight:600})}>{row.store.name||row.store.id}</td><td style={S.td}><span style={Object.assign({},S.bg,String(row.order&&row.order.status||"")==="processed"?S.bgP:S.bgG)}>{row.order&&row.order.status||"-"}</span></td><td style={S.tm}>{fmtDT(row.order&&row.order.date)}</td><td style={Object.assign({},S.td,{textAlign:"center",fontFamily:"monospace",fontWeight:700})}>{row.lineCount}</td><td style={S.td}><div style={{display:"flex",gap:4,flexWrap:"wrap"}}><button style={Object.assign({},S.b,S.bS,{padding:"3px 8px",fontSize:10.5})} onClick={function(){downloadVendorStoreDocument(row);}} disabled={!!downloadingSplit[downloadKey]}>{downloadingSplit[downloadKey]?"Downloading...":"Download Document"}</button><button style={Object.assign({},S.b,S.bS,{padding:"3px 8px",fontSize:10.5})} onClick={function(){printVendorStoreDocument(row);}}>Print</button></div></td><td style={S.td}><div style={{display:"flex",gap:4,flexWrap:"wrap"}}><button style={Object.assign({},S.b,S.bS,{padding:"3px 8px",fontSize:10.5})} onClick={function(){openVendorStoreDialog(row,false);}}>View</button></div></td></tr>;
        })}
      </tbody></table></div>}
    </div>):(<div style={Object.assign({},S.card,{padding:0})}>
      <div style={{padding:"12px 14px",borderBottom:"1px solid rgba(148,163,184,.24)",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
        <div><div style={S.t}>{selCategory==="vendor_orders"?(CATEGORY_LABELS[selCategory]+" Consolidated"):(""+CATEGORY_LABELS[selCategory]+" Consolidated Order "+vt)}</div><div style={S.d}>Review store quantities, then save and continue to supplier split.</div></div>
        <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap",justifyContent:"flex-end"}}>
          {!editingAll&&<button style={Object.assign({},S.b,S.bS)} onClick={startEditAll} disabled={isCompletedLocked||!hasAccessibleOpenType}>Edit All Stores</button>}
          {editingAll&&<button style={Object.assign({},S.b,S.bP)} onClick={saveAllEdits} disabled={savingAll||isCompletedLocked||!hasAccessibleOpenType}>{savingAll?"Saving...":"Save"}</button>}
          <button style={Object.assign({},S.b,S.bP)} onClick={beginSplit} disabled={isCompletedLocked||editingAll||savingAll||!hasAccessibleOpenType}>Next</button>
        </div>
      </div>
      <div style={{padding:"10px 14px 0",display:"flex",gap:8,flexWrap:"wrap"}}>
        {nonVendorStoreStatusRows.map(function(row){
          var badgeStyle=row.status==="processed"?S.bgP:(row.status==="submitted"||row.status==="draft_shared")?S.bgG:(row.status==="draft"?S.bgY:S.bgY);
          return <div key={row.store.id} style={{display:"inline-flex",alignItems:"center",gap:6,padding:"6px 10px",borderRadius:999,border:"1px solid rgba(148,163,184,.28)",background:"rgba(255,255,255,.75)",fontSize:12.5,color:"#334155"}}><span style={{fontWeight:600}}>{row.store.name||row.store.id}</span><span style={Object.assign({},S.bg,badgeStyle)}>{row.label}</span></div>;
        })}
      </div>
      <div style={Object.assign({},S.tw,{border:"none",borderRadius:0})}><table style={Object.assign({},S.tbl,{borderCollapse:"collapse",tableLayout:"fixed"})}><thead>
        <tr><th style={Object.assign({},tHeadTop,{minWidth:170})}>{("Date: "+new Date().toLocaleDateString())}</th><th style={Object.assign({},tHeadTopCenter,{minWidth:68})}></th>{selCategory==="vendor_orders"&&<th style={Object.assign({},tHeadTopCenter,{minWidth:68})}>UNIT</th>}{slots.map(function(sl,idx){return <th key={sl.apna} style={Object.assign({},tHeadTopCenter,{minWidth:84})}>{slotHeaderForIndex(sl,idx)}</th>;})}<th style={Object.assign({},tHeadTop,{minWidth:180})}></th></tr>
        <tr><th style={Object.assign({},tHeadSub,{textAlign:"left"})}>{itemHeader}</th><th style={Object.assign({},tHeadSub,{minWidth:68})}>{totalHeader}</th>{selCategory==="vendor_orders"&&<th style={Object.assign({},tHeadSub,{minWidth:68})}>UNIT</th>}{slots.map(function(sl,idx){return <th key={sl.apna+"_q"} style={Object.assign({},tHeadSub,{minWidth:84})}>{selCategory==="vendor_orders"?"QTY":(activeTemplate&&activeTemplate.storeColumns&&activeTemplate.storeColumns[idx]&&activeTemplate.storeColumns[idx].header||"QTY")}</th>;})}<th style={Object.assign({},tHeadSub,{textAlign:"left"})}>{noteHeader}</th></tr>
      </thead><tbody>{baseRows.map(function(it,rowIdx){
        var liveVendorState=selCategory==="vendor_orders"&&editingAll?getEditableVendorRowState(it):null;
        var totalQty=liveVendorState?liveVendorState.totalQty:it.total;
        var unitLabel=liveVendorState?liveVendorState.unitLabel:(getOrderItemUnitLabel({unitType:Object.values(it.unitTypeByStoreId||{})[0]||"cas"})||"CASE");
        return(<tr key={it.code}><td style={tProductCell}>{it.name}</td><td style={Object.assign({},tQtyCell,{fontWeight:700,color:"#166534"})}>{totalQty||""}</td>{selCategory==="vendor_orders"&&<td style={Object.assign({},tQtyCell,{fontWeight:700,color:"#166534",fontSize:11,textAlign:"center"})}>{unitLabel}</td>}{slots.map(function(sl){var sid=sl.store&&sl.store.id;var baseQ=sid?((it.qtyByStoreId&&it.qtyByStoreId[sid])||0):0;var fallbackMeta=sid&&it.orderUnitByStoreId&&it.orderUnitByStoreId[sid]?it.orderUnitByStoreId[sid]:{unitType:"cas",customUnit:""};var storeCol=sid!=null?editableStoreIndexById[sid]:null;return(<td key={sl.apna} style={Object.assign({},tQtyCell,editingAll&&sid?S.cE:{})}>{editingAll&&sid&&selCategory==="vendor_orders"?renderVendorQtyEditor(sid,it.code,fallbackMeta,rowIdx,storeCol):editingAll&&sid?<input style={S.ie} type="text" inputMode="numeric" pattern="[0-9]*" value={Number((editQtyByStore[sid]||{})[it.code])||0} onChange={function(e){var v=Math.max(0,parseInt(e.target.value)||0);setEditQtyByStore(function(prev){var n=Object.assign({},prev);var m=Object.assign({},n[sid]||{});m[it.code]=v;n[sid]=m;return n;});}} onKeyDown={function(e){if(storeCol==null) return;handleGridNavigation(e,consolidatedNavGroup,rowIdx,storeCol,consolidatedNavMaxRow,consolidatedNavMaxCol);}} data-nav-group={consolidatedNavGroup} data-nav-row={rowIdx} data-nav-col={storeCol} disabled={isCompletedLocked||savingAll}/>:<span style={{fontFamily:"Calibri,'Segoe UI',Arial,sans-serif",fontSize:12.5,color:baseQ>0?"#0F172A":"#64748B"}}>{selCategory==="vendor_orders"?formatQtyValueWithUnit(baseQ,fallbackMeta):(baseQ||"")}</span>}</td>);})}<td style={Object.assign({},tCellBase,{background:"#FFFFFF",textAlign:"left",color:"#475569"})}>{editingAll?<div style={{display:"grid",gap:6}}>{editableStoreSlots.map(function(sl,noteIdx){var sid=sl.store.id;var nVal=String((editNotesByStore[sid]||{})[it.code]||"");var noteCol=editableStoreSlots.length+noteIdx;return <div key={sid+"_"+it.code} style={{display:"block"}}><input style={Object.assign({},S.inp,{padding:"5px 7px",fontSize:12.5,minHeight:28})} value={nVal} onChange={function(e){var v=e.target.value;setEditNotesByStore(function(prev){var n=Object.assign({},prev);var m=Object.assign({},n[sid]||{});m[it.code]=v;n[sid]=m;return n;});}} onKeyDown={function(e){handleGridNavigation(e,consolidatedNavGroup,rowIdx,noteCol,consolidatedNavMaxRow,consolidatedNavMaxCol);}} data-nav-group={consolidatedNavGroup} data-nav-row={rowIdx} data-nav-col={noteCol} disabled={isCompletedLocked||savingAll} placeholder="note"/></div>;})}</div>:(it.note||"")}</td></tr>);
      })}</tbody></table></div>
    </div>))}

    {step===2&&(isSingleVendorFlow?(<div style={S.card}>
      <div style={S.cH}><div><div style={S.t}>{selectedVendor?(selectedVendor.name+" - Send Mode"):"Vendor Send Mode"}</div><div style={S.d}>Choose whether the supplier should receive individual store documents, one consolidated order, or one consolidated order with all store-level details.</div></div></div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(260px,1fr))",gap:10,marginBottom:14}}>
        <button style={Object.assign({},S.card,{marginBottom:0,textAlign:"left",border:vendorSendMode==="individual"?"2px solid #16A34A":"1px solid rgba(148,163,184,.28)",background:vendorSendMode==="individual"?"rgba(22,163,74,.08)":"rgba(255,255,255,.7)",cursor:"pointer"})} onClick={function(){setVendorSendMode("individual");}}>
          <div style={Object.assign({},S.t,{marginBottom:6})}>Send Individual Store Documents</div>
          <div style={S.d}>{vendorStoreDocs.length} attachment(s), one document per ready store. This keeps each store in its own uploaded format.</div>
        </button>
        <button style={Object.assign({},S.card,{marginBottom:0,textAlign:"left",border:vendorSendMode==="consolidated"?"2px solid #16A34A":"1px solid rgba(148,163,184,.28)",background:vendorSendMode==="consolidated"?"rgba(22,163,74,.08)":"rgba(255,255,255,.7)",cursor:"pointer"})} onClick={function(){setVendorSendMode("consolidated");}}>
          <div style={Object.assign({},S.t,{marginBottom:6})}>Send One Consolidated Order</div>
          <div style={S.d}>Review a single combined vendor order first, then send that consolidated file to the supplier.</div>
        </button>
        <button style={Object.assign({},S.card,{marginBottom:0,textAlign:"left",border:vendorSendMode==="consolidated_with_details"?"2px solid #16A34A":"1px solid rgba(148,163,184,.28)",background:vendorSendMode==="consolidated_with_details"?"rgba(22,163,74,.08)":"rgba(255,255,255,.7)",cursor:"pointer"})} onClick={function(){setVendorSendMode("consolidated_with_details");}}>
          <div style={Object.assign({},S.t,{marginBottom:6})}>Send Consolidated Order With Store Details</div>
          <div style={S.d}>Send the same detailed workbook shown in the consolidation monitor, including the overall total and each store's qty columns.</div>
        </button>
      </div>
      <div style={Object.assign({},S.card,{padding:"12px 14px"})}>
        <div style={S.t}>{vendorSendMode==="individual"?"Individual Store Email":(vendorSendMode==="consolidated_with_details"?"Detailed Consolidated Vendor Email":"Consolidated Vendor Email")}</div>
        <div style={S.d}>{vendorSendMode==="individual"?((selectedVendor&&supplierEmailsText(selectedVendor))||"No vendor email set")+" | "+vendorStoreDocs.length+" store document(s) ready.":(vendorSendMode==="consolidated_with_details"?("Continue to the detailed consolidated preview for "+((selectedVendor&&selectedVendor.name)||"this vendor")+" before sending."):("Continue to consolidated preview for "+((selectedVendor&&selectedVendor.name)||"this vendor")+" before sending."))}</div>
      </div>
      {vendorSendMode==="individual"&&<div style={Object.assign({},S.card,{padding:"12px 14px"})}>
        <div style={S.cH}>
          <div>
            <div style={S.t}>{selectedVendor?(selectedVendor.name+" - Individual Store Preview"):"Individual Store Preview"}</div>
            <div style={S.d}>Review the store-specific document layout before sending the individual attachments.</div>
          </div>
        </div>
        {vendorStoreDocs.length>0?<Fragment>
          <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:10}}>
            {vendorStoreDocs.map(function(row){
              var storeId=String(row.store&&row.store.id||"");
              var isActive=storeId===String(vendorPreviewStoreId||"");
              return <button key={storeId} style={Object.assign({},S.b,isActive?S.bP:S.bS,{padding:"4px 10px",fontSize:10.5})} onClick={function(){setVendorPreviewStoreId(storeId);}}>{row.store.name||row.store.id}</button>;
            })}
          </div>
          {selectedVendorPreviewRow&&<Fragment>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,flexWrap:"wrap",marginBottom:10}}>
              <div style={{fontSize:12,color:"#64748B"}}>Store: <strong style={{color:"#0F172A"}}>{selectedVendorPreviewRow.store.name||selectedVendorPreviewRow.store.id}</strong> | Submitted: {fmtDT(selectedVendorPreviewRow.order&&selectedVendorPreviewRow.order.date)}</div>
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                <button style={Object.assign({},S.b,S.bS,{padding:"3px 8px",fontSize:10.5})} onClick={function(){downloadVendorStoreDocument(selectedVendorPreviewRow);}} disabled={!!downloadingSplit[String(selectedVendorPreviewRow.store.id||"")]}>Download Document</button>
                <button style={Object.assign({},S.b,S.bS,{padding:"3px 8px",fontSize:10.5})} onClick={function(){printVendorStoreDocument(selectedVendorPreviewRow);}}>Print</button>
                <button style={Object.assign({},S.b,S.bS,{padding:"3px 8px",fontSize:10.5})} onClick={function(){openVendorStoreDialog(selectedVendorPreviewRow,false);}}>Open Full View</button>
              </div>
            </div>
            <div style={Object.assign({},S.tw,{maxHeight:"46vh"})}><table style={S.tbl}><thead><tr><th style={S.th}>{itemHeader}</th><th style={S.th}>UNIT</th><th style={Object.assign({},S.th,{textAlign:"center"})}>{qtyHeader||"Qty"}</th><th style={S.th}>{noteHeader||"Note"}</th></tr></thead><tbody>
              {vendorIndividualPreviewDisplayRows.length?vendorIndividualPreviewDisplayRows.map(function(entry){
                var row=entry.row;
                return <tr key={entry.key}><td style={Object.assign({},S.td,{fontWeight:500})}>{row.name||""}</td><td style={S.td}>{row.unit||""}</td><td style={Object.assign({},S.td,{textAlign:"center"})}><span style={{fontFamily:"monospace"}}>{row.qtyDisplay||""}</span></td><td style={S.td}>{row.note||"-"}</td></tr>;
              }):<tr><td colSpan={4} style={Object.assign({},S.td,{textAlign:"center",padding:20,color:"#64748B"})}>No filled lines in this store document.</td></tr>}
            </tbody></table></div>
          </Fragment>}
        </Fragment>:<div style={{textAlign:"center",padding:20,color:"#6B7186"}}>No ready store documents are available for preview.</div>}
      </div>}
      <div style={S.mA}>
        <button style={Object.assign({},S.b,S.bS)} onClick={function(){setStep(1);}}>Back</button>
        {vendorSendMode==="individual"?<button style={Object.assign({},S.b,S.bP)} onClick={sendVendorIndividualDocs} disabled={eMailing||!selectedVendor||vendorStoreDocs.length<1||isCompletedLocked}>{eMailing?"Sending...":"Send Individual Store Documents"}</button>:<button style={Object.assign({},S.b,S.bP)} onClick={function(){setStep(3);}} disabled={!selectedVendor||isCompletedLocked}>{vendorSendMode==="consolidated_with_details"?"Continue to Detailed Consolidated Preview":"Continue to Consolidated Preview"}</button>}
      </div>
    </div>):(<div style={S.card}>
      <div style={S.cH}><div><div style={S.t}>{selCategory==="vendor_orders"?(CATEGORY_LABELS[selCategory]+" Split by Supplier"):(""+CATEGORY_LABELS[selCategory]+" Split Order "+vt+" by Supplier")}</div><div style={S.d}>Set product-level split percentages for each supplier.</div></div></div>
      {isLeavesFlow&&(<Fragment>
        <div style={S.dWrap}>
          <div style={S.dCard}>
            <div style={S.dTitle}>Select Supplier</div>
            <input style={Object.assign({},S.inp,{marginBottom:10})} value={supplierSearch} onChange={function(e){setSupplierSearch(e.target.value);}} placeholder="Search supplier"/>
            {filteredSupplierList.map(function(s){
              var checked=splitSupplierIds[0]===s.id;
              return <button key={s.id} style={Object.assign({},S.dBtn,checked?S.dBtnA:{})} onClick={function(){chooseSingleSupplier(s.id);}}>{s.name} <span style={{fontSize:11,color:"#64748B"}}>{supplierEmailsText(s)||"No email"}</span></button>;
            })}
            {filteredSupplierList.length===0&&<div style={{fontSize:12,color:"#64748B"}}>No suppliers match this search.</div>}
          </div>
        </div>
        {splitSupplierIds.length<1&&<div style={S.nP}>Select one supplier for Leaves order.</div>}
        <div style={S.mA}><button style={Object.assign({},S.b,S.bS)} onClick={function(){setStep(1);}}>Back</button><button style={Object.assign({},S.b,S.bP)} disabled={splitSupplierIds.length!==1||isCompletedLocked} onClick={function(){setStep(3);}}>Next</button></div>
      </Fragment>)}
      {!isLeavesFlow&&(<Fragment>
      <div style={{marginBottom:12,maxWidth:280}}>
        <input style={S.inp} value={supplierSearch} onChange={function(e){setSupplierSearch(e.target.value);}} placeholder="Search supplier"/>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(220px,1fr))",gap:8,marginBottom:12}}>
        {filteredSupplierList.map(function(s){
          var checked=splitSupplierIds.indexOf(s.id)>=0;
          return <label key={s.id} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",border:"1px solid rgba(148,163,184,.3)",borderRadius:8,background:checked?"rgba(22,163,74,.08)":"rgba(255,255,255,.7)"}}><input type="checkbox" checked={checked} onChange={function(e){toggleSplitSupplier(s.id,e.target.checked);}}/><span style={{fontSize:12.5,fontWeight:600}}>{s.name}</span><span style={{fontSize:11,color:"#64748B"}}>{supplierEmailsText(s)||"No email"}</span></label>;
        })}
      </div>
      {filteredSupplierList.length===0&&<div style={S.nP}>No suppliers match this search.</div>}
      {splitSupplierIds.length<1&&<div style={S.nP}>Select at least 1 supplier to split this order.</div>}
      {splitSupplierIds.length>=1&&(<Fragment>
        <div style={Object.assign({},S.tw,{maxHeight:"46vh"})}><table style={S.tbl}><thead><tr><th style={S.th}>Product</th><th style={Object.assign({},S.th,{textAlign:"right"})}>Total</th>{splitSupplierIds.map(function(sid){return <th key={sid} style={Object.assign({},S.th,{textAlign:"center"})}>{(supplierById[sid]||{}).name||sid} %</th>;})}</tr></thead><tbody>
          {savedRows.map(function(r){
            var itemPct=normalizeSplit(splitSupplierIds,(itemOverrides&&itemOverrides[r.code])||defaultSplitMap(splitSupplierIds));
            return <tr key={r.code}><td style={S.td}>{r.name}</td><td style={Object.assign({},S.tm,{textAlign:"right"})}>{r.total||0}</td>{splitSupplierIds.map(function(sid,idx){var last=idx===splitSupplierIds.length-1;return <td key={sid} style={Object.assign({},S.td,{textAlign:"center"})}><input style={Object.assign({},S.inp,{width:80,textAlign:"center"})} type="text" inputMode="numeric" readOnly={last||isCompletedLocked} value={itemPct[sid]||0} onChange={function(e){var v=parsePct(e.target.value);setItemOverrides(function(prev){var cur=Object.assign({},prev[r.code]||{});cur[sid]=v;var n=Object.assign({},prev);n[r.code]=normalizeSplit(splitSupplierIds,cur);return n;});}}/></td>;})}</tr>;
          })}
        </tbody></table></div>
      </Fragment>)}
      <div style={S.mA}><button style={Object.assign({},S.b,S.bS)} onClick={function(){setStep(1);}}>Back</button><button style={Object.assign({},S.b,S.bP)} disabled={splitSupplierIds.length<1||isCompletedLocked} onClick={function(){saveSplitPreset(itemOverrides);setStep(3);}}>Save Split & Preview</button></div>
      </Fragment>)}
    </div>))}

    {step===3&&(<div style={S.card}>
      <div style={S.cH}><div><div style={S.t}>{CATEGORY_LABELS[selCategory]} Supplier Preview & Send</div><div style={S.d}>{isSingleVendorFlow?(vendorSendMode==="consolidated_with_details"?"Review the detailed consolidated vendor workbook, including store-level columns, before sending it to the supplier.":"Review the consolidated vendor order before sending it to the supplier."):"Both split orders are shown side by side. You can still override product split percentages below."}</div></div></div>
      {!isSingleVendorFlow&&!isLeavesFlow&&<div style={Object.assign({},S.card,{padding:"10px 12px"})}>
        <div style={{fontSize:12,fontWeight:700,marginBottom:8}}>Further Product-Level Split Override</div>
        <div style={Object.assign({},S.tw,{maxHeight:"30vh"})}><table style={S.tbl}><thead><tr><th style={S.th}>Product</th>{splitSupplierIds.map(function(sid){return <th key={sid} style={Object.assign({},S.th,{textAlign:"center"})}>{(supplierById[sid]||{}).name||sid} %</th>;})}</tr></thead><tbody>
          {savedRows.map(function(r){
            var itemPct=normalizeSplit(splitSupplierIds,(itemOverrides&&itemOverrides[r.code])||defaultSplitMap(splitSupplierIds));
            return <tr key={r.code}><td style={S.td}>{r.name}</td>{splitSupplierIds.map(function(sid,idx){var last=idx===splitSupplierIds.length-1;return <td key={sid} style={Object.assign({},S.td,{textAlign:"center"})}><input style={Object.assign({},S.inp,{width:80,textAlign:"center"})} type="text" inputMode="numeric" readOnly={last||isCompletedLocked} value={itemPct[sid]||0} onChange={function(e){var v=parsePct(e.target.value);setItemOverrides(function(prev){var cur=Object.assign({},prev[r.code]||{});cur[sid]=v;var n=Object.assign({},prev);n[r.code]=normalizeSplit(splitSupplierIds,cur);return n;});}}/></td>;})}</tr>;
          })}
        </tbody></table></div>
      </div>}
      <div style={{display:"grid",gridTemplateColumns:isSingleVendorFlow?"1fr":"repeat(auto-fit,minmax(480px,1fr))",gap:10}}>
        {splitSupplierIds.map(function(sid){
          var s=supplierById[sid]||{id:sid,name:sid,email:"",emails:[]};
          var sEmailText=supplierEmailsText(s);
          var rows=splitRowsBySupplier[sid]||[];
          var displayRows=isSingleVendorFlow?vendorPreviewDisplayRows:rows.map(function(r){return {type:"item",key:r.code,row:r};});
          var sent=!!sentSplitBySupplier[sid];
          var isDownloading=!!downloadingSplit[sid];
          var useVendorMonitorPreview=isSingleVendorFlow&&selCategory==="vendor_orders"&&vendorSendMode==="consolidated_with_details";
          var useVendorDocumentPreview=isSingleVendorFlow&&selCategory==="vendor_orders"&&!useVendorMonitorPreview;
          if(useVendorMonitorPreview) displayRows=vendorConsolidatedDisplayRows;
          return <div key={sid} style={Object.assign({},S.card,{marginBottom:0,padding:10})}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,marginBottom:8,flexWrap:"wrap"}}>
              <div><div style={S.t}>{s.name}</div><div style={S.d}>{sEmailText||"No email"}</div></div>
              <div style={{display:"flex",gap:6,alignItems:"center"}}>
                <button style={Object.assign({},S.b,S.bS)} onClick={function(){downloadSplitExcel(sid);}} disabled={isDownloading||isCompletedLocked}>{isDownloading?"Downloading...":(isSingleVendorFlow?(useVendorMonitorPreview?"Download Detailed File":"Download Consolidated File"):"Download Excel")}</button>
                <button style={Object.assign({},S.b,S.bS)} onClick={function(){printSplitExcel(sid);}} disabled={isCompletedLocked}>Print</button>
                <button style={Object.assign({},S.b,sent?S.bG:S.bP)} onClick={function(){sendSplitEmail(sid);}} disabled={eMailing||supplierEmailsArray(s).length===0||isCompletedLocked||sent}>{sent?"Sent":(useVendorMonitorPreview?"Send Detailed Consolidated Order":"Send Consolidated Order")}</button>
              </div>
            </div>
            <div style={Object.assign({},S.tw,{maxHeight:"40vh",border:"1px solid rgba(148,163,184,.25)"})}><table style={Object.assign({},S.tbl,{borderCollapse:"collapse",tableLayout:"fixed"})}><thead>
              {useVendorMonitorPreview?
                <Fragment>
                  <tr><th style={Object.assign({},tHeadTop,{minWidth:220})}>{s.name}</th><th style={Object.assign({},tHeadTopCenter,{minWidth:78})}></th><th style={Object.assign({},tHeadTopCenter,{minWidth:110})}></th>{slots.map(function(sl,idx){return <th key={sl.apna} style={Object.assign({},tHeadTopCenter,{minWidth:96})}>{slotHeaderForIndex(sl,idx)}</th>;})}</tr>
                  <tr><th style={Object.assign({},tHeadSub,{textAlign:"left"})}>{itemHeader}</th><th style={Object.assign({},tHeadSub,{minWidth:78})}>UNIT</th><th style={Object.assign({},tHeadSub,{minWidth:110})}>{totalHeader}</th>{slots.map(function(sl,idx){return <th key={sl.apna+"_q"} style={Object.assign({},tHeadSub,{minWidth:96})}>{slotQtyHeaderForIndex(sl,idx)}</th>;})}</tr>
                </Fragment>
                :useVendorDocumentPreview?
                <Fragment>
                  <tr><th style={Object.assign({},tHeadTop,{minWidth:220})}>{s.name}</th><th style={Object.assign({},tHeadTopCenter,{minWidth:78})}></th><th style={Object.assign({},tHeadTopCenter,{minWidth:110})}></th></tr>
                  <tr><th style={Object.assign({},tHeadSub,{textAlign:"left"})}>{itemHeader}</th><th style={Object.assign({},tHeadSub,{minWidth:78})}>UNIT</th><th style={Object.assign({},tHeadSub,{minWidth:110})}>{totalHeader}</th></tr>
                </Fragment>
                :<Fragment>
                  <tr><th style={Object.assign({},tHeadTop,{minWidth:200})}>{s.name}</th><th style={Object.assign({},tHeadTopCenter,{minWidth:78})}></th>{slots.map(function(sl,idx){return <th key={sl.apna} style={Object.assign({},tHeadTopCenter,{minWidth:100})}>{slotHeaderForIndex(sl,idx)}</th>;})}<th style={Object.assign({},tHeadTop,{minWidth:280})}></th></tr>
                  <tr><th style={Object.assign({},tHeadSub,{textAlign:"left"})}>{itemHeader}</th><th style={Object.assign({},tHeadSub,{minWidth:78})}>{totalHeader}</th>{slots.map(function(sl,idx){return <th key={sl.apna+"_q"} style={Object.assign({},tHeadSub,{minWidth:100})}>{selCategory==="vendor_orders"?"QTY":(activeTemplate&&activeTemplate.storeColumns&&activeTemplate.storeColumns[idx]&&activeTemplate.storeColumns[idx].header||"QTY")}</th>;})}<th style={Object.assign({},tHeadSub,{textAlign:"left"})}>{noteHeader}</th></tr>
                </Fragment>}
            </thead><tbody>
              {displayRows.map(function(entry){
                if(entry.type==="heading"){
                  return <tr key={entry.key}><td colSpan={(useVendorMonitorPreview||useVendorDocumentPreview)?(useVendorMonitorPreview?(slots.length+3):3):(slots.length+3)} style={Object.assign({},tProductCell,{background:"rgba(226,232,240,.42)",fontWeight:700})}>{entry.text}</td></tr>;
                }
                var r=entry.row;
                return useVendorMonitorPreview
                  ? <tr key={entry.key}><td style={tProductCell}>{r.name||""}</td><td style={tQtyCell}>{r.unit||""}</td><td style={Object.assign({},tQtyCell,{fontWeight:700,color:"#166534"})}>{r.totalDisplay||formatQtySummaryByUnit(r.qtyByStoreId||{},r.orderUnitByStoreId||{})||""}</td>{slots.map(function(sl){var sid=sl.store&&sl.store.id;var q=sid?((r.qtyByStoreId&&r.qtyByStoreId[sid])||0):0;var unitMeta=sid?((r.orderUnitByStoreId&&r.orderUnitByStoreId[sid])||{unitType:"cas",customUnit:""}):{unitType:"cas",customUnit:""};return <td key={sl.apna} style={tQtyCell}><span style={{fontFamily:"Calibri,'Segoe UI',Arial,sans-serif",fontSize:11,color:q>0?"#0F172A":"#64748B"}}>{formatQtyValueWithUnit(q,unitMeta)}</span></td>;})}</tr>
                  : useVendorDocumentPreview
                  ? <tr key={entry.key}><td style={tProductCell}>{r.name||""}</td><td style={tQtyCell}>{r.unit||""}</td><td style={Object.assign({},tQtyCell,{fontWeight:700,color:"#166534"})}>{r.totalDisplay||formatQtySummaryByUnit(r.qtyByStoreId||{},r.orderUnitByStoreId||{})||""}</td></tr>
                  : <tr key={entry.key}><td style={tProductCell}>{itemNameWithUnit(r)}</td><td style={Object.assign({},tQtyCell,{fontWeight:700,color:"#166534"})}>{r.total||""}</td>{slots.map(function(sl){var q=sl.store?(r.qtyByStoreId&&r.qtyByStoreId[sl.store.id])||0:0;return <td key={sl.apna} style={tQtyCell}><span style={{fontFamily:"Calibri,'Segoe UI',Arial,sans-serif",fontSize:11,color:q>0?"#0F172A":"#64748B"}}>{q||""}</span></td>;})}<td style={Object.assign({},tCellBase,{background:"#FFFFFF",textAlign:"left",color:"#475569"})}>{r.note||""}</td></tr>;
              })}
            </tbody></table></div>
          </div>;
        })}
      </div>
      <div style={S.mA}><button style={Object.assign({},S.b,S.bS)} onClick={function(){setStep(2);}}>Back</button>{isSingleVendorFlow&&latestTypeLog&&vendorStoreDocs.length>0&&<button style={Object.assign({},S.b,S.bG)} onClick={processOrder}>Mark All Processed</button>}</div>
    </div>)}
    {vendorStoreDialogRow&&(<div style={S.ov} onClick={function(){if(!savingVendorStoreDialog) closeVendorStoreDialog();}}><div style={Object.assign({},S.mo,S.mW)} onClick={function(e){e.stopPropagation();}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:8}}>{vendorStoreDialogEditing?"Edit":"View"} Store Order - {(vendorStoreDialogRow.store&&vendorStoreDialogRow.store.name)||vendorStoreDialogRow.store&&vendorStoreDialogRow.store.id}</div>
      <div style={{fontSize:12,color:"#64748B",marginBottom:10}}>Status: {vendorStoreDialogRow.order&&vendorStoreDialogRow.order.status||"-"} | Submitted: {fmtDT(vendorStoreDialogRow.order&&vendorStoreDialogRow.order.date)}</div>
      {(!vendorStoreDialogEditing&&consolidatedRawSheets.length>0&&selCategory!=="vendor_orders")?(<Fragment>
        {consolidatedRawSheets.length>1&&<div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:8}}>{consolidatedRawSheets.map(function(sheet,idx){return <button key={sheet.name+"_"+idx} style={Object.assign({},S.b,vendorStoreRawSheetIdx===idx?S.bP:S.bS,{padding:"4px 9px",fontSize:10.5})} onClick={function(){setVendorStoreRawSheetIdx(idx);}}>{sheet.name}</button>;})}</div>}
        {(function(){
          var sheetIdx=Math.min(Math.max(0,vendorStoreRawSheetIdx),consolidatedRawSheets.length-1);
          var sheet=consolidatedRawSheets[sheetIdx];
          var shKey=String(sheet.name||sheetIdx);
          var shOverlay=vsDialogOverlay[shKey]||(Object.values(vsDialogOverlay)[0])||{};
          var colCount=Math.max.apply(null,(sheet.rows||[]).map(function(r){return (r||[]).length;})||[0]);
          return <div style={Object.assign({},S.tw,{maxHeight:"55vh"})}><table style={Object.assign({},S.tbl,{tableLayout:"auto",minWidth:Math.max(620,colCount*90)})}><tbody>
            {(sheet.rows||[]).map(function(row,rIdx){
              return <tr key={"vsrd_"+rIdx}>{(row||[]).map(function(cell,cIdx){
                var cellOverlay=shOverlay[rIdx]&&shOverlay[rIdx][cIdx]!==undefined?shOverlay[rIdx][cIdx]:null;
                var displayVal=cellOverlay!==null?cellOverlay:(cell==null?"":String(cell));
                var isQtyHighlight=cellOverlay!==null&&cellOverlay!=="";
                return <td key={"vsrdc_"+rIdx+"_"+cIdx} style={Object.assign({},S.td,{whiteSpace:"pre-wrap",verticalAlign:"top",fontSize:11.5,padding:"4px 6px",background:isQtyHighlight?"rgba(34,197,94,0.18)":undefined,fontFamily:isQtyHighlight?"monospace":undefined,fontWeight:isQtyHighlight?700:undefined,color:isQtyHighlight?"#166534":undefined})}>{displayVal}</td>;
              })}</tr>;
            })}
          </tbody></table></div>;
        })()}
      </Fragment>):(
      <div style={Object.assign({},S.tw,{maxHeight:"55vh"})}><table style={S.tbl}><thead><tr><th style={S.th}>{itemHeader}</th><th style={S.th}>UNIT</th><th style={Object.assign({},S.th,{textAlign:"center"})}>{qtyHeader||"Qty"}</th><th style={S.th}>{noteHeader||"Note"}</th></tr></thead><tbody>
        {vendorStoreDialogDisplayRows.map(function(entry){
          if(entry.type==="heading"){
            return <tr key={entry.key}><td colSpan={4} style={Object.assign({},S.td,{fontWeight:700,color:"#0F172A",background:"rgba(226,232,240,.42)"})}>{entry.text}</td></tr>;
          }
          var row=entry.row;
          return <tr key={entry.key}><td style={Object.assign({},S.td,{fontWeight:500})}>{row.name||""}</td><td style={S.td}>{row.unit||""}</td><td style={Object.assign({},S.td,{textAlign:"center"})}>{vendorStoreDialogEditing?<input style={S.ie} type="text" inputMode="numeric" pattern="[0-9]*" value={vendorStoreDialogQty[row.code]||0} onChange={function(e){var v=Math.max(0,parseInt(e.target.value,10)||0);setVendorStoreDialogQty(function(prev){var n=Object.assign({},prev);n[row.code]=v;return n;});}} disabled={savingVendorStoreDialog}/>:<span style={{fontFamily:"monospace"}}>{row.qtyDisplay||""}</span>}</td><td style={S.td}>{vendorStoreDialogEditing?<input style={Object.assign({},S.inp,{padding:"5px 8px",fontSize:11.5})} value={vendorStoreDialogNotes[row.code]||""} onChange={function(e){var v=e.target.value;setVendorStoreDialogNotes(function(prev){var n=Object.assign({},prev);n[row.code]=v;return n;});}} disabled={savingVendorStoreDialog} placeholder="note"/>:(row.note||"-")}</td></tr>;
        })}
      </tbody></table></div>)}
      <div style={S.mA}><button style={Object.assign({},S.b,S.bS)} onClick={closeVendorStoreDialog} disabled={savingVendorStoreDialog}>Close</button>{vendorStoreDialogEditing&&<button style={Object.assign({},S.b,S.bP)} onClick={saveVendorStoreDialog} disabled={savingVendorStoreDialog}>{savingVendorStoreDialog?"Saving...":"Save"}</button>}</div>
    </div></div>)}
  </div>);
}
function SupplierOrders({orders,setOrders,items,aot,manualOpenOrder,manualOpenSeq,manualOpenLeaves,toast,stores,suppliers,categoryTemplates,activeVendorOrderIds,vendorOrderConfigs}){
  var _v=useState(aot||"A"),vt=_v[0],sVt=_v[1];
  var _cat=useState("vegetables"),selCategory=_cat[0],setSelCategory=_cat[1];
  var _vk=useState(null),selectedVendorKey=_vk[0],setSelectedVendorKey=_vk[1];
  var _sent=useState({}),sent=_sent[0],sSent=_sent[1];
  var _sending=useState({}),sending=_sending[0],sSending=_sending[1];
  var _downloading=useState({}),downloading=_downloading[0],setDownloading=_downloading[1];
  var _previewLoading=useState({}),previewLoading=_previewLoading[0],setPreviewLoading=_previewLoading[1];
  var _preview=useState(null),previewSheet=_preview[0],setPreviewSheet=_preview[1];
  var _hist=useState([]),history=_hist[0],setHistory=_hist[1];
  var _vm=useState("individual"),vendorSendMode=_vm[0],setVendorSendMode=_vm[1];
  var resolvedVendorKey=normalizeVendorKey(selCategory,selectedVendorKey);
  var activeTemplate=getTemplateForCategory(categoryTemplates,selCategory,resolvedVendorKey);
  var templateHeaders=activeTemplate&&activeTemplate.uiHeaders?activeTemplate.uiHeaders:null;
  var itemHeader=selCategory==="vendor_orders"&&templateHeaders&&templateHeaders.item?templateHeaders.item:"Item";
  var totalHeader=selCategory==="vendor_orders"&&templateHeaders&&templateHeaders.total?templateHeaders.total:"Total Qty";
  var currentType=selCategory==="vendor_orders"?"VENDOR":vt;
  var dk=dateKey(currentType,selCategory,resolvedVendorKey,manualOpenOrder,manualOpenSeq,getVendorSeqFromConfigs(vendorOrderConfigs,resolvedVendorKey));

  useEffect(function(){
    let cancelled=false;
    apiClient.supplierOrders.getAll().then(h=>{if(!cancelled) setHistory(h||[]);}).catch(()=>{});
    return ()=>{cancelled=true;};
  },[]);
  // Compute totals per item across all stores
  const allSuppliersForCategory = suppliersForCategory(suppliers,selCategory);
  var preferredVendorIds=normalizeVendorOrderList(activeVendorOrderIds);
  var preferredVendorIdsKey=preferredVendorIds.join("|");
  const supList = selCategory==="vendor_orders"
    ? allSuppliersForCategory.filter(function(v){return preferredVendorIds.indexOf(String(v&&v.id||""))>=0;})
    : allSuppliersForCategory;
  useEffect(function(){
    if(selCategory==="vendor_orders"){
      return;
    }else if(selectedVendorKey){
      setSelectedVendorKey(null);
    }
  },[selCategory,selectedVendorKey]);
  useEffect(function(){
    if(selCategory!=="vendor_orders") return;
    if(selectedVendorKey) return;
    if(preferredVendorIds.length===1){
      setSelectedVendorKey(preferredVendorIds[0]);
    }
  },[selCategory,selectedVendorKey,preferredVendorIdsKey]);
  useEffect(function(){
    if(selCategory!=="vendor_orders") return;
    if(!selectedVendorKey) return;
    if(preferredVendorIds.indexOf(String(selectedVendorKey||""))>=0) return;
    setSelectedVendorKey(null);
  },[selCategory,selectedVendorKey,preferredVendorIdsKey]);
  const itemList = Array.isArray(items) ? items.filter(function(it){return normalizeCategory(it.category)===normalizeCategory(selCategory)&&normalizeVendorKey(selCategory,it.vendorKey)===resolvedVendorKey;}) : [];
  var totals=useMemo(function(){var t={};itemList.forEach(function(it){var sum=0;stores.forEach(function(st){var k=st.id+"_"+dk;sum+=(orders[k]&&orders[k].items?orders[k].items[it.code]:0)||0;});if(sum>0)t[it.code]=sum;});return t;},[itemList,stores,orders,dk]);
  // Group by supplier
  var supplierGroups=useMemo(function(){return supList.map(function(sup){var supItems=itemList.filter(function(it){return (sup.items||[]).indexOf(it.code)>=0&&totals[it.code]>0;});return{supplier:sup,items:supItems};}).filter(function(g){return g.items.length>0;});},[supList,itemList,totals]);
  // Unassigned items
  var assigned={};supList.forEach(function(s){(s.items||[]).forEach(function(c){assigned[c]=true;});});
  var unassigned=itemList.filter(function(it){return totals[it.code]>0&&!assigned[it.code];});

  var sendEmail=function(sup,supItems){
    var recipients=supplierEmailsArray(sup);
    if(!recipients.length){toast("Supplier email missing",true);return;}
    var subject="Purchase Order - "+(selCategory==="vendor_orders"?"Vendor Orders":"Order "+vt)+" - "+new Date().toLocaleDateString();
    var body="Dear "+sup.name+",\n\nPlease find our order details below:\n\n";
    supItems.forEach(function(it){body+=it.name+" ("+it.code+") - Qty: "+totals[it.code]+"\n";});
    body+="\nThank you.";
    var mailto="mailto:"+encodeURIComponent(recipients.join(","))+"?subject="+encodeURIComponent(subject)+"&body="+encodeURIComponent(body);
    var a=document.createElement("a");a.href=mailto;a.click();
    sSent(function(p){var n=Object.assign({},p);n[sup.id+"_"+currentType+"_"+selCategory]=true;return n;});
    toast("Opening email for "+sup.name+" ("+recipients.join(", ")+")");
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
      toast((selCategory==="vendor_orders"?"Vendor orders":"Order "+vt)+" marked processed for all stores");
    }catch(e){toast(e.message,true);}  };
  var allSent=supplierGroups.every(function(g){return sent[g.supplier.id+"_"+currentType+"_"+selCategory];});
  var downloadExcelForHistory=async function(r){
    if(!r||!r._id){toast("Missing supplier order record id",true);return;}
    if(!r.hasExcel){toast("Excel file not available for this record",true);return;}
    var key=String(r._id);
    var fallbackName="consolidated-order-"+String(r.type||"X")+"-"+String(r.week||"").replace(/[^A-Za-z0-9_-]/g,"_")+".xlsx";
    try{
      setDownloading(function(prev){var n=Object.assign({},prev);n[key]=true;return n;});
      await apiClient.supplierOrders.downloadExcel(r._id, r.excelFilename || fallbackName);
      toast("Downloaded Excel for "+(r.supplierName||"supplier"));
    }catch(e){toast(e.message||"Failed to download Excel",true);}
    finally{
      setDownloading(function(prev){var n=Object.assign({},prev);delete n[key];return n;});
    }
  };
  var printExcelForHistory=async function(r){
    var printWindow;
    try{
      if(!r||!r._id){toast("Missing supplier order record id",true);return;}
      if(!r.hasExcel){toast("Excel file not available for this record",true);return;}
      printWindow=openPendingPrintWindow("Preparing document...");
      var resp=await apiClient.supplierOrders.previewExcel(r._id);
      await printSheetSections((r.excelFilename||r.supplierName||"supplier-order"),[{name:resp&&resp.sheetName?resp.sheetName:"Sheet1",rows:normalizePreviewRows(resp&&resp.rows)}],printWindow);
      toast("Print dialog opened");
    }catch(e){
      if(printWindow&&!printWindow.closed) printWindow.close();
      toast(e.message||"Failed to print document",true);
    }
  };
  var openSheetPreviewForHistory=async function(r){
    if(!r||!r._id){toast("Missing supplier order record id",true);return;}
    if(!r.hasExcel){toast("Excel file not available for this record",true);return;}
    var key=String(r._id);
    try{
      setPreviewLoading(function(prev){var n=Object.assign({},prev);n[key]=true;return n;});
      var resp=await apiClient.supplierOrders.previewExcel(r._id);
      setPreviewSheet({
        record:r,
        sheetName:resp&&resp.sheetName?resp.sheetName:"Sheet1",
        rows:normalizePreviewRows(resp&&resp.rows),
      });
    }catch(e){toast(e.message||"Failed to load sheet preview",true);}
    finally{setPreviewLoading(function(prev){var n=Object.assign({},prev);delete n[key];return n;});}
  };
  var selectedVendor=supList.find(function(v){return v.id===resolvedVendorKey;})||null;
  var historySections=[
    {id:"vegetables",title:"Vegetable Orders"},
    {id:"leaves",title:"Leaves Orders"},
    {id:"vendor_orders",title:"Vendor Orders"},
  ];
  var vendorStoreDocs=useMemo(function(){
    if(selCategory!=="vendor_orders"||!resolvedVendorKey) return [];
    return (stores||[]).map(function(st){
      var order=getCurrentOrderForStoreType(orders,st.id,currentType,selCategory,resolvedVendorKey,manualOpenOrder,manualOpenSeq,getVendorSeqFromConfigs(vendorOrderConfigs,resolvedVendorKey));
      var hasVisible=!!(order&&["submitted","draft_shared","processed"].indexOf(String(order.status||""))>=0);
      var lineCount=order?Object.keys(Object.assign({},order.items||{},order.notes||{})).filter(function(code){return normalizeOrderItemEntry((order.items||{})[code]).qty>0||String((order.notes||{})[code]||"").trim();}).length:0;
      return {store:st,order:order,lineCount:lineCount,ready:hasVisible&&lineCount>0};
    }).filter(function(row){return row.ready;});
  },[stores,orders,currentType,selCategory,resolvedVendorKey,manualOpenOrder,manualOpenSeq,vendorOrderConfigs]);
  var vendorPendingCount=useMemo(function(){
    if(selCategory!=="vendor_orders"||!resolvedVendorKey) return 0;
    return (stores||[]).filter(function(st){
      var order=getCurrentOrderForStoreType(orders,st.id,currentType,selCategory,resolvedVendorKey,manualOpenOrder,manualOpenSeq,getVendorSeqFromConfigs(vendorOrderConfigs,resolvedVendorKey));
      return !(order&&["submitted","draft_shared","processed"].indexOf(String(order.status||""))>=0);
    }).length;
  },[stores,orders,currentType,selCategory,resolvedVendorKey,manualOpenOrder,manualOpenSeq,vendorOrderConfigs]);
  var vendorHistorySent=useMemo(function(){
    if(selCategory!=="vendor_orders"||!resolvedVendorKey) return false;
    return (history||[]).some(function(r){
      return normalizeCategory(r.category||"vegetables")==="vendor_orders"
        && String(r.vendorKey||"")===String(resolvedVendorKey||"")
        && String(r.type||"")===String(currentType||"")
        && String(r.week||"")===String(dk.endsWith("-"+currentType+"-"+categoryKey(selCategory,resolvedVendorKey))?dk.slice(0,dk.length-("-"+currentType+"-"+categoryKey(selCategory,resolvedVendorKey)).length):dk);
    });
  },[history,selCategory,resolvedVendorKey,currentType,dk]);
  var downloadVendorStoreDocument=async function(row){
    if(!row||!row.order||!row.store){toast("Store document not available",true);return;}
    try{
      var key=String(row.store.id||"");
      setDownloading(function(prev){var n=Object.assign({},prev);n[key]=true;return n;});
      var rowCodes=Object.keys(Object.assign({},row.order.items||{},row.order.notes||{}));
      var rowItems=(items||[]).filter(function(it){return rowCodes.indexOf(it.code)>=0;});
      var itemDetailsByCode=buildOrderItemDetails(rowCodes,rowItems,items,activeTemplate);
      var itemNamesByCode={};
      Object.keys(itemDetailsByCode).forEach(function(code){itemNamesByCode[code]=itemDetailsByCode[code].name;});
      var resp=await apiClient.orders.storeOrderExcelPreview(currentType,selCategory,resolvedVendorKey,row.order.items||{},row.order.notes||{},row.store.id,row.order.date||new Date().toISOString(),itemNamesByCode,itemDetailsByCode);
      downloadBase64File(resp&&((resp.fileBase64)||(resp.excelBase64)),resp&&resp.filename,resp&&resp.contentType);
      toast("Document downloaded for "+(row.store.name||row.store.id));
    }catch(e){toast(e.message||"Failed to download document",true);}
    finally{
      setDownloading(function(prev){var n=Object.assign({},prev);delete n[String(row.store.id||"")];return n;});
    }
  };
  var printVendorStoreHistoryDocument=async function(row){
    var printWindow;
    try{
      if(!row||!row.order||!row.store){toast("Store document not available",true);return;}
      printWindow=openPendingPrintWindow("Preparing document...");
      var rowCodes=Object.keys(Object.assign({},row.order.items||{},row.order.notes||{}));
      var rowItems=(items||[]).filter(function(it){return rowCodes.indexOf(it.code)>=0;});
      var itemDetailsByCode=buildOrderItemDetails(rowCodes,rowItems,items,activeTemplate);
      var itemNamesByCode={};
      Object.keys(itemDetailsByCode).forEach(function(code){itemNamesByCode[code]=itemDetailsByCode[code].name;});
      var resp=await apiClient.orders.storeOrderExcelPreview(currentType,selCategory,resolvedVendorKey,row.order.items||{},row.order.notes||{},row.store.id,row.order.date||new Date().toISOString(),itemNamesByCode,itemDetailsByCode);
      await printBase64File(resp&&((resp.fileBase64)||(resp.excelBase64)),resp&&resp.filename,resp&&resp.contentType,printWindow);
      toast("Print dialog opened");
    }catch(e){
      if(printWindow&&!printWindow.closed) printWindow.close();
      toast(e.message||"Failed to print document",true);
    }
  };
  var sendVendorIndividualDocs=async function(){
    if(!selectedVendor){toast("Select a vendor first",true);return;}
    var recipients=supplierEmailsArray(selectedVendor);
    if(!recipients.length){toast("Vendor email missing",true);return;}
    try{
      sSending(function(prev){var n=Object.assign({},prev);n.vendorIndividual=true;return n;});
      await apiClient.orders.emailVendorIndividual(selectedVendor.id,recipients,selectedVendor.name);
      sSent(function(prev){var n=Object.assign({},prev);n["vendorIndividual_"+selectedVendor.id]=true;return n;});
      var h=await apiClient.supplierOrders.getAll();
      setHistory(h||[]);
      toast("Individual store documents sent to "+selectedVendor.name);
    }catch(e){toast(e.message||"Failed to send vendor documents",true);}
    finally{
      sSending(function(prev){var n=Object.assign({},prev);delete n.vendorIndividual;return n;});
    }
  };

  return(<div>
    {history.length>0&&(<div style={Object.assign({},S.card,{marginBottom:12})}>
      <div style={S.cH}><div><div style={S.t}>Sent Supplier Orders</div><div style={S.d}>{history.length} records</div></div></div>
      {historySections.map(function(section){
        var rows=history.filter(function(r){return normalizeCategory(r.category||"vegetables")===section.id;});
        return (<div key={section.id} style={{marginTop:10}}>
          <div style={{fontSize:13,fontWeight:700,color:"#0F172A",marginBottom:6}}>{section.title} ({rows.length})</div>
          {rows.length===0?<div style={{textAlign:"center",padding:14,color:"#6B7186",border:"1px solid rgba(148,163,184,.24)",borderRadius:10}}>No sent records</div>:
          <div style={S.tw}><table style={S.tbl}><thead><tr><th style={S.th}>Date</th><th style={S.th}>Type</th><th style={S.th}>Supplier</th><th style={S.th}>Email</th><th style={S.th}>Week</th><th style={S.th}>Excel</th><th style={S.th}>Actions</th></tr></thead><tbody>
            {rows.map(function(r){
              var key=String((r&&r._id)||r.sentAt||"");
              var isDownloading=!!downloading[key];
              var isPreviewLoading=!!previewLoading[key];
              return(<tr key={key}><td style={S.tm}>{new Date(r.sentAt).toLocaleString()}</td><td style={S.td}>{r.type}</td><td style={S.td}>{r.supplierName}</td><td style={S.tm}>{r.email}</td><td style={S.tm}>{r.week}</td><td style={S.td}>{r.hasExcel?<span style={Object.assign({},S.bg,S.bgG)}>Available</span>:<span style={Object.assign({},S.bg,S.bgY)}>Not stored</span>}</td><td style={S.td}>{r.hasExcel?<div style={{display:"flex",gap:6,flexWrap:"wrap"}}><button style={Object.assign({},S.b,S.bS,{padding:"3px 8px",fontSize:10})} onClick={function(){openSheetPreviewForHistory(r);}} disabled={isPreviewLoading}>{isPreviewLoading?"Loading...":"View Sheet"}</button><button style={Object.assign({},S.b,S.bS,{padding:"3px 8px",fontSize:10})} onClick={function(){downloadExcelForHistory(r);}} disabled={isDownloading}>{isDownloading?"Downloading...":"Download Excel"}</button><button style={Object.assign({},S.b,S.bS,{padding:"3px 8px",fontSize:10})} onClick={function(){printExcelForHistory(r);}}>Print</button></div>:null}</td></tr>);
            })}
          </tbody></table></div>}
        </div>);
      })}
    </div>)}
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:6,marginBottom:14}}>
      <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"flex-start"}}>
        <OrderDrawerNav
          selCategory={selCategory}
          setSelCategory={setSelCategory}
          orderType={vt}
          setOrderType={sVt}
          getCategoryDisabled={function(catId){return catId==="vendor_orders"?preferredVendorIds.length===0:!isCategoryOpenForType(catId,vt,aot||vt,manualOpenLeaves);}}
          getOrderTypeDisabled={function(){return false;}}
        />
        {selCategory==="vendor_orders"&&<select style={Object.assign({},S.inp,{width:220})} value={selectedVendorKey||""} onChange={function(e){setSelectedVendorKey(e.target.value||null);}}><option value="">Select vendor</option>{supList.map(function(v){return <option key={v.id} value={v.id}>{v.name}</option>;})}</select>}
      </div>
      {allSent&&supplierGroups.length>0&&<button style={Object.assign({},S.b,S.bG)} onClick={processOrder}>Mark All Processed</button>}
    </div>
    {selCategory==="vendor_orders"&&(
      <div>
        <div style={S.nI}>Vendor supplier sending now runs from Consolidated {" > "} Vendors. Use this page only to review store documents and past send history.</div>
        <div style={Object.assign({},S.card,{marginBottom:12})}>
          <div style={S.cH}>
            <div>
              <div style={S.t}>{selectedVendor?(selectedVendor.name+" - Individual Store Documents"):"Vendor Documents"}</div>
              <div style={S.d}>{vendorStoreDocs.length} ready store document(s){vendorPendingCount>0?(" | "+vendorPendingCount+" store(s) still pending submission"):""}</div>
            </div>
            <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
              {(vendorHistorySent||sent["vendorIndividual_"+(selectedVendor&&selectedVendor.id||"")])&&<span style={Object.assign({},S.bg,S.bgG)}>Sent</span>}
              {(vendorHistorySent||sent["vendorIndividual_"+(selectedVendor&&selectedVendor.id||"")])&&vendorStoreDocs.length>0&&<button style={Object.assign({},S.b,S.bG)} onClick={processOrder}>Mark All Processed</button>}
            </div>
          </div>
          {vendorStoreDocs.length===0?<div style={{textAlign:"center",padding:24,color:"#6B7186"}}>{selectedVendor?"No submitted store documents ready for this vendor yet.":"Select a vendor to see store documents."}</div>:
          <div style={S.tw}><table style={S.tbl}><thead><tr><th style={S.th}>Store</th><th style={S.th}>Status</th><th style={S.th}>Lines</th><th style={S.th}>Document</th></tr></thead><tbody>
            {vendorStoreDocs.map(function(row){
              var dKey=String(row.store.id||"");
              return <tr key={dKey}><td style={Object.assign({},S.td,{fontWeight:500})}>{row.store.name||row.store.id}</td><td style={S.td}><span style={Object.assign({},S.bg,String(row.order.status||"")==="processed"?S.bgP:S.bgG)}>{row.order.status}</span></td><td style={Object.assign({},S.td,{textAlign:"center",fontFamily:"monospace"})}>{row.lineCount}</td><td style={S.td}><div style={{display:"flex",gap:4,flexWrap:"wrap"}}><button style={Object.assign({},S.b,S.bS,{padding:"3px 8px",fontSize:10.5})} onClick={function(){downloadVendorStoreDocument(row);}} disabled={!!downloading[dKey]}>{downloading[dKey]?"Downloading...":"Download Document"}</button><button style={Object.assign({},S.b,S.bS,{padding:"3px 8px",fontSize:10.5})} onClick={function(){printVendorStoreHistoryDocument(row);}}>Print</button></div></td></tr>;
            })}
          </tbody></table></div>}
        </div>
      </div>
    )}
    {selCategory!=="vendor_orders"&&<div style={S.nI}>{selCategory==="vendor_orders"?(CATEGORY_LABELS[selCategory]+" by supplier. Send emails, then mark as processed."):(""+CATEGORY_LABELS[selCategory]+" Order "+vt+" by supplier. Send emails, then mark as processed.")}</div>}
    {selCategory!=="vendor_orders"&&supplierGroups.length===0&&<div style={S.card}><div style={{textAlign:"center",padding:30,color:"#6B7186"}}>No order data for {selCategory==="vendor_orders"?CATEGORY_LABELS[selCategory]:(CATEGORY_LABELS[selCategory]+" Order "+vt)}. Submit orders first.</div></div>}
    {selCategory!=="vendor_orders"&&supplierGroups.map(function(g){
      var isSent=sent[g.supplier.id+"_"+currentType+"_"+selCategory];
      return(<div key={g.supplier.id} style={Object.assign({},S.card,{border:isSent?"1px solid rgba(52,211,153,0.3)":"1px solid rgba(148,163,184,.24)"})}>
        <div style={S.cH}>
          <div><div style={S.t}>{g.supplier.name}</div><div style={S.d}>{supplierEmailsText(g.supplier)} | {g.supplier.phone}</div></div>
          <div style={{display:"flex",gap:5,alignItems:"center"}}>
            {isSent?<span style={Object.assign({},S.bg,S.bgG)}>Email Sent</span>
            :<button style={Object.assign({},S.b,S.bP)} onClick={function(){sendEmail(g.supplier,g.items);}}><Ic type="mail" size={13}/>Send Email</button>}
          </div>
        </div>
        <div style={S.tw}><table style={S.tbl}><thead><tr><th style={S.th}>Code</th><th style={S.th}>{itemHeader}</th><th style={S.th}>Category</th><th style={S.th}>Unit</th><th style={Object.assign({},S.th,{textAlign:"center"})}>{totalHeader}</th>
          {stores.map(function(st){return <th key={st.id} style={Object.assign({},S.th,{textAlign:"center",fontSize:9})}>{st.name.split(" ")[0]}</th>;})}</tr></thead>
          <tbody>{g.items.map(function(it){return(<tr key={it.code}><td style={S.tm}>{it.code}</td><td style={Object.assign({},S.td,{fontWeight:500})}>{it.name}</td><td style={Object.assign({},S.td,{color:"#64748B"})}>{it.category}</td><td style={Object.assign({},S.td,{color:"#64748B"})}>{it.unit}</td>
            <td style={Object.assign({},S.td,{textAlign:"center",fontFamily:"monospace",fontWeight:700,color:"#166534"})}>{totals[it.code]}</td>
            {stores.map(function(st){var k=st.id+"_"+dk;var q=orders[k]&&orders[k].items?orders[k].items[it.code]||0:0;return <td key={st.id} style={Object.assign({},S.td,{textAlign:"center",fontFamily:"monospace",fontSize:11,color:q>0?"#0F172A":"#64748B"})}>{q}</td>;})}
          </tr>);})}</tbody></table></div>
      </div>);
    })}
    {selCategory!=="vendor_orders"&&unassigned.length>0&&(<div style={Object.assign({},S.card,{borderColor:"rgba(248,113,113,0.3)"})}><div style={S.cH}><div><div style={Object.assign({},S.t,{color:"#F87171"})}>Unassigned Items</div><div style={S.d}>These items are not mapped to any supplier.</div></div></div>
      <div style={S.tw}><table style={S.tbl}><thead><tr><th style={S.th}>Code</th><th style={S.th}>Item</th><th style={Object.assign({},S.th,{textAlign:"center"})}>Total Qty</th></tr></thead><tbody>
        {unassigned.map(function(it){return <tr key={it.code}><td style={S.tm}>{it.code}</td><td style={S.td}>{it.name}</td><td style={Object.assign({},S.td,{textAlign:"center",fontFamily:"monospace",fontWeight:700})}>{totals[it.code]}</td></tr>;})}</tbody></table></div></div>)}
    {previewSheet&&(<div style={S.ov} onClick={function(){setPreviewSheet(null);}}><div style={Object.assign({},S.mo,S.mW)} onClick={function(e){e.stopPropagation();}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:8}}>Stored Sheet Preview - {previewSheet.record&&previewSheet.record.supplierName?previewSheet.record.supplierName:"Supplier"}</div>
      <div style={{fontSize:12,color:"#64748B",marginBottom:10}}>{previewSheet.record&&previewSheet.record.week?"Week: "+previewSheet.record.week+" | ":""}{previewSheet.sheetName?"Sheet: "+previewSheet.sheetName:""}</div>
      <ExcelSheetPreviewTable rows={previewSheet.rows} maxHeight={420}/>
      <div style={S.mA}><button style={Object.assign({},S.b,S.bS)} onClick={function(){setPreviewSheet(null);}}>Close</button></div>
    </div></div>)}
  </div>);
}

/* ═══ ITEM MASTER (no category rows) ═══ */
function ItemMaster({items,setItems,toast,suppliers,categoryTemplates,setCategoryTemplates,user}){
  var _a=useState(false),shA=_a[0],sA=_a[1];var _u=useState(false),shU=_u[0],sU=_u[1];
  var isWarehouseUser=isWarehouseRole(user);
  var itemMasterCategories=isWarehouseUser?[{id:"vendor_orders",label:"Vendor Orders"}]:ORDER_CATEGORIES;
  var defaultItemMasterCategory=isWarehouseUser?"vendor_orders":"vegetables";
  var _n=useState({code:"",name:"",category:defaultItemMasterCategory,unit:""}),nI=_n[0],sNI=_n[1];
  var _s=useState(""),sr=_s[0],sSr=_s[1];var _c=useState(null),csv=_c[0],sC=_c[1];var _m=useState("merge"),md=_m[0],sMd=_m[1];
  var _sc=useState(defaultItemMasterCategory),selCategory=_sc[0],setSelCategory=_sc[1];
  var _uc=useState(defaultItemMasterCategory),uploadCategory=_uc[0],setUploadCategory=_uc[1];
  var _sv=useState(null),selectedVendorKey=_sv[0],setSelectedVendorKey=_sv[1];
  var _uv=useState(null),uploadVendorKey=_uv[0],setUploadVendorKey=_uv[1];
  var _ut=useState(null),uploadTemplate=_ut[0],setUploadTemplate=_ut[1];
  var _rsi=useState(0),rawSheetIndex=_rsi[0],setRawSheetIndex=_rsi[1];
  var _rvm=useState(false),showRawViewModal=_rvm[0],setShowRawViewModal=_rvm[1];
  var fR=useRef(null);
  var vendorOptions=Array.isArray(suppliers)?suppliers:[];
  useEffect(function(){
    if(!isWarehouseUser) return;
    if(selCategory!=="vendor_orders") setSelCategory("vendor_orders");
    if(uploadCategory!=="vendor_orders") setUploadCategory("vendor_orders");
    if(nI.category!=="vendor_orders") sNI(function(prev){return Object.assign({},prev,{category:"vendor_orders"});});
  },[isWarehouseUser,selCategory,uploadCategory,nI.category]);
  useEffect(function(){
    if(selCategory==="vendor_orders"){
      return;
    }else{
      if(selectedVendorKey) setSelectedVendorKey(null);
      if(uploadVendorKey) setUploadVendorKey(null);
    }
  },[selCategory,selectedVendorKey,uploadVendorKey]);
  var resolvedVendorKey=normalizeVendorKey(selCategory,selectedVendorKey);
  var activeTemplate=getTemplateForCategory(categoryTemplates,selCategory,resolvedVendorKey);
  var activeRawGrid=normalizeRawGridTemplate(activeTemplate&&activeTemplate.rawGrid?activeTemplate.rawGrid:null);
  var activeRawSheets=activeRawGrid&&Array.isArray(activeRawGrid.sheets)?activeRawGrid.sheets:[];
  var activeRawSheet=activeRawSheets.length?activeRawSheets[Math.min(Math.max(0,rawSheetIndex),activeRawSheets.length-1)]:null;
  useEffect(function(){
    setRawSheetIndex(0);
  },[selCategory,resolvedVendorKey,activeRawSheets.length]);
  var fl=items.filter(function(it){var q=sr.toLowerCase();var cat=normalizeCategory(it.category);var vendor=normalizeVendorKey(cat,it.vendorKey);var displayCode=buildItemMasterCode(it.name,it.unit).toLowerCase();return cat===selCategory&&vendor===resolvedVendorKey&&(it.name.toLowerCase().indexOf(q)>=0||displayCode.indexOf(q)>=0||it.code.toLowerCase().indexOf(q)>=0||cat.toLowerCase().indexOf(q)>=0);});
  var sorted=useMemo(function(){
    if(selCategory==="vendor_orders"){
      return orderRowsByTemplate(activeTemplate,fl);
    }
    if(selCategory==="vegetables"){
      return sortItemsAlphabetical(fl);
    }
    return sortItems(fl);
  },[fl,activeTemplate,selCategory]);
  var displayRows=useMemo(function(){return buildTemplateDisplayRows(activeTemplate,sorted);},[activeTemplate,sorted]);
  var uploadPreviewRows=useMemo(function(){
    if(!uploadTemplate||!csv) return [];
    return buildTemplateDisplayRows(uploadTemplate,csv);
  },[uploadTemplate,csv]);
  var add=async function(){
      var generatedCode=buildItemMasterCode(nI.name,nI.unit);
      if(!generatedCode||!nI.name){toast("Name required",true);return;}
      if(items.find(function(i){return String(i.code||"").trim().toLowerCase()===generatedCode.toLowerCase();})){toast("Code exists",true);return;}
      try{
        await apiClient.items.create(Object.assign({},nI,{code:generatedCode,category:normalizeCategory(nI.category||selCategory),vendorKey:normalizeVendorKey(nI.category||selCategory,selectedVendorKey)}));
        // reload
        const all = await apiClient.items.getAll();
        setItems(sortItems(all));
        sNI({code:"",name:"",category:selCategory,unit:""});sA(false);toast("Item added");
      }catch(e){toast(e.message,true);}    };
  var rm=async function(c){
      try{
        await apiClient.items.delete(c);
        const all = await apiClient.items.getAll();
        setItems(sortItems(all));
        toast("Removed");
      }catch(e){toast(e.message,true);}    };
  var hF=function(e){var f=e.target.files&&e.target.files[0];if(!f)return;var name=f.name||"";var ext=name.split(".").pop().toLowerCase();
    if(uploadCategory==="vendor_orders"&&!uploadVendorKey){
      toast("Select vendor before uploading vendor order items",true);
      e.target.value="";
      return;
    }
    if(ext==="csv"||ext==="txt"){
      var r=new FileReader();
      r.onload=function(ev){var p=parseCSV(ev.target.result,uploadCategory);if(!p.length){toast("Could not parse CSV",true);return;}sC(p.map(function(it){return Object.assign({},it,{category:uploadCategory,vendorKey:normalizeVendorKey(uploadCategory,uploadVendorKey)});}));setUploadTemplate(null);sU(true);};
      r.readAsText(f);
    }else if(ext==="xls"||ext==="xlsx"){
      var r=new FileReader();
      r.onload=function(ev){
        try{
          var data=new Uint8Array(ev.target.result);
          var wb=XLSX.read(data,{type:'array'});
          var originalFile=(ext==="xlsx")?{filename:name,contentType:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",base64:XLSX.write(wb,{bookType:"xlsx",type:"base64"})}:null;
          var rawGridTemplate=buildRawGridTemplateFromWorkbook(wb,name,originalFile);
          var sheetNames=Array.isArray(wb.SheetNames)?wb.SheetNames:[];
          if(!sheetNames.length){toast("No sheets found in Excel file",true);return;}
          if(uploadCategory==="vegetables"){
            var allParsed=[];
            sheetNames.forEach(function(sn){
              var ws=wb.Sheets[sn];
              if(!ws) return;
              var rows=worksheetToRows(ws);
              if(rows.length<2) return;
              var parsed=parseItemSheetRows(rows,uploadCategory)||[];
              parsed.forEach(function(it){allParsed.push(it);});
            });
            if(allParsed.length===0){toast("No valid item rows in Excel file",true);return;}
            sC(allParsed.map(function(it,idx){return Object.assign({},it,{sortOrder:idx,vendorKey:normalizeVendorKey(uploadCategory,uploadVendorKey)});}));
            setUploadTemplate(null);
            sU(true);
          }else{
            var parsedSheets=[];
            var looseItems=[];
            var looseOrder=0;
            sheetNames.forEach(function(sn){
              var ws=wb.Sheets[sn];
              if(!ws) return;
              var rows=worksheetToRows(ws);
              if(rows.length<2) return;
              var parsedTemplate=parseTemplateItemSheet(rows,uploadCategory,uploadVendorKey,name,sn,originalFile);
              if(parsedTemplate&&parsedTemplate.items&&parsedTemplate.items.length){
                parsedSheets.push(parsedTemplate);
              }else{
                var loose=parseLooseSheetItems(rows,uploadCategory,uploadVendorKey,sn,looseOrder);
                looseOrder=loose.nextOrder;
                if(loose.items&&loose.items.length){
                  loose.items.forEach(function(it){looseItems.push(it);});
                }
              }
            });
            if(!parsedSheets.length&&looseItems.length===0){toast("Could not read item rows from Excel file",true);return;}
            var mergedParsed=parsedSheets.length?mergeParsedTemplateSheets(parsedSheets,uploadCategory,uploadVendorKey,name,originalFile):null;
            var mergedItems=mergedParsed&&Array.isArray(mergedParsed.items)?mergedParsed.items.slice():[];
            var usedCodes={};
            mergedItems.forEach(function(it){
              var code=String(it&&it.code||"").trim();
              if(code) usedCodes[code]=true;
            });
            looseItems.forEach(function(it){
              var baseCode=String(it&&it.code||"").trim();
              if(!baseCode) return;
              var finalCode=baseCode;
              if(usedCodes[finalCode]) finalCode=finalCode+"__L"+String(mergedItems.length+1);
              while(usedCodes[finalCode]) finalCode=finalCode+"_x";
              usedCodes[finalCode]=true;
              mergedItems.push(Object.assign({},it,{code:finalCode}));
            });
            if(!mergedItems.length){toast("Could not detect item rows in Excel file",true);return;}
            var uploadTpl=mergedParsed&&mergedParsed.template
              ?Object.assign({},mergedParsed.template,{rawGrid:rawGridTemplate&&rawGridTemplate.rawGrid?rawGridTemplate.rawGrid:null,originalFile:originalFile||mergedParsed.template.originalFile||null})
              :(rawGridTemplate||null);
            if(uploadTpl&&looseItems.length){
              var nextOutline=Array.isArray(uploadTpl.outline)?uploadTpl.outline.slice():[];
              var looseHeading="";
              looseItems.forEach(function(it,idx){
                var finalItem=mergedItems[mergedItems.length-looseItems.length+idx];
                if(!finalItem) return;
                var heading=String(finalItem&&finalItem.subheading||"").trim();
                if(heading&&heading!==looseHeading){
                  nextOutline.push({type:"heading",text:heading,rowIndex:idx,colIndex:0});
                  looseHeading=heading;
                }
                nextOutline.push({type:"item",code:finalItem.code,name:finalItem.name,rowIndex:idx,colIndex:0});
              });
              uploadTpl=Object.assign({},uploadTpl,{outline:nextOutline});
            }
            sC(mergedItems.map(function(it,idx){return Object.assign({},it,{sortOrder:idx});}));
            setUploadTemplate(uploadTpl);
            sU(true);
          }
        }catch(err){console.error('Excel parse error',err);toast("Could not parse Excel file",true);}      };
      r.readAsArrayBuffer(f);
    }else if(ext==="docx"){
      if(uploadCategory!=="vendor_orders"||!uploadVendorKey){
        toast("Word templates are supported only for vendor orders with a selected vendor",true);
      }else{
        var r=new FileReader();
        r.onload=async function(ev){
          try{
            var result=String(ev.target.result||"");
            var base64=result.indexOf(",")>=0?result.split(",")[1]:result;
            var parsed=await apiClient.items.parseTemplate({
              filename:name,
              contentType:f.type||"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              base64:base64,
              category:uploadCategory,
              vendorKey:uploadVendorKey
            });
            if(!parsed||!parsed.items||!parsed.items.length||!parsed.template){
              toast("Could not detect order rows in Word file",true);
              return;
            }
            sC(parsed.items);
            setUploadTemplate(parsed.template);
            sU(true);
          }catch(err){console.error('Word parse error',err);toast(err.message||"Could not parse Word file",true);}
        };
        r.readAsDataURL(f);
      }
    }else{
      toast("Unsupported file type",true);
    }
    e.target.value="";};
  var cfU=async function(){
    if(!csv)return;
    if(uploadCategory==="vendor_orders"&&!uploadVendorKey){
      toast("Select vendor before confirming vendor order import",true);
      return;
    }
    try{
      await apiClient.items.bulkImport(csv,md,uploadCategory,uploadTemplate,uploadVendorKey);
      const results=await Promise.all([
        apiClient.items.getAll(),
        apiClient.settings.getAll(),
      ]);
      const all=results[0]||[];
      const settingsResp=results[1]||{};
      var nextTemplates=settingsResp.categoryTemplates&&typeof settingsResp.categoryTemplates==="object"?settingsResp.categoryTemplates:{};
      var repairedState=repairLoadedTemplatesAndItems(sortItems(all),nextTemplates);
      setItems(repairedState.items);
      if(setCategoryTemplates){
        nextTemplates=repairedState.categoryTemplates;
        if(uploadTemplate&&Object.keys(nextTemplates).length===0){
          var templateKey=normalizeVendorKey(uploadCategory,uploadVendorKey)?(normalizeCategory(uploadCategory)+":"+normalizeVendorKey(uploadCategory,uploadVendorKey)):normalizeCategory(uploadCategory);
          nextTemplates[templateKey]=uploadTemplate;
        }
        setCategoryTemplates(nextTemplates);
      }
      toast(md==="replace"?"Replaced "+csv.length+" "+CATEGORY_LABELS[uploadCategory].toLowerCase()+" items":"Merged "+csv.length+" "+CATEGORY_LABELS[uploadCategory].toLowerCase()+" items");
    }catch(e){
      toast(e.message,true);
    }
    sC(null);setUploadTemplate(null);sU(false);
  };
  return(<div><div style={S.card}>
    <div style={S.cH}>
      <div><div style={S.t}>Item Master</div><div style={S.d}>{sorted.length} items in {CATEGORY_LABELS[selCategory]}</div></div>
      <div style={{display:"flex",gap:5,alignItems:"center",flexWrap:"wrap"}}>
        <div style={S.tabs}>{itemMasterCategories.map(function(cat){return <button key={cat.id} style={Object.assign({},S.tab,selCategory===cat.id?S.tA:S.tI)} onClick={function(){setSelCategory(cat.id);setUploadCategory(cat.id);sNI(function(prev){return Object.assign({},prev,{category:cat.id});});}}>{cat.label}</button>;})}</div>
        {selCategory==="vendor_orders"&&<select style={Object.assign({},S.inp,{width:220})} value={selectedVendorKey||""} onChange={function(e){setSelectedVendorKey(e.target.value||null);setUploadVendorKey(e.target.value||null);}}><option value="">Select vendor</option>{vendorOptions.map(function(v){return <option key={v.id} value={v.id}>{v.name}</option>;})}</select>}
        <div style={S.sB}><Ic type="search" size={13}/><input style={S.sI} placeholder="Search..." value={sr} onChange={function(e){sSr(e.target.value);}}/></div>
        <button style={Object.assign({},S.b,S.bS)} onClick={function(){fR.current&&fR.current.click();}}>Upload CSV/Excel/Word</button>
        {activeRawSheets.length>0&&<button style={Object.assign({},S.b,S.bS)} onClick={function(){setShowRawViewModal(true);}}>View Uploaded Layout</button>}
        <button style={Object.assign({},S.b,S.bP)} onClick={function(){sNI(function(prev){return Object.assign({},prev,{category:selCategory});});sA(true);}} disabled={selCategory==="vendor_orders"&&!selectedVendorKey}>+ Add</button>
        <input ref={fR} type="file" accept=".csv,.txt,.xls,.xlsx,.docx" style={{display:"none"}} onChange={hF}/>
      </div>
    </div>
    <div style={{display:"flex",justifyContent:"center"}}>
      <div style={Object.assign({},S.tw,{width:"100%",maxWidth:1120})}><table style={S.tbl}><thead><tr><th style={S.th}>Code</th><th style={S.th}>Name</th><th style={S.th}>Category</th><th style={S.th}>Unit</th><th style={Object.assign({},S.th,{width:40})}></th></tr></thead>
        <tbody>{displayRows.map(function(row){
          if(row.type==="heading"){
            return <tr key={row.key}><td colSpan={5} style={Object.assign({},S.td,{fontWeight:700,color:"#0F172A",background:"rgba(226,232,240,.42)"})}>{row.text}</td></tr>;
          }
          var it=row.item;
          return(<tr key={row.key}><td style={S.tm}>{buildItemMasterCode(it.name,it.unit)||it.code}</td><td style={Object.assign({},S.td,{fontWeight:500})}>{it.name}</td><td style={Object.assign({},S.td,{color:"#64748B"})}>{it.category||"-"}</td><td style={Object.assign({},S.td,{color:"#64748B"})}>{it.unit||"-"}</td><td style={S.td}><button style={Object.assign({},S.b,S.bD,{padding:"2px 6px",fontSize:10})} onClick={function(){rm(it.code);}}>Del</button></td></tr>);
        })}{sorted.length===0&&<tr><td colSpan={5} style={Object.assign({},S.td,{textAlign:"center",padding:24,color:"#6B7186"})}>No items</td></tr>}</tbody></table></div>
    </div>
    </div>
    {shA&&(<div style={S.ov} onClick={function(){sA(false);}}><div style={S.mo} onClick={function(e){e.stopPropagation();}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:12}}>Add New Item</div>
      <div style={S.fg}><div style={S.lb}>Name *</div><input style={S.inp} value={nI.name} onChange={function(e){sNI(Object.assign({},nI,{name:e.target.value}));}}/></div>
      <div style={S.fr}><div style={Object.assign({},S.fg,{flex:1})}><div style={S.lb}>Category</div><select style={S.inp} value={nI.category} onChange={function(e){sNI(Object.assign({},nI,{category:e.target.value}));}}>{itemMasterCategories.map(function(cat){return <option key={cat.id} value={cat.id}>{cat.label}</option>;})}</select></div>
        <div style={Object.assign({},S.fg,{flex:1})}><div style={S.lb}>Unit</div><input style={S.inp} value={nI.unit} onChange={function(e){sNI(Object.assign({},nI,{unit:e.target.value}));}}/></div></div>
      <div style={S.fg}><div style={S.lb}>Code</div><input style={Object.assign({},S.inp,{background:"#F8FAFC",color:"#475569"})} value={buildItemMasterCode(nI.name,nI.unit)} readOnly placeholder="Item Name:Unit"/></div>
      {nI.category==="vendor_orders"&&<div style={S.fg}><div style={S.lb}>Vendor</div><select style={S.inp} value={selectedVendorKey||""} onChange={function(e){setSelectedVendorKey(e.target.value||null);}}><option value="">Select vendor</option>{vendorOptions.map(function(v){return <option key={v.id} value={v.id}>{v.name}</option>;})}</select></div>}
      <div style={S.mA}><button style={Object.assign({},S.b,S.bS)} onClick={function(){sA(false);}}>Cancel</button><button style={Object.assign({},S.b,S.bP)} onClick={add}>Add</button></div></div></div>)}
    {shU&&csv&&(<div style={S.ov} onClick={function(){sU(false);sC(null);}}><div style={Object.assign({},S.mo,S.mW)} onClick={function(e){e.stopPropagation();}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:12}}>Upload {CATEGORY_LABELS[uploadCategory]} - {csv.length} items found</div>
      <div style={S.fg}><div style={S.lb}>Category</div><select style={S.inp} value={uploadCategory} onChange={function(e){setUploadCategory(e.target.value);}}>{itemMasterCategories.map(function(cat){return <option key={cat.id} value={cat.id}>{cat.label}</option>;})}</select></div>
      {uploadCategory==="vendor_orders"&&<div style={S.fg}><div style={S.lb}>Vendor</div><select style={S.inp} value={uploadVendorKey||""} onChange={function(e){setUploadVendorKey(e.target.value||null);}}><option value="">Select vendor</option>{vendorOptions.map(function(v){return <option key={v.id} value={v.id}>{v.name}</option>;})}</select></div>}
      <div style={S.fg}><div style={S.lb}>Mode</div><select style={S.inp} value={md} onChange={function(e){sMd(e.target.value);}}><option value="merge">Merge</option><option value="replace">Replace</option></select></div>
      {uploadTemplate&&<div style={S.nI}>{uploadTemplate.kind==="docx_vendor_form"?"Word template layout detected. Store documents will preserve the uploaded vendor form format.":"Template layout detected from the uploaded form. This category will use the same row/column layout for document output."}</div>}
      <div style={{fontSize:11,color:"#64748B",marginBottom:6}}>Preview (first 8):</div>
      <div style={Object.assign({},S.tw,{maxHeight:180})}><table style={S.tbl}><thead><tr><th style={S.th}>Code</th><th style={S.th}>Name</th><th style={S.th}>Category</th><th style={S.th}>Unit</th></tr></thead><tbody>
        {(uploadTemplate&&uploadTemplate.kind==="docx_vendor_form"?uploadPreviewRows.slice(0,12).map(function(row){
          if(row.type==="heading"){
            return <tr key={row.key}><td colSpan={4} style={Object.assign({},S.td,{fontWeight:700,color:"#0F172A",background:"rgba(226,232,240,.42)"})}>{row.text}</td></tr>;
          }
          var it=row.item;
          return <tr key={row.key}><td style={S.tm}>{buildItemMasterCode(it.name,it.unit)||it.code}</td><td style={S.td}>{it.name}</td><td style={S.td}>{it.category||"-"}</td><td style={S.td}>{it.unit||"-"}</td></tr>;
        }):csv.slice(0,8).map(function(it,i){return <tr key={i}><td style={S.tm}>{buildItemMasterCode(it.name,it.unit)||it.code}</td><td style={S.td}>{it.name}</td><td style={S.td}>{it.category||"-"}</td><td style={S.td}>{it.unit||"-"}</td></tr>;}) )}
      </tbody></table></div>
      <div style={S.mA}><button style={Object.assign({},S.b,S.bS)} onClick={function(){sU(false);sC(null);}}>Cancel</button><button style={Object.assign({},S.b,S.bP)} onClick={cfU}>Confirm</button></div></div></div>)}
    {showRawViewModal&&activeRawSheet&&(<div style={S.ov} onClick={function(){setShowRawViewModal(false);}}><div style={Object.assign({},S.mo,S.mW)} onClick={function(e){e.stopPropagation();}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:10}}>Uploaded Workbook Layout</div>
      {activeRawSheets.length>1&&<div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:8}}>{activeRawSheets.map(function(sheet,idx){
        return <button key={sheet.name+"_"+idx} style={Object.assign({},S.b,rawSheetIndex===idx?S.bP:S.bS,{padding:"4px 9px",fontSize:10.5})} onClick={function(){setRawSheetIndex(idx);}}>{sheet.name}</button>;
      })}</div>}
      <div style={Object.assign({},S.tw,{maxHeight:520})}><table style={Object.assign({},S.tbl,{tableLayout:"fixed",minWidth:Math.max(980,((activeRawSheet.rows[0]||[]).length||8)*108)})}><tbody>
        {activeRawSheet.rows.map(function(row,rIdx){return <tr key={"raw_m_r_"+rIdx}>{(row||[]).map(function(cell,cIdx){return <td key={"raw_m_c_"+rIdx+"_"+cIdx} style={Object.assign({},S.td,{whiteSpace:"pre-wrap",verticalAlign:"top",fontSize:11.5,padding:"4px 6px"})}>{cell==null?"":String(cell)}</td>;})}</tr>;})}
      </tbody></table></div>
      <div style={S.mA}><button style={Object.assign({},S.b,S.bS)} onClick={function(){setShowRawViewModal(false);}}>Close</button></div>
    </div></div>)}
  </div>);
}

/* ═══ USER MANAGEMENT (with phone) ═══ */
function UserMgmt({users,setUsers,toast,stores}){
  var _a=useState(false),shA=_a[0],sA=_a[1];
  var _n=useState({username:"",password:"",name:"",phone:"",email:"",role:"manager",storeId:stores[0]?stores[0].id:"",active:true}),nu=_n[0],sN=_n[1];
  var _cs=useState(""),customStore=_cs[0],setCustomStore=_cs[1];
  var _osm=useState(false),otherStoreMode=_osm[0],setOtherStoreMode=_osm[1];
  var _r=useState(null),rP=_r[0],sRP=_r[1];var _pw=useState(""),nPw=_pw[0],sNP=_pw[1];
  var _eu=useState(null),editUserId=_eu[0],setEditUserId=_eu[1];
  var _ef=useState({username:"",name:"",phone:"",email:"",role:"manager",storeId:"",active:true}),editF=_ef[0],setEditF=_ef[1];
  var _ecs=useState(""),editCustomStore=_ecs[0],setEditCustomStore=_ecs[1];
  var _eosm=useState(false),editOtherStoreMode=_eosm[0],setEditOtherStoreMode=_eosm[1];
  var add=async function(){
      var resolvedStoreId=otherStoreMode?customStore.trim():nu.storeId;
      if(!nu.username||!nu.password||!nu.name||!nu.phone||!nu.email){toast("Name, phone, email, username and password are required",true);return;}
      if(nu.role==="manager"&&!resolvedStoreId){toast("Store is required for manager",true);return;}
      if(users.find(function(u){return u.username===nu.username;})){toast("Username exists",true);return;}
      try{
        await apiClient.users.create(Object.assign({},nu,{storeId:resolvedStoreId||null}));
        const all=await apiClient.users.getAll();
        setUsers(all);
        sN({username:"",password:"",name:"",phone:"",email:"",role:"manager",storeId:stores[0]?stores[0].id:"",active:true});
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
      setEditF({username:u.username||"",name:u.name||"",phone:u.phone||"",email:u.email||"",role:u.role||"manager",storeId:u.storeId||"",active:!!u.active});
      var known=stores.some(function(s){return s.id===(u.storeId||"");});
      setEditOtherStoreMode(!!(u.storeId&&!known));
      setEditCustomStore(known?"":(u.storeId||""));
    };
  var saveEdit=async function(){
      if(!editUserId) return;
      var resolvedStoreId=editOtherStoreMode?editCustomStore.trim():editF.storeId;
      if(!editF.username||!editF.name||!editF.phone||!editF.email){toast("Name, username, phone and email are required",true);return;}
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
    <div style={S.tw}><table style={S.tbl}><thead><tr><th style={S.th}>Name</th><th style={S.th}>Username</th><th style={S.th}>Phone</th><th style={S.th}>Email</th><th style={S.th}>Role</th><th style={S.th}>Store</th><th style={S.th}>Status</th><th style={S.th}>Actions</th></tr></thead><tbody>
      {users.map(function(u){var sn=u.storeId?((stores.find(function(s){return s.id===u.storeId;})||{}).name||u.storeId):"-";return(<tr key={u.username}>
        <td style={Object.assign({},S.td,{fontWeight:500})}>{u.name}</td><td style={S.tm}>{u.username}</td><td style={S.tm}>{u.phone||"-"}</td><td style={S.tm}>{u.email||"-"}</td>
        <td style={S.td}><span style={Object.assign({},S.bg,u.role==="admin"?S.bgB:(u.role==="warehouse"?S.bgW:S.bgG))}>{u.role}</span></td><td style={S.td}>{sn}</td>
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
        <div style={Object.assign({},S.fg,{flex:1})}><div style={S.lb}>Email *</div><input style={S.inp} value={nu.email} onChange={function(e){sN(Object.assign({},nu,{email:e.target.value}));}} placeholder="name@example.com"/></div></div>
      <div style={S.fr}><div style={Object.assign({},S.fg,{flex:1})}><div style={S.lb}>Role</div><select style={S.inp} value={nu.role} onChange={function(e){sN(Object.assign({},nu,{role:e.target.value}));}}><option value="manager">Manager</option><option value="warehouse">Warehouse</option><option value="admin">Admin</option></select></div></div>
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
      <div style={S.fg}><div style={S.lb}>Email *</div><input style={S.inp} value={editF.email} onChange={function(e){setEditF(Object.assign({},editF,{email:e.target.value}));}} placeholder="name@example.com"/></div>
      <div style={S.fr}><div style={Object.assign({},S.fg,{flex:1})}><div style={S.lb}>Role</div><select style={S.inp} value={editF.role} onChange={function(e){setEditF(Object.assign({},editF,{role:e.target.value}));}}><option value="manager">Manager</option><option value="warehouse">Warehouse</option><option value="admin">Admin</option></select></div>
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
  var _ef=useState({name:"",emails:"",phone:""}),edF=_ef[0],sEdF=_ef[1];
  var _n=useState({id:"",name:"",emails:"",phone:"",items:[]}),nS=_n[0],sNS=_n[1];
  var add=async function(){
      if(!nS.id||!nS.name||!nS.emails){toast("ID, Name, and at least one Email required",true);return;}
      if(supList.find(function(s){return s.id===nS.id;})){toast("ID exists",true);return;}
      try{
        await apiClient.suppliers.create({id:nS.id,name:nS.name,emails:supplierEmailsArray({email:nS.emails}),phone:nS.phone,items:nS.items||[]});
        const all=await apiClient.suppliers.getAll();
        setSuppliers(all);
        sNS({id:"",name:"",emails:"",phone:"",items:[]});
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
  var startEdit=function(s){sEdSup(s.id);sEdF({name:s.name,emails:supplierEmailsText(s),phone:s.phone||""});};
  var saveEdit=async function(){
      if(!edF.name||!edF.emails){toast("Name and at least one Email required",true);return;}
      try{
        await apiClient.suppliers.update(edSup,{name:edF.name,emails:supplierEmailsArray({email:edF.emails}),phone:edF.phone});
        const all=await apiClient.suppliers.getAll();
        setSuppliers(all);
        sEdSup(null);
        toast("Supplier updated");
      }catch(e){toast(e.message,true);}    };
  return(<div>
    <div style={S.card}><div style={S.cH}><div><div style={S.t}>Suppliers</div><div style={S.d}>{supList.length} suppliers</div></div><button style={Object.assign({},S.b,S.bP)} onClick={function(){sA(true);}}>+ Add</button></div>
      <div style={S.tw}><table style={S.tbl}><thead><tr><th style={S.th}>ID</th><th style={S.th}>Name</th><th style={S.th}>Emails</th><th style={S.th}>Phone</th><th style={S.th}>Items</th><th style={Object.assign({},S.th,{width:200})}>Actions</th></tr></thead><tbody>
        {supList.map(function(s){return(<tr key={s.id}><td style={S.tm}>{s.id}</td><td style={Object.assign({},S.td,{fontWeight:500})}>{s.name}</td><td style={S.tm}>{supplierEmailsText(s)}</td><td style={S.tm}>{s.phone}</td><td style={S.td}><span style={Object.assign({},S.bg,S.bgB)}>{(s.items||[]).length} items</span></td>
          <td style={S.td}><div style={{display:"flex",gap:3}}><button style={Object.assign({},S.b,S.bS,{padding:"2px 6px",fontSize:10})} onClick={function(){startEdit(s);}}>Edit</button><button style={Object.assign({},S.b,S.bD,{padding:"2px 6px",fontSize:10})} onClick={function(){rm(s.id);}}>Del</button></div></td></tr>);})}</tbody></table></div></div>
    {shA&&(<div style={S.ov} onClick={function(){sA(false);}}><div style={S.mo} onClick={function(e){e.stopPropagation();}} onMouseDown={function(e){e.stopPropagation();}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:12}}>Add Supplier</div>
      <div style={S.fr}><div style={Object.assign({},S.fg,{flex:1})}><div style={S.lb}>ID *</div><input style={S.inp} value={nS.id} onChange={function(e){sNS(Object.assign({},nS,{id:e.target.value}));}} placeholder="SUP4"/></div>
        <div style={Object.assign({},S.fg,{flex:1})}><div style={S.lb}>Name *</div><input style={S.inp} value={nS.name} onChange={function(e){sNS(Object.assign({},nS,{name:e.target.value}));}}/></div></div>
      <div style={S.fr}><div style={Object.assign({},S.fg,{flex:1})}><div style={S.lb}>Emails * (comma separated)</div><input style={S.inp} value={nS.emails} onChange={function(e){sNS(Object.assign({},nS,{emails:e.target.value}));}} placeholder="a@x.com, b@y.com"/></div>
        <div style={Object.assign({},S.fg,{flex:1})}><div style={S.lb}>Phone</div><input style={S.inp} value={nS.phone} onChange={function(e){sNS(Object.assign({},nS,{phone:e.target.value}));}}/></div></div>
      <div style={S.mA}><button style={Object.assign({},S.b,S.bS)} onClick={function(){sA(false);}}>Cancel</button><button style={Object.assign({},S.b,S.bP)} onClick={add}>Add</button></div></div></div>)}
    {edSup&&(<div style={S.ov} onClick={function(){sEdSup(null);}}><div style={S.mo} onClick={function(e){e.stopPropagation();}} onMouseDown={function(e){e.stopPropagation();}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:12}}>Edit Supplier - {edSup}</div>
      <div style={S.fg}><div style={S.lb}>Name *</div><input style={S.inp} value={edF.name} onChange={function(e){sEdF(Object.assign({},edF,{name:e.target.value}));}}/></div>
      <div style={S.fr}><div style={Object.assign({},S.fg,{flex:1})}><div style={S.lb}>Emails * (comma separated)</div><input style={S.inp} value={edF.emails} onChange={function(e){sEdF(Object.assign({},edF,{emails:e.target.value}));}}/></div>
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
  var _ee=useState(""),eEmail=_ee[0],sEEmail=_ee[1];
  var _a=useState(false),sh=_a[0],sS=_a[1];var _n=useState({id:"",name:"",email:""}),ns=_n[0],sN=_n[1];
  var startE=function(s){sEId(s.id);sEN(s.name);sEEmail(s.email||"");};
  var saveE=async function(){
      if(!eN.trim()){toast("Name required",true);return;}
      try{
        await apiClient.stores.update(eId,{name:eN.trim(),email:eEmail.trim()});
        const all=await apiClient.stores.getAll();
        setStores(all);
        sEId(null);
        sEEmail("");
        toast("Updated");
      }catch(e){toast(e.message,true);}    };
  var addS=async function(){
      if(!ns.id||!ns.name){toast("ID and Name required",true);return;}
      if(stores.find(function(s){return s.id===ns.id;})){toast("ID exists",true);return;}
      try{
        await apiClient.stores.create({id:ns.id.trim(),name:ns.name.trim(),email:ns.email.trim()});
        const all=await apiClient.stores.getAll();
        setStores(all);
        sN({id:"",name:"",email:""});sS(false);
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
    <div style={S.tw}><table style={S.tbl}><thead><tr><th style={S.th}>ID</th><th style={S.th}>Name</th><th style={S.th}>Email</th><th style={Object.assign({},S.th,{width:140})}>Actions</th></tr></thead><tbody>
      {stores.map(function(s){return(<tr key={s.id}><td style={S.tm}>{s.id}</td><td style={S.td}>{eId===s.id?<div style={{display:"flex",gap:4,alignItems:"center"}}><input style={Object.assign({},S.inp,{flex:1})} value={eN} onChange={function(e){sEN(e.target.value);}} onKeyDown={function(e){if(e.key==="Enter")saveE();}}/><button style={Object.assign({},S.b,S.bG,{padding:"3px 8px"})} onClick={saveE}>Save</button><button style={Object.assign({},S.b,S.bS,{padding:"3px 8px"})} onClick={function(){sEId(null);sEEmail("");}}>X</button></div>:<span style={{fontWeight:500}}>{s.name}</span>}</td><td style={S.tm}>{eId===s.id?<input style={Object.assign({},S.inp,{minWidth:220})} value={eEmail} onChange={function(e){sEEmail(e.target.value);}} placeholder="store@example.com"/>:(s.email||"-")}</td>
        <td style={S.td}>{eId!==s.id&&<div style={{display:"flex",gap:3}}><button style={Object.assign({},S.b,S.bS,{padding:"2px 8px",fontSize:10})} onClick={function(){startE(s);}}>Edit</button><button style={Object.assign({},S.b,S.bD,{padding:"2px 8px",fontSize:10})} onClick={function(){rmS(s.id);}}>Del</button></div>}</td></tr>);})}</tbody></table></div></div>
    {sh&&(<div style={S.ov} onClick={function(){sS(false);}}><div style={S.mo} onClick={function(e){e.stopPropagation();}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:12}}>Add Store</div>
      <div style={S.fg}><div style={S.lb}>Store ID *</div><input style={S.inp} value={ns.id} onChange={function(e){sN(Object.assign({},ns,{id:e.target.value}));}} placeholder="S6"/></div>
      <div style={S.fg}><div style={S.lb}>Store Name *</div><input style={S.inp} value={ns.name} onChange={function(e){sN(Object.assign({},ns,{name:e.target.value}));}}/></div>
      <div style={S.fg}><div style={S.lb}>Store Email</div><input style={S.inp} value={ns.email} onChange={function(e){sN(Object.assign({},ns,{email:e.target.value}));}} placeholder="store@example.com"/></div>
      <div style={S.mA}><button style={Object.assign({},S.b,S.bS)} onClick={function(){sS(false);}}>Cancel</button><button style={Object.assign({},S.b,S.bP)} onClick={addS}>Add</button></div></div></div>)}
  </div>);
}

/* ═══ REPORTS ═══ */
function Reports({orders,items,stores,user}){
  var _tab=useState("top"),tab=_tab[0],sTab=_tab[1];
  var isWarehouseUser=isWarehouseRole(user);
  // Aggregate report data, filtering warehouse users to vendor orders only.
  var agg=useMemo(function(){
    var itemTotals={};var storeTotals={};var catTotals={};var orderCount=0;
    Object.entries(orders).forEach(function(e){var o=e[1];if(!o.items)return;
      if(isWarehouseUser&&normalizeCategory(o.category||"vegetables")!=="vendor_orders") return;
      orderCount++;
      var sid=o.store;if(!storeTotals[sid])storeTotals[sid]={submitted:0,processed:0,draft:0,total:0};storeTotals[sid][o.status]=(storeTotals[sid][o.status]||0)+1;storeTotals[sid].total++;
      Object.entries(o.items).forEach(function(ie){var code=ie[0],qtyEntry=normalizeOrderItemEntry(ie[1]),qty=qtyEntry.qty;if(qty<=0)return;if(!itemTotals[code])itemTotals[code]={qty:0,orders:0};itemTotals[code].qty+=qty;itemTotals[code].orders++;
        var it=items.find(function(i){return i.code===code;});var cat=it?it.category:(o.category||"Other");if(!catTotals[cat])catTotals[cat]={qty:0,items:{}};catTotals[cat].qty+=qty;catTotals[cat].items[code]=true;});});
    // Top items sorted by qty
    var topItems=Object.entries(itemTotals).map(function(e){var it=items.find(function(i){return i.code===e[0];});return{code:e[0],codeDisplay:String(e[0]||"").indexOf("XLS::")===0?String(e[0]).slice(5):e[0],name:it?it.name:displayNameForOrderKey(e[0],items),category:it?it.category:"",qty:e[1].qty,orders:e[1].orders};}).sort(function(a,b){return b.qty-a.qty;});
    var catList=Object.entries(catTotals).map(function(e){return{category:e[0],qty:e[1].qty,uniqueItems:Object.keys(e[1].items).length};}).sort(function(a,b){return b.qty-a.qty;});
    var storeList=Object.entries(storeTotals).map(function(e){var st=stores.find(function(s){return s.id===e[0];});return Object.assign({id:e[0],name:st?st.name:e[0]},e[1]);});
    return{topItems:topItems,catList:catList,storeList:storeList,orderCount:orderCount};
  },[orders,items,stores,isWarehouseUser]);

  return(<div>
    <div style={S.tabs}>
      {[["top","Top Items"],["category","By Category"],["store","By Store"]].map(function(t){return <button key={t[0]} style={Object.assign({},S.tab,tab===t[0]?S.tA:S.tI)} onClick={function(){sTab(t[0]);}}>{t[1]}</button>;})}
    </div>
    <div style={S.sg}>
      <div style={S.sc}><div style={S.sL}>{isWarehouseUser?"Vendor Orders":"Total Orders"}</div><div style={Object.assign({},S.sV,{color:"#166534"})}>{agg.orderCount}</div></div>
      <div style={S.sc}><div style={S.sL}>{isWarehouseUser?"Vendor Items Ordered":"Unique Items Ordered"}</div><div style={Object.assign({},S.sV,{color:"#34D399"})}>{agg.topItems.length}</div></div>
      <div style={S.sc}><div style={S.sL}>{isWarehouseUser?"Vendor Categories":"Categories Active"}</div><div style={Object.assign({},S.sV,{color:"#FBBF24"})}>{agg.catList.length}</div></div>
    </div>

    {tab==="top"&&(<div style={S.card}><div style={S.t}>{isWarehouseUser?"Most Ordered Vendor Items":"Most Ordered Items"}</div><div style={S.d}>{isWarehouseUser?"Ranked by total quantity across vendor orders":"Ranked by total quantity across all orders"}</div>
      {agg.topItems.length===0?<div style={{textAlign:"center",padding:30,color:"#6B7186"}}>No order data yet. Submit some orders first.</div>:
      <div style={Object.assign({},S.tw,{marginTop:10})}><table style={S.tbl}><thead><tr><th style={S.th}>#</th><th style={S.th}>Code</th><th style={S.th}>Item</th><th style={S.th}>Category</th><th style={Object.assign({},S.th,{textAlign:"right"})}>Total Qty</th><th style={Object.assign({},S.th,{textAlign:"right"})}>In Orders</th><th style={S.th}>Bar</th></tr></thead><tbody>
        {agg.topItems.slice(0,20).map(function(it,i){var maxQ=agg.topItems[0].qty;var pct=maxQ>0?Math.round(it.qty/maxQ*100):0;return(<tr key={it.code}><td style={Object.assign({},S.td,{fontWeight:700,color:"#6B7186"})}>{i+1}</td><td style={S.tm}>{it.codeDisplay}</td><td style={Object.assign({},S.td,{fontWeight:500})}>{it.name}</td><td style={Object.assign({},S.td,{color:"#64748B"})}>{it.category}</td>
          <td style={Object.assign({},S.td,{textAlign:"right",fontFamily:"monospace",fontWeight:700,color:"#166534"})}>{it.qty}</td>
          <td style={Object.assign({},S.td,{textAlign:"right",fontFamily:"monospace"})}>{it.orders}</td>
          <td style={Object.assign({},S.td,{width:120})}><div style={{height:8,borderRadius:4,background:"rgba(148,163,184,.22)",overflow:"hidden"}}><div style={{height:"100%",width:pct+"%",background:"linear-gradient(90deg,#16A34A,#22C55E)",borderRadius:4}}/></div></td></tr>);})}</tbody></table></div>}</div>)}

    {tab==="category"&&(<div style={S.card}><div style={S.t}>{isWarehouseUser?"Vendor Orders by Category":"Orders by Category"}</div>
      {agg.catList.length===0?<div style={{textAlign:"center",padding:30,color:"#6B7186"}}>No data</div>:
      <div style={Object.assign({},S.tw,{marginTop:10})}><table style={S.tbl}><thead><tr><th style={S.th}>Category</th><th style={Object.assign({},S.th,{textAlign:"right"})}>Total Qty</th><th style={Object.assign({},S.th,{textAlign:"right"})}>Unique Items</th><th style={S.th}>Bar</th></tr></thead><tbody>
        {agg.catList.map(function(c){var maxQ=agg.catList[0].qty;var pct=maxQ>0?Math.round(c.qty/maxQ*100):0;return(<tr key={c.category}><td style={Object.assign({},S.td,{fontWeight:600})}>{c.category}</td>
          <td style={Object.assign({},S.td,{textAlign:"right",fontFamily:"monospace",fontWeight:700,color:"#34D399"})}>{c.qty}</td>
          <td style={Object.assign({},S.td,{textAlign:"right",fontFamily:"monospace"})}>{c.uniqueItems}</td>
          <td style={Object.assign({},S.td,{width:120})}><div style={{height:8,borderRadius:4,background:"rgba(148,163,184,.22)",overflow:"hidden"}}><div style={{height:"100%",width:pct+"%",background:"linear-gradient(90deg,#34D399,#059669)",borderRadius:4}}/></div></td></tr>);})}</tbody></table></div>}</div>)}

    {tab==="store"&&(<div style={S.card}><div style={S.t}>{isWarehouseUser?"Vendor Orders by Store":"Orders by Store"}</div>
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
function Settings({stores,schedule,setSchedule,manualOpenOrder,setManualOpenOrder,manualOpenSeq,setManualOpenSeq,manualOpenLeaves,setManualOpenLeaves,vendorOrderConfigs,setVendorOrderConfigs,setVendorOrdersOpenVendors,setServerActiveVendorOrderIds,scheduleToday,setReopenedFromId,orderMsgs,setOrderMsgs,toast,logo,setLogo,logoRef,handleLogo,suppliers,user}){
  var _e=useState(null),ed=_e[0],sEd=_e[1];var _v=useState(0),eV=_v[0],sEV=_v[1];
  var _em=useState(null),emT=_em[0],sEmT=_em[1];var _emV=useState(""),emV=_emV[0],sEmV=_emV[1];
  var _mo=useState(manualOpenOrder||""),moType=_mo[0],sMoType=_mo[1];
  var _mol=useState(!!manualOpenLeaves),moLeaves=_mol[0],sMoLeaves=_mol[1];
  var _svk=useState(""),selectedVendorSettingKey=_svk[0],setSelectedVendorSettingKey=_svk[1];
  var _vws=useState(null),vendorWindowStartValue=_vws[0],setVendorWindowStartValue=_vws[1];
  var _vwe=useState(null),vendorWindowEndValue=_vwe[0],setVendorWindowEndValue=_vwe[1];
  var knownSupplierIds=normalizeVendorOrderList((suppliers||[]).map(function(s){return s&&s.id;}));
  var isWarehouseUser=isWarehouseRole(user);
  var normalizedVendorConfigs=normalizeVendorOrderConfigs(vendorOrderConfigs).filter(function(config){
    return config&&knownSupplierIds.indexOf(String(config.vendorKey||""))>=0;
  });
  var vendorConfigsKey=JSON.stringify(normalizedVendorConfigs);
  var effectiveToday=Number.isInteger(scheduleToday)?scheduleToday:new Date().getDay();
  var selectedVendorConfig=normalizedVendorConfigs.find(function(config){return config.vendorKey===selectedVendorSettingKey;})||null;
  var selectedVendorIsOpenToday=!!(selectedVendorConfig&&isVendorConfigActiveNow(selectedVendorConfig,effectiveToday));
  var configuredVendorRows=normalizedVendorConfigs.slice().sort(function(a,b){
    return String(vendorDisplayName(suppliers,a.vendorKey)).localeCompare(String(vendorDisplayName(suppliers,b.vendorKey)),undefined,{sensitivity:"base"});
  }).map(function(config){
    return {
      vendorKey:config.vendorKey,
      vendorName:vendorDisplayName(suppliers,config.vendorKey),
      startDay:config.startDay,
      endDay:config.endDay,
      temporaryOpenOnly:!!config.temporaryOpenOnly,
      temporaryOpenUntil:config.temporaryOpenUntil||null,
      windowText:vendorConfigWindowText(config),
      openToday:isVendorConfigActiveNow(config,effectiveToday),
    };
  });
  useEffect(function(){ sMoType(manualOpenOrder||""); },[manualOpenOrder]);
  useEffect(function(){ sMoLeaves(!!manualOpenLeaves); },[manualOpenLeaves]);
  useEffect(function(){
    if(selectedVendorConfig){
      setVendorWindowStartValue(parseOptionalDay(selectedVendorConfig.startDay));
      setVendorWindowEndValue(parseOptionalDay(selectedVendorConfig.endDay));
      return;
    }
    setVendorWindowStartValue(null);
    setVendorWindowEndValue(null);
  },[selectedVendorSettingKey,vendorConfigsKey]);
  var applyVendorConfigState=function(nextConfigs,activeVendorIds){
    var normalized=normalizeVendorOrderConfigs(nextConfigs);
    if(setVendorOrderConfigs) setVendorOrderConfigs(normalized);
    if(setVendorOrdersOpenVendors){
      setVendorOrdersOpenVendors(Array.isArray(activeVendorIds)?normalizeVendorOrderList(activeVendorIds):[]);
    }
    if(setServerActiveVendorOrderIds&&Array.isArray(activeVendorIds)){
      setServerActiveVendorOrderIds(normalizeVendorOrderList(activeVendorIds));
    }
  };
  var saveDay=async function(){
      if (eV === '' || eV === null) {
        toast('Please select a day', true);
        return;
      }
      try{
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
        if(setReopenedFromId) setReopenedFromId(null);
        persistReopenTarget(null);
        toast(resp.manualOpenOrder?("Manual open active: Order "+resp.manualOpenOrder):"Manual open cleared");
      }catch(e){toast(e.message,true);}  };
  var saveManualLeavesOpen=async function(){
      try{
        var resp=await apiClient.settings.updateManualOpenLeaves(!!moLeaves);
        if(setManualOpenLeaves) setManualOpenLeaves(!!resp.manualOpenLeaves);
        toast(resp.manualOpenLeaves?"Leaves manual override enabled":"Leaves manual override disabled");
      }catch(e){toast(e.message,true);}  };
  var saveVendorOrdersOpen=async function(){
      try{
        if(!selectedVendorSettingKey){
          toast("Select a supplier first",true);
          return;
        }
        var saveStartDay=parseOptionalDay(vendorWindowStartValue);
        var saveEndDay=parseOptionalDay(vendorWindowEndValue);
        if((saveStartDay===null)!==(saveEndDay===null)){
          toast("Select both From and To days",true);
          return;
        }
        if(saveStartDay===null&&saveEndDay===null){
          toast("Select both From and To days, or use Open for 24 Hours",true);
          return;
        }
        var resp=await apiClient.settings.updateVendorOrdersOpen({
          vendorKey:selectedVendorSettingKey,
          enabled:true,
          startDay:saveStartDay,
          endDay:saveEndDay,
        });
        var nextConfigs=normalizeVendorOrderConfigs(resp.vendorOrderConfigs);
        applyVendorConfigState(nextConfigs,resp.activeVendorOrders);
        if(setReopenedFromId) setReopenedFromId(null);
        persistReopenTarget(null);
        toast("Vendor settings saved for "+vendorDisplayName(suppliers,selectedVendorSettingKey)+" ("+vendorWindowText(saveStartDay,saveEndDay)+")");
      }catch(e){toast(e.message,true);}  };
  var openVendorFor24Hours=async function(){
      try{
        if(!selectedVendorSettingKey){
          toast("Select a supplier first",true);
          return;
        }
        var resp=await apiClient.settings.updateVendorOrdersOpen({
          vendorKey:selectedVendorSettingKey,
          enabled:true,
          openToday24h:true,
        });
        var nextConfigs=normalizeVendorOrderConfigs(resp.vendorOrderConfigs);
        applyVendorConfigState(nextConfigs,resp.activeVendorOrders);
        if(setReopenedFromId) setReopenedFromId(null);
        persistReopenTarget(null);
        toast("Vendor opened for 24 hours: "+vendorDisplayName(suppliers,selectedVendorSettingKey));
      }catch(e){toast(e.message,true);}  };
  var closeVendorSetting=async function(vendorKey){
      var targetVendorKey=String(vendorKey||selectedVendorSettingKey||"").trim();
      if(!targetVendorKey){
        toast("Select a supplier first",true);
        return;
      }
      try{
        var resp=await apiClient.settings.updateVendorOrdersOpen({vendorKey:targetVendorKey,enabled:false});
        var nextConfigs=normalizeVendorOrderConfigs(resp.vendorOrderConfigs);
        applyVendorConfigState(nextConfigs,resp.activeVendorOrders);
        if(setReopenedFromId) setReopenedFromId(null);
        persistReopenTarget(null);
        if(selectedVendorSettingKey===targetVendorKey){
          setVendorWindowStartValue(null);
          setVendorWindowEndValue(null);
        }
        toast("Vendor closed for "+vendorDisplayName(suppliers,targetVendorKey));
      }catch(e){toast(e.message,true);}
    };
  return(<div>
    <div style={S.card}><div style={S.cH}><div><div style={S.t}>{isWarehouseUser?"Vendor Orders Activation":"Vegetable Order Schedule"}</div><div style={S.d}>{isWarehouseUser?"Open or schedule vendor orders for stores and notify store emails automatically.":"Edit day for each order type"}</div></div></div>
      {!isWarehouseUser&&<Fragment>
      <div style={Object.assign({},S.tw,{marginTop:4})}><table style={S.tbl}><thead><tr><th style={S.th}>Order</th><th style={S.th}>Day</th><th style={Object.assign({},S.th,{width:120})}>Actions</th></tr></thead><tbody>
        {["A","B","C"].map(function(t){var isE=ed===t;return(<tr key={t}><td style={Object.assign({},S.td,{fontWeight:600,fontSize:13})}>Order {t}</td><td style={S.td}>{isE?<select style={Object.assign({},S.inp,{width:140})} value={eV} onChange={function(e){
                var v=e.target.value;
                sEV(v === "" ? "" : parseInt(v));
              }}>
                <option value="" disabled>Choose day</option>
                {DAYS.map(function(d,i){
                  return <option key={i} value={i}>{d}</option>;
                })}
              </select>:<span>{schedule[t]!=null?DAYS[schedule[t]]:"Unset"}</span>}</td>
          <td style={S.td}>{isE?<div style={{display:"flex",gap:3}}><button style={Object.assign({},S.b,S.bG,{padding:"3px 8px",fontSize:10})} onClick={saveDay}>Save</button><button style={Object.assign({},S.b,S.bS,{padding:"3px 8px",fontSize:10})} onClick={function(){sEd(null);}}>Cancel</button></div>:<button style={Object.assign({},S.b,S.bS,{padding:"3px 8px",fontSize:10})} onClick={function(){
                  sEd(t);
                  // initialize editor value; if unset then leave blank so placeholder shows
                  sEV(schedule[t] != null ? schedule[t] : "");
                }}><Ic type="edit" size={11}/> Edit</button>}</td></tr>);})}</tbody></table></div>
      <div style={{marginTop:10,paddingTop:10,borderTop:"1px solid rgba(148,163,184,.24)"}}>
        <div style={{fontSize:12,fontWeight:600,color:"#0F172A",marginBottom:4}}>Vegetable Order Manual Override</div>
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
      <div style={{marginTop:10,paddingTop:10,borderTop:"1px solid rgba(148,163,184,.24)"}}>
        <div style={{fontSize:12,fontWeight:600,color:"#0F172A",marginBottom:4}}>Leaves Manual Override</div>
        <div style={{fontSize:11,color:"#64748B",marginBottom:8}}>Open Leaves (Order B category) separately without changing the active A/B/C order override.</div>
        <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
          <label style={{display:"flex",alignItems:"center",gap:8,cursor:"pointer"}}>
            <input type="checkbox" checked={!!moLeaves} onChange={function(e){sMoLeaves(e.target.checked);}}/>
            <span style={{fontSize:12}}>Enable Leaves manual override</span>
          </label>
          <button style={Object.assign({},S.b,S.bG)} onClick={saveManualLeavesOpen}>Save Leaves Override</button>
          {manualOpenLeaves&&<span style={Object.assign({},S.bg,S.bgW)}>Leaves Override Active</span>}
        </div>
      </div>
      </Fragment>}
      <div style={{marginTop:10,paddingTop:10,borderTop:"1px solid rgba(148,163,184,.24)"}}>
        <div style={{fontSize:12,fontWeight:600,color:"#0F172A",marginBottom:4}}>Vendor Orders Activation</div>
        <div style={{fontSize:11,color:"#64748B",marginBottom:8}}>Select a supplier to open the schedule form. Set From and To day, cancel schedule, or use Open for 24 hours to auto-close after one day.</div>
        <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",marginBottom:8}}>
          <select style={Object.assign({},S.inp,{width:260})} value={selectedVendorSettingKey} onChange={function(e){setSelectedVendorSettingKey(e.target.value||"");}}>
            <option value="">Select supplier</option>
            {(suppliers||[]).map(function(v){return <option key={v.id} value={v.id}>{v.name}</option>;})}
          </select>
          {selectedVendorSettingKey&&<span style={Object.assign({},S.bg,selectedVendorIsOpenToday?S.bgG:S.bgY)}>{selectedVendorIsOpenToday?"Open today":"Ready to save"}</span>}
        </div>
        {selectedVendorSettingKey&&<div style={Object.assign({},S.card,{marginBottom:10,padding:"12px 14px",background:"rgba(248,250,252,.8)"})}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,flexWrap:"wrap",marginBottom:8}}>
            <div><div style={S.t}>{vendorDisplayName(suppliers,selectedVendorSettingKey)}</div><div style={S.d}>{selectedVendorConfig?"Editing saved supplier window":"Create a supplier-specific vendor order window"}</div></div>
            {selectedVendorConfig&&<span style={Object.assign({},S.bg,S.bgW)}>Current: {vendorConfigWindowText(selectedVendorConfig)}</span>}
          </div>
          <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",marginBottom:8}}>
            <select style={Object.assign({},S.inp,{width:190})} value={vendorWindowStartValue==null?"":String(vendorWindowStartValue)} onChange={function(e){
              var value=e.target.value;
              setVendorWindowStartValue(value===""?null:parseInt(value,10));
            }}>
              <option value="">From day</option>
              {DAYS.map(function(day,idx){return <option key={day} value={idx}>{day}</option>;})}
            </select>
            <select style={Object.assign({},S.inp,{width:190})} value={vendorWindowEndValue==null?"":String(vendorWindowEndValue)} onChange={function(e){
              var value=e.target.value;
              setVendorWindowEndValue(value===""?null:parseInt(value,10));
            }}>
              <option value="">To day</option>
              {DAYS.map(function(day,idx){return <option key={day} value={idx}>{day}</option>;})}
            </select>
            <button style={Object.assign({},S.b,S.bG)} onClick={saveVendorOrdersOpen}>Save Supplier Setting</button>
            <button style={Object.assign({},S.b,S.bW)} onClick={openVendorFor24Hours}>Open for 24 Hours</button>
            <button style={Object.assign({},S.b,S.bD)} onClick={function(){closeVendorSetting(selectedVendorSettingKey);}} disabled={!selectedVendorConfig}>Cancel Schedule</button>
          </div>
          <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
            <span style={Object.assign({},S.bg,S.bgW)}>Window: {vendorWindowText(vendorWindowStartValue,vendorWindowEndValue)}</span>
            <span style={Object.assign({},S.bg,S.bgW)}>Saved suppliers: {configuredVendorRows.length}</span>
          </div>
        </div>}
        <div style={Object.assign({},S.tw,{marginTop:6})}>
          <table style={S.tbl}>
            <thead><tr><th style={S.th}>Supplier</th><th style={S.th}>Window</th><th style={S.th}>Status</th><th style={S.th}>Action</th></tr></thead>
            <tbody>
              {configuredVendorRows.map(function(row){
                return <tr key={row.vendorKey}><td style={Object.assign({},S.td,{fontWeight:600})}>{row.vendorName}</td><td style={S.td}>{row.windowText}</td><td style={S.td}><span style={Object.assign({},S.bg,row.openToday?S.bgG:S.bgY)}>{row.openToday?"Open today":"Closed today"}</span></td><td style={S.td}><div style={{display:"flex",gap:6,flexWrap:"wrap"}}><button style={Object.assign({},S.b,S.bS,{padding:"3px 8px",fontSize:10.5})} onClick={function(){setSelectedVendorSettingKey(row.vendorKey);}}>Edit</button><button style={Object.assign({},S.b,S.bD,{padding:"3px 8px",fontSize:10.5})} onClick={function(){closeVendorSetting(row.vendorKey);}}>Cancel</button></div></td></tr>;
              })}
              {configuredVendorRows.length===0&&<tr><td colSpan={4} style={Object.assign({},S.td,{textAlign:"center",padding:20,color:"#64748B"})}>No supplier-specific vendor settings saved yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    {!isWarehouseUser&&<div style={S.card}><div style={S.cH}><div><div style={S.t}>Order Messages</div><div style={S.d}>Custom instructions shown to managers for each order type</div></div></div>
      {["A","B","C"].map(function(t){var isE=emT===t;return(<div key={t} style={{padding:"10px 0",borderBottom:"1px solid rgba(148,163,184,.24)"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
          <div style={{flex:1}}><div style={{fontSize:12,fontWeight:600,marginBottom:4}}>Order {t}</div>
            {isE?<textarea style={Object.assign({},S.inp,{minHeight:60})} value={emV} onChange={function(e){sEmV(e.target.value);}}/>
            :<div style={{fontSize:12,color:"#64748B",lineHeight:1.5}}>{orderMsgs[t]||"No message set"}</div>}</div>
          <div>{isE?<div style={{display:"flex",gap:3}}><button style={Object.assign({},S.b,S.bG,{padding:"3px 8px",fontSize:10})} onClick={saveMsg}>Save</button><button style={Object.assign({},S.b,S.bS,{padding:"3px 8px",fontSize:10})} onClick={function(){sEmT(null);}}>X</button></div>
            :<button style={Object.assign({},S.b,S.bS,{padding:"3px 8px",fontSize:10})} onClick={function(){sEmT(t);sEmV(orderMsgs[t]||"");}}><Ic type="edit" size={11}/> Edit</button>}</div></div></div>);})}</div>
    }

    {!isWarehouseUser&&<div style={S.card}><div style={S.cH}><div><div style={S.t}>Company Logo</div><div style={S.d}>Upload your logo to replace the default "OM" icon (max 500KB)</div></div></div>
      <div style={{display:"flex",alignItems:"center",gap:14,marginTop:4}}>
        {logo?<img src={logo} alt="Logo" style={{width:48,height:48,borderRadius:10,objectFit:"cover",border:"1px solid rgba(148,163,184,.24)"}}/>:<div style={Object.assign({},S.logo,{width:48,height:48,fontSize:16})}>OM</div>}
        <div style={{display:"flex",gap:6}}>
          <button style={Object.assign({},S.b,S.bP)} onClick={function(){logoRef.current&&logoRef.current.click();}}>Upload Logo</button>
          {logo&&<button style={Object.assign({},S.b,S.bD)} onClick={async function(){setLogo(null);toast("Logo removed");try{await apiClient.settings.updateLogo(null);}catch(e){console.error('logo clear failed',e);toast('Unable to clear logo',true);} }}>Remove</button>}
        </div>
      </div></div>}

    {!isWarehouseUser&&<div style={S.card}><div style={S.t}>Stores</div>
      <div style={Object.assign({},S.tw,{marginTop:8})}><table style={S.tbl}><thead><tr><th style={S.th}>ID</th><th style={S.th}>Name</th></tr></thead><tbody>
        {stores.map(function(s){return <tr key={s.id}><td style={S.tm}>{s.id}</td><td style={S.td}>{s.name}</td></tr>;})}</tbody></table></div></div>}

    {!isWarehouseUser&&<div style={{marginTop:10,padding:12,background:"rgba(148,163,184,.22)",borderRadius:6,border:"1px solid rgba(148,163,184,.24)",fontSize:12,color:"#64748B"}}>
      <strong style={{color:"#0F172A"}}>OrderManager v3.1</strong> - Supplier edit, submit confirm, sort options, mailto emails, company logo, custom messages.</div>
    }
  </div>);
}
