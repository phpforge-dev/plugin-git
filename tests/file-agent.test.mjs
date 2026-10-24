import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Window} from 'happy-dom';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

test('file selection is independent from staging; requests contain only selected snapshots', async () => {
 const folder = await mkdtemp(join(tmpdir(),'git-file-agent-'));
 try {
  const output = join(folder,'test.mjs');
  await build({stdin:{contents:"export {mountGitFileAgent} from './src/git-file-agent'; export {selectedFileContext} from './src/git-file-context'; export {configure} from './src/sdk';",resolveDir:process.cwd()},outfile:output,bundle:true,format:'esm'});
  const {mountGitFileAgent,selectedFileContext,configure} = await import(pathToFileURL(output));
  const w = new Window();globalThis.document = w.document;globalThis.Element = w.Element;
  document.body.innerHTML = '<section><div id="git-changes"><details open><summary>Alterações</summary></details></div></section>';
  const parent = document.querySelector('section');
  const list = document.querySelector('#git-changes');
  const details = list.querySelector('details');
  const cleanups = [];let resolve, sent, calls = [], cancelled = 0, prompts = 0, tokenSuffix = '', openedDiff = 0, staged = 0;
  const changes = [{path:'selected.php',index:'M',worktree:'M'}, {path:'new.php',index:'?',worktree:'?'}, {path:'excluded.php',index:' ',worktree:'M'}, {path:'conflict.php',index:'U',worktree:'U'}];
  for(const file of changes){
   const row=document.createElement('div');const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.onchange=()=>staged++;
   const button=document.createElement('button');button.className='git-file-row';button.dataset.path=file.path;button.textContent=file.path;button.onclick=()=>openedDiff++;
   row.append(checkbox,button);details.append(row);
  }
  configure({own:fn=>cleanups.push(fn),tr:s=>s,msg:(parts,...values)=>parts.reduce((out,part,i)=>out+part+(values[i]??''),''),html:s=>s,activeLanguage:()=> 'en',service:()=>({generate:prompt=>{prompts++;sent=prompt;return new Promise(r=>resolve=r);},cancel:async()=>{cancelled++;}})});
  const api={gitStatus:async()=>({changes}),gitDiff:async(path,layer)=>{calls.push([path,layer]);return {beforeLabel:layer?'HEAD':'index',afterLabel:layer?'index':'disk',before:'before '+path,after:'after '+path+(layer?' staged':' disk'),token:path+layer+tokenSuffix};},gitConflict:async(path)=>({base:'base',ours:'ours',theirs:'theirs',result:'disk conflict',token:path+tokenSuffix})};
  const controller=mountGitFileAgent(api,parent,()=>true);
  controller.sync(changes);
  const buttons=[...details.querySelectorAll('button')];
  const click=(target,opts={})=>target.dispatchEvent(new w.MouseEvent('click',{bubbles:true,...opts}));
  const wait=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
  click(buttons[0]);assert.equal(openedDiff,1);assert.equal(buttons[0].getAttribute('aria-pressed'),'true');
  click(buttons[1],{ctrlKey:true});assert.equal(openedDiff,1);assert.equal(buttons[1].getAttribute('aria-pressed'),'true');assert.equal(staged,0);
  // Keyboard toggling does not open a diff or stage a file.
  buttons[1].dispatchEvent(new w.KeyboardEvent('keydown',{key:' ',bubbles:true}));assert.equal(buttons[1].getAttribute('aria-pressed'),'false');
  click(buttons[1],{metaKey:true});
  const ask=parent.querySelector('.git-agent-ask');assert.match(ask.textContent,/2/);
  ask.click();const dialog=document.querySelector('dialog');dialog.show=()=>dialog.open=true;dialog.close=()=>dialog.open=false;
  // happy-dom currently implements show() on some versions; normalize for retries.
  const instruction=dialog.querySelector('textarea');
  const send=dialog.querySelector('.git-agent-send');
  send.click();await wait();assert.equal(prompts,0);assert.match(dialog.textContent,/Descreva/);
  dialog.querySelector('[data-preset="review"]').click();assert.match(instruction.value,/bugs/);
  send.click();await wait();
  assert.equal(prompts,1);assert.match(sent,/selected.php/);assert.match(sent,/new.php/);assert.doesNotMatch(sent,/excluded.php|conflict.php/);
  assert.match(sent,/ staged/);assert.match(sent,/ disk/);assert.equal(staged,0);
  assert.ok(calls.every(([path])=>path==='selected.php'||path==='new.php'));
  resolve('<img src=x onerror=alert(1)> review text');await wait();
  const answer=dialog.querySelector('.git-agent-answer');assert.equal(answer.querySelector('img'),null);assert.match(answer.textContent,/review text/);
  dialog.querySelector('[data-preset="impact"]').click();assert.match(instruction.value,/impacto/);
  send.click();await wait();tokenSuffix='changed';resolve('impact answer');await wait();assert.match(dialog.querySelector('.git-agent-status').textContent,/mudaram durante/);assert.equal(answer.textContent,'impact answer');
  tokenSuffix='';send.click();await wait();dialog.querySelector('.git-agent-stop').click();resolve('late answer');await wait();assert.equal(cancelled,1);assert.notEqual(answer.textContent,'late answer');
  send.click();await wait();controller.reset();resolve('after reset');await wait();assert.equal(answer.textContent,'');assert.equal(dialog.open,false);assert.equal(ask.disabled,true);
  click(buttons[0]);click(buttons[2],{shiftKey:true});assert.match(ask.textContent,/3/);assert.equal(staged,0);
  controller.sync(changes.slice(0,1));assert.match(ask.textContent,/1/);
  calls=[];
  const conflict=await selectedFileContext(api,['conflict.php']);assert.match(conflict.json,/disk conflict/);assert.equal(calls.length,0);
  await assert.rejects(selectedFileContext(api,['missing.php']),/saiu da lista/);
  const huge={...api,gitDiff:async()=>({before:'x'.repeat(60001),after:'',token:'big'})};await assert.rejects(selectedFileContext(huge,['new.php']),/grandes demais/);
  for(const fn of cleanups.reverse())fn();assert.equal(document.querySelector('.git-agent-query'),null);
  await w.happyDOM.abort();
 } finally {await rm(folder,{recursive:true,force:true});}
});
