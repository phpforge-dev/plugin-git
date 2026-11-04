import {test} from 'node:test';import assert from 'node:assert/strict';import {Window} from 'happy-dom';
import {activate} from '../workbench.js';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const settle=async(n=6)=>{for(let i=0;i<n;i++)await tick();};
test('Log In via GitHub (device flow), Generate and Use Token after a rejected push',async t=>{
 const w=new Window();for(const key of ['window','document','MutationObserver','ResizeObserver','HTMLElement','HTMLDialogElement','Option','localStorage','navigator','CustomEvent'])Object.defineProperty(globalThis,key,{value:w[key],configurable:true,writable:true});
 globalThis.Option=function(text,value){const el=document.createElement('option');el.text=text;el.value=value;return el;};globalThis.requestAnimationFrame=w.requestAnimationFrame.bind(w);globalThis.cancelAnimationFrame=w.cancelAnimationFrame.bind(w);
 const copied=[];Object.defineProperty(w.navigator,'clipboard',{value:{writeText:async text=>{copied.push(text);}},configurable:true});
 document.body.innerHTML='<main><aside><h3>Project</h3><div id="tree"></div><div id="project"></div></aside><section class="code"><div id="tabs"></div><div id="breadcrumbs"></div><div id="navigation"></div><div id="editor"></div></section><div class="left-rail"></div><section id="agent"></section></main><button id="open"></button><dialog id="appearance-dialog"><div class="appearance-footer"></div></dialog>';
 const cleanups=[];let contribution;t.after(()=>{for(const fn of cleanups.splice(0).reverse())fn();});const format=(parts,...args)=>typeof parts==='string'?parts:parts.reduce((v,s,i)=>v+s+(args[i]??''),'');
 const sdk={own:fn=>cleanups.push(fn),provide:(name,value)=>contribution=value,tr:s=>s,msg:format,html:format,activeLanguage:()=>'en',dockWindow:()=>()=>{},resizeToolWindow:()=>{},toolIcon:()=>{},editorFont:{size:13,family:'monospace'},fileIcon:()=>'',keymap:{registerAction:()=>()=>{},onChange:()=>()=>{},shortcut:()=>'',ariaShortcuts:()=>''},monaco:{editor:{createDiffEditor:()=>({dispose(){},setModel(){},layout(){},updateOptions(){},getLineChanges:()=>[],goToDiff(){},onDidUpdateDiff:()=>({dispose(){}})})}},host:{open:async()=>{}}};
 activate(sdk);
 // Host falso: espelha gitAccountsLogin sem rede; o token nunca chega à interface.
 const accounts=[];const calls=[];let polls=[];let startError;let pushError;const saved=[];
 const api=new Proxy({agents:async()=>[],onDockerProgress:()=>()=>{},onTerminalEvent:()=>()=>{},
  gitAccounts:async()=>({accounts:accounts.map(a=>({...a})),project:{binding:accounts[0]?.id??null,account:accounts[0]??null,missing:false}}),
  gitAccountsLogin:async input=>{calls.push(input);
   if(input.action==='start'){if(startError)throw Error(startError);return {session:'s'+calls.length,userCode:'WDJB-MJHT',verificationUri:'https://github.com/login/device',interval:0,expiresIn:900,opened:true};}
   if(input.action==='poll'){const next=polls.shift()??{status:'pending',interval:0};if(next instanceof Error)throw next;if(next.status==='done')accounts.push({id:next.id,kind:'github',host:'github.com',login:next.login,name:'Mona Lisa',email:'mona@example.invalid',default:!accounts.length,hasSecret:true});return next;}
   if(input.action==='generate')return {url:'https://github.com/settings/tokens/new?scopes=repo',opened:false};
   return null;},
  gitAccountsSave:async input=>{saved.push(input);if(input.secret==='bad')throw Error('Token inválido, expirado ou revogado. Gere um novo token e tente de novo.');return input.id;},
  gitAccountsUse:async()=>null,
  gitStatus:async()=>({branch:'main',head:'abc',indexToken:'t',changes:[{path:'a.php',index:'M',worktree:' '}]}),
  gitTools:async()=>({branches:[{name:'main',current:true,remote:false,upstream:'origin/main',tracking:''}],remotes:['origin'],stashes:[],tags:[],worktrees:[]}),
  gitCommit:async()=>'deadbeefcafe',
  gitOperation:async input=>{calls.push({op:input.kind});if(pushError){const e=pushError;pushError=undefined;throw Error(e);}return 'pushed';},
 },{get:(obj,key)=>obj[key]??(async()=>{throw Error('unexpected operation '+String(key));})});
 sdk.api=api;contribution.mount(api,()=>false,async()=>{});await tick();
 const $=id=>document.getElementById(id);const click=id=>{$(id).click();};

 document.querySelector('#appearance-dialog .git-accounts-open').click();await settle();
 // + no GitHub: menu com Entrar via GitHub e Entrar com token, navegável pelo teclado.
 click('git-accounts-add');await tick();
 const menu=$('git-accounts-add-menu');assert.equal(menu.hidden,false);
 assert.deepEqual([...menu.querySelectorAll('[role=menuitem]')].map(b=>b.textContent),['Entrar via GitHub…','Entrar com token…','Entrar no GitHub Enterprise…']);
 assert.equal(document.activeElement,$('git-accounts-login-browser'));
 menu.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));assert.equal(document.activeElement,$('git-accounts-login-token'));
 menu.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(menu.hidden,true);assert.equal(document.activeElement,$('git-accounts-add'));

 // Falha ao iniciar (sem client id): erro visível e caminho para o token.
 startError='Login pelo navegador não configurado: falta o client id público do OAuth App do GitHub (PHP_IDE_GITHUB_CLIENT_ID). Use Log In with Token.';
 click('git-accounts-add');await tick();click('git-accounts-login-browser');await settle();
 assert.equal($('git-account-browser').open,true);assert.match($('git-account-browser-error').textContent,/client id/);
 assert.equal($('git-account-browser-reopen').textContent,'Tentar novamente');
 startError=undefined;

 // Tentar novamente: código exibido e copiado, navegador aberto, espera até a autorização.
 polls=[{status:'pending',interval:0},{status:'done',id:'gh-1',login:'octocat',updated:false}];
 click('git-account-browser-reopen');await settle(12);
 assert.equal(calls.filter(c=>c.action==='poll').length,2,'polls until authorized');
 assert.equal($('git-account-browser').open,false,'closes when the account is created');
 assert.deepEqual(copied,['WDJB-MJHT'],'user code copied for the browser page');
 assert.match($('git-accounts-status').textContent,/octocat adicionada/);
 const row=document.querySelector('.git-accounts-row');assert.match(row.textContent,/Mona Lisa.*octocat/);
 assert.equal(JSON.stringify(calls).includes('token'),false,'no token travels to the UI');

 // Cancelar descarta a sessão no host.
 click('git-accounts-add');await tick();click('git-accounts-login-browser');await settle();
 assert.equal($('git-account-code').textContent,'WDJB-MJHT');assert.match($('git-account-browser-text').textContent,/github\.com\/login\/device/);
 const session=calls.filter(c=>c.action==='start').at(-1);
 click('git-account-browser-cancel');await settle();
 assert.equal($('git-account-browser').open,false);assert.ok(calls.some(c=>c.action==='cancel'),'cancel sent');
 const pollsBefore=calls.filter(c=>c.action==='poll').length;await settle(6);assert.equal(calls.filter(c=>c.action==='poll').length,pollsBefore,'no polling after cancel');
 assert.ok(session);

 // Entrar com token: Gerar abre a página de token; login/nome/e-mail são opcionais (vêm da API).
 click('git-accounts-add');await tick();click('git-accounts-login-token');await tick();
 assert.equal($('git-account-generate').hidden,false);assert.equal($('git-account-form-title').textContent,'Adicionar conta GitHub');
 assert.ok([...document.querySelectorAll('.git-account-identity')].every(l=>l.hidden),'Add GitHub Account: only server and token');
 assert.match($('git-account-hint').textContent,/\[repo, gist, read:org, workflow, read:user, user:email\]/);
 $('git-account-form').querySelector('form').dispatchEvent(new w.Event('submit',{cancelable:true}));await settle();
 assert.equal($('git-account-form-error').textContent,'O token não pode ficar vazio.');
 click('git-account-generate');await settle();
 assert.deepEqual(calls.at(-1),{action:'generate',kind:'github',host:'github.com'});
 assert.match($('git-account-form-error').textContent,/settings\/tokens\/new/,'shows the URL when the browser cannot open');
 $('git-account-form').close();
 // GitHub Enterprise: mesmo formulário com o servidor vazio e focado.
 click('git-accounts-add');await tick();click('git-accounts-login-enterprise');await tick();
 assert.equal($('git-account-host').value,'');assert.equal(document.activeElement,$('git-account-host'));$('git-account-form').close();
 // GitLab: + abre direto "Adicionar conta GitLab" (sem login pelo navegador), botão Entrar.
 [...document.querySelectorAll('#git-accounts-nav [role=tab]')].find(b=>b.textContent==='GitLab').click();await settle();
 click('git-accounts-add');await tick();
 assert.equal($('git-accounts-add-menu').hidden,true);assert.equal($('git-account-form').open,true);
 assert.equal($('git-account-form-title').textContent,'Adicionar conta GitLab');assert.equal($('git-account-form-save').textContent,'Entrar');
 assert.match($('git-account-hint').textContent,/\[api, read_user\]/);$('git-account-form').close();
 click('git-accounts-close');

 // Push recusado com token expirado: aviso com Usar token, diálogo só com o token, novo push.
 click('show-commit');await settle();
 $('git-message').value='msg';$('git-message').dispatchEvent(new w.Event('input'));
 pushError='[git-account-token:gh-1] O token da conta octocat (github.com) expirou ou foi revogado. Use Token para informar um novo.\nfatal: Authentication failed';
 $('git-commit-push').disabled=false;click('git-commit-push');await settle();click('git-confirm-commit');await settle(10);
 assert.equal($('git-operations').open,true,'push dialog opens after commit');
 $('git-operations').querySelector('form').dispatchEvent(new w.Event('submit',{cancelable:true}));await settle(10);
 assert.match($('git-operation-result').textContent,/expirou ou foi revogado/);assert.doesNotMatch($('git-operation-result').textContent,/\[git-account-token/);
 const use=$('git-operation-use-token');assert.ok(use,'Use Token action');assert.equal($('git-account-chooser').open,false,'does not reopen the account chooser');
 use.click();await settle();
 assert.equal($('git-account-form').open,true);assert.equal($('git-account-form-title').textContent,'Entrar no GitHub');
 assert.ok([...document.querySelectorAll('.git-account-identity')].every(l=>l.hidden),'only server and token');
 assert.equal($('git-account-host').readOnly,true);assert.equal($('git-account-form-save').textContent,'Entrar');
 $('git-account-secret').value='bad';$('git-account-form').querySelector('form').dispatchEvent(new w.Event('submit',{cancelable:true}));await settle();
 assert.match($('git-account-form-error').textContent,/expirado/);assert.equal($('git-account-form').open,true,'rejected token keeps the dialog');
 $('git-account-secret').value='new-token';$('git-account-form').querySelector('form').dispatchEvent(new w.Event('submit',{cancelable:true}));await settle();
 assert.deepEqual({id:saved.at(-1).id,login:saved.at(-1).login,secret:saved.at(-1).secret},{id:'gh-1',login:'octocat',secret:'new-token'});
 assert.equal($('git-account-secret').value,'');assert.match($('git-operation-result').textContent,/Token atualizado/);
 $('git-operations').querySelector('form').dispatchEvent(new w.Event('submit',{cancelable:true}));await settle(10);
 assert.equal($('git-operation-result').textContent,'pushed');
 for(let i=0;i<localStorage.length;i++)assert.doesNotMatch(String(localStorage.getItem(localStorage.key(i))),/new-token|WDJB/);
});
