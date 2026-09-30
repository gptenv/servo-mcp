import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import servoWasm from '../servo-wasm/target/wasm32-unknown-unknown/production-stripped/servo_js_wasm.wasm';
import { createServoWorkerRuntime } from '../servo-wasm/ports/servo-js-wasm/worker-adapter.mjs';
import { assertPublicHttpUrl, assertPublicWebSocketUrl } from './security';

const MAX_PERSISTED_HTML_BYTES = 1 * 1024 * 1024;
const MAX_SCRIPT_BYTES = 64 * 1024;
const MAX_TOOL_DURATION_MS = 15_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const SESSION_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ASSET_CHUNK_CHARS = 1_000_000;
const SNAPSHOT_CHUNK_CHARS = 200_000;
const STORAGE_CAPTURE_CHUNK_CHARS = 32_768;
const pageSummaryExpression = `JSON.stringify({url: location.href, title: document.title, text: (document.body?.innerText || '').slice(0, 20000)})`;
const resumeStateExpression = `(async()=>{
  const nodePath=(node)=>{const path=[];for(let current=node;current&&current!==document.documentElement;current=current.parentElement){const parent=current.parentElement;if(!parent)return null;path.unshift(Array.prototype.indexOf.call(parent.children,current));}return path;};
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
  if(location.origin!=='null'&&typeof indexedDB!=='undefined'&&typeof indexedDB.databases==='function'){
    let infos;try{infos=await indexedDB.databases();}catch(error){throw new Error('IndexedDB snapshot could not list databases: '+String(error));}
    for(const info of infos){if(typeof info.name!=='string')continue;let db;try{db=await new Promise((resolve,reject)=>{const request=indexedDB.open(info.name);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);request.onblocked=()=>reject(new Error('IndexedDB database enumeration was blocked.'));});}catch(error){throw new Error('IndexedDB snapshot could not open '+info.name+': '+String(error));}
      let stage='reading schema';try{const stores=[];const names=Array.from(db.objectStoreNames);if(names.length){const tx=db.transaction(names,'readonly');const pending=[];for(const name of names){stage='reading records from '+name;const store=tx.objectStore(name);const indexes=Array.from(store.indexNames,(indexName)=>{const index=store.index(indexName);return {name:index.name,keyPath:index.keyPath,unique:index.unique,multiEntry:index.multiEntry};});const storeData={name:store.name,keyPath:store.keyPath,autoIncrement:store.autoIncrement,indexes,records:[]};stores.push(storeData);pending.push(new Promise((resolve,reject)=>{let keys,values;const collect=()=>{if(keys===undefined||values===undefined)return;if(keys.length!==values.length){reject(new Error('IndexedDB returned mismatched record keys and values.'));return;}for(let index=0;index<keys.length;index++)storeData.records.push({primaryKey:keys[index],value:values[index]});resolve();};const keyRequest=store.getAllKeys();const valueRequest=store.getAll();keyRequest.onerror=()=>reject(keyRequest.error);valueRequest.onerror=()=>reject(valueRequest.error);keyRequest.onsuccess=()=>{keys=keyRequest.result;collect();};valueRequest.onsuccess=()=>{values=valueRequest.result;collect();};}));}await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('IndexedDB snapshot transaction aborted.'));});await Promise.all(pending);stage='serializing records';for(const store of stores){for(const record of store.records){record.primaryKey=await encodeGraph(record.primaryKey);record.value=await encodeGraph(record.value);}}}
        databases.push({name:db.name,version:db.version,stores});
      }catch(error){throw new Error('IndexedDB snapshot failed while '+stage+' in '+info.name+': '+String(error));}finally{db.close();}
    }
  }
  return JSON.stringify({version:1,url:location.href,origin:location.origin,scrollX:scrollX||0,scrollY:scrollY||0,fields,localStorage:[],sessionStorage:[],cookies:'',indexedDB:databases});
})()`;

type ResumeField = { path: number[]; kind: 'checked' | 'selected' | 'html' | 'value'; value: boolean | boolean[] | string; selectionStart?: number | null; selectionEnd?: number | null };
type ResumeSnapshot = {
  version: 1;
  url: string;
  scrollX: number;
  scrollY: number;
  fields: ResumeField[];
  localStorage: [string, string][];
  sessionStorage: [string, string][];
  cookies: string;
  cookieState?: string;
  indexedDB?: IndexedDatabaseSnapshot[];
  origin?: string;
  localStorageByOrigin?: Record<string, [string, string][]>;
  sessionStorageByOrigin?: Record<string, [string, string][]>;
  indexedDBByOrigin?: Record<string, IndexedDatabaseSnapshot[]>;
  indexedDBStatePresent?: boolean;
  originAssets?: Record<string, string>;
};

