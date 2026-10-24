import {mountTreeGitStatus} from './tree-git-status';
import {mountEditorChanges} from './editor-changes';
import {configure} from './sdk';
import {mountGit} from './git-panel';
export function activate(sdk:any){configure(sdk);sdk.provide('git',{mountTreeGitStatus(...args:any[]){args[0]=sdk.api;return mountTreeGitStatus(...args);},mountEditorChanges(...args:any[]){args[0]=sdk.api;return mountEditorChanges(...args);},mount(...args:any[]){const before=new Set(document.querySelectorAll('*'));args[0]=sdk.api;const result=mountGit(...args);const added=[...document.querySelectorAll('*')].filter(n=>!before.has(n));sdk.own(()=>{result.dispose?.();for(const n of added)if(n.isConnected)n.remove();});return result;}});}
