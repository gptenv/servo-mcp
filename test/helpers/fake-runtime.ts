/**
 * A scriptable in-memory stand-in for the Servo WASM worker runtime returned
 * by `createServoWorkerRuntime`. Tests control its behavior through the
 * options object; every call is recorded so assertions can inspect usage.
 */

const isOpaqueHttpDocument = "globalThis.origin === 'null' && location.origin !== 'null'";
const STORAGE_CAPTURE_CHUNK_CHARS = 32_768;
const MAX_WEB_STORAGE_CAPTURE_CHARS = 512 * 1024;
const MAX_INDEXEDDB_CAPTURE_BYTES = 2 * 1024 * 1024;
const MAX_INDEXEDDB_CAPTURE_RECORDS = 5_000;

const resumeStateExpression = (captureIndexedDB = true) => `(async()=>{
  const nodePath=(node)=>{const path=[];for(let current=node;current&&current!==document.documentElement;current=current.parentElement){const parent=current.parentElement;if(!parent)return null;path.unshift(Array.prototype.indexOf.call(parent.children,current));}return path;};
  if(${isOpaqueHttpDocument})return JSON.stringify({opaqueDocument:true});
  const fields=[];
  for(const element of Array.from(document.querySelectorAll('input,textarea,select,[contenteditable="true"]')).slice(0,200)){
    const tag=element.tagName.toLowerCase();
    if(tag==='input'&&['password','file'].includes((element.type||'').toLowerCase()))continue;
    const path=nodePath(element);if(!path)continue;
    if(tag==='input'&&['checkbox','radio'].includes((element.type||'').toLowerCase()))fields.push({path,kind:'checked',value:Boolean(element.checked)});
    else if(tag==='select')fields.push({path,kind:'selected',value:Array.from(element.options).map((option)=>Boolean(option.selected))});
    else if(element.isContentEditable)fields.push({path,kind:'html',value:element.innerHTML.slice(0,2048)});
    else {let selectionStart=null,selectionEnd=null;try{selectionStart=element.selectionStart??null;selectionEnd=element.selectionEnd??null;}catch{}fields.push({path,kind:'value',value:String(element.value??'').slice(0,2048),selectionStart,selectionEnd});}
  }
  const bytesToBase64=(bytes)=>{let binary='';for(let offset=0;offset<bytes.length;offset+=0x8000)binary+=String.fromCharCode(...bytes.subarray(offset,offset+0x8000));return btoa(binary);};
  const encodeGraph=async(root)=>{const nodes=[];const seen=new Map();const encode=async(value)=>{
    if(value===null||typeof value==='string'||typeof value==='boolean')return value;
    if(typeof value==='number')return Number.isFinite(value)?value:{t:'number',v:String(value)};
    if(typeof value==='undefined')return {t:'undefined'};
    if(typeof value==='bigint')return {t:'bigint',v:String(value)};
    if(typeof value==='symbol'||typeof value==='function')throw new TypeError('IndexedDB value contains a non-cloneable value.');
    if(seen.has(value))return {r:seen.get(value)};
    const id=nodes.length;seen.set(value,id);nodes.push(null);
    let node;
    if(value instanceof Date){const time=value.getTime();node={t:'date',v:Number.isFinite(time)?time:{t:'number',v:'NaN'}};}
    else if(value instanceof RegExp)node={t:'regexp',s:value.source,f:value.flags,l:value.lastIndex};
    else if(value instanceof ArrayBuffer)node={t:'buffer',v:bytesToBase64(new Uint8Array(value))};
    else if(ArrayBuffer.isView(value))node={t:'view',c:value.constructor.name,b:await encode(value.buffer),o:value.byteOffset,l:value instanceof DataView?value.byteLength:value.length};
    else if(typeof Blob!=='undefined'&&value instanceof Blob){const common={type:value.type,bytes:bytesToBase64(new Uint8Array(await value.arrayBuffer()))};node=typeof File!=='undefined'&&value instanceof File?{t:'file',...common,name:value.name,lastModified:value.lastModified}:{t:'blob',...common};}
    else if(value instanceof Map){const entries=[];for(const [key,item] of value)entries.push([await encode(key),await encode(item)]);node={t:'map',e:entries};}
    else if(value instanceof Set){const entries=[];for(const item of value)entries.push(await encode(item));node={t:'set',e:entries};}
    else if(Array.isArray(value)){const entries=[];for(let i=0;i<value.length;i++)entries.push(i in value?await encode(value[i]):{t:'hole'});node={t:'array',l:value.length,e:entries};}
    else if(value&&Object.getPrototypeOf(value)===Object.prototype||value&&Object.getPrototypeOf(value)===null){const entries=[];for(const [key,item] of Object.entries(value))entries.push([key,await encode(item)]);node={t:Object.getPrototypeOf(value)===null?'null-object':'object',e:entries};}
    else throw new TypeError('IndexedDB contains an unsupported structured-clone value: '+Object.prototype.toString.call(value));
    nodes[id]=node;return {r:id};
  };return {root:await encode(root),nodes};};
  const databases=[];
  let estimatedIndexedDBBytes=0;
  let indexedDBRecordCount=0;
  let estimateNodes=0;
  const estimateValueBytes=(value,seen=new Set())=>{
    if(++estimateNodes>50000)return ${MAX_INDEXEDDB_CAPTURE_BYTES+1};
    if(value===null||typeof value==='boolean'||typeof value==='number'||typeof value==='bigint')return 8;
    if(typeof value==='string')return value.length*2;
    if(value instanceof ArrayBuffer)return value.byteLength;
    if(ArrayBuffer.isView(value))return value.byteLength;
    if(typeof Blob!=='undefined'&&value instanceof Blob)return value.size;
    if(typeof value!=='object'||seen.has(value))return 0;
    seen.add(value);
    let bytes=16;
    if(value instanceof Map){for(const [key,item] of value){bytes+=estimateValueBytes(key,seen)+estimateValueBytes(item,seen);if(bytes>${MAX_INDEXEDDB_CAPTURE_BYTES})break;}}
    else if(value instanceof Set){for(const item of value){bytes+=estimateValueBytes(item,seen);if(bytes>${MAX_INDEXEDDB_CAPTURE_BYTES})break;}}
    else if(value instanceof Date||value instanceof RegExp)bytes+=128;
    else {for(const key in value){if(Object.prototype.hasOwnProperty.call(value,key)){bytes+=key.length*2+estimateValueBytes(value[key],seen);if(bytes>${MAX_INDEXEDDB_CAPTURE_BYTES})break;}}}
    return bytes;
  };
  if(${captureIndexedDB}&&location.origin!=='null'&&typeof indexedDB!=='undefined'&&typeof indexedDB.databases==='function'){
    let infos;try{infos=await indexedDB.databases();}catch(error){throw new Error('IndexedDB snapshot could not list databases: '+String(error));}
    for(const info of infos){if(typeof info.name!=='string')continue;let db;try{db=await new Promise((resolve,reject)=>{const request=indexedDB.open(info.name);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);request.onblocked=()=>reject(new Error('IndexedDB database enumeration was blocked.'));});}catch(error){throw new Error('IndexedDB snapshot could not open '+info.name+': '+String(error));}
      let stage='reading schema';try{
        const stores=[];const names=Array.from(db.objectStoreNames);
        if(names.length){
          const tx=db.transaction(names,'readonly');const pending=[];
          for(const name of names){
            stage='reading records from '+name;const store=tx.objectStore(name);
            const indexes=Array.from(store.indexNames,(indexName)=>{const index=store.index(indexName);return {name:index.name,keyPath:index.keyPath,unique:index.unique,multiEntry:index.multiEntry};});
            const storeData={name:store.name,keyPath:store.keyPath,autoIncrement:store.autoIncrement,indexes,records:[]};stores.push(storeData);
            pending.push(new Promise((resolve,reject)=>{
              const request=store.openCursor();
              request.onerror=()=>reject(request.error);
              request.onsuccess=()=>{const cursor=request.result;if(!cursor){resolve();return;}try{if(++indexedDBRecordCount>${MAX_INDEXEDDB_CAPTURE_RECORDS})throw new RangeError('IndexedDB snapshot exceeds the ${MAX_INDEXEDDB_CAPTURE_RECORDS} record limit.');estimateNodes=0;estimatedIndexedDBBytes+=estimateValueBytes(cursor.primaryKey)+estimateValueBytes(cursor.value);if(estimatedIndexedDBBytes>${MAX_INDEXEDDB_CAPTURE_BYTES})throw new RangeError('IndexedDB snapshot exceeds the ${MAX_INDEXEDDB_CAPTURE_BYTES} byte safety limit.');storeData.records.push({primaryKey:cursor.primaryKey,value:cursor.value});cursor.continue();}catch(error){reject(error);try{tx.abort();}catch{}}};
            }));
          }
          await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('IndexedDB snapshot transaction aborted.'));});
          await Promise.all(pending);
          stage='serializing records';
          for(const store of stores){for(const record of store.records){record.primaryKey=await encodeGraph(record.primaryKey);record.value=await encodeGraph(record.value);}}
        }
        databases.push({name:db.name,version:db.version,stores});
      }catch(error){throw new Error('IndexedDB snapshot failed while '+stage+' in '+info.name+': '+String(error));}finally{db.close();}
    }
  }
  return JSON.stringify({version:1,url:location.href,origin:location.origin,scrollX:scrollX||0,scrollY:scrollY||0,fields,localStorage:[],sessionStorage:[],cookies:'',indexedDB:databases});
})()`;

