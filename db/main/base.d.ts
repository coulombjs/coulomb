import { AnyIDType, Model } from '../models';
import { SettingManager } from '../../settings/main';
import { Index } from '../query';
import { BackendDescription } from '../base';
export declare abstract class Backend<IDType = AnyIDType> {
    abstract init(): Promise<void>;
    abstract describe(): Promise<BackendDescription<any>>;
    abstract getIndex(idField: string, ...args: any[]): Promise<Index<any>>;
    abstract listIDs(query: object): Promise<IDType[]>;
    abstract read(objID: IDType, ...args: any[]): Promise<object>;
    abstract create(obj: object, ...args: any[]): Promise<void>;
    abstract update(objID: IDType, obj: object, ...args: any[]): Promise<void>;
    abstract delete(objID: IDType, ...args: any[]): Promise<void>;
    setUpIPC(dbID: string): void;
}
export declare type ManagedDataChangeReporter<IDType> = (changedIDs?: IDType[]) => Promise<void>;
export declare type BackendStatusReporter<Status> = (payload: Partial<Status>) => Promise<void>;
export interface BackendClass<InitialOptions extends object, Options extends InitialOptions, Status extends object> {
    new (options: Options, reportBackendStatus: BackendStatusReporter<Status>): Backend;
    registerSettingsForConfigurableOptions?(settings: SettingManager, initialOptions: Partial<InitialOptions>, dbID: string): void;
    completeOptionsFromSettings?(settings: SettingManager, initialOptions: Partial<InitialOptions>, dbID: string): Promise<Options>;
}
export declare abstract class VersionedBackend<IDType = AnyIDType> extends Backend<IDType> {
    abstract discard(objIDs: IDType[]): Promise<void>;
    abstract commit(objIDs: IDType[], commitMessage: string): Promise<void>;
    abstract listUncommitted?(): Promise<IDType[]>;
}
export declare abstract class ModelManager<M extends Model, IDType extends AnyIDType, Q extends object = object> {
    abstract count(query?: Q): Promise<number>;
    abstract reportUpdatedData: ManagedDataChangeReporter<IDType>;
    abstract listIDs(query?: Q): Promise<IDType[]>;
    abstract readAll(query?: Q): Promise<Index<M>>;
    abstract read(id: IDType): Promise<M>;
    abstract create(obj: M, ...args: any[]): Promise<void>;
    abstract update(objID: IDType, obj: M, ...args: any[]): Promise<void>;
    abstract delete(objID: IDType, ...args: unknown[]): Promise<void>;
    protected abstract getDBRef(objID: IDType | string): string;
    protected abstract getObjID(dbRef: string): IDType;
    init(): Promise<void>;
    setUpIPC(modelName: string): void;
}
export declare class CommitError extends Error {
    code: string;
    constructor(code: string, msg: string);
}
export declare abstract class VersionedFilesystemBackend extends VersionedBackend<string> {
    abstract getIndex(idField: string, subdir: string, onlyIDs?: string[]): Promise<Index<any>>;
    abstract registerManager(manager: FilesystemManager): void;
    abstract resetOrphanedFileChanges(): Promise<void>;
}
export interface FilesystemManager {
    managesFileAtPath(filePath: string): boolean;
}
