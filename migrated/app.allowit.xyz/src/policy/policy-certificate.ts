import type {MicroPolicy, WorkflowNode} from '../micro/micro-contracts';
import {runtimeOf} from '../runtime/runtime';
import {scaled} from '../paysh/paysh-units';
/** nodeIds are the exact workflow nodes a badge stands for. The funding total has no badge; the figure states it. */
export type CertificateBadge={kind:'purchase'|'tiers'|'actions'|'merchant'|'recipient'|'preference'|'review'|'custom'|'approval'|'daily';name:string;tip:string;nodeIds:string[]};
/** Native badges come only from calls into the pinned policy_api.rs. */
const NATIVE_BADGES:Readonly<Record<string,'approval'|'daily'>>={require_approval:'approval',enforce_daily_limit:'daily'};
export function hashIdentity(value:string){let h=2166136261;for(const c of value){h^=c.codePointAt(0)!;h=Math.imul(h,16777619);}return h>>>0;}
/** Spread nearby identifiers over the hue wheel before deriving a policy's colours. */
const mix=(h:number)=>{h^=h>>>16;h=Math.imul(h,0x85ebca6b);h^=h>>>13;h=Math.imul(h,0xc2b2ae35);h^=h>>>16;return h>>>0;};
const TRACE_FROM=9, TRACE_TO=49;
const onWheel=(n:number)=>(TRACE_TO+((n%320)+320)%320)%360;
const clearOfTrace=(h:number)=>{h=((h%360)+360)%360;return h>TRACE_FROM&&h<TRACE_TO?(h-TRACE_FROM<TRACE_TO-h?TRACE_FROM:TRACE_TO):h;};
const semanticFamily=(nodes:WorkflowNode[])=>{const actions=nodes.filter(n=>n.name==='allow_actions').flatMap(n=>n.arguments).join(' ').toLowerCase();return /research|data|paper|report/.test(actions)?0:/invest|trade|swap/.test(actions)?1:/pay|transfer|purchase/.test(actions)?2:3;};
export type CertificatePolicy = Omit<MicroPolicy, 'network'> & {network: string};
export function certificateFor(policy:CertificatePolicy,owner:string,token='USDC'){
 const nodes=policy.workflow??[], top=nodes.filter(n=>n.kind==='function'||n.kind==='preference');
 const badges:CertificateBadge[]=[];
 const runtime=runtimeOf(policy), legacy=runtime.state==='legacy';
 const total=policy.allocation?.amount;
 for(const n of nodes){const kind=n.origin==='policy_api'&&n.kind==='function'&&Object.hasOwn(NATIVE_BADGES,n.name)?NATIVE_BADGES[n.name]:undefined;if(kind)badges.push({kind,name:n.label||n.name,tip:n.description?`${n.label||n.name}. ${n.description}`:n.label||n.name,nodeIds:[n.id]});}
 const firstCustom=nodes.findIndex(n=>n.kind==='custom');
 const guaranteed=top.filter(n=>n.name==='set_cap'||n.name==='cap_purchase_tiers'||firstCustom<0||nodes.indexOf(n)<firstCustom);
 // Legacy workflows expose display amounts. Typed policies use compiler-owned units, never argument strings.
 const purchase=legacy?guaranteed.find(n=>n.name==='cap_per_transaction'):undefined,tiers=legacy?top.find(n=>n.name==='cap_purchase_tiers'):undefined;
 if(purchase)badges.push({kind:'purchase',name:`Up to ${purchase.arguments[0]} ${token} per purchase`,tip:`Up to ${purchase.arguments[0]} ${token} per purchase, inclusive.`,nodeIds:[purchase.id]});
 if(tiers)badges.push({kind:'tiers',name:`${tiers.arguments[1]} purchases up to ${tiers.arguments[0]} ${token}, then cheaper bands`,tip:`${tiers.arguments[1]} purchases up to ${tiers.arguments[0]} ${token}. Each cheaper band halves the ceiling and doubles the count. Pending purchases reserve a slot.`,nodeIds:[tiers.id]});
 if(runtime.state==='typed')for(const q of runtime.runtime.providerCallRequirements??[]){
  const amount=scaled(q.max_payment_units,runtime.runtime.paymentAsset.decimals),asset=runtime.runtime.paymentAsset.symbol;
  const nodes=guaranteed.filter(n=>n.name===q.operation);
  if(nodes.length)badges.push({kind:'purchase',name:`Up to ${amount} ${asset} per call`,tip:`Up to ${amount} ${asset} per call to ${q.service_id}, from the compiled policy.`,nodeIds:nodes.map(n=>n.id)});
 }
 for(const [name,kind,label] of [['allow_actions','actions','Allowed actions'],['require_merchant','merchant','Merchant'],['require_recipient','recipient','Recipient'],['check_preference','preference','Preference'],['require_user_input','review','Owner review']] as const){
  const found=guaranteed.filter(n=>n.name===name);if(found.length){const detail=found.map(n=>n.arguments[0]||n.description).join('; ');badges.push({kind,name:`${label}: ${detail}`,tip:`${label}: ${detail}`,nodeIds:found.map(n=>n.id)});}
 }
 if(firstCustom>=0)badges.push({kind:'custom',name:'Custom rules',tip:'Custom rules apply. Read them in the workflow; conditional rules are not shown as guarantees.',nodeIds:nodes.filter(n=>n.kind==='custom').map(n=>n.id)});
 const features=[...new Set(top.map(n=>n.name))].sort();
 const family=semanticFamily(nodes),fingerprint=hashIdentity(`${owner}|${policy.id}|${policy.sourceHash}`);
 const cap=Math.max(0,Number(total)||0),price=Math.max(0,Number(purchase?.arguments[0]||tiers?.arguments[0])||0);
 // Typed funding and spending can be different assets. Do not derive a purchase count or an exchange rate.
 const capacity=legacy&&price>0?Math.min(100,cap/price):0;
 const capScale=Math.min(1,Math.log10(1+cap)/5),activityScale=Math.min(1,Math.log2(1+capacity)/7);
 // Keep the fingerprint-derived line colours clear of the red status trace.
 const hue=onWheel(mix(fingerprint));
 const complement=clearOfTrace(hue+150+mix(hashIdentity(`${features.join('|')}|${family}`))%61);
 const from=0.08+capScale*0.3,to=Math.min(1,from+0.3+activityScale*0.35);
 return {badges,fingerprint:fingerprint.toString(16).padStart(8,'0'),hue,complement,stops:[from,to] as const,family,capacity,cap,features};
}