function storageProbeExpression(key: string, reset: boolean): string {
  return `(function(){
    const key=${JSON.stringify(key)};
    let state=globalThis[key];
    const fresh=!state;
    if(fresh){state=Object.create(null);Object.defineProperty(globalThis,key,{value:state,configurable:false});}
    let supported=true;
    for(const name of ['localStorage','sessionStorage','indexedDB']){
      let owner=globalThis;
      while(owner&&!Object.getOwnPropertyDescriptor(owner,name))owner=Object.getPrototypeOf(owner);
      const descriptor=owner&&Object.getOwnPropertyDescriptor(owner,name);
      if(!descriptor||typeof descriptor.get!=='function'){supported=false;continue;}
      if(state[name+'Getter']!==descriptor.get){
        const original=descriptor.get;
        const getter=function(){state[name]=(state[name]||0)+1;return Reflect.apply(original,this,[]);};
        try{Object.defineProperty(owner,name,{...descriptor,get:getter});state[name+'Getter']=getter;}
        catch{supported=false;}
      }
    }
    const result={supported,fresh,localStorage:(state.localStorage||0)>0,sessionStorage:(state.sessionStorage||0)>0,indexedDB:(state.indexedDB||0)>0};
    if(${reset})state.localStorage=state.sessionStorage=state.indexedDB=0;
    return JSON.stringify(result);
  })()`;
}

