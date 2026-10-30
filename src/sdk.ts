export let sdk:any; export let monaco:any; export let dockWindow:any,resizeToolWindow:any,toolIcon:any,editorFont:any,keymap:any,fileIcon:any;
export const tr=(...args:any[])=>sdk?.tr(...args)??args[0];export const msg=(...args:any[])=>sdk.msg(...args);export const html=(...args:any[])=>sdk.html(...args);export const activeLanguage=(...args:any[])=>sdk.activeLanguage(...args);
export const own=(value:any)=>{if(typeof value==='function')sdk.own(value);else if(value?.dispose)sdk.own(()=>value.dispose());return value;};
export const on=(target:any,event:string,fn:any)=>{target.addEventListener(event,fn);own(()=>target.removeEventListener(event,fn));};
export const every=(fn:any,ms:number)=>{const id=setInterval(fn,ms);own(()=>clearInterval(id));return id;};
export function configure(value:any){sdk=value;({monaco,dockWindow,resizeToolWindow,toolIcon,editorFont,keymap,fileIcon}=value);}
/** Icon-only button; the label becomes the hover tooltip and the accessible name (same markup as the host toolIcon). */
export function iconButton(button:HTMLElement,path:string,label:string){button.setAttribute('aria-label',label);button.title=label;button.innerHTML=`<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;}
