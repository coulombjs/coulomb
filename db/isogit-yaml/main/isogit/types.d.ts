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
