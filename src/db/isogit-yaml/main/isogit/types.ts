export interface GitAuthentication {
  /* Authentication as expected by isomorphic-git */

  username?: string
  password?: string

  // Unsupported currently
  oauth2format?: 'github' | 'gitlab' | 'bitbucket'
  token?: string
}


export interface GitAuthor {
  name?: string
  email?: string
}


/* Worker messages */

export interface GitRepoAccessParams {
  workDir: string
  repoURL: string
  auth: GitAuthentication
}


export interface CloneRequestMessage extends GitRepoAccessParams {
  action: 'clone'
}
export interface PullRequestMessage extends GitRepoAccessParams {
  action: 'pull'
  author: GitAuthor
}
export interface PushRequestMessage extends GitRepoAccessParams {
  action: 'push'
}
export interface FetchRequestMessage extends GitRepoAccessParams {
  action: 'fetch'
}


export type WorkerMessage =
  CloneRequestMessage
  | PullRequestMessage
  | FetchRequestMessage
  | PushRequestMessage;