const applyResumeState = (snapshot: unknown): string => `(async()=>{
  const s=${JSON.stringify(snapshot)};
  if(${isOpaqueHttpDocument})return JSON.stringify({restored:false});
  const restoreStorage=(getStore,entries)=>{const store=getStore();store.clear();for(const [key,value] of entries)store.setItem(key,value);};
  const origin=new URL(s.url).origin;
  const localEntries=s.localStorageByOrigin?.[origin]??s.localStorage;
  const sessionEntries=s.sessionStorageByOrigin?.[origin]??s.sessionStorage;
  restoreStorage(()=>localStorage,localEntries);restoreStorage(()=>sessionStorage,sessionEntries);
  if(s.cookies){for(const cookie of s.cookies.split(/;\\s*/)){if(cookie)try{document.cookie=cookie;}catch{}}}
  const decodeGraph=(graph)=>{const nodes=graph.nodes;const values=new Array(nodes.length);for(let i=0;i<nodes.length;i++){const node=nodes[i];switch(node.t){case'object':values[i]={};break;case'null-object':values[i]=Object.create(null);break;case'array':values[i]=[];break;case'map':values[i]=new Map();break;case'set':values[i]=new Set();break;case'date':values[i]=new Date(node.v&&node.v.t==='number'?NaN:node.v);break;case'regexp':values[i]=new RegExp(node.s,node.f);values[i].lastIndex=node.l;break;case'buffer':{const raw=atob(node.v);const bytes=Uint8Array.from(raw,(c)=>c.charCodeAt(0));values[i]=bytes.buffer;break;}case'blob':case'file':{const raw=atob(node.bytes);const bytes=Uint8Array.from(raw,(c)=>c.charCodeAt(0));values[i]=node.t==='file'?new File([bytes],node.name,{type:node.type,lastModified:node.lastModified}):new Blob([bytes],{type:node.type});break;}case'view':values[i]=null;break;}}
    const valueOf=(v)=>{if(v&&typeof v==='object'&&'r'in v)return values[v.r];if(v&&v.t==='undefined')return undefined;if(v&&v.t==='bigint')return BigInt(v.v);if(v&&v.t==='number')return v.v==='NaN'?NaN:v.v==='Infinity'?Infinity:v.v==='-Infinity'?-Infinity:-0;return v;};
    for(let i=0;i<nodes.length;i++){const node=nodes[i];if(node.t==='view'){const buffer=valueOf(node.b);const ctor=node.c==='DataView'?DataView:globalThis[node.c];if(typeof ctor!=='function')throw new TypeError('Unsupported IndexedDB typed array: '+node.c);values[i]=node.c==='DataView'?new DataView(buffer,node.o,node.l):new ctor(buffer,node.o,node.l);}}
    for(let i=0;i<nodes.length;i++){const node=nodes[i],target=values[i];if(node.t==='object'||node.t==='null-object')for(const [key,value] of node.e)Object.defineProperty(target,key,{value:valueOf(value),writable:true,enumerable:true,configurable:true});else if(node.t==='array'){target.length=node.l;for(let index=0;index<node.e.length;index++)if(!(node.e[index]&&node.e[index].t==='hole'))target[index]=valueOf(node.e[index]);}else if(node.t==='map')for(const [key,value] of node.e)target.set(valueOf(key),valueOf(value));else if(node.t==='set')for(const value of node.e)target.add(valueOf(value));}
    return valueOf(graph.root);};
  const restoreIndexedDB=async(databases,present)=>{if(!present||typeof indexedDB==='undefined')return;const expected=new Set(databases.map((database)=>database.name));for(const info of await indexedDB.databases())if(info.name&&!expected.has(info.name))await new Promise((resolve,reject)=>{const request=indexedDB.deleteDatabase(info.name);request.onsuccess=resolve;request.onerror=()=>reject(request.error);request.onblocked=()=>reject(new Error('IndexedDB database deletion was blocked.'));});for(const saved of databases){const db=await new Promise((resolve,reject)=>{const request=indexedDB.open(saved.name);request.onerror=()=>reject(request.error);request.onblocked=()=>reject(new Error('IndexedDB restore was blocked.'));request.onsuccess=()=>resolve(request.result);});
      const same=(left,right)=>JSON.stringify(left)===JSON.stringify(right);const schemaDiffers=db.objectStoreNames.length!==saved.stores.length||saved.stores.some((store)=>{if(!db.objectStoreNames.contains(store.name))return true;const existing=db.transaction(store.name,'readonly').objectStore(store.name);return !same(existing.keyPath,store.keyPath)||existing.autoIncrement!==store.autoIncrement||existing.indexNames.length!==store.indexes.length||store.indexes.some((index)=>{if(!existing.indexNames.contains(index.name))return true;const current=existing.index(index.name);return !same(current.keyPath,index.keyPath)||current.unique!==index.unique||current.multiEntry!==index.multiEntry;});});let version=db.version;db.close();
      const restored=await new Promise((resolve,reject)=>{const request=indexedDB.open(saved.name,schemaDiffers?Math.max(saved.version,version+1):version);request.onerror=()=>reject(request.error);request.onblocked=()=>reject(new Error('IndexedDB schema restore was blocked.'));request.onupgradeneeded=()=>{const target=request.result;for(const existingName of Array.from(target.objectStoreNames))if(!saved.stores.some((store)=>store.name===existingName))target.deleteObjectStore(existingName);for(const store of saved.stores){let objectStore;if(target.objectStoreNames.contains(store.name)){objectStore=request.transaction.objectStore(store.name);if(!same(objectStore.keyPath,store.keyPath)||objectStore.autoIncrement!==store.autoIncrement){target.deleteObjectStore(store.name);objectStore=target.createObjectStore(store.name,{keyPath:store.keyPath,autoIncrement:store.autoIncrement});}}else objectStore=target.createObjectStore(store.name,{keyPath:store.keyPath,autoIncrement:store.autoIncrement});for(const existingName of Array.from(objectStore.indexNames))if(!store.indexes.some((index)=>index.name===existingName))objectStore.deleteIndex(existingName);for(const index of store.indexes){if(objectStore.indexNames.contains(index.name)){const current=objectStore.index(index.name);if(!same(current.keyPath,index.keyPath)||current.unique!==index.unique||current.multiEntry!==index.multiEntry)objectStore.deleteIndex(index.name);}if(!objectStore.indexNames.contains(index.name))objectStore.createIndex(index.name,index.keyPath,{unique:index.unique,multiEntry:index.multiEntry});}}};request.onsuccess=()=>resolve(request.result);});
      try{for(const store of saved.stores){const objectStore=restored.transaction(store.name,'readwrite').objectStore(store.name);const tx=objectStore.transaction;objectStore.clear();for(const record of store.records){const value=decodeGraph(record.value);const key=decodeGraph(record.primaryKey);if(objectStore.keyPath===null)objectStore.put(value,key);else objectStore.put(value);}await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('IndexedDB restore transaction aborted.'));});}}finally{restored.close();}
    }};
  const databases=s.indexedDBByOrigin?.[origin]??s.indexedDB??[];
  await restoreIndexedDB(databases,s.indexedDBStatePresent??true);
  const nodeAt=(path)=>{let node=document.documentElement;for(const index of path){node=node?.children?.[index];if(!node)return null;}return node;};
  for(const field of s.fields){const node=nodeAt(field.path);if(!node)continue;try{if(field.kind==='checked')node.checked=field.value;else if(field.kind==='selected')Array.from(node.options).forEach((option,index)=>option.selected=Boolean(field.value[index]));else if(field.kind==='html')node.innerHTML=field.value;else{node.value=field.value;if(field.selectionStart!==null&&field.selectionStart!==undefined&&typeof node.setSelectionRange==='function')node.setSelectionRange(field.selectionStart,field.selectionEnd);}}catch{}}
  try{scrollTo(s.scrollX,s.scrollY);}catch{}
  return JSON.stringify({restored:true,hasStorage:localEntries.length+sessionEntries.length>0,hasCookies:Boolean(s.cookies),hasIndexedDBState:s.indexedDBStatePresent??databases.length>0,indexedDatabases:databases.length});
})()`;


