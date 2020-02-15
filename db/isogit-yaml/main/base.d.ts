import { SettingManager } from '../../../settings/main';
import { FilesystemWrapper } from '../../main/fs-wrapper';
import { BackendClass as BaseBackendClass, BackendStatusReporter as BaseBackendStatusReporter, VersionedFilesystemBackend, FilesystemManager } from '../../main/base';
import { BackendDescription, BackendStatus } from '../base';
interface FixedBackendOptions {
    workDir: string;
    corsProxyURL: string;
    upstreamRepoURL: string;
    fsWrapperClass: () => Promise<{
        default: new (baseDir: string) => FilesystemWrapper<any>;
    }>;
    syncInterval?: number;
}
interface ConfigurableBackendOptions {
    repoURL: string;
    username: string;
    authorName: string;
    authorEmail: string;
}
declare type BackendOptions = FixedBackendOptions & ConfigurableBackendOptions & {
    fsWrapper: FilesystemWrapper<any>;
};
declare type InitialBackendOptions = FixedBackendOptions & Partial<ConfigurableBackendOptions>;
declare type BackendStatusReporter = BaseBackendStatusReporter<BackendStatus>;
declare class Backend extends VersionedFilesystemBackend {
    private opts;
    private reportBackendStatus;
    private git;
    private gitSyncIntervalDelay;
    private gitSyncInterval;
    private fs;
    private managers;
    constructor(opts: BackendOptions, reportBackendStatus: BackendStatusReporter);
    listIDs(query: {
        subdir: string;
    }): Promise<string[]>;
    describe(): Promise<BackendDescription>;
    static registerSettingsForConfigurableOptions(settings: SettingManager, initialOptions: InitialBackendOptions, dbID: string): void;
    static completeOptionsFromSettings(settings: SettingManager, availableOptions: InitialBackendOptions, dbID: string): Promise<{
        workDir: string;
        corsProxyURL: string;
        upstreamRepoURL: string;
        fsWrapperClass: () => Promise<{
            default: new (baseDir: string) => FilesystemWrapper<any>;
        }>;
        fsWrapper: FilesystemWrapper<any>;
        repoURL: string;
        username: string;
        authorName: string;
        authorEmail: string;
    }>;
    registerManager(manager: FilesystemManager): Promise<void>;
    init(forceReset?: boolean): Promise<void>;
    read(objID: string, metaFields?: string[]): Promise<object>;
    readVersion(objID: string, version: string): Promise<any>;
    create<O extends Record<string, any>>(obj: O, objPath: string, metaFields?: (keyof O)[]): Promise<void>;
    commit(objIDs: string[], message: string): Promise<void>;
    discard(objIDs: string[]): Promise<void>;
    listUncommitted(): Promise<string[]>;
    getIndex(subdir: string, idField: string): Promise<Record<string, any>>;
    update(objID: string, newData: Record<string, any>, idField: string): Promise<void>;
    delete(objID: string): Promise<void>;
    resetOrphanedFileChanges(): Promise<void>;
    private readUncommittedFileInfo;
    private getRef;
    private synchronize;
    private checkUncommitted;
    setUpIPC(dbID: string): void;
}
export declare const BackendClass: BaseBackendClass<InitialBackendOptions, BackendOptions, BackendStatus>;
export default Backend;