type PersistedSnapshotHeader = {
  version: 3;
  url: string;
  origin: string;
  scrollX: number;
  scrollY: number;
  fields: ResumeField[];
  cookies: string;
  cookieState?: string;
  originAssets: Record<string, string>;
};

type OriginStorageSnapshot = {
  localStorage: [string, string][];
  sessionStorage: [string, string][];
  indexedDB: IndexedDatabaseSnapshot[];
};

type IndexedDatabaseSnapshot = {
  name: string;
  version: number;
  stores: Array<{
    name: string;
    keyPath: string | string[] | null;
    autoIncrement: boolean;
    indexes: Array<{ name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean }>;
    records: Array<{ primaryKey: EncodedGraph; value: EncodedGraph }>;
  }>;
};
type EncodedGraph = { root: unknown; nodes: Array<Record<string, unknown> | null> };

export const browserSessionOptionsSchema = z.object({
  sessionId: z.string().uuid(),
  url: z.string().url().max(2048).optional(),
  html: z.string().max(MAX_PERSISTED_HTML_BYTES).optional(),
  width: z.number().int().min(320).max(1920).default(1280),
  height: z.number().int().min(240).max(1600).default(720),
  fontBase64: z.string().max(44_739_244).optional(),
  maxDurationMs: z.number().int().min(100).max(MAX_TOOL_DURATION_MS).default(10_000),
}).refine((value) => !(value.url && value.html !== undefined), {
  message: 'Provide a URL or inline HTML, not both.',
});

export type BrowserSessionOptions = z.infer<typeof browserSessionOptionsSchema>;
type ServoRuntime = Awaited<ReturnType<typeof createServoWorkerRuntime>>;
type SessionStatus = 'active' | 'closed' | 'expired' | 'interrupted' | 'failed';
type SessionRow = {
  status: SessionStatus;
  created_at: number;
  updated_at: number;
  expires_at: number;
  width: number;
  height: number;
};

export type PageSummary = { url: string; title: string; text: string; loadError?: string };
export type BrowserActionResult = { action: string; page: PageSummary };

function parseEvaluationResult(result: unknown): unknown {
  if (typeof result !== 'object' || result === null || !('Ok' in result)) return result;
  const value = (result as { Ok?: { String?: unknown } }).Ok?.String;
  if (typeof value !== 'string') return result;
  try { return JSON.parse(value); } catch { return result; }
}

async function publicFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = assertPublicHttpUrl(input instanceof Request ? input.url : String(input));
  return fetch(url, { ...init, redirect: 'manual' });
}

function publicWebSocket(url: string, protocols?: string | string[]): WebSocket {
  return new WebSocket(assertPublicWebSocketUrl(url), protocols);
}

async function pump(runtime: ServoRuntime, maxDurationMs: number): Promise<void> {
  const result = await runtime.pumpUntilSettled({ maxDurationMs, maxTurns: 2_000, networkIdleMs: 250 });
  if (!result.settled) throw new Error(`Servo did not settle within ${maxDurationMs} ms.`);
}

async function pageSummary(runtime: ServoRuntime): Promise<PageSummary> {
  const parsed = parseEvaluationResult(await runtime.evaluate(pageSummaryExpression, { maxDurationMs: 10_000 }));
  if (typeof parsed !== 'object' || parsed === null || !('url' in parsed) || !('title' in parsed) || !('text' in parsed)) {
    throw new Error('Servo returned an invalid page summary.');
  }
  return parsed as PageSummary;
}

