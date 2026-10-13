import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcilePublication} from './publication.mjs';
const revision='a'.repeat(40);
const service={id:'srv-fixture',type:'static_site',name:'fss-fixture',ownerId:'tea-fixture',repo:'https://github.com/test/sites',branch:'main',rootDir:'sites/fixture',serviceDetails:{url:'https://fixture.onrender.com'}};
const base={ownerId:service.ownerId,repo:service.repo,slug:'fixture',revision,wait:async()=>{},attempts:2};
test('external create followed by failed portal acknowledgement reuses exact service on retry',async()=>{
 let created=0, saved=false;
 const render=async(path,init)=>{
  if(path.startsWith('/services?'))return created?[{service}]:[];
  if(path==='/services'&&init?.method==='POST'){created++;return {service};}
  if(path.endsWith('/deploys?limit=100'))return [{deploy:{status:'live',commit:{id:revision}}}];
  throw Error(path);
 };
 await assert.rejects(reconcilePublication({...base,render,acknowledge:async()=>{throw Error('portal unavailable');}}));
 await reconcilePublication({...base,render,acknowledge:async()=>{saved=true;}});
 assert.equal(created,1);assert.equal(saved,true);
});
test('no-diff retry reconciles target revision after earlier publication failure',async()=>{
 let failed=true, deploys=0, confirmed=false;
 const render=async(path,init)=>{
  if(path==='/services/srv-fixture')return service;
  if(path.endsWith('/deploys?limit=100'))return [{deploy:{status:failed?'build_failed':'live',commit:{id:revision}}}];
  if(path.endsWith('/deploys')&&init?.method==='POST'){deploys++;assert.equal(JSON.parse(init.body).commitId,revision);return {};}
  throw Error(path);
 };
 await assert.rejects(reconcilePublication({...base,serviceId:service.id,render,acknowledge:async()=>{}}),/failed/);
 failed=false;
 await reconcilePublication({...base,serviceId:service.id,render,acknowledge:async()=>{confirmed=true;}});
 assert.equal(deploys,1);assert.equal(confirmed,true);
});
test('cross-tenant service and unconfirmed deployment never complete',async()=>{
 await assert.rejects(reconcilePublication({...base,serviceId:service.id,render:async()=>({...service,rootDir:'sites/other'}),acknowledge:async()=>{throw Error('must not save');}}),/does not match/);
 await assert.rejects(reconcilePublication({...base,serviceId:service.id,render:async(path)=>path==='/services/srv-fixture'?service:path.includes('?')?[{deploy:{status:'build_in_progress',commit:{id:revision}}}]:{},acknowledge:async()=>{}}),/deadline/);
});
