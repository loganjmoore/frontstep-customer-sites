import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, cp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run=promisify(execFile);

test('runner claims, limits edits to one static site and returns the current claim without publishing', async () => {
  const directory=await mkdtemp(join(tmpdir(),'frontstep-runner-'));
  const reports=[];
  let rejectClaim=false;
  const server=createServer(async (req,res)=>{
    assert.equal(req.headers.authorization,'Bearer isolated-test');
    res.setHeader('content-type','application/json');
    if(req.method==='GET') return res.end(JSON.stringify({tickets:[{id:17,kind:'change',status:'open',subject:'Update hours',plan:'launch',scope:'Static marketing content only',site:{id:'site-fixture',slug:'fixture',name:'Fixture Plumbing',live:true},messages:[{author:'customer',body:'Change Saturday hours to 8 to 2',at:'2026-10-13',files:[]}]}]}));
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw);reports.push(body);
    if (rejectClaim && body.status === "check") {res.statusCode=409;return res.end(JSON.stringify({error:"expired claim"}));}
    if(body.status==='working')return res.end(JSON.stringify({ok:true,claimToken:'isolated-claim'}));
    assert.equal(body.claimToken,'isolated-claim');res.end(JSON.stringify({ok:true}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    await symlink(new URL('../node_modules',import.meta.url).pathname,join(directory,'node_modules'),'dir');
    await cp(new URL('.',import.meta.url),join(directory,'agent'),{recursive:true});
    await cp(new URL('../templates',import.meta.url),join(directory,'templates'),{recursive:true});
    await mkdir(join(directory,'sites/fixture'),{recursive:true});
    const html='<html><body><h1>Fixture Plumbing</h1><p>Saturday 9 to 2</p><footer>Site by <a href="https://frontstepsites.com">Front Step Sites</a></footer></body></html>';
    await writeFile(join(directory,'sites/fixture/index.html'),html);
    const env={...process.env,PORTAL_URL:`http://127.0.0.1:${server.address().port}`,AGENT_TOKEN:'isolated-test',PUSH:'0',RENDER_API_KEY:'',GITHUB_OUTPUT:'',GIT_AUTHOR_NAME:'Test',GIT_AUTHOR_EMAIL:'test@example.test',GIT_COMMITTER_NAME:'Test',GIT_COMMITTER_EMAIL:'test@example.test'};
    const exec=(command,args)=>run(command,args,{cwd:directory,env});
    await writeFile(join(directory,'.gitignore'),'node_modules\n.work/\n');
    await exec('git',['init','-q']);await exec('git',['add','sites','agent','templates','.gitignore']);await exec('git',['commit','-qm','Fixture']);
    await exec('node',['agent/run.mjs','pick','17']);
    const meta=JSON.parse(await readFile(join(directory,'.work/meta.json'),'utf8'));
    assert.equal(meta.claimToken,'isolated-claim');
    assert.match(await readFile(join(directory,'.work/brief.md'),'utf8'),/Static marketing content only/);
    await writeFile(join(directory,'sites/fixture/index.html'),html.replace('9 to 2','8 to 2'));
    await writeFile(join(directory,'.work/status'),'done');await writeFile(join(directory,'.work/reply.md'),'We updated your Saturday hours.');
    await exec('node',['agent/run.mjs','finish']);
    assert.equal(reports.at(-1).status,'done');assert.equal(reports.at(-1).claimToken,'isolated-claim');
    assert.match(await readFile(join(directory,'sites/fixture/index.html'),'utf8'),/Saturday 8 to 2/);
    assert.equal((await exec('git',['diff-tree','--no-commit-id','--name-only','-r','HEAD'])).stdout.trim(),'sites/fixture/index.html');
    const revision=(await exec('git',['rev-parse','HEAD'])).stdout;
    rejectClaim=true;
    await assert.rejects(exec('node',['agent/run.mjs','finish']),/expired claim/);
    assert.equal((await exec('git',['rev-parse','HEAD'])).stdout,revision);
    rejectClaim=false;
    await writeFile(join(directory,'.work/meta.json'),JSON.stringify({...meta,slug:'other'}));
    await assert.rejects(exec('node',['agent/run.mjs','finish']),/metadata does not match/);
    assert.equal(reports.filter(r=>r.status==='done').length,1);

  } finally {await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
});
