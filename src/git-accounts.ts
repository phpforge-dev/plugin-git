import {tr,msg,html,own,on} from './sdk';

/** Conta Git da IDE como o host devolve: o token fica no cofre do sistema, nunca aqui. */
export type GitHostAccount = {id:string;kind:'github'|'gitlab'|'bitbucket'|'generic';host:string;login:string;name:string;email:string;default:boolean;hasSecret:boolean};
export type ProjectAccount = {binding:string|null;account:GitHostAccount|null;missing:boolean}|null;
type Listing = {accounts:GitHostAccount[];project:ProjectAccount};

export const ACCOUNT_REQUIRED='[git-account] ';
/** Texto do erro sem o marcador e se ele pede uma (nova) escolha de conta. */
const TOKEN_REJECTED=/\[git-account-token:([^\]]*)\] /;
/** Texto do erro sem marcadores, se ele pede uma (nova) escolha de conta e, no aviso de token
 * expirado do push, o id da conta para a ação Usar token. */
export function accountError(error:unknown){const raw=String(error).replace(/^Error:\s*/,'');const token=TOKEN_REJECTED.exec(raw)?.[1];return{required:raw.includes(ACCOUNT_REQUIRED),token,text:raw.replace(ACCOUNT_REQUIRED,'').replace(TOKEN_REJECTED,'')};}
const CHANGED='phpforge-git-accounts';

const KINDS=[
 {kind:'github',label:'GitHub',host:'github.com',hint:tr('Os seguintes escopos devem ser concedidos ao token: [repo, gist, read:org, workflow, read:user, user:email]')},
 {kind:'gitlab',label:'GitLab',host:'gitlab.com',hint:tr('Os seguintes escopos devem ser concedidos ao token: [api, read_user]')},
 {kind:'bitbucket',label:'Bitbucket',host:'bitbucket.org',hint:tr('API token ou app password com permissão de leitura e escrita em repositórios.')},
 {kind:'generic',label:tr('Outros hosts Git'),host:'',hint:tr('Usuário e senha ou token aceitos pelo servidor via HTTPS. Remotos SSH continuam usando a chave do sistema.')},
] as const;
const kindLabel=(kind:string)=>KINDS.find(k=>k.kind===kind)?.label??kind;
const palette=['#5fb865','#6b74d6','#d9844a','#3d9ccf','#c25d9b','#b4a23c'];
function avatar(account:GitHostAccount){
 const span=document.createElement('span');span.className='git-accounts-avatar';span.setAttribute('aria-hidden','true');
 const words=(account.name||account.login).trim().split(/\s+/);span.textContent=((words[0]?.[0]??'')+(words.length>1?words[words.length-1][0]:'')).toUpperCase();
 let sum=0;for(const c of account.login+account.host)sum=(sum*31+c.charCodeAt(0))>>>0;span.style.background=palette[sum%palette.length];return span;
}
export const describeAccount=(a:GitHostAccount)=>`${a.name} · ${a.login}@${a.host}`;