function parseJsonResult(runtime: ServoRuntime): unknown {
  const result = parseEvaluationResult(runtime.pageResult());
  if (typeof result === 'string') {
    try { return JSON.parse(result); } catch { return result; }
  }
  return result;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

const applyResumeState = (snapshot: ResumeSnapshot): string => `(async()=>{
  const s=${JSON.stringify(snapshot)};
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

function snapshotForOrigin(snapshot: ResumeSnapshot, url: string): ResumeSnapshot {
  const origin = new URL(url).origin;
  const snapshotOrigin = snapshot.origin ?? new URL(snapshot.url).origin;
  const hasOriginMaps = snapshot.localStorageByOrigin !== undefined
    || snapshot.sessionStorageByOrigin !== undefined
    || snapshot.indexedDBByOrigin !== undefined;
  return {
    ...snapshot,
    url,
    fields: snapshot.url === url ? snapshot.fields : [],
    scrollX: snapshot.url === url ? snapshot.scrollX : 0,
    scrollY: snapshot.url === url ? snapshot.scrollY : 0,
    localStorage: hasOriginMaps ? snapshot.localStorageByOrigin?.[origin] ?? [] : origin === snapshotOrigin ? snapshot.localStorage : [],
    sessionStorage: hasOriginMaps ? snapshot.sessionStorageByOrigin?.[origin] ?? [] : origin === snapshotOrigin ? snapshot.sessionStorage : [],
    cookies: snapshot.url === url ? snapshot.cookies : '',
    indexedDB: hasOriginMaps ? snapshot.indexedDBByOrigin?.[origin] ?? [] : origin === snapshotOrigin ? snapshot.indexedDB ?? [] : [],
    indexedDBStatePresent: snapshot.indexedDBByOrigin !== undefined
      ? Object.hasOwn(snapshot.indexedDBByOrigin, origin)
      : origin === snapshotOrigin && snapshot.indexedDB !== undefined,
    localStorageByOrigin: undefined,
    sessionStorageByOrigin: undefined,
    indexedDBByOrigin: undefined,
    originAssets: undefined,
  };
}

export class ServoBrowserSession extends DurableObject<Env> {
  private runtime: ServoRuntime | undefined;
  private queue: Promise<void> = Promise.resolve();
  // Host fetch failures (DNS, TLS, connection errors) during the current
  // operation, keyed by URL, so a failed page load is reported to the caller.
  private fetchFailures = new Map<string, string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS browser_session (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          width INTEGER NOT NULL,
          height INTEGER NOT NULL
        )
      `);
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS browser_snapshot (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          snapshot_json TEXT NOT NULL
        )
      `);
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS browser_asset (
          name TEXT NOT NULL,
          chunk_index INTEGER NOT NULL,
          chunk_text TEXT NOT NULL,
          PRIMARY KEY (name, chunk_index)
        )
      `);
    });
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private row(): SessionRow | undefined {
    return this.ctx.storage.sql.exec<SessionRow>(
      'SELECT status, created_at, updated_at, expires_at, width, height FROM browser_session WHERE singleton = 1',
    ).toArray()[0];
  }

  private writeStatus(status: SessionStatus, expiresAt = Date.now()): void {
    this.ctx.storage.sql.exec(
      'UPDATE browser_session SET status = ?, updated_at = ?, expires_at = ? WHERE singleton = 1',
      status, Date.now(), expiresAt,
    );
  }

  private storeAsset(name: string, value: string, chunkChars = ASSET_CHUNK_CHARS): void {
    this.ctx.storage.sql.exec('DELETE FROM browser_asset WHERE name = ?', name);
    let chunkIndex = 0;
    for (let offset = 0; offset < value.length; chunkIndex++) {
      let end = Math.min(offset + chunkChars, value.length);
      if (end < value.length && end > offset && value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff) end--;
      this.ctx.storage.sql.exec(
        'INSERT INTO browser_asset (name, chunk_index, chunk_text) VALUES (?, ?, ?)',
        name, chunkIndex, value.slice(offset, end),
      );
      offset = end;
    }
  }

  private readAsset(name: string): string | undefined {
    const chunks = this.ctx.storage.sql.exec<{ chunk_text: string }>(
      'SELECT chunk_text FROM browser_asset WHERE name = ? ORDER BY chunk_index', name,
    ).toArray();
    return chunks.length ? chunks.map((chunk) => chunk.chunk_text).join('') : undefined;
  }

  private snapshotRecord(): { json: string; value: Record<string, unknown> } | undefined {
    const json = this.ctx.storage.sql.exec<{ snapshot_json: string }>(
      'SELECT snapshot_json FROM browser_snapshot WHERE singleton = 1',
    ).toArray()[0]?.snapshot_json;
    if (!json) return undefined;
    return { json, value: JSON.parse(json) as Record<string, unknown> };
  }

  private loadSnapshot(url?: string): ResumeSnapshot | undefined {
    const record = this.snapshotRecord();
    if (!record) return undefined;
    if (record.value.version === 3 && typeof record.value.url === 'string'
      && typeof record.value.origin === 'string' && typeof record.value.originAssets === 'object'
      && record.value.originAssets !== null) {
      const header = record.value as unknown as PersistedSnapshotHeader;
      const targetUrl = url ?? header.url;
      const origin = new URL(targetUrl).origin;
      const assetName = header.originAssets[origin];
      if (!assetName) return undefined;
      const data = this.readAsset(assetName);
      if (!data) throw new Error(`Browser restore data for ${origin} is missing.`);
      const storage = JSON.parse(data) as OriginStorageSnapshot;
      return {
        version: 1,
        url: targetUrl,
        origin,
        scrollX: targetUrl === header.url ? header.scrollX : 0,
        scrollY: targetUrl === header.url ? header.scrollY : 0,
        fields: targetUrl === header.url ? header.fields : [],
        cookies: header.cookies,
        cookieState: header.cookieState,
        localStorage: storage.localStorage,
        sessionStorage: storage.sessionStorage,
        indexedDB: storage.indexedDB,
        indexedDBStatePresent: true,
        originAssets: header.originAssets,
      };
    }

    let text = record.json;
    try {
      const pointer = record.value as { version?: number; assetName?: string };
      if (pointer.version === 2 && typeof pointer.assetName === 'string') {
        const chunked = this.readAsset(pointer.assetName);
        if (!chunked) throw new Error('Browser restore snapshot data is missing.');
        text = chunked;
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'Browser restore snapshot data is missing.') throw error;
      // Snapshot version 1 stored the full JSON directly in this column.
    }
    const value = JSON.parse(text) as ResumeSnapshot;
    if (value.version !== 1 || typeof value.url !== 'string' || !Array.isArray(value.fields)) {
      throw new Error('Stored browser restore snapshot has an unsupported format.');
    }
    return value;
  }

  private hasSnapshot(): boolean {
    const record = this.snapshotRecord();
    if (!record) return false;
    if (record.value.version === 3 && typeof record.value.url === 'string'
      && typeof record.value.originAssets === 'object' && record.value.originAssets !== null) {
      const origin = new URL(record.value.url).origin;
      return typeof (record.value.originAssets as Record<string, unknown>)[origin] === 'string';
    }
    return true;
  }

  private async captureWebStorage(
    runtime: ServoRuntime,
    storageName: 'localStorage' | 'sessionStorage',
  ): Promise<[string, string][]> {
    const temporaryName = `__servoMcpStorageCapture_${crypto.randomUUID().replaceAll('-', '')}`;
    const temporaryKey = JSON.stringify(temporaryName);
    const setup = parseEvaluationResult(await runtime.evaluate(
      `(()=>{if(location.origin==='null')return JSON.stringify({opaque:true,count:0});const store=globalThis[${JSON.stringify(storageName)}];const entries=[];for(let i=0;i<store.length;i++){const key=store.key(i);if(key!==null)entries.push([key,String(store.getItem(key)??'')]);}globalThis[${temporaryKey}]=entries;return JSON.stringify({count:entries.length});})()`,
      { maxDurationMs: 15_000 },
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
          const piece = parseEvaluationResult(await runtime.evaluate(
            `JSON.stringify((()=>{const entry=globalThis[${temporaryKey}]?.[${index}];if(!entry)throw new Error('Storage changed during snapshot capture.');return {keyLength:entry[0].length,valueLength:entry[1].length,key:entry[0].slice(${offset},${offset + STORAGE_CAPTURE_CHUNK_CHARS}),value:entry[1].slice(${offset},${offset + STORAGE_CAPTURE_CHUNK_CHARS})}})())`,
            { maxDurationMs: 15_000 },
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
      await runtime.evaluate(`delete globalThis[${temporaryKey}]`, { maxDurationMs: 2_000 }).catch(() => undefined);
    }
    return entries;
  }

  private async captureSnapshot(runtime: ServoRuntime): Promise<void> {
    const cookieState = bytesToBase64(runtime.exportCookieState());
    const value = parseEvaluationResult(await runtime.evaluate(resumeStateExpression, { maxDurationMs: 15_000 }));
    if (typeof value !== 'object' || value === null || !('url' in value) || !('fields' in value)) {
      throw new Error(`Servo returned invalid browser restore state: ${JSON.stringify(value).slice(0, 512)}`);
    }
    const snapshot = value as ResumeSnapshot;
    snapshot.cookieState = cookieState;
    snapshot.localStorage = await this.captureWebStorage(runtime, 'localStorage');
    snapshot.sessionStorage = await this.captureWebStorage(runtime, 'sessionStorage');
    const origin = snapshot.origin ?? new URL(snapshot.url).origin;
    const previous = this.snapshotRecord();
    const originAssets: Record<string, string> = {};
    const legacyAssetNames: string[] = [];
    if (previous?.value.version === 3 && typeof previous.value.originAssets === 'object' && previous.value.originAssets !== null) {
      Object.assign(originAssets, previous.value.originAssets);
    } else if (previous) {
      const legacy = this.loadSnapshot();
      if (legacy) {
        const localByOrigin = legacy.localStorageByOrigin ?? {};
        const sessionByOrigin = legacy.sessionStorageByOrigin ?? {};
        const indexedByOrigin = legacy.indexedDBByOrigin ?? {};
        const origins = new Set([
          ...Object.keys(localByOrigin),
          ...Object.keys(sessionByOrigin),
          ...Object.keys(indexedByOrigin),
        ]);
        const legacyOrigin = legacy.origin ?? new URL(legacy.url).origin;
        origins.add(legacyOrigin);
        for (const savedOrigin of origins) {
          const name = `origin:${crypto.randomUUID()}`;
          const state: OriginStorageSnapshot = {
            localStorage: localByOrigin[savedOrigin] ?? (savedOrigin === legacyOrigin ? legacy.localStorage : []),
            sessionStorage: sessionByOrigin[savedOrigin] ?? (savedOrigin === legacyOrigin ? legacy.sessionStorage : []),
            indexedDB: indexedByOrigin[savedOrigin] ?? (savedOrigin === legacyOrigin ? legacy.indexedDB ?? [] : []),
          };
          this.storeAsset(name, JSON.stringify(state), SNAPSHOT_CHUNK_CHARS);
          originAssets[savedOrigin] = name;
        }
      }
      const oldPointer = previous.value as { version?: number; assetName?: string };
      if (oldPointer.version === 2 && oldPointer.assetName) legacyAssetNames.push(oldPointer.assetName);
    }

    const assetName = `origin:${crypto.randomUUID()}`;
    const originState: OriginStorageSnapshot = {
      localStorage: snapshot.localStorage,
      sessionStorage: snapshot.sessionStorage,
      indexedDB: snapshot.indexedDB ?? [],
    };
    this.storeAsset(assetName, JSON.stringify(originState), SNAPSHOT_CHUNK_CHARS);
    const replacedOriginAsset = originAssets[origin];
    originAssets[origin] = assetName;
    const header: PersistedSnapshotHeader = {
      version: 3,
      url: snapshot.url,
      origin,
      scrollX: snapshot.scrollX,
      scrollY: snapshot.scrollY,
      fields: snapshot.fields,
      cookies: snapshot.cookies,
      cookieState,
      originAssets,
    };
    this.ctx.storage.sql.exec(
      'INSERT INTO browser_snapshot (singleton, snapshot_json) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET snapshot_json = excluded.snapshot_json',
      JSON.stringify(header),
    );
    if (replacedOriginAsset && replacedOriginAsset !== assetName) {
      this.ctx.storage.sql.exec('DELETE FROM browser_asset WHERE name = ?', replacedOriginAsset);
    }
    for (const legacyAsset of legacyAssetNames) {
      this.ctx.storage.sql.exec('DELETE FROM browser_asset WHERE name = ?', legacyAsset);
    }
  }

  private async applySavedState(runtime: ServoRuntime, snapshot: ResumeSnapshot, url: string, reapplying = false) {
    const result = parseEvaluationResult(await runtime.evaluate(
      applyResumeState(snapshotForOrigin(snapshot, url)), { maxDurationMs: 15_000 },
    ));
    if (typeof result !== 'object' || result === null || !('restored' in result)) {
      const action = reapplying ? 'reapply' : 'apply';
      throw new Error(`Servo could not ${action} the saved tab state: ${JSON.stringify(result).slice(0, 512)}`);
    }
    await pump(runtime, 2_000);
    return result as { hasStorage?: boolean; hasCookies?: boolean; hasIndexedDBState?: boolean; indexedDatabases?: number };
  }

  private hasSavedOrigin(snapshot: ResumeSnapshot, url: string): boolean {
    const origin = new URL(url).origin;
    return Object.hasOwn(snapshot.localStorageByOrigin ?? {}, origin)
      || Object.hasOwn(snapshot.sessionStorageByOrigin ?? {}, origin)
      || Object.hasOwn(snapshot.indexedDBByOrigin ?? {}, origin)
      || (snapshot.origin ?? new URL(snapshot.url).origin) === origin;
  }

  private async restoreNavigatedOrigin(runtime: ServoRuntime, url: string): Promise<void> {
    const snapshot = this.loadSnapshot(url);
    if (!snapshot) return;
    if (!snapshot.originAssets && !this.hasSavedOrigin(snapshot, url)) return;
    const restored = await this.applySavedState(runtime, snapshot, url);
    if (restored.hasStorage || restored.hasCookies || restored.hasIndexedDBState || restored.indexedDatabases) {
      if (!runtime.reload()) throw new Error('Servo could not reload after restoring this tab origin.');
      await pump(runtime, 10_000);
      await this.applySavedState(runtime, snapshot, url, true);
    }
  }

  private async createRuntime(width: number, height: number, sessionId: string, savedCookieState?: string): Promise<ServoRuntime> {
    const runtime = await createServoWorkerRuntime(servoWasm, {
      width,
      height,
      url: 'about:blank',
      fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => publicFetch(input, init).catch((error: unknown) => {
        const url = input instanceof Request ? input.url : String(input);
        this.fetchFailures.set(url, error instanceof Error ? error.message : String(error));
        throw error;
      }),
      webSocketFactory: publicWebSocket,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      maxSubrequests: 50,
      log: (message: string) => console.error(`[servo:${sessionId}] ${message.slice(0, 2048)}`),
    });
    const names = this.ctx.storage.sql.exec<{ name: string }>(
      'SELECT DISTINCT name FROM browser_asset WHERE name LIKE ?', 'font:%',
    ).toArray().map((row) => row.name).sort();
    for (const name of names) {
      const base64 = this.readAsset(name);
      if (!base64) continue;
      const binary = atob(base64);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      runtime.registerFont(bytes);
    }
    const cookieState = savedCookieState ?? this.readAsset('cookie-state');
    if (cookieState) runtime.restoreCookieState(base64ToBytes(cookieState));
    return runtime;
  }

  private async restoreRuntime(row: SessionRow): Promise<ServoRuntime> {
    const snapshot = this.loadSnapshot();
    if (!snapshot) throw new Error('Browser session has no saved tab state to restore.');
    const runtime = await this.createRuntime(row.width, row.height, this.sessionId(), snapshot.cookieState);
    try {
      const initialHtml = this.readAsset('initial-html');
      const parsedUrl = new URL(snapshot.url);
      const isInlineDocument = parsedUrl.origin === 'https://servo-inline.invalid' && initialHtml !== undefined;
      const isBlankDocument = snapshot.url === 'about:blank';
      const url = isBlankDocument ? snapshot.url : isInlineDocument ? parsedUrl.href : assertPublicHttpUrl(snapshot.url).href;
      const loaded = isBlankDocument || (isInlineDocument
        ? runtime.loadHtml(initialHtml, { url })
        : runtime.loadPage(url));
      if (!loaded) throw new Error('Servo could not reopen the saved tab URL.');
      let restored: { hasStorage?: boolean; hasCookies?: boolean; hasIndexedDBState?: boolean; indexedDatabases?: number } | undefined;
      if (!isBlankDocument) {
        await pump(runtime, 10_000);
        restored = await this.applySavedState(runtime, snapshot, snapshot.url);
      }
      // Give restored storage and script-visible cookies a chance to initialize
      // the re-opened page, as a browser does when restoring a tab profile.
      if (!isInlineDocument && !isBlankDocument && (restored?.hasStorage || restored?.hasCookies || restored?.hasIndexedDBState || restored?.indexedDatabases)) {
        if (!runtime.reload()) throw new Error('Servo could not reload the restored tab.');
        await pump(runtime, 10_000);
        await this.applySavedState(runtime, snapshot, snapshot.url, true);
      }
      this.runtime = runtime;
      return runtime;
    } catch (error) {
      try { runtime.reset(); } catch { /* discard a partially restored runtime */ }
      throw error;
    }
  }

  private async summary(runtime: ServoRuntime): Promise<PageSummary> {
    const page = await pageSummary(runtime);
    const failure = this.fetchFailures.get(page.url);
    return failure === undefined ? page : { ...page, loadError: `The page could not be loaded: ${failure}` };
  }

  private sessionId(): string {
    return this.ctx.id.toString();
  }

  private async renewLease(): Promise<void> {
    const expiresAt = Date.now() + SESSION_IDLE_TTL_MS;
    this.ctx.storage.sql.exec(
      'UPDATE browser_session SET updated_at = ?, expires_at = ? WHERE singleton = 1 AND status = ?',
      Date.now(), expiresAt, 'active',
    );
    await this.ctx.storage.setAlarm(expiresAt);
    // Do not retain the runtime with a JS timer. Any pending setTimeout keeps
    // this Durable Object from hibernating and accruing duration charges. Once
    // the request and snapshot writes finish, let Cloudflare hibernate the DO;
    // a later browser operation restores the runtime from the durable snapshot.
  }

  private clearRuntime(): void {
    try {
      this.runtime?.reset();
    } catch (error) {
      console.error(JSON.stringify({ event: 'servo_session_reset_failed', error: String(error) }));
    }
    this.runtime = undefined;
  }

  private async expireIfIdle(): Promise<void> {
    const row = this.row();
    if (row?.status !== 'active') return;
    if (row.expires_at > Date.now()) {
      await this.renewLease();
      return;
    }
    this.clearRuntime();
    this.writeStatus('expired');
    await this.ctx.storage.deleteAlarm();
    this.ctx.storage.sql.exec('DELETE FROM browser_snapshot');
    this.ctx.storage.sql.exec('DELETE FROM browser_asset');
  }

  private async requireRuntime(): Promise<ServoRuntime> {
    const row = this.row();
    if (!row) throw new Error('Browser session does not exist. Create a new Servo browser session.');
    if (row.status !== 'active') {
      throw new Error(`Browser session is ${row.status}. Create a new Servo browser session.`);
    }
    if (row.expires_at <= Date.now()) {
      this.clearRuntime();
      this.writeStatus('expired');
      await this.ctx.storage.deleteAlarm();
      this.ctx.storage.sql.exec('DELETE FROM browser_snapshot');
      this.ctx.storage.sql.exec('DELETE FROM browser_asset');
      throw new Error('Browser session was reaped after 30 days of inactivity. Create a new Servo browser session.');
    }
    if (this.runtime?.trapped) {
      this.clearRuntime();
    }
    if (!this.runtime) {
      try {
        await this.restoreRuntime(row);
      } catch (error) {
        this.writeStatus('failed');
        await this.ctx.storage.deleteAlarm();
        throw new Error(`Saved tab could not be restored: ${String(error)}`);
      }
    }
    return this.runtime;
  }

  private async operate<T>(operation: (runtime: ServoRuntime) => Promise<T>): Promise<T> {
    return this.serial(async () => {
      this.fetchFailures.clear();
      const runtime = await this.requireRuntime();
      try {
        const previousUrl = (await pageSummary(runtime)).url;
        let result: Awaited<T> = await operation(runtime);
        const currentPage = await pageSummary(runtime);
        if (new URL(previousUrl).origin !== new URL(currentPage.url).origin) {
          await this.restoreNavigatedOrigin(runtime, currentPage.url);
          const restoredPage = await this.summary(runtime);
          if (typeof result === 'object' && result !== null && 'page' in result) {
            result = { ...result, page: restoredPage } as Awaited<T>;
          } else if (typeof result === 'object' && result !== null && 'url' in result && 'title' in result) {
            result = restoredPage as Awaited<T>;
          }
        }
        return result;
      } finally {
        if (this.runtime === runtime && this.row()?.status === 'active') {
          try {
            await this.captureSnapshot(runtime);
          } catch (error) {
            console.error(JSON.stringify({ event: 'servo_snapshot_failed', error: String(error) }));
            throw error;
          }
          await this.renewLease();
        }
      }
    });
  }

  async initialize(options: BrowserSessionOptions): Promise<{ sessionId: string; page: PageSummary; capabilities: unknown; expiresAt: number }> {
    return this.serial(async () => {
      if (this.row()) throw new Error('This browser session ID has already been initialized.');
      this.fetchFailures.clear();
      if (options.url) assertPublicHttpUrl(options.url);
      if (options.html !== undefined && new TextEncoder().encode(options.html).byteLength > MAX_PERSISTED_HTML_BYTES) {
        throw new RangeError(`Inline HTML exceeds ${MAX_PERSISTED_HTML_BYTES} UTF-8 bytes, the resumable-session limit.`);
      }

      const now = Date.now();
      this.ctx.storage.sql.exec(
        'INSERT INTO browser_session (singleton, status, created_at, updated_at, expires_at, width, height) VALUES (1, ?, ?, ?, ?, ?, ?)',
        'failed', now, now, now, options.width, options.height,
      );
      try {
        if (options.html !== undefined) await this.storeAsset('initial-html', options.html);
        if (options.fontBase64) await this.storeAsset('font:000000', options.fontBase64);
        const runtime = await this.createRuntime(options.width, options.height, options.sessionId);
        this.runtime = runtime;
        if (options.html !== undefined) {
          if (!runtime.loadHtml(options.html)) throw new Error('Servo rejected the supplied HTML document.');
        } else if (options.url && !runtime.loadPage(options.url)) {
          throw new Error('Servo rejected the requested URL.');
        }
        if (options.url || options.html !== undefined) await pump(runtime, options.maxDurationMs);
        const page = await this.summary(runtime);
        await this.captureSnapshot(runtime);
        this.writeStatus('active', Date.now() + SESSION_IDLE_TTL_MS);
        await this.renewLease();
        return {
          sessionId: options.sessionId,
          page,
          capabilities: runtime.capabilities(),
          expiresAt: Date.now() + SESSION_IDLE_TTL_MS,
        };
      } catch (error) {
        this.clearRuntime();
        this.writeStatus('failed');
        this.ctx.storage.sql.exec('DELETE FROM browser_snapshot');
        this.ctx.storage.sql.exec('DELETE FROM browser_asset');
        throw error;
      }
    });
  }

  async getStatus(): Promise<{ status: SessionStatus | 'missing'; updatedAt?: number; expiresAt?: number; runtimeAvailable: boolean; resumable: boolean }> {
    return this.serial(async () => {
      const row = this.row();
      if (!row) return { status: 'missing', runtimeAvailable: false, resumable: false };
      if (row.status === 'active' && row.expires_at <= Date.now()) {
        this.clearRuntime();
        this.writeStatus('expired');
        await this.ctx.storage.deleteAlarm();
        this.ctx.storage.sql.exec('DELETE FROM browser_snapshot');
        this.ctx.storage.sql.exec('DELETE FROM browser_asset');
        return { status: 'expired', updatedAt: row.updated_at, expiresAt: row.expires_at, runtimeAvailable: false, resumable: false };
      }
      if (row.status === 'active' && this.runtime?.trapped) {
        this.clearRuntime();
      }
      return {
        status: row.status,
        updatedAt: row.updated_at,
        expiresAt: row.expires_at,
        runtimeAvailable: Boolean(this.runtime && !this.runtime.trapped),
        resumable: row.status === 'active' && this.hasSnapshot(),
      };
    });
  }

  async navigate(url: string, maxDurationMs = 10_000): Promise<BrowserActionResult> {
    assertPublicHttpUrl(url);
    return this.operate(async (runtime) => {
      if (!runtime.loadPage(url)) throw new Error('Servo rejected the requested URL.');
      await pump(runtime, maxDurationMs);
      return { action: 'navigate', page: await this.summary(runtime) };
    });
  }

  async inspect(): Promise<PageSummary> {
    return this.operate((runtime) => this.summary(runtime));
  }

  async wait(maxDurationMs = 10_000): Promise<PageSummary> {
    return this.operate(async (runtime) => {
      await pump(runtime, maxDurationMs);
      return this.summary(runtime);
    });
  }

  async evaluate(script: string, maxDurationMs = 10_000): Promise<{ value: unknown; page: PageSummary }> {
    if (new TextEncoder().encode(script).byteLength > MAX_SCRIPT_BYTES) throw new RangeError('Script exceeds 64 KiB.');
    return this.operate(async (runtime) => {
      const value = await runtime.evaluate(script, { maxDurationMs });
      return { value, page: await this.summary(runtime) };
    });
  }

  async click(x: number, y: number, button = 0, maxDurationMs = 10_000): Promise<BrowserActionResult> {
    return this.operate(async (runtime) => {
      runtime.click(x, y, button);
      await pump(runtime, maxDurationMs);
      return { action: 'click', page: await this.summary(runtime) };
    });
  }

  async typeText(text: string, maxDurationMs = 10_000): Promise<BrowserActionResult> {
    return this.operate(async (runtime) => {
      runtime.typeText(text);
      await pump(runtime, maxDurationMs);
      return { action: 'type', page: await this.summary(runtime) };
    });
  }

  async pressKey(key: string, maxDurationMs = 10_000): Promise<BrowserActionResult> {
    return this.operate(async (runtime) => {
      runtime.pressKey(key);
      await pump(runtime, maxDurationMs);
      return { action: 'key', page: await this.summary(runtime) };
    });
  }

  async scroll(deltaX: number, deltaY: number, x?: number, y?: number, maxDurationMs = 10_000): Promise<BrowserActionResult> {
    return this.operate(async (runtime) => {
      runtime.scrollBy(deltaX, deltaY, { x, y });
      await pump(runtime, maxDurationMs);
      return { action: 'scroll', page: await this.summary(runtime) };
    });
  }

  async history(direction: 'back' | 'forward', maxDurationMs = 10_000): Promise<BrowserActionResult> {
    return this.operate(async (runtime) => {
      const navigated = direction === 'back' ? runtime.goBack() : runtime.goForward();
      if (navigated) await pump(runtime, maxDurationMs);
      return { action: direction, page: await this.summary(runtime) };
    });
  }

  async reload(maxDurationMs = 10_000): Promise<BrowserActionResult> {
    return this.operate(async (runtime) => {
      if (!runtime.reload()) throw new Error('Servo could not reload the current page.');
      await pump(runtime, maxDurationMs);
      return { action: 'reload', page: await this.summary(runtime) };
    });
  }

  async screenshot(fullPage = false, maxDurationMs = 5_000): Promise<{ page: PageSummary; png: Uint8Array }> {
    return this.operate(async (runtime) => ({
      page: await this.summary(runtime),
      png: await runtime.screenshot({ fullPage, maxDurationMs }),
    }));
  }

  async capabilities(): Promise<unknown> {
    return this.operate(async (runtime) => runtime.capabilities());
  }

  async registerFont(fontBase64: string): Promise<{ faces: number }> {
    return this.operate(async (runtime) => {
      const binary = atob(fontBase64);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      const faces = runtime.registerFont(bytes);
      const count = this.ctx.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(DISTINCT name) AS count FROM browser_asset WHERE name LIKE 'font:%'",
      ).toArray()[0]?.count ?? 0;
      await this.storeAsset(`font:${String(count).padStart(6, '0')}`, fontBase64);
      return { faces };
    });
  }

  async close(): Promise<{ status: 'closed' }> {
    return this.serial(async () => {
      this.clearRuntime();
      const row = this.row();
      if (row && row.status !== 'closed') this.writeStatus('closed');
      await this.ctx.storage.deleteAlarm();
      this.ctx.storage.sql.exec('DELETE FROM browser_snapshot');
      this.ctx.storage.sql.exec('DELETE FROM browser_asset');
      return { status: 'closed' };
    });
  }

  async alarm(): Promise<void> {
    await this.serial(() => this.expireIfIdle());
  }
}
