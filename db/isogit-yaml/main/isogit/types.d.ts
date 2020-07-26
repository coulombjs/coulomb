export interface GitAuthentication {
    username?: string;
    password?: string;
    oauth2format?: 'github' | 'gitlab' | 'bitbucket';
    token?: string;
}
export interface GitAuthor {
    name?: string;
    email?: string;
}
export interface GitRepoAccessParams {
    workDir: string;
    repoURL: string;
    auth: GitAuthentication;
}
export interface CloneRequestMessage extends GitRepoAccessParams {
    action: 'clone';
}
export interface PullRequestMessage extends GitRepoAccessParams {
    action: 'pull';
    author: GitAuthor;
}
export interface PushRequestMessage extends GitRepoAccessParams {
    action: 'push';
}
export interface FetchRequestMessage extends GitRepoAccessParams {
    action: 'fetch';
}
export declare type WorkerMessage = CloneRequestMessage | PullRequestMessage | FetchRequestMessage | PushRequestMessage;
