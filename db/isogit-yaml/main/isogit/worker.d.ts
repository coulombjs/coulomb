import { CloneRequestMessage, PullRequestMessage, PushRequestMessage } from './types';
import { ModuleMethods } from 'threads/dist/types/master';
export interface GitMethods {
    clone: (msg: CloneRequestMessage) => Promise<{
        success: true;
    }>;
    pull: (msg: PullRequestMessage) => Promise<{
        success: true;
    }>;
    push: (msg: PushRequestMessage) => Promise<{
        success: true;
    }>;
}
export declare type GitWorkerSpec = ModuleMethods & GitMethods;