export interface FakeEvalCall {
  script: string;
  result: unknown;
}

export interface FakeSummary {
  url?: string;
  title?: string;
  text?: string;
  invalid?: boolean;
}

export interface FakeRuntimeOptions {
  /** Value returned (or thrown) when no scripted evaluation matches. */
  evaluateDefault?: unknown;
  summary?: FakeSummary | FakeSummaryFn | (() => FakeSummary | FakeSummaryFn);
  resumeState?: ResumeStateScript[] | ((script: string) => ResumeStateScript);
  loadPageReturns?: boolean;
  loadHtmlReturns?: boolean;
  loadHtmlThrows?: Error;
  reloadReturns?: boolean;
  goBackReturns?: boolean;
  goForwardReturns?: boolean;
  pumpResult?: { settled: boolean };
  /** Optional factory consulted on every pump call (for scripted gating). */
  pumpFactory?: () => Promise<{ settled: boolean }>;
  pumpThrows?: Error;
  screenshotPng?: Uint8Array;
  screenshotThrows?: Error;
  pageReadyResult?: { ready: boolean; reason?: string };
  capabilitiesValue?: unknown;
  registerFontFaces?: number;
  resetThrows?: boolean;
  trapped?: boolean;
  pageResultValue?: unknown;
  evaluateThrows?: Error;
  /** Extra scripted evaluations keyed by exact script text. */
  evaluations?: Record<string, unknown>;
}

export type FakeSummaryFn = (script: string) => FakeSummary;

/** Scripted outcomes for the restore-state expression used while restoring. */
export interface ResumeStateScript {
  evaluatePageReturns?: boolean;
  pageResultValue?: unknown;
}

export class FakeServoRuntime {
  readonly calls: string[] = [];
  readonly evaluations: FakeEvalCall[] = [];
  readonly fonts: Uint8Array[] = [];
  readonly restoredCookies: Uint8Array[] = [];
  trapped: boolean;
  private evaluatePageCount = 0;
  private currentUrl = 'about:blank';
  private documentTimeOrigin = 1;
  private pendingNavigation: { fromUrl: string; targetUrl: string } | null = null;
  private capturedStorage: Record<string, [string, string][]> = {
    localStorage: [],
    sessionStorage: [],
  };
  private storageCaptures = new Map<string, [string, string][]>();

  constructor(private readonly options: FakeRuntimeOptions = {}) {
    this.trapped = options.trapped ?? false;
  }

  /** Contract fake for Servo-WASM's browser-owned requestHttp API. */
  async requestHttp(input: { url: string; method: string; headers?: Record<string, string>; body?: string; maxDurationMs: number }): Promise<any> {
    if (input.body !== undefined && new TextEncoder().encode(input.body).byteLength > 1048576)
      throw new RangeError('Request body exceeds 1 MiB');
    const name = Object.keys(input.headers ?? {}).find(h =>
      /^(authorization|proxy-authorization|cookie|cookie2|x-api-key|x-auth-token|x-access-token)$/i.test(h));
    if (name) throw new TypeError('Page-script HTTP cannot carry ' + name + ': page JavaScript could intercept it');
    const script = '(async () => {\n  const request = ' + JSON.stringify(input)
      + ';\n  return fetch(request.url); })()';
    const value: any = await this.evaluate(script, { maxDurationMs: input.maxDurationMs + 1000 });
    if (typeof value?.Ok?.String !== 'string') throw new Error('Invalid Servo HTTP response fixture');
    return JSON.parse(value.Ok.String);
  }

  private static decodeBrowserValue(result: unknown): unknown {
    if (result && typeof result === 'object' && 'Ok' in result) {
      const value = (result as { Ok?: { String?: unknown } }).Ok?.String;
      if (typeof value === 'string') {
        try { return JSON.parse(value); } catch { return result; }
      }
    }
    return result;
  }

