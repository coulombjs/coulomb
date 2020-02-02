export interface GitAuthentication {
  /* Authentication as expected by isomorphic-git */

  username?: string,
  password?: string,

  // Unsupported currently
  oauth2format?: 'github' | 'gitlab' | 'bitbucket',
  token?: string,
}


export interface GitAuthor {
  name?: string,
  email?: string,
}