/* The aperture geometry from 4017d16, with its central line given to the status trace. */

export type ApertureState = 'open' | 'closed' | 'draft';
export interface ApertureMeasure {
  w: number;
  h: number;
  bx: number;
  by: number;
  bw: number;
  bh: number;
}

export function buildAperture(m: ApertureMeasure, state: ApertureState) {
  const {w, h, bx, by, bw, bh} = m;
  const f = (n: number) => Math.round(n * 10) / 10;
  const step = 8;
  const cy = by + bh / 2;
  const gap = bh / 2 + 14;
  const x0 = Math.max(bx - 28, 40);
  const x1 = Math.min(bx + bw + 28, w - 40);
  const ease = Math.max(16, Math.min(90, x0 - 4));
  const topBand = Math.max(cy - gap, 8);
  const botBand = Math.max(h - cy - gap, 8);
  const squash = (y: number) => (y < cy ? y * (topBand / cy) : h - (h - y) * (botBand / (h - cy)));
  const win = (x: number) => {
    if (x <= x0 - ease || x >= x1 + ease) return 0;
    if (x < x0) return 0.5 - 0.5 * Math.cos((Math.PI * (x - (x0 - ease))) / ease);
    if (x <= x1) return 1;
    return 0.5 + 0.5 * Math.cos((Math.PI * (x - x1)) / ease);
  };
  const curve = (y: number, end = w) => {
    const ys = squash(y);
    const rightEase = end === w ? ease : Math.min(ease, end - x1);
    const sampleStep = 2;
    const pts: [number, number][] = [[0, y], [x0 - ease, y]];
    for (let x = x0 - ease + sampleStep; x < x0; x += sampleStep) pts.push([x, y + (ys - y) * win(x)]);
    pts.push([x0, ys], [x1, ys]);
    for (let x = x1 + sampleStep; x < x1 + rightEase; x += sampleStep) pts.push([x, y + (ys - y) * (0.5 + 0.5 * Math.cos(Math.PI * (x - x1) / rightEase))]);
    pts.push([x1 + rightEase, y], [end, y]);
    return pts;
  };
  const toPath = (pts: [number, number][]) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${f(x)} ${f(y)}`).join(' ');
  // The line nearest the figure's middle is the status lane: the trace runs its curve, so it never crosses a line.
  let lane = step / 2;
  for (let y = step / 2; y < h; y += step) if (Math.abs(y - cy) < Math.abs(lane - cy)) lane = y;
  const lines: string[] = [];
  for (let y = step / 2; y < h; y += step) if (y !== lane) lines.push(toPath(curve(y)));
  let trace = '';
  let head: string | null = null;
  let dot: {x: number; y: number} | null = null;
  let len = 0;
  let stop = '';
  const pathOf = (pts: [number, number][]) => {
    const [endX, endY] = pts[pts.length - 1];
    stop = `M${f(endX)} ${f(endY - 5)} L${f(endX)} ${f(endY + 5)}`;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return toPath(pts);
  };
  // Marks stay within 5 of the lane so they stop short of the neighbouring lines 8 away.
  if (state === 'open') {
    // Finish the bend before the terminal mark, including in narrow sidebar cards.
    const pts = curve(lane, w - 12);
    trace = pathOf(pts);
    dot = {x: w - 12, y: lane};
  } else if (state === 'closed') {
    const xe = Math.max(24, (x0 - ease) * 0.55);
    trace = pathOf([
      [0, lane],
      [xe, lane],
    ]);
    head = `M${f(xe)} ${f(lane - 5)} L${f(xe)} ${f(lane + 5)}`;
  } else {
    const xe = Math.max(24, (x0 - ease) * 0.55);
    trace = pathOf([
      [0, lane],
      [xe, lane],
    ]);
    dot = {x: xe, y: lane};
  }
  return {lines, trace, head, dot, lane, stop, len: Math.ceil(len)};
}
