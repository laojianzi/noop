import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
const root=mkdtempSync(join(tmpdir(),'noop-assets-ablation-'));
const source=process.env.NOOP_E2E_ABLATION_CONFIG;
const runtime=process.env.NOOP_E2E_WORKERD;
const assets=process.env.NOOP_E2E_WEB_ASSETS;
if(!source||!runtime||!assets) throw new Error('Set NOOP_E2E_ABLATION_CONFIG, NOOP_E2E_WORKERD and NOOP_E2E_WEB_ASSETS');
cpSync(join(dirname(source),'bundle'),join(root,'bundle'),{recursive:true});
const js=readdirSync(assets).find(x=>/^nsh\.[a-f0-9]+\.js$/.test(x));
if(!js) throw new Error('real Web fixture is missing its runtime script');
const s=createServer();
await new Promise((ok,fail)=>s.once('error',fail).listen(0,'127.0.0.1',ok));
const port=s.address().port;
await new Promise((ok,fail)=>s.close(e=>e?fail(e):ok()));
let config=readFileSync(source,'utf8');
config=config.replace(/address = "127\.0\.0\.1:\d+"/,`address = "127.0.0.1:${port}"`);
config=config.replace(/path = "[^"]+\/coordinator\/storage"/,`path = "${root}/storage"`);
mkdirSync(join(root,'storage'),{recursive:true});
const env={...process.env,NOOP_LOCAL_TOKEN:'synthetic-ablation-token',NOOP_LOCAL_OWNER_EMAIL:'',NOOP_LOCAL_SMTP:'',NOOP_LOCAL_LANG:''};
async function probe(name,cfg){
  const path=join(root,`${name}.capnp`);
  writeFileSync(path,cfg);
  const child=spawn(runtime,['serve',path],{env,stdio:'ignore'});
  try {
    const base=`http://127.0.0.1:${port}`;
    let response;
    for(let i=0;i<60;i++){
      if(child.exitCode!==null) throw new Error(`${name} runtime exited`);
      try{response=await fetch(`${base}/`);break;}catch{await new Promise(r=>setTimeout(r,100));}
    }
    if(!response) throw new Error(`${name} runtime did not start`);
    const html=await response.text();
    const script=await fetch(`${base}/${js}`);
    return {rootStatus:response.status,rootType:response.headers.get('content-type'),realApp:html.includes('<title>Noop</title>')&&html.includes('nsh-fetch'),scriptStatus:script.status,scriptType:script.headers.get('content-type')};
  } finally {
    child.kill('SIGINT');
    await new Promise(ok=>child.once('exit',ok));
  }
}
const normal=await probe('with-wrapper',config);
const direct=await probe('without-wrapper',config.replace('(name = "ASSETS", service = "assets")','(name = "ASSETS", service = "web")'));
if(!(normal.rootStatus===200&&normal.realApp&&normal.rootType?.includes('text/html')&&normal.scriptStatus===200&&normal.scriptType?.includes('javascript'))) throw new Error('normal static assets failed');
if(direct.rootStatus===200&&direct.realApp&&direct.rootType?.includes('text/html')&&direct.scriptStatus===200&&direct.scriptType?.includes('javascript')) throw new Error('the removed wrapper was not necessary');
const result={normal,direct,conclusion:'The raw disk binding returns a directory listing instead of the Web entry page.'};
writeFileSync(join(root,'result.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
console.log(`Evidence: ${root}`);
