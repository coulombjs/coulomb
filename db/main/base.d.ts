import { AnyIDType, Model } from '../models';
import { SettingManager } from '../../settings/main';
import { Index } from '../query';
export interface Backend<IDType = AnyIDType> {
    init(): Promise<void>;
    readAll<T extends Record<string, any>>(...args: any[]): Promise<Index<T>>;
    read(objID: IDType, ...args: any[]): Promise<object>;
    create<T extends Record<string, any>>(obj: T, ...args: any[]): Promise<void>;
    update<T extends Record<string, any>>(objID: IDType, obj: T, ...args: any[]): Promise<void>;
    delete(objID: IDType, ...args: any[]): Promise<void>;
    setUpIPC?(dbID: string): void;
}
export interface BackendStatus {
    isMisconfigured: boolean;
}
export declare type BackendStatusReporter<Status extends BackendStatus> = (payload: Partial<Status>) => void;
export interface BackendClass<InitialOptions extends object, Options extends InitialOptions, Status extends BackendStatus> {
    new (options: Options, reportBackendStatus: BackendStatusReporter<Status>): Backend;
    registerSettingsForConfigurableOptions?(settings: SettingManager, initialOptions: Partial<InitialOptions>, dbID: string): void;
    completeOptionsFromSettings?(settings: SettingManager, initialOptions: Partial<InitialOptions>, dbID: string): Promise<Options>;
}
export interface VersionedBackend<T = object, IDType = AnyIDType> extends Backend<IDType> {
    discard(objIDs: IDType[]): Promise<void>;
    commit(objIDs: IDType[], commitMessage: string): Promise<void>;
    listUncommitted?(): Promise<IDType[]>;
}
export interface VersionedManager<M extends Model, IDType extends AnyIDType> {
    setUpIPC?(modelName: string): void;
    create(obj: M, commit: boolean | string): Promise<void>;
    update(objID: IDType, obj: M, commit: boolean | string): Promise<void>;
    delete(objID: IDType, commit: boolean | string): Promise<void>;
    discard?(objIDs: IDType[]): Promise<void>;
    commit?(objIDs: IDType[], commitMessage: string): Promise<void>;
    listUncommitted?(): Promise<IDType[]>;
}
export declare class CommitError extends Error {
    code: string;
    constructor(code: string, msg: string);
}
export interface VersionedFilesystemBackend extends VersionedBackend<object, string> {
    registerManager(manager: VersionedFilesystemManager): void;
    resetOrphanedFileChanges(): Promise<void>;
}
export interface VersionedFilesystemManager {
    managesFileAtPath(filePath: string): boolean;
}
