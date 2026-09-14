import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { updateUiScript } from '../src/update-ui.js'

class Element {
  constructor(tag) { this.tagName=tag;this.children=[];this.parentElement=null;this.dataset={};this.attrs={};this.textContent='';this.className='';this.open=false
    this.classList={contains:n=>this.className.split(' ').includes(n),add:n=>{if(!this.classList.contains(n))this.className+=` ${n}`},remove:n=>{this.className=this.className.split(' ').filter(v=>v!==n).join(' ')}}
  }
  append(...nodes){for(let node of nodes){if(typeof node==='string'){const e=new Element('#text');e.textContent=node;node=e}node.remove();node.parentElement=this;this.children.push(node)}}
  remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(n=>n!==this);this.parentElement=null}
  replaceChildren(){for(const n of [...this.children])n.remove()}
  setAttribute(k,v){this.attrs[k]=v}
  removeAttribute(k){delete this.attrs[k]}
  showModal(){this.open=true}
  close(){this.open=false}
  get isConnected(){return this.tagName==='body'||Boolean(this.parentElement?.isConnected)}
  get nodeType(){return this.tagName==='#text'?3:1}
  matches(selector){return selector.split(',').some(s=>this.classList.contains(s.trim().slice(1)))}
  querySelector(selector){return all(this).slice(1).find(n=>n.matches(selector))||null}
}
const all = root => [root,...root.children.flatMap(all)]
async function fixture(state){
  const body=new Element('body'),head=new Element('head'),seat=new Element('div'),setting=new Element('button')
  seat.className='dcu-settings-seat';setting.className='dcu-settings-trigger';seat.append(setting);body.append(seat)
  let changed,mutated,queries=0;const calls=[]
  const window={dshDesktop:{getUpdates:async()=>state,checkUpdates:async()=>state,onUpdatesChanged:fn=>{changed=fn},openUpdateLink:async()=>{},executeUpdates:async r=>{calls.push(r);return{ok:true}}},addEventListener(){}}
  const document={body,head,createElement:tag=>new Element(tag),querySelector:s=>{queries++;return all(body).find(n=>n.matches(s))||null}}
  vm.runInNewContext(updateUiScript(),{window,document,MutationObserver:class{constructor(fn){mutated=fn}observe(){}},Set,JSON})
  await Promise.resolve();await Promise.resolve()
  return{body,seat,setting,calls,queries:()=>queries,mutate:records=>mutated(records),publish:s=>{state=s;changed(s)},entry:()=>all(body).find(e=>e.className==='dshDualUpdateEntry'),dialog:()=>all(body).find(e=>e.tagName==='dialog')}
}
const state=(d,a)=>({dsh:{currentVersion:'1.0.0',targetVersion:'2.0.0',hasUpdate:d,canUpdate:d,state:d?'available':'current'},desktop:{currentVersion:'3.0.0',targetVersion:'4.0.0',hasUpdate:a,canUpdate:a,state:a?'available':'current'},busy:false})

test('streaming mutations do not rescan document; replacement seats and entries still reconcile',async()=>{
  const f=await fixture(state(false,true)), initial=f.queries()
  for(let n=0;n<1000;n++)f.mutate([{addedNodes:[new Element('#text')]}])
  assert.equal(f.queries(),initial)
  const entry=f.entry();entry.remove();f.mutate([{addedNodes:[]}]);assert.equal(f.entry(),entry)
  f.seat.remove();const seat=new Element('div');seat.className='dcu-settings-seat';f.body.append(seat)
  f.mutate([{addedNodes:[seat]}]);assert.equal(f.entry().parentElement,seat)
  const preferred=new Element('div');preferred.className='dcu-settings-seat';f.body.children.unshift(preferred);preferred.parentElement=f.body
  f.mutate([{addedNodes:[preferred]}]);assert.equal(f.entry().parentElement,preferred)
  f.publish(state(false,false));const queries=f.queries();f.mutate([{addedNodes:[new Element('div')]}]);assert.equal(f.queries(),queries)
})
test('one icon shares settings row, updates colours immediately, disappears without updates',async()=>{
  const f=await fixture(state(false,false));assert.equal(f.entry(),undefined)
  for(const [d,a,kind]of[[true,false,'dsh'],[false,true,'desktop'],[true,true,'both']]){
    f.publish(state(d,a));assert.equal(f.entry().dataset.kind,kind);assert.equal(f.entry().parentElement,f.seat);assert.equal(f.entry().textContent,'');assert.match(f.entry().innerHTML,/<svg/)
  }
  f.publish(state(false,false));assert.equal(f.entry(),undefined);assert.equal(f.seat.classList.contains('dshDualUpdateRow'),false)
})
test('two cards prefer desktop and allow explicit simultaneous selection',async()=>{
  const f=await fixture(state(true,true));f.entry().onclick();const dialog=f.dialog()
  const inputs=all(dialog).filter(e=>e.tagName==='input');assert.deepEqual(inputs.map(e=>e.checked),[false,true])
  inputs[0].checked=true;inputs[0].onchange()
  await all(dialog).find(e=>e.textContent==='更新所选项').onclick()
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].dsh,true);assert.equal(f.calls[0].desktop,true)
})
test('unavailable updates cannot be selected and progress can reopen after a reload',async()=>{
  const initial=state(false,true);initial.desktop.canUpdate=false;initial.desktop.reason='unknown-flavor-cannot-update'
  const f=await fixture(initial);f.entry().onclick();assert.ok(all(f.dialog()).filter(e=>e.tagName==='input').every(e=>e.disabled))
  f.dialog().close();f.publish({...state(true,true),busy:true,selection:{dsh:true,desktop:true}})
  assert.equal(f.dialog().open,true);assert.ok(all(f.dialog()).filter(e=>e.tagName==='input').every(e=>e.disabled&&e.checked))
  f.publish({...state(false,true),desktop:{...state(false,true).desktop,state:'downloading',progress:42,canUpdate:false},busy:true,selection:{desktop:true}})
  assert.equal(all(f.dialog()).find(e=>e.tagName==='progress').value,42)
})
