import {test} from 'node:test';import assert from 'node:assert/strict';import {Window} from 'happy-dom';
import {activate} from '../workbench.js';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
test('accounts settings, first-commit choice, remembered and switchable project account',async t=>{
 const w=new Window();for(const key of ['window','document','MutationObserver','ResizeObserver','HTMLElement','HTMLDialogElement','Option','localStorage','navigator','CustomEvent'])Object.defineProperty(globalThis,key,{value:w[key],configurable:true,writable:true});
 globalThis.Option=function(text,value){const el=document.createElement('option');el.text=text;el.value=value;return el;};globalThis.requestAnimationFrame=w.requestAnimationFrame.bind(w);globalThis.cancelAnimationFrame=w.cancelAnimationFrame.bind(w);
 document.body.innerHTML='<main><aside><h3>Project</h3><div id="tree"></div><div id="project"></div></aside><section class="code"><div id="tabs"></div><div id="breadcrumbs"></div><div id="navigation"></div><div id="editor"></div></section><div class="left-rail"></div><section id="agent"></section></main><button id="open"></button><dialog id="appearance-dialog"><div class="appearance-footer"></div></dialog>';
 const cleanups=[];let contribution;t.after(()=>{for(const fn of cleanups.splice(0).reverse())fn();});const format=(parts,...args)=>typeof parts==='string'?parts:parts.reduce((v,s,i)=>v+s+(args[i]??''),'');
 const sdk={own:fn=>cleanups.push(fn),provide:(name,value)=>contribution=value,tr:s=>s,msg:format,html:format,activeLanguage:()=>'en',dockWindow:()=>()=>{},resizeToolWindow:()=>{},toolIcon:()=>{},editorFont:{size:13,family:'monospace'},fileIcon:()=>'',keymap:{registerAction:()=>()=>{},onChange:()=>()=>{},shortcut:()=>'',ariaShortcuts:()=>''},monaco:{editor:{createDiffEditor:()=>({dispose(){},setModel(){},layout(){},updateOptions(){},getLineChanges:()=>[],goToDiff(){},onDidUpdateDiff:()=>({dispose(){}})})}},host:{open:async()=>{}}};
 activate(sdk);
 // Host falso: espelha o contrato de gitAccounts* sem cofre nem rede.
 const accounts=[];let binding=null;const saved=[];const commits=[];let failNext;
 const project=()=>({binding,account:accounts.find(a=>a.id===binding)??null,missing:!!binding&&binding!=='system'&&!accounts.some(a=>a.id===binding)});
 const api=new Proxy({agents:async()=>[],onDockerProgress:()=>()=>{},onTerminalEvent:()=>()=>{},
  gitAccounts:async()=>({accounts:accounts.map(a=>({...a})),project:project()}),
  gitAccountsSave:async input=>{saved.push(input);if(!input.email.includes('@'))throw Error('Informe um e-mail de autor válido');const id='id-'+input.login;accounts.push({id,kind:input.kind,host:input.host,login:input.login,name:input.name,email:input.email,default:!accounts.length,hasSecret:!!input.secret});return id;},
  gitAccountsRemove:async id=>{accounts.splice(accounts.findIndex(a=>a.id===id),1);},
  gitAccountsDefault:async id=>{for(const a of accounts)a.default=a.id===id;},
  gitAccountsUse:async id=>{binding=id;return project();},
  gitStatus:async()=>({branch:'main',head:'abc',indexToken:'t',changes:[{path:'a.php',index:'M',worktree:' '}]}),
  gitCommit:async message=>{if(failNext){const e=failNext;failNext=undefined;throw Error(e);}commits.push({message,binding});return 'deadbeefcafe';},
 },{get:(obj,key)=>obj[key]??(async()=>{throw Error('unexpected operation '+String(key));})});
 sdk.api=api;contribution.mount(api,()=>false,async()=>{});await tick();
 const $=id=>document.getElementById(id);const click=id=>{$(id).click();};

 // Atalho nas Configurações abre a tela de contas (GitHub por padrão).
 const launcher=document.querySelector('#appearance-dialog .git-accounts-open');assert.ok(launcher,'launcher in Settings');
 launcher.click();await tick();assert.equal($('git-accounts-settings').open,true);assert.equal($('git-accounts-page').textContent,'GitHub');
 const add=async(login,name,email,secret='tok')=>{click('git-accounts-add');await tick();assert.equal($('git-account-host').value,'github.com');
  $('git-account-login').value=login;$('git-account-name').value=name;$('git-account-email').value=email;$('git-account-secret').value=secret;
  $('git-account-form').querySelector('form').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();await tick();};
 await add('jeidison','Jeidison Farias','bad-email');
 assert.match($('git-account-form-error').textContent,/e-mail/);assert.equal($('git-account-form').open,true,'invalid input keeps the form open');
 $('git-account-form').close();
 await add('jeidison','Jeidison Farias','j@example.invalid');await add('jeidison-many','Jeidison Many','m@example.invalid');
 assert.equal($('git-account-secret').value,'','token cleared from the DOM after save');
 const rows=[...document.querySelectorAll('.git-accounts-row')];assert.equal(rows.length,2);
 assert.ok(rows[0].querySelector('.git-accounts-name.default'),'default account is bold');assert.equal(rows[1].querySelector('.git-accounts-host').textContent,'github.com');
 rows[1].click();await tick();click('git-accounts-default');await tick();await tick();assert.equal(accounts[1].default,true);
 assert.match($('git-accounts-project-value').textContent,/Nenhuma conta/);
 click('git-accounts-close');

 // Primeiro commit sem conta: pergunta, grava a escolha e o commit usa a conta.
 click('show-commit');await tick();await tick();
 assert.match($('git-project-account').textContent,/escolher/);
 $('git-message').value='first';$('git-message').dispatchEvent(new w.Event('input'));
 document.querySelector('.git-file-row')?.click();
 $('git-review-commit').disabled=false;click('git-review-commit');await tick();await tick();
 assert.equal($('git-account-chooser').open,true,'asks for an account on first commit');
 const choices=[...document.querySelectorAll('input[name=git-account-choice]')];assert.deepEqual(choices.map(c=>c.value),['id-jeidison','id-jeidison-many','system']);
 assert.equal(choices.find(c=>c.checked).value,'id-jeidison-many','default account preselected');
 $('git-account-chooser').querySelector('form').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();await tick();await tick();
 assert.equal(binding,'id-jeidison-many');assert.equal($('git-account-chooser').open,false);
 click('git-confirm-commit');await tick();await tick();assert.deepEqual(commits.at(-1),{message:'first',binding:'id-jeidison-many'});
 assert.match($('git-project-account').textContent,/jeidison-many@github\.com/);

 // Segundo commit: não pergunta de novo.
 $('git-message').value='second';$('git-review-commit').disabled=false;click('git-review-commit');await tick();await tick();
 assert.equal($('git-account-chooser').open,false,'remembered choice');
 click('git-confirm-commit');await tick();await tick();assert.equal(commits.length,2);

 // Trocar a conta pelo indicador do Commit.
 click('git-project-account');await tick();await tick();
 document.querySelector('input[name=git-account-choice][value="id-jeidison"]').checked=true;
 $('git-account-chooser').querySelector('form').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();await tick();
 assert.equal(binding,'id-jeidison');

 // Conta removida no host: o erro do commit abre a escolha e é recuperável.
 failNext='[git-account] A conta Git deste projeto foi removida. Escolha outra conta.';
 $('git-message').value='third';$('git-review-commit').disabled=false;click('git-review-commit');await tick();await tick();
 click('git-confirm-commit');await tick();await tick();await tick();
 assert.equal($('git-account-chooser').open,true);assert.doesNotMatch($('git-commit-error').textContent,/\[git-account\]/);
 document.querySelector('input[name=git-account-choice][value="system"]').checked=true;
 $('git-account-chooser').querySelector('form').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();await tick();await tick();
 assert.equal(binding,'system');assert.match($('git-commit-error').textContent,/Confirme o commit novamente/);
 for(let i=0;i<localStorage.length;i++)assert.doesNotMatch(String(localStorage.getItem(localStorage.key(i))),/tok|jeidison/,'no account data in localStorage');

 for(const fn of cleanups.splice(0).reverse())fn();
 assert.equal(document.getElementById('git-accounts-settings'),null);assert.equal(document.querySelector('.git-accounts-open'),null,'launcher removed on disable');
});