  async captureWebStorage(storageName: 'localStorage' | 'sessionStorage'): Promise<[string, string][]> {
    const temporaryName = `__servoMcpStorageCapture_${crypto.randomUUID().replaceAll('-', '')}`;
    const temporaryKey = JSON.stringify(temporaryName);
    const setup = FakeServoRuntime.decodeBrowserValue(await this.evaluate(
      `(()=>{if(location.origin==='null')return JSON.stringify({opaque:true,count:0});const store=globalThis[${JSON.stringify(storageName)}];const keys=[];let chars=0;for(let i=0;i<store.length;i++){const key=store.key(i);if(key!==null){const value=String(store.getItem(key)??'');chars+=key.length+value.length;if(chars>${MAX_WEB_STORAGE_CAPTURE_CHARS})throw new RangeError('${storageName} exceeds the ${MAX_WEB_STORAGE_CAPTURE_CHARS} character snapshot safety limit.');keys.push(key);}}globalThis[${temporaryKey}]=keys;return JSON.stringify({count:keys.length});})()`,

    ));
    if (typeof setup !== 'object' || setup === null || !('count' in setup) || typeof setup.count !== 'number') {
      throw new Error(`Servo could not enumerate ${storageName}: ${JSON.stringify(setup).slice(0, 512)}`);
    }
    if ('opaque' in setup && setup.opaque === true) return [];

    const entries: [string, string][] = [];
    try {
      for (let index = 0; index < setup.count; index++) {
        let key = '';
        let value = '';
        let keyLength: number | undefined;
        let valueLength: number | undefined;
        for (let offset = 0; keyLength === undefined || offset < Math.max(keyLength, valueLength ?? 0); offset += STORAGE_CAPTURE_CHUNK_CHARS) {
          const piece = FakeServoRuntime.decodeBrowserValue(await this.evaluate(
            `JSON.stringify((()=>{const key=globalThis[${temporaryKey}]?.[${index}];if(typeof key!=='string')throw new Error('Storage changed during snapshot capture.');const value=globalThis[${JSON.stringify(storageName)}].getItem(key);if(value===null)throw new Error('Storage changed during snapshot capture.');return {keyLength:key.length,valueLength:value.length,key:key.slice(${offset},${offset + STORAGE_CAPTURE_CHUNK_CHARS}),value:value.slice(${offset},${offset + STORAGE_CAPTURE_CHUNK_CHARS})}})())`,

          ));
          if (typeof piece !== 'object' || piece === null || !('key' in piece) || typeof piece.key !== 'string'
            || !('value' in piece) || typeof piece.value !== 'string'
            || !('keyLength' in piece) || typeof piece.keyLength !== 'number'
            || !('valueLength' in piece) || typeof piece.valueLength !== 'number') {
            throw new Error(`Servo could not read ${storageName} entry ${index}: ${JSON.stringify(piece).slice(0, 512)}`);
          }
          if (keyLength !== undefined && (keyLength !== piece.keyLength || valueLength !== piece.valueLength)) {
            throw new Error(`${storageName} changed during snapshot capture.`);
          }
          keyLength = piece.keyLength;
          valueLength = piece.valueLength;
          key += piece.key;
          value += piece.value;
        }
        entries.push([key, value]);
      }
    } finally {
      await this.evaluate(`delete globalThis[${temporaryKey}]`).catch(() => undefined);
    }
    return entries;
  }


  async captureResumeState({ captureIndexedDB = true } = {}): Promise<unknown> {
    return FakeServoRuntime.decodeBrowserValue(await this.evaluate(resumeStateExpression(captureIndexedDB)));
  }

  private static selectResumeStateForOrigin(snapshot: any, url: string): any {
    const origin = new URL(url).origin;
    const snapshotOrigin = snapshot.origin ?? new URL(snapshot.url).origin;
    const mapped = snapshot.localStorageByOrigin !== undefined ||
      snapshot.sessionStorageByOrigin !== undefined || snapshot.indexedDBByOrigin !== undefined;
    return {
      ...snapshot, url,
      fields: snapshot.url === url ? snapshot.fields : [],
      scrollX: snapshot.url === url ? snapshot.scrollX : 0,
      scrollY: snapshot.url === url ? snapshot.scrollY : 0,
      localStorage: mapped ? snapshot.localStorageByOrigin?.[origin] ?? [] : origin === snapshotOrigin ? snapshot.localStorage : [],
      sessionStorage: mapped ? snapshot.sessionStorageByOrigin?.[origin] ?? [] : origin === snapshotOrigin ? snapshot.sessionStorage : [],
      cookies: snapshot.url === url ? snapshot.cookies : '',
      indexedDB: mapped ? snapshot.indexedDBByOrigin?.[origin] ?? [] : origin === snapshotOrigin ? snapshot.indexedDB ?? [] : [],
      indexedDBStatePresent: snapshot.indexedDBByOrigin !== undefined
        ? Object.hasOwn(snapshot.indexedDBByOrigin, origin)
        : origin === snapshotOrigin && snapshot.indexedDB !== undefined,
      localStorageByOrigin: undefined,
      sessionStorageByOrigin: undefined,
      indexedDBByOrigin: undefined,
      originAssets: undefined,
    };
  }

  async restoreBrowserTab({ snapshot, url = snapshot.url, inlineHtml }: {
    snapshot: any; url?: string; inlineHtml?: string;
  }): Promise<{ restored: true; url: string }> {
    const blank = url === 'about:blank';
    const inline = inlineHtml !== undefined;
    const loaded = blank || (inline ? this.loadHtml(inlineHtml, { url }) : this.loadPage(url));
    if (!loaded) throw new Error('Servo could not reopen the saved tab URL.');
    let restored: any;
    if (!blank) {
      const commit = await this.waitForNavigationCommit({ url: 'about:blank', timeOrigin: null });
      if (!commit.committed) throw new Error('Saved document navigation did not commit.');
      const ready = await this.waitForPageReady({});
      if (!ready.ready) throw new Error('Saved browser document did not become ready.');
      restored = await this.restoreResumeState(snapshot, url);
      await this.pumpCooperatively();
    }
    if (!inline && !blank && (restored?.hasStorage || restored?.hasCookies ||
        restored?.hasIndexedDBState || restored?.indexedDatabases)) {
      if (!this.reload()) throw new Error('Servo could not reload the restored tab.');
      await this.pumpCooperatively();
      await this.restoreResumeState(snapshot, url);
      await this.pumpCooperatively();
    }
    return { restored: true, url };
  }

  hasSavedOrigin(snapshot: any, url: string): boolean {
    const origin = new URL(url).origin;
    return Object.hasOwn(snapshot.localStorageByOrigin ?? {}, origin) ||
      Object.hasOwn(snapshot.sessionStorageByOrigin ?? {}, origin) ||
      Object.hasOwn(snapshot.indexedDBByOrigin ?? {}, origin) ||
      (snapshot.origin ?? new URL(snapshot.url).origin) === origin;
  }

