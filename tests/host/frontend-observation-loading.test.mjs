import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
test('generic host import, open, create and close never load frontend coordinator implementation',()=>{
  const result=spawnSync(process.execPath,['--input-type=module','-e',`
    import assert from 'node:assert/strict';
    import {registerHooks} from 'node:module';
    import {mkdtempSync,rmSync} from 'node:fs';
    import {tmpdir} from 'node:os';
    import {join} from 'node:path';
    const urls=[];
    registerHooks({resolve(specifier,context,next){const value=next(specifier,context);urls.push(value.url);return value;}});
    const {openLocalHost}=await import('@agentui/host');
    const {transcriptProjection}=await import('@agentui/contracts/conversation');
    const directory=mkdtempSync(join(tmpdir(),'generic-observation-'));
    try{
      const host=openLocalHost({path:join(directory,'host.sqlite'),projection:transcriptProjection,driver:[],authorize:()=>true});
      host.createConversation({hostId:'h',conversationId:'c'},{installationId:'generic',binding:{engine:'fixture',nativeVersion:'1',account:'test',authorizedScope:'test',nativeFormat:'v1'}});
      host.close();await host.drained;
      assert(urls.every(url=>!url.includes('/frontend-tools/')),urls.join('\\n'));
    }finally{rmSync(directory,{recursive:true,force:true});}
  `],{cwd:new URL('../../',import.meta.url),encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+result.stderr);
});