/** Settings → Controle de versão → GitHub/GitLab/Bitbucket/Outros hosts e a escolha de conta por projeto. */
export function mountGitAccounts(api:any){
 const settings=document.createElement('dialog');settings.id='git-accounts-settings';settings.className='git-accounts-settings';settings.setAttribute('aria-label',tr('Contas Git'));
 settings.innerHTML=html`<div class="git-accounts-title">Configurações</div><div class="git-accounts-body"><nav aria-label="Controle de versão"><div class="git-accounts-group">Controle de versão</div><div id="git-accounts-nav" role="tablist"></div></nav>
 <section><div class="git-accounts-crumb"><span>Controle de versão</span> › <strong id="git-accounts-page"></strong></div>
 <div class="git-accounts-list-wrap"><div class="git-accounts-toolbar" role="toolbar"><button type="button" id="git-accounts-add">+</button><button type="button" id="git-accounts-remove">−</button><button type="button" id="git-accounts-default">✓</button><button type="button" id="git-accounts-edit">✎</button></div>
 <div id="git-accounts-add-menu" class="git-accounts-menu" role="menu" hidden><button type="button" role="menuitem" id="git-accounts-login-browser">Entrar via GitHub…</button><button type="button" role="menuitem" id="git-accounts-login-token">Entrar com token…</button><hr><button type="button" role="menuitem" id="git-accounts-login-enterprise">Entrar no GitHub Enterprise…</button></div>
 <div id="git-accounts-list" role="listbox" tabindex="0" aria-label="Contas"></div></div>
 <p id="git-accounts-empty" class="git-accounts-note"></p>
 <div class="git-accounts-project"><strong>Este projeto</strong><span id="git-accounts-project-value"></span><button type="button" id="git-accounts-project-change">Trocar conta…</button></div>
 <p class="git-accounts-note">Tokens ficam no cofre de senhas do sistema (Keychain no macOS) e só são entregues ao processo git de cada fetch, pull ou push. A conta em negrito é a padrão sugerida para novos projetos.</p>
 <p id="git-accounts-status" role="status" aria-live="polite"></p></section></div>
 <div class="git-accounts-footer"><button type="button" id="git-accounts-close">Fechar</button></div>`;
 const form=document.createElement('dialog');form.id='git-account-form';form.className='git-accounts-form';
 form.innerHTML=html`<form method="dialog"><h2 id="git-account-form-title"></h2>
 <label>Servidor<input id="git-account-host" autocomplete="off" spellcheck="false" placeholder="git.empresa.com"></label>
 <label class="git-account-identity">Usuário (login)<input id="git-account-login" autocomplete="off" spellcheck="false"></label>
 <label class="git-account-identity">Nome do autor<input id="git-account-name" autocomplete="off"></label>
 <label class="git-account-identity">E-mail do autor<input id="git-account-email" type="email" autocomplete="off" spellcheck="false"></label>
 <label>Token<span class="git-account-token-row"><input id="git-account-secret" type="password" autocomplete="off" spellcheck="false"><button type="button" id="git-account-generate">Gerar…</button></span></label>
 <p id="git-account-hint" class="git-accounts-note"></p><p id="git-account-form-error" role="alert"></p>
 <div class="git-accounts-footer"><button type="button" id="git-account-form-cancel">Cancelar</button><button type="submit" id="git-account-form-save" class="default">Adicionar conta</button></div></form>`;
 const chooser=document.createElement('dialog');chooser.id='git-account-chooser';chooser.className='git-accounts-form';
 chooser.innerHTML=html`<form method="dialog"><h2>Conta Git deste projeto</h2><p id="git-account-chooser-reason"></p><div id="git-account-choices" role="radiogroup" aria-label="Contas"></div>
 <p class="git-accounts-note">A escolha fica na configuração local deste repositório (phpide.account). Commits usam nome e e-mail da conta; fetch, pull e push usam o token dela quando o remoto HTTPS é do mesmo host.</p><p id="git-account-chooser-error" role="alert"></p>
 <div class="git-accounts-footer"><button type="button" id="git-account-chooser-add">Adicionar conta…</button><span></span><button type="button" id="git-account-chooser-cancel">Cancelar</button><button type="submit" id="git-account-chooser-use" class="default">Usar esta conta</button></div></form>`;
 const browser=document.createElement('dialog');browser.id='git-account-browser';browser.className='git-accounts-form';
 browser.innerHTML=html`<form method="dialog"><h2>Entrar no GitHub</h2><p id="git-account-browser-text"></p>
 <div class="git-account-code"><output id="git-account-code" aria-label="Código de verificação"></output><button type="button" id="git-account-code-copy">Copiar código</button></div>
 <p id="git-account-browser-status" role="status" aria-live="polite"></p><p id="git-account-browser-error" role="alert"></p>
 <p class="git-accounts-note">O token gerado vai direto para o cofre de senhas do sistema. O PHP IDE pede os escopos repo, gist, read:org, workflow, read:user e user:email.</p>
 <div class="git-accounts-footer"><button type="button" id="git-account-browser-token">Entrar com token…</button><span></span><button type="button" id="git-account-browser-reopen">Abrir navegador novamente</button><button type="button" id="git-account-browser-cancel">Cancelar</button></div></form>`;
 const ask=document.createElement('dialog');ask.className='git-accounts-form';ask.innerHTML=html`<form method="dialog"><p id="git-accounts-confirm-text"></p><div class="git-accounts-footer"><button value="no">Cancelar</button><button value="yes" class="default">Remover</button></div></form>`;
 document.body.append(settings,form,chooser,browser,ask);own(()=>{stopLogin();settings.remove();form.remove();chooser.remove();browser.remove();ask.remove();});
 const confirmRemove=(text:string)=>new Promise<boolean>(resolve=>{q(ask,'git-accounts-confirm-text').textContent=text;ask.returnValue='';ask.addEventListener('close',()=>resolve(ask.returnValue==='yes'),{once:true});ask.showModal();});
 const q=<T extends HTMLElement=HTMLElement>(root:HTMLElement,id:string)=>root.querySelector<T>('#'+id)!;
 const input=(id:string)=>q<HTMLInputElement>(form,id);
 for(const [id,label] of [['git-accounts-add',tr('Adicionar conta')],['git-accounts-remove',tr('Remover conta')],['git-accounts-default',tr('Definir como padrão')],['git-accounts-edit',tr('Editar conta e token')]] as const){const b=q(settings,id);b.title=label;b.setAttribute('aria-label',label);}
 let listing:Listing={accounts:[],project:null};let page:string='github';let selected:string|undefined;let editing:GitHostAccount|undefined;let formKind:string='github';let working=false;let tokenMode=false;let tokenDone:((ok:boolean)=>void)|undefined;
 const status=(text:string)=>{q(settings,'git-accounts-status').textContent=text;};
 const changed=()=>window.dispatchEvent(new CustomEvent(CHANGED));
 async function load(){listing=await api.gitAccounts();return listing;}
 function projectText(project:ProjectAccount){
  if(!project)return tr('Projeto sem repositório Git');
  if(project.missing)return tr('A conta escolhida foi removida — escolha outra');
  if(project.binding==='system')return tr('Configuração do Git do sistema');
  if(project.account)return describeAccount(project.account);
  return tr('Nenhuma conta escolhida (será perguntado no primeiro commit ou push)');
 }
 function renderNav(){
  const nav=q(settings,'git-accounts-nav');nav.replaceChildren(...KINDS.map(k=>{const b=document.createElement('button');b.type='button';b.setAttribute('role','tab');b.textContent=k.label;b.setAttribute('aria-selected',String(k.kind===page));b.onclick=()=>{page=k.kind;selected=undefined;render();};return b;}));
 }
 function render(){
  renderNav();const meta=KINDS.find(k=>k.kind===page)!;q(settings,'git-accounts-page').textContent=meta.label;
  const rows=listing.accounts.filter(a=>a.kind===page);if(!rows.some(a=>a.id===selected))selected=rows[0]?.id;
  q(settings,'git-accounts-list').replaceChildren(...rows.map(a=>{
   const row=document.createElement('div');row.className='git-accounts-row';row.setAttribute('role','option');row.dataset.id=a.id;row.setAttribute('aria-selected',String(a.id===selected));
   const text=document.createElement('span');text.className='git-accounts-text';const top=document.createElement('span');top.className='git-accounts-name';
   const name=document.createElement('span');name.textContent=a.name;const login=document.createElement('span');login.className='git-accounts-login';login.textContent=a.login;top.append(name,login);
   if(a.default){top.classList.add('default');row.title=tr('Conta padrão');}
   const host=document.createElement('span');host.className='git-accounts-host';host.textContent=a.host+(a.hasSecret?'':tr(' · sem token'));text.append(top,host);
   row.append(avatar(a),text);row.onclick=()=>{selected=a.id;render();};row.ondblclick=()=>openForm(a);return row;
  }));
  q(settings,'git-accounts-empty').textContent=rows.length?'':msg`Nenhuma conta ${meta.label}. Use + para adicionar.`;
  q<HTMLButtonElement>(settings,'git-accounts-remove').disabled=working||!selected;q<HTMLButtonElement>(settings,'git-accounts-edit').disabled=working||!selected;
  q<HTMLButtonElement>(settings,'git-accounts-default').disabled=working||!selected||!!rows.find(a=>a.id===selected)?.default;
  q(settings,'git-accounts-project-value').textContent=projectText(listing.project);q<HTMLButtonElement>(settings,'git-accounts-project-change').disabled=!listing.project;
 }
 async function refresh(){try{await load();render();}catch(error){status(accountError(error).text);}}
 async function act(work:()=>Promise<unknown>,done:string){if(working)return;working=true;render();try{await work();status(done);changed();}catch(error){status(accountError(error).text);}finally{working=false;await refresh();}}
 /** Formulário da conta. `token` é o diálogo "Entrar no GitHub/GitLab" do aviso de token expirado. */
 function openForm(account?:GitHostAccount,kind=page,token=false,enterprise=false){
  editing=account;formKind=account?.kind??kind;tokenMode=token&&!!account;const meta=KINDS.find(k=>k.kind===formKind)!;
  const remote=formKind==='github'||formKind==='gitlab';
  q(form,'git-account-form-title').textContent=tokenMode?msg`Entrar no ${meta.label}`:account?msg`Editar conta ${meta.label}`:enterprise?tr('Adicionar conta GitHub Enterprise'):msg`Adicionar conta ${meta.label}`;
  // Como no PhpStorm, GitHub/GitLab pedem só servidor e token: login, nome e e-mail vêm da API.
  for(const row of form.querySelectorAll<HTMLElement>('.git-account-identity'))row.hidden=tokenMode||(!account&&remote);
  input('git-account-host').readOnly=tokenMode;q(form,'git-account-generate').hidden=!remote;
  for(const id of ['git-account-login','git-account-name','git-account-email'])input(id).placeholder=remote?tr('Obtido do servidor pelo token'):'';
  input('git-account-host').value=account?.host??(enterprise?'':meta.host);input('git-account-login').value=account?.login??'';input('git-account-name').value=account?.name??'';input('git-account-email').value=account?.email??'';input('git-account-secret').value='';
  input('git-account-secret').placeholder=account?.hasSecret?tr('Deixe vazio para manter o token salvo'):tr('Token de acesso pessoal');
  q(form,'git-account-hint').textContent=tokenMode?msg`O servidor recusou o token salvo de ${account!.login}. ${meta.hint}`:meta.hint;q(form,'git-account-form-error').textContent='';q(form,'git-account-form-save').textContent=tokenMode||(!account&&formKind==='gitlab')?tr('Entrar'):account?tr('Salvar'):tr('Adicionar conta');
  form.showModal();input(enterprise||(!meta.host&&!account)?'git-account-host':account||remote?'git-account-secret':'git-account-login').focus();
 }
 q(form,'git-account-generate').onclick=async()=>{
  try{const page:{url:string;opened:boolean}=await api.gitAccountsLogin({action:'generate',kind:formKind,host:input('git-account-host').value});
   q(form,'git-account-form-error').textContent=page.opened?'':msg`Não foi possível abrir o navegador. Abra ${page.url}`;}
  catch(error){q(form,'git-account-form-error').textContent=accountError(error).text;}
 };
 let afterSave:((id:string)=>void)|undefined;
 q(form,'git-account-form-cancel').onclick=()=>{afterSave=undefined;form.close();};
 form.querySelector('form')!.onsubmit=async event=>{
  event.preventDefault();if(working)return;working=true;const save=q<HTMLButtonElement>(form,'git-account-form-save');save.disabled=true;
  const secret=input('git-account-secret');
  try{
   if((tokenMode||!editing)&&!secret.value&&formKind!=='generic')throw Error(tr('O token não pode ficar vazio.'));
   const id:string=await api.gitAccountsSave({id:editing?.id,kind:formKind,host:input('git-account-host').value,login:input('git-account-login').value,name:input('git-account-name').value,email:input('git-account-email').value,secret:secret.value});
   secret.value='';const done=tokenDone;tokenDone=undefined;form.close();page=formKind;selected=id;status(tokenMode?tr('Token atualizado.'):editing?tr('Conta atualizada.'):tr('Conta adicionada.'));changed();done?.(true);const next=afterSave;afterSave=undefined;next?.(id);
  }catch(error){q(form,'git-account-form-error').textContent=accountError(error).text;}
  finally{working=false;save.disabled=false;await refresh();}
 };
 form.addEventListener('close',()=>{input('git-account-secret').value='';const done=tokenDone;tokenDone=undefined;done?.(false);});
 // + no GitHub abre o menu Entrar via GitHub / Entrar com token; nas outras páginas, o formulário.
 const addMenu=q(settings,'git-accounts-add-menu');
 const closeAddMenu=(focus=false)=>{addMenu.hidden=true;if(focus)q(settings,'git-accounts-add').focus();};
 q(settings,'git-accounts-add').onclick=()=>{
  if(page!=='github'){openForm(undefined,page);return;}
  addMenu.hidden=!addMenu.hidden;if(!addMenu.hidden)addMenu.querySelector<HTMLElement>('[role=menuitem]')!.focus();
 };
 addMenu.onkeydown=(event:KeyboardEvent)=>{
  const items=[...addMenu.querySelectorAll<HTMLElement>('[role=menuitem]')];const at=items.indexOf(document.activeElement as HTMLElement);
  if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();items[(at+(event.key==='ArrowDown'?1:items.length-1))%items.length].focus();}
  else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeAddMenu(true);}
 };
 // WebKit não foca botões no clique: fechar por clique fora, e por Tab só quando o foco sai do menu.
 addMenu.addEventListener('focusout',event=>{const next=event.relatedTarget as Node|null;if(next&&next!==settings&&!addMenu.contains(next))closeAddMenu();});
 on(document,'pointerdown',(event:Event)=>{const target=event.target as Node;if(!addMenu.hidden&&!addMenu.contains(target)&&!q(settings,'git-accounts-add').contains(target))closeAddMenu();});
 q(settings,'git-accounts-login-browser').onclick=()=>{closeAddMenu();void loginBrowser();};
 q(settings,'git-accounts-login-token').onclick=()=>{closeAddMenu();openForm(undefined,'github');};
 q(settings,'git-accounts-login-enterprise').onclick=()=>{closeAddMenu();openForm(undefined,'github',false,true);};

 // Entrar via GitHub: device flow; o código aparece aqui e o navegador abre na página de verificação.
 let loginSession:string|undefined;let loginTimer:ReturnType<typeof setTimeout>|undefined;let loginRun=0;
 const bq=(id:string)=>q(browser,id);
 function stopLogin(){loginRun++;if(loginTimer)clearTimeout(loginTimer);loginTimer=undefined;const session=loginSession;loginSession=undefined;if(session)void api.gitAccountsLogin({action:'cancel',session}).catch(()=>{});}
 function loginFailed(error:unknown){loginSession=undefined;bq('git-account-browser-status').textContent='';bq('git-account-browser-error').textContent=accountError(error).text;bq('git-account-browser-reopen').textContent=tr('Tentar novamente');}
 async function loginBrowser(){
  stopLogin();const run=loginRun;
  bq('git-account-code').textContent='';bq('git-account-browser-text').textContent='';bq('git-account-browser-error').textContent='';bq('git-account-browser-reopen').textContent=tr('Abrir navegador novamente');
  bq('git-account-browser-status').textContent=tr('Iniciando login…');if(!browser.open)browser.showModal();
  let started:{session:string;userCode:string;verificationUri:string;interval:number;opened:boolean};
  try{started=await api.gitAccountsLogin({action:'start',kind:'github',host:'github.com'});}catch(error){if(run===loginRun)loginFailed(error);return;}
  if(run!==loginRun){void api.gitAccountsLogin({action:'cancel',session:started.session}).catch(()=>{});return;}
  loginSession=started.session;bq('git-account-code').textContent=started.userCode;
  bq('git-account-browser-text').textContent=started.opened?msg`O navegador foi aberto em ${started.verificationUri}. Digite o código abaixo e autorize o PHP IDE.`:msg`Abra ${started.verificationUri} no navegador, digite o código abaixo e autorize o PHP IDE.`;
  bq('git-account-browser-status').textContent=tr('Aguardando autorização no navegador…');
  void navigator.clipboard?.writeText(started.userCode).catch(()=>{});
  const poll=(seconds:number)=>{loginTimer=setTimeout(async()=>{
   if(run!==loginRun||!loginSession)return;
   try{
    const result:{status:string;interval?:number;id?:string;login?:string;updated?:boolean}=await api.gitAccountsLogin({action:'poll',session:loginSession});
    if(run!==loginRun)return;
    if(result.status==='pending'){poll(result.interval??started.interval);return;}
    loginSession=undefined;browser.close();page='github';selected=result.id;
    status(result.updated?msg`Token da conta ${result.login} atualizado.`:msg`Conta ${result.login} adicionada.`);changed();await refresh();
    const next=afterSave;afterSave=undefined;if(result.id)next?.(result.id);
   }catch(error){if(run===loginRun)loginFailed(error);}
  },seconds*1000);};
  poll(started.interval);
 }
 bq('git-account-code-copy').onclick=()=>{const code=bq('git-account-code').textContent??'';if(code)void navigator.clipboard?.writeText(code).then(()=>{bq('git-account-browser-status').textContent=tr('Código copiado. Aguardando autorização no navegador…');},()=>{});};
 bq('git-account-browser-reopen').onclick=async()=>{
  if(!loginSession){void loginBrowser();return;}
  try{const r=await api.gitAccountsLogin({action:'reopen',session:loginSession});if(!r.opened)bq('git-account-browser-error').textContent=tr('Não foi possível abrir o navegador. Abra o endereço acima manualmente.');}catch(error){loginFailed(error);}
 };
 bq('git-account-browser-cancel').onclick=()=>browser.close();
 bq('git-account-browser-token').onclick=()=>{browser.close();openForm(undefined,'github');};
 browser.addEventListener('close',()=>stopLogin());
 q(settings,'git-accounts-edit').onclick=()=>{const a=listing.accounts.find(a=>a.id===selected);if(a)openForm(a);};
 q(settings,'git-accounts-remove').onclick=()=>{const a=listing.accounts.find(a=>a.id===selected);if(a)void confirmRemove(msg`Remover a conta ${a.login} (${a.host})? O token será apagado do cofre do sistema. Projetos que usam esta conta pedirão outra no próximo commit ou push.`).then(yes=>{if(yes)void act(()=>api.gitAccountsRemove(a.id),tr('Conta removida.'));});};
 q(settings,'git-accounts-default').onclick=()=>{if(selected)void act(()=>api.gitAccountsDefault(selected),tr('Conta padrão definida.'));};
 q(settings,'git-accounts-list').onkeydown=(event:KeyboardEvent)=>{
  const rows=listing.accounts.filter(a=>a.kind===page);const at=rows.findIndex(a=>a.id===selected);
  if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();const next=rows[Math.max(0,Math.min(rows.length-1,at+(event.key==='ArrowDown'?1:-1)))];if(next){selected=next.id;render();}}
  else if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();q(settings,'git-accounts-remove').click();}
  else if(event.key==='Enter'){event.preventDefault();q(settings,'git-accounts-edit').click();}
 };
 q(settings,'git-accounts-close').onclick=()=>settings.close();
 q(settings,'git-accounts-project-change').onclick=()=>{void choose(tr('Escolha a conta usada nos commits e pushes deste projeto.'));};

 // Escolha de conta do projeto; resolve true quando há uma escolha gravada.
 let pending:((value:boolean)=>void)|undefined;
 function renderChoices(current?:string){
  const box=q(chooser,'git-account-choices');const items:[string,string,string][]=listing.accounts.map(a=>[a.id,describeAccount(a),`${kindLabel(a.kind)}${a.hasSecret?'':tr(' · sem token')}${a.default?tr(' · padrão'):''}`]);
  items.push(['system',tr('Configuração do Git do sistema'),tr('user.name/user.email e credenciais configurados fora da IDE')]);
  const initial=current&&items.some(i=>i[0]===current)?current:listing.accounts.find(a=>a.default)?.id??listing.accounts[0]?.id??'system';
  box.replaceChildren(...items.map(([value,title,detail])=>{const label=document.createElement('label');label.className='git-account-choice';const radio=document.createElement('input');radio.type='radio';radio.name='git-account-choice';radio.value=value;radio.checked=value===initial;const strong=document.createElement('strong');strong.textContent=title;const small=document.createElement('small');small.textContent=detail;label.append(radio,strong,small);return label;}));
 }
 async function choose(reason:string):Promise<boolean>{
  if(chooser.open)return false;
  try{await load();}catch(error){status(accountError(error).text);return false;}
  if(!listing.project)return false;
  q(chooser,'git-account-chooser-reason').textContent=reason;q(chooser,'git-account-chooser-error').textContent='';
  renderChoices(listing.project.missing?undefined:listing.project.binding??undefined);chooser.showModal();
  return new Promise(resolve=>{pending=resolve;});
 }
 const settle=(value:boolean)=>{const done=pending;pending=undefined;if(chooser.open)chooser.close();done?.(value);};
 chooser.addEventListener('close',()=>settle(false));
 q(chooser,'git-account-chooser-cancel').onclick=()=>settle(false);
 q(chooser,'git-account-chooser-add').onclick=()=>{afterSave=async()=>{await load();renderChoices(selected);};openForm(undefined,'github');};
 chooser.querySelector('form')!.onsubmit=async event=>{
  event.preventDefault();const value=chooser.querySelector<HTMLInputElement>('input[name=git-account-choice]:checked')?.value;if(!value)return;
  const use=q<HTMLButtonElement>(chooser,'git-account-chooser-use');use.disabled=true;
  try{listing.project=await api.gitAccountsUse(value);changed();settle(true);}catch(error){q(chooser,'git-account-chooser-error').textContent=accountError(error).text;}finally{use.disabled=false;}
 };
 /** Aviso de token expirado no push: "Entrar no GitHub/GitLab" só com o token da conta. */
 async function useToken(id:string):Promise<boolean>{
  try{await load();}catch(error){status(accountError(error).text);return false;}
  const account=listing.accounts.find(a=>a.id===id);if(!account)return false;
  if(form.open)form.close();openForm(account,account.kind,true);
  return new Promise(resolve=>{tokenDone=resolve;});
 }
 /** Garante uma conta válida antes de commit/push; pergunta só quando falta ou foi removida. */
 async function ensure(action:string):Promise<boolean>{
  let current:Listing;try{current=await load();}catch(error){throw Error(accountError(error).text);}
  if(!current.project)return true;
  if(current.project.binding&&!current.project.missing)return true;
  return choose(current.project.missing?tr('A conta escolhida para este projeto foi removida. Escolha outra para continuar.'):msg`Este projeto ainda não tem conta Git. Escolha a conta usada neste ${action} e nos próximos.`);
 }

 // Atalho nas Configurações da IDE, ao lado de Plugins… e Keymap….
 const launcher=document.createElement('button');launcher.type='button';launcher.className='keymap-open git-accounts-open';launcher.textContent=tr('Contas Git…');
 launcher.onclick=event=>{event.stopPropagation();(document.getElementById('appearance-dialog') as HTMLDialogElement|null)?.close?.();void open();};
 const place=()=>{const host=document.getElementById('appearance-dialog');if(host&&!host.contains(launcher)){const footer=host.querySelector('.appearance-footer');if(footer)footer.before(launcher);else host.append(launcher);}};
 place();const observer=new MutationObserver(place);observer.observe(document.body,{childList:true});own(()=>{observer.disconnect();launcher.remove();});
 async function open(kind?:string){if(kind)page=kind;status('');await refresh();if(!settings.open)settings.showModal();q(settings,'git-accounts-list').focus();}
 return {open,choose,ensure,useToken,loginBrowser,load,onChange(fn:()=>void){on(window,CHANGED,fn);},close(){settle(false);form.close();browser.close();settings.close();}};
}