  async reloadDocument({ readiness = {}, inlineHtml, rejectionMessage = 'Servo rejected document reload.' }: {
    readiness?: unknown; inlineHtml?: string; rejectionMessage?: string;
  } = {}): Promise<void> {
    const before = await this.navigationIdentity();
    if (inlineHtml !== undefined && before.url) {
      await this.navigateHtml(inlineHtml, { url: before.url, readiness });
      return;
    }
    if (!this.reload()) throw new Error(rejectionMessage);
    const committed = await this.waitForNavigationCommit(before);
    if (!committed.committed) throw new Error('Servo reload did not commit a document.');
    const ready = await this.waitForPageReady(readiness);
    if (!ready.ready) throw new Error('Servo document readiness timed out after reload.');
  }

  async restoreResumeState(snapshot: unknown, url = (snapshot as { url: string }).url): Promise<unknown> {
    return FakeServoRuntime.decodeBrowserValue(await this.evaluate(applyResumeState(FakeServoRuntime.selectResumeStateForOrigin(snapshot, url))));
  }

  async probeStorage(key: string, reset = false): Promise<unknown> {
    return FakeServoRuntime.decodeBrowserValue(await this.evaluate(storageProbeExpression(key, reset)));
  }

  async pageSummary(): Promise<{ url: string; title: string; text: string }> {
    const result: any = await this.evaluate('JSON.stringify({url: location.href, title: document.title, text: ""})');
    if (typeof result?.Ok?.String !== 'string') throw new Error('Servo returned an invalid page summary.');
    const value = JSON.parse(result.Ok.String);
    if (typeof value.url !== 'string' || typeof value.title !== 'string' || typeof value.text !== 'string')
      throw new Error('Servo returned an invalid page summary.');
    return value;
  }

  async documentHtml(): Promise<string> {
    const result: any = await this.evaluate("JSON.stringify((document.documentElement?.outerHTML ?? '').slice(0, 512000))");
    if (typeof result?.Ok?.String !== 'string') throw new Error('Servo did not return the document HTML.');
    const value = JSON.parse(result.Ok.String);
    if (typeof value !== 'string') throw new Error('Servo did not return the document HTML.');
    return value;
  }

  setInitialUrl(url: string): void {
    this.currentUrl = url;
    this.pendingNavigation = null;
    this.documentTimeOrigin++;
  }

  private resumeStep(): ResumeStateScript {
    const script = this.options.resumeState;
    // Always advance the step counter, even when no steps are scripted, so
    // `pageResult()` calls that occur before any `evaluatePage()` (e.g. during
    // restore reloads) consume the correct scripted entry.
    const index = this.evaluatePageCount++;
    if (!script) return {};
    if (typeof script === 'function') return script(String(index));
    return script[Math.min(index, script.length - 1)] ?? {};
  }

  private currentSummary(script: string): FakeSummary {
    const configuredSummary = this.options.summary;
    let summary = configuredSummary;
    if (typeof configuredSummary === 'function') {
      summary = configuredSummary.length === 0
        ? (configuredSummary as () => FakeSummary | FakeSummaryFn)()
        : (configuredSummary as FakeSummaryFn)(script);
    }
    if (typeof summary === 'function') summary = (summary as FakeSummaryFn)(script);
    if (summary) return summary;
    return { url: this.currentUrl };
  }

  private summaryJson(script: string): string {
    const summary = this.currentSummary(script);
    if (summary.invalid) return JSON.stringify({ nope: true });
    return JSON.stringify({
      url: summary.url ?? 'about:blank',
      title: summary.title ?? '',
      text: summary.text ?? '',
    });
  }

  private scriptedEvaluation(script: string): { hit: boolean; value?: unknown } {
    const table = this.options.evaluations;
    if (!table) return { hit: false };
    if (script in table) return { hit: true, value: table[script] };
    // Prefix matching lets tests target the long built-in page-summary and
    // restore-state expressions without pasting their full text.
    for (const key of Object.keys(table)) {
      if (key.length > 0 && key !== '*' && script.startsWith(key)) return { hit: true, value: table[key] };
    }
    if ('*' in table) return { hit: true, value: table['*'] };
    return { hit: false };
  }

