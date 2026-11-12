// Records real browser interactions. The stage adds chapter labels, never fabricated results.
// Requires installed Chrome, web dependencies and Playwright's FFmpeg.
import { chromium } from '../web/node_modules/playwright/index.mjs';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] || join(root, 'docs/images/blackbox-demo.webm'));
const tempRoot = join(root,'.blackbox');
await mkdir(tempRoot,{recursive:true});
await mkdir(dirname(output),{recursive:true});
const dir = await mkdtemp(join(tempRoot,'portfolio-'));
const server = spawn(join(root,'dist',process.platform==='win32'?'blackbox.exe':'blackbox'),['serve','-ui','127.0.0.1:22990','-proxy','127.0.0.1:22991','-demo','127.0.0.1:22992','-db',join(dir,'history.db')],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
let log='';server.stdout.on('data',b=>log+=b);server.stderr.on('data',b=>log+=b);
let browser;
const chapters=[];
try {
 let ready=false;
 for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error(log);try{if((await fetch('http://127.0.0.1:22990/api/state')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
 assert(ready,'Server must be ready');
 browser=await chromium.launch({channel:process.env.BLACKBOX_BROWSER_CHANNEL||'chrome',headless:true});
 // Only this recording context permits framing the real UI; the shipped CSP is unchanged.
 const context=await browser.newContext({bypassCSP:true,viewport:{width:1920,height:1080},recordVideo:{dir,size:{width:1920,height:1080}},deviceScaleFactor:1});
 const page=await context.newPage();
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const stage=await readFile(join(root,'scripts/portfolio-stage.html'),'utf8');
 await page.route('**/portfolio-stage',r=>r.fulfill({contentType:'text/html',body:stage}));
 // Recording-only presentation: permit this local page to be embedded in the stage.
 // No response body, API response, or shipped server policy is changed.
 await page.route('http://127.0.0.1:22990/', async route => {
  const response = await route.fetch();
  const headers = response.headers();
  delete headers['content-security-policy']; delete headers['x-frame-options'];
  await route.fulfill({ response, headers });
 });
 await page.goto('http://127.0.0.1:22990/portfolio-stage');
 const frame=await page.locator('iframe').elementHandle().then(el=>el.contentFrame());
 assert(frame);
 await frame.getByRole('button',{name:'Run experiment',exact:true}).waitFor();
 const start=Date.now();
 const hold=ms=>page.waitForTimeout(process.env.BLACKBOX_VIDEO_DRY_RUN ? Math.min(ms,250) : ms);
 async function chapter(number,title,description,caption){
  chapters.push({seconds:(Date.now()-start)/1000,number,title:title.replaceAll('<br>',' '),caption});
  await page.evaluate(({number,title,description,caption})=>{document.querySelector('#number').textContent=`0${number} / 06`;document.querySelector('#chapter').innerHTML=title;document.querySelector('#context').innerHTML=description;document.querySelector('#caption').textContent=caption;document.querySelector('#progress').style.width=`${number/6*100}%`;}, {number,title,description,caption});
  console.log(`Chapter ${number}: ${title.replaceAll('<br>',' ')}`);
 }
 async function click(locator){
  await locator.scrollIntoViewIfNeeded();
  const box=await locator.boundingBox(); assert(box);
  await page.evaluate(({x,y})=>{const c=document.querySelector('#cursor');c.style.display='block';c.style.left=x+'px';c.style.top=y+'px';},{x:box.x+box.width/2,y:box.y+box.height/2});
  await hold(450);
  await page.locator('#cursor').evaluate(el=>el.classList.add('click'));
  await locator.click();
  await hold(250);
  await page.locator('#cursor').evaluate(el=>{el.classList.remove('click');el.style.display='none';});
 }
 async function screenshot(name){await page.screenshot({path:join(dir,name+'.png')});}
 await screenshot('00-cover');
 await hold(6000);
 await page.locator('#cover').evaluate(el=>el.classList.add('hidden'));
 await chapter(1,'Choose<br>a failure.','A real HTTP request.<br>A real database write.','Drop the first response after the API has already saved the workout.');
 await hold(2500);
 await frame.locator('.experiment-grid').evaluate(el=>el.scrollIntoView({block:'start',behavior:'smooth'}));
 await hold(3500);
 await screenshot('01-setup');
 await click(frame.getByRole('button',{name:'Run experiment',exact:true}));
 await frame.getByText('actual: 2',{exact:true}).waitFor();
 await chapter(2,'One action.<br>Two writes.','The client retries.<br>The API writes again.','The unprotected client stores two workouts. The invariant is broken.');
 await screenshot('02-duplicate');
 await hold(6500);
 // Use navigation to show the traffic from the completed run.
 await click(frame.getByRole('navigation').getByRole('button',{name:/Request stream/}));
 await click(frame.getByRole('button',{name:'Inspect POST /workouts, connection dropped'}).first());
 await frame.getByRole('dialog').getByText('No HTTP response',{exact:true}).waitFor();
 await chapter(3,'Find the<br>missing link.','Upstream: 201.<br>Client: no response.','The server answered. Blackbox dropped that response before the client received it.');
 await screenshot('03-inspector');
 await hold(8000);
 await click(frame.getByRole('button',{name:'Close request details'}));
 await click(frame.getByRole('navigation').getByRole('button',{name:'Failure lab',exact:true}));
 await frame.locator('.experiment-grid').evaluate(el=>el.scrollIntoView({block:'start'}));
 await chapter(4,'Change the<br>retry behavior.','Same failure.<br>Same logical action.','Reuse an idempotency key, with an API that implements deduplication.');
 await click(frame.getByRole('button',{name:'Idempotent',exact:true}));
 await hold(1800);
 await click(frame.getByRole('button',{name:'Run experiment',exact:true}));
 await frame.getByText('actual: 1',{exact:true}).waitFor();
 await screenshot('04-idempotent');
 await hold(6500);
 await click(frame.getByRole('button',{name:'Compare saved experiments'}));
 await frame.getByText('The invariant recovered.',{exact:true}).waitFor();
 await frame.locator('.comparison-selectors').evaluate(el=>el.scrollIntoView({block:'start'}));
 await chapter(5,'Compare<br>the evidence.','Two attempts each.<br>Two writes → one.','Both runs retain their fault rules. The comparison checks that the setups match.');
 await screenshot('05-comparison');
 await hold(8500);
 const download=page.waitForEvent('download');
 await click(frame.getByRole('article',{name:'Comparison experiment'}).getByRole('link',{name:'Export result'}));
 const file=await download;await file.saveAs(join(dir,'exported-result.json'));
 const saved=JSON.parse(await readFile(join(dir,'exported-result.json'),'utf8'));
 assert.equal(saved.storedWorkouts,1);
 await page.locator('#caption').evaluate(el=>el.textContent='Export the result and its configuration as a reproducible test case.');
 await hold(3500);
 await click(frame.getByRole('navigation').getByRole('button',{name:'Failure lab',exact:true}));
 await chapter(6,'Keep the<br>case close.','Desktop or mobile.<br>Local by design.','Inspect outcomes, restore a setup, and run it again. All on your machine.');
 await page.locator('#window').evaluate(el=>el.classList.add('phone'));
 await frame.locator('.result-panel').evaluate(el=>el.scrollIntoView({block:'start'}));
 await hold(1500);
 await screenshot('06-mobile');
 await hold(6000);
 const state=await (await fetch('http://127.0.0.1:22990/api/state')).json();
 const runs=await (await fetch('http://127.0.0.1:22990/api/runs')).json();
 assert.equal(state.lastRun.storedWorkouts,1);assert.equal(runs.runs.length,2);assert.equal(runs.runs[1].storedWorkouts,2);assert.deepEqual(errors,[]);
 await writeFile(join(dir,'recorded-evidence.json'),JSON.stringify({runs:runs.runs,events:state.events,errors},null,2));
 await page.evaluate(()=>{document.querySelector('#kicker').textContent='BLACKBOX / A LOCAL HTTP FAILURE LAB';document.querySelector('#cover-title').innerHTML='Make the failure visible.<br><em>Keep the evidence.</em>';document.querySelector('#cover-copy').innerHTML='Response loss · latency · HTTP errors<br>Go + React + SQLite. One local executable.';document.querySelector('#byline').textContent='github.com/nerifilipe/blackbox';document.querySelector('#cover').classList.remove('hidden');});
 await hold(1000);await screenshot('07-end');await hold(5000);
 await writeFile(join(dir,'chapters.json'),JSON.stringify(chapters,null,2));
 const video=page.video();await context.close();await rename(await video.path(),output);
 console.log(JSON.stringify({output,artifacts:dir,seconds:(Date.now()-start)/1000}));
} catch(error) { console.error(error); throw error; } finally {if(browser)await browser.close();server.kill();await writeFile(join(dir,'server.log'),log);}
