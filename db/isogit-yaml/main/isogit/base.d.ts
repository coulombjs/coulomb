import * as git from 'isomorphic-git';
import { BackendStatusReporter } from '../base';
export declare class IsoGitWrapper {
    private fs;
    private repoUrl;
    private upstreamRepoUrl;
    workDir: string;
    private corsProxy;
    private auth;
    private stagingLock;
    constructor(fs: any, repoUrl: string, upstreamRepoUrl: string, workDir: string, corsProxy: string);
    isInitialized(): Promise<boolean>;
    isUsingRemoteURLs(remoteUrls: {
        origin: string;
        upstream: string;
    }): Promise<boolean>;
    needsPassword(): boolean;
    forceInitialize(): Promise<void>;
    configSet(prop: string, val: string): Promise<void>;
    configGet(prop: string): Promise<string>;
    setPassword(value: string | undefined): void;
    loadAuth(): Promise<void>;
    pull(): Promise<any>;
    stage(pathSpecs: string[]): Promise<void>;
    commit(msg: string): Promise<string>;
    fetchRemote(): Promise<void>;
    fetchUpstream(): Promise<void>;
    push(force?: boolean): Promise<git.PushResponse>;
    resetFiles(paths?: string[]): Promise<void>;
    getOriginUrl(): Promise<string | null>;
    getUpstreamUrl(): Promise<string | null>;
    listLocalCommits(): Promise<string[]>;
    listChangedFiles(pathSpecs?: string[]): Promise<string[]>;
    stageAndCommit(pathSpecs: string[], msg: string): Promise<number>;
    private unstageAll;
    private _handleGitError;
    checkUncommitted(sendRemoteStatus: BackendStatusReporter): Promise<boolean>;
    synchronize(sendRemoteStatus: BackendStatusReporter): Promise<void>;
}
export declare function isGitError(e: Error & {
    code: string;
}): boolean;
