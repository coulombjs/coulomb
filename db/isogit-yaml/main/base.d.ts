import { BackendClass, BackendStatus as BaseBackendStatus, BackendStatusReporter as BaseBackendStatusReporter } from '../../main/base';
export interface FixedBackendOptions {
    workDir: string;
    corsProxyURL: string;
    upstreamRepoURL: string;
}
export interface ConfigurableBackendOptions {
    repoURL: string;
    username: string;
    authorName: string;
    authorEmail: string;
}
export declare type BackendOptions = FixedBackendOptions & ConfigurableBackendOptions;
export declare type InitialBackendOptions = FixedBackendOptions & Partial<ConfigurableBackendOptions>;
export interface BackendStatus extends BaseBackendStatus {
    isOffline: boolean;
    hasLocalChanges: boolean;
    needsPassword: boolean;
    statusRelativeToLocal: 'ahead' | 'behind' | 'diverged' | 'updated' | undefined;
    isPushing: boolean;
    isPulling: boolean;
}
export declare type BackendStatusReporter = BaseBackendStatusReporter<BackendStatus>;
export declare const Backend: BackendClass<InitialBackendOptions, BackendOptions, BackendStatus>;
export default Backend;