  evaluate(script: string, _opts?: { maxDurationMs?: number }): Promise<unknown> {
    this.calls.push('evaluate');
    const scripted = this.scriptedEvaluation(script);
    if (script.includes('const nodePath=')) {
      const payload = scripted.hit ? scripted.value : validResumeStateValue;
      let resumeState: unknown = payload;
      if (payload && typeof payload === 'object' && 'Ok' in payload) {
        const raw = (payload as { Ok?: { String?: unknown } }).Ok?.String;
        if (typeof raw === 'string') {
          try { resumeState = JSON.parse(raw); } catch { /* leave malformed state for the caller to report */ }
        }
      }
      if (resumeState && typeof resumeState === 'object') {
        const state = resumeState as { localStorage?: [string, string][]; sessionStorage?: [string, string][] };
        this.capturedStorage = {
          localStorage: state.localStorage ?? [],
          sessionStorage: state.sessionStorage ?? [],
        };
      }
    }
    if (scripted.hit) {
      this.evaluations.push({ script, result: scripted.value });
      return Promise.resolve(scripted.value);
    }
    if (script.startsWith('JSON.stringify({url: location.href, timeOrigin: performance.timeOrigin}')) {
      const summary = this.currentSummary(script);
      const value = { Ok: { String: JSON.stringify({
        url: summary.url ?? this.currentUrl,
        timeOrigin: this.documentTimeOrigin,
      }) } };
      this.evaluations.push({ script, result: value });
      return Promise.resolve(value);
    }
    if (script.startsWith('JSON.stringify({url: location.href')) {
      const value: unknown = { Ok: { String: this.summaryJson(script) } };
      this.evaluations.push({ script, result: value });
      return Promise.resolve(value);
    }
    if (this.options.evaluateThrows) return Promise.reject(this.options.evaluateThrows);
    if (script.includes('const nodePath=')) {
      // Default scripted restore state so captureSnapshot succeeds unless the
      // test explicitly scripts that expression via `evaluations`.
      const value: unknown = validResumeStateValue;
      this.evaluations.push({ script, result: value });
      return Promise.resolve(value);
    }
    if (script.includes("location.origin==='null'") && script.includes('const store=globalThis[')) {
      const storageName = script.match(/const store=globalThis\[("localStorage"|"sessionStorage")\]/)?.[1];
      const temporaryName = script.match(/globalThis\[("__servoMcpStorageCapture_[^"]+")\]=(?:entries|keys)/)?.[1];
      if (!storageName || !temporaryName) return Promise.resolve(null);
      const entries = this.capturedStorage[JSON.parse(storageName)] ?? [];
      this.storageCaptures.set(JSON.parse(temporaryName), entries);
      const value = { Ok: { String: JSON.stringify({ count: entries.length }) } };
      this.evaluations.push({ script, result: value });
      return Promise.resolve(value);
    }
    if (script.includes('const entry=globalThis[') || script.includes('const key=globalThis[')) {
      const temporaryName = script.match(/const entry=globalThis\[("__servoMcpStorageCapture_[^"]+")\]/)?.[1];
      const keyTemporaryName = script.match(/const key=globalThis\[("__servoMcpStorageCapture_[^"]+")\]/)?.[1];
      const storageNameLiteral = script.match(/globalThis\[("localStorage"|"sessionStorage")\]/)?.[1];
      const storageName = storageNameLiteral === undefined ? undefined : JSON.parse(storageNameLiteral) as 'localStorage' | 'sessionStorage';
      const index = Number(script.match(/\?\.\[(\d+)\]/)?.[1]);
      const offset = Number(script.match(/\.slice\((\d+),/)?.[1]);
      const entry = temporaryName === undefined ? undefined : this.storageCaptures.get(JSON.parse(temporaryName))?.[index];
      const key = keyTemporaryName === undefined ? undefined : this.storageCaptures.get(JSON.parse(keyTemporaryName))?.[index]?.[0];
      const valueEntry = storageName === undefined || key === undefined ? undefined : this.capturedStorage[storageName]?.find(([storedKey]) => storedKey === key);
      const selected = entry ?? valueEntry;
      if (!selected) return Promise.resolve(null);
      const value = {
        keyLength: selected[0].length,
        valueLength: selected[1].length,
        key: selected[0].slice(offset, offset + 32_768),
        value: selected[1].slice(offset, offset + 32_768),
      };
      const result = { Ok: { String: JSON.stringify(value) } };
      this.evaluations.push({ script, result });
      return Promise.resolve(result);
    }
    if (script.startsWith('delete globalThis[')) {
      const temporaryName = script.match(/delete globalThis\[("__servoMcpStorageCapture_[^"]+")\]/)?.[1];
      if (temporaryName) this.storageCaptures.delete(JSON.parse(temporaryName));
      this.evaluations.push({ script, result: null });
      return Promise.resolve(null);
    }
    if (script.startsWith('(async()=>{')) {
      const step = this.resumeStep();
      this.calls.push('evaluatePage');
      this.calls.push('pageResult');
      let value = step.evaluatePageReturns === false
        ? { Err: 'could not apply the saved tab state' }
        : step.pageResultValue ?? this.options.pageResultValue ?? { Ok: { String: '{"restored":true,"hasStorage":false,"hasCookies":false,"hasIndexedDBState":false,"indexedDatabases":0}' } };
      if (value && typeof value === 'object' && 'Ok' in value) {
        const raw = (value as { Ok?: { String?: unknown } }).Ok?.String;
        if (typeof raw === 'string') {
          try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && !('restored' in parsed)) {
              value = { Ok: { String: JSON.stringify({ restored: true, ...parsed }) } };
            }
          } catch { /* preserve scripted malformed JSON for error-path tests */ }
        }
      }
      this.evaluations.push({ script, result: value });
      return Promise.resolve(value);
    }
    const value = this.options.evaluateDefault ?? null;
    this.evaluations.push({ script, result: value });
    return Promise.resolve(value);
  }

  evaluatePage(_script: string): boolean {
    this.calls.push('evaluatePage');
    return this.resumeStep().evaluatePageReturns ?? true;
  }

  pageResult(): unknown {
    this.calls.push('pageResult');
    const scripted = this.resumeStep();
    if ('pageResultValue' in scripted) return scripted.pageResultValue;
    return this.options.pageResultValue ?? { Ok: { String: '{"restored":true,"hasStorage":false,"hasCookies":false}' } };
  }

  pumpUntilSettled(_opts?: { maxDurationMs?: number; maxTurns?: number; networkIdleMs?: number }): Promise<{ settled: boolean }> {
    this.calls.push('pump');
    if (this.options.pumpFactory) return this.options.pumpFactory();
    if (this.options.pumpThrows) return Promise.reject(this.options.pumpThrows);
    return Promise.resolve(this.options.pumpResult ?? { settled: true });
  }

  pumpCooperatively(_opts?: { maxTurns?: number }): Promise<{ ready: boolean; turns: number; pendingFetches: number; timersPending: boolean }> {
    this.calls.push('pump');
    const finishPump = () => {
      if (this.pendingNavigation) {
        const summary = this.currentSummary('');
        const url = summary.url ?? this.currentUrl;
        // The fake treats the requested URL or a changed final URL as a committed document.
        if (url === this.pendingNavigation.targetUrl || url !== this.pendingNavigation.fromUrl) {
          this.documentTimeOrigin++;
          this.pendingNavigation = null;
        }
      }
      const settled = this.options.pumpResult?.settled ?? true;
      return { ready: true, turns: 1, pendingFetches: settled ? 0 : 1, timersPending: !settled };
    };
    if (this.options.pumpFactory) return this.options.pumpFactory().then(finishPump);
    if (this.options.pumpThrows) return Promise.reject(this.options.pumpThrows);
    return Promise.resolve(finishPump());
  }


  navigationIdentity(): Promise<{ url: string; timeOrigin: number }> {
    const url = this.currentSummary('').url ?? this.currentUrl;
    this.calls.push('navigationIdentity');
    return Promise.resolve({ url, timeOrigin: this.documentTimeOrigin });
  }

  async waitForNavigationCommit(
    before: { url: string; timeOrigin: number | null },
    _opts?: { maxDurationMs?: number },
  ): Promise<{ committed: boolean; url: string }> {
    this.calls.push('waitForNavigationCommit');
    for (let attempt = 0; attempt < 30; attempt++) {
      await this.pumpCooperatively();
      const current = await this.navigationIdentity();
      if (current.url !== 'about:blank' &&
          (before.timeOrigin === null
            ? current.url !== before.url
            : current.timeOrigin !== before.timeOrigin)) {
        return { committed: true, url: current.url };
      }
      await Promise.resolve();
    }
    return { committed: false, url: (await this.navigationIdentity()).url };
  }

  async waitForPageReady(_options?: unknown): Promise<{ ready: boolean; reason: string }> {
    this.calls.push('waitForPageReady');
    return { ready: this.options.pageReadyResult?.ready ?? true,
      reason: this.options.pageReadyResult?.reason ?? 'domquiet' };
  }

  async navigate(url: string, options?: unknown): Promise<{ ready: boolean; reason: string }> {
    const before = await this.navigationIdentity();
    if (!this.loadPage(url)) throw new Error('Servo rejected the requested URL');
    const commit = await this.waitForNavigationCommit(before);
    if (!commit.committed) throw new Error('Navigation did not commit: ' + commit.url);
    const ready = await this.waitForPageReady(options);
    if (!ready.ready) throw new Error('Document readiness timed out: ' + ready.reason);
    return ready;
  }

  async navigateHtml(html: string, options?: { url?: string; readiness?: unknown }): Promise<{ ready: boolean; reason: string }> {
    if (!this.loadHtml(html, { url: options?.url })) throw new Error('Servo rejected the supplied HTML');
    this.currentUrl = options?.url ?? 'https://servo-inline.invalid/';
    this.documentTimeOrigin++;
    await this.pumpCooperatively();
    const ready = await this.waitForPageReady(options?.readiness);
    if (!ready.ready) throw new Error('Inline document readiness timed out');
    return ready;
  }

  loadPage(url: string): boolean {
    this.calls.push(`loadPage:${url}`);
    const accepted = this.options.loadPageReturns ?? true;
    if (accepted) {
      const fromUrl = this.currentSummary('').url ?? this.currentUrl;
      this.pendingNavigation = { fromUrl, targetUrl: url };
      this.currentUrl = url;
    }
    return accepted;
  }

  loadHtml(html: string, _opts?: { url?: string }): boolean {
    this.calls.push(`loadHtml:${html.slice(0, 32)}`);
    if (this.options.loadHtmlThrows) throw this.options.loadHtmlThrows;
    return this.options.loadHtmlReturns ?? true;
  }

  reload(): boolean {
    this.calls.push('reload');
    const accepted = this.options.reloadReturns ?? true;
    if (accepted) {
      const current = this.currentSummary('').url ?? this.currentUrl;
      this.pendingNavigation = { fromUrl: current, targetUrl: current };
    }
    return accepted;
  }

  goBack(): boolean {
    this.calls.push('goBack');
    return this.options.goBackReturns ?? true;
  }

  goForward(): boolean {
    this.calls.push('goForward');
    return this.options.goForwardReturns ?? true;
  }

  click(x: number, y: number, button = 0): void {
    this.calls.push(`click:${x}:${y}:${button}`);
  }

  typeText(text: string): void {
    this.calls.push(`typeText:${text}`);
  }

  pressKey(key: string): void {
    this.calls.push(`pressKey:${key}`);
  }

  scrollBy(deltaX: number, deltaY: number, point?: { x?: number; y?: number }): void {
    this.calls.push(`scrollBy:${deltaX}:${deltaY}:${point?.x}:${point?.y}`);
  }

  async screenshot(_options?: { fullPage?: boolean; maxDurationMs?: number; readiness?: unknown }): Promise<Uint8Array> {
    this.calls.push('screenshot');
    if (this.options.screenshotThrows) throw this.options.screenshotThrows;
    return this.options.screenshotPng ?? new Uint8Array([1, 2, 3]);
  }

  capabilities(): unknown {
    this.calls.push('capabilities');
    return this.options.capabilitiesValue ?? { supported: ['dom'] };
  }

  registerFont(bytes: Uint8Array): number {
    this.calls.push('registerFont');
    this.fonts.push(bytes);
    return this.options.registerFontFaces ?? 1;
  }

  exportCookieState(): Uint8Array {
    this.calls.push('exportCookieState');
    return new Uint8Array([1, 2, 3]);
  }

  restoreCookieState(bytes: Uint8Array): void {
    this.calls.push('restoreCookieState');
    this.restoredCookies.push(bytes);
  }

  reset(): void {
    this.calls.push('reset');
    if (this.options.resetThrows) throw new Error('fake reset failed');
  }
}

/** A summary object missing required keys, used to trigger validation errors. */
export const invalidSummary = { nope: true };

/** The default valid restore-state payload returned by scripted evaluations. */
const validResumeStateValue = {
  Ok: {
    String: JSON.stringify({
      version: 1,
      url: 'https://public.example/page',
      scrollX: 0,
      scrollY: 0,
      fields: [],
      localStorage: [],
      sessionStorage: [],
      cookies: '',
    }),
  },
};

export function snapshotScriptMarker(): string {
  return 'JSON.stringify((()=>';
}
