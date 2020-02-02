import { ModelConfig } from '../../../config/app';
import { ManagerOptions } from '../../../config/main';
import { Model, AnyIDType } from '../../models';
import { Index } from '../../query';
import { VersionedFilesystemBackend, VersionedManager, VersionedFilesystemManager } from '../../main/base';
declare class Manager<M extends Model, IDType extends AnyIDType> implements VersionedManager<M, IDType>, VersionedFilesystemManager {
    private db;
    private managerConfig;
    private modelConfig;
    constructor(db: VersionedFilesystemBackend, managerConfig: ManagerOptions<M>, modelConfig: ModelConfig);
    managesFileAtPath(filePath: string): boolean;
    create(obj: M, commit?: boolean | string): Promise<void>;
    read(objID: IDType): Promise<M>;
    commit(objIDs: IDType[], message: string): Promise<void>;
    discard(objIDs: IDType[]): Promise<void>;
    listUncommitted(): Promise<IDType[]>;
    readAll(): Promise<Index<M>>;
    update(objID: IDType, newData: M, commit?: boolean | string): Promise<void>;
    delete(objID: IDType, commit?: string | boolean): Promise<void>;
    private commitOne;
    private formatObjectName;
    private formatCommitMessage;
    private getDBRef;
    getObjID(dbRef: string): IDType;
    setUpIPC(modelName: string): void;
}
export default Manager;
