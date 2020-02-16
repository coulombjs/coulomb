import { ModelInfo } from '../../../config/app';
import { ManagerClass as BaseManagerClass, ManagerOptions as BaseManagerOptions } from '../../../config/main';
import { Model, AnyIDType } from '../../models';
import { default as Backend } from './base';
import { ModelManager, FilesystemManager, ManagedDataChangeReporter } from '../../main/base';
export interface ManagerOptions<M extends Model> extends BaseManagerOptions<M> {
    workDir: string;
    metaFields?: (keyof M)[];
    idField: keyof M;
}
interface BasicQuery<IDType extends AnyIDType> {
    onlyIDs?: IDType[];
}
declare class Manager<M extends Model, IDType extends AnyIDType, Q extends BasicQuery<IDType> = BasicQuery<IDType>> extends ModelManager<M, IDType, Q> implements FilesystemManager {
    private db;
    private managerConfig;
    private modelInfo;
    reportUpdatedData: ManagedDataChangeReporter<IDType>;
    constructor(db: Backend, managerConfig: ManagerOptions<M>, modelInfo: ModelInfo, reportUpdatedData: ManagedDataChangeReporter<IDType>);
    managesFileAtPath(filePath: string): boolean;
    listIDs(query?: Q): Promise<IDType[]>;
    count(query?: Q): Promise<number>;
    create(obj: M, commit?: boolean | string): Promise<void>;
    read(objID: IDType): Promise<M>;
    readVersion(objID: IDType, version: string): Promise<any>;
    commit(objIDs: IDType[], message: string): Promise<void>;
    discard(objIDs: IDType[]): Promise<void>;
    listUncommitted(): Promise<IDType[]>;
    readAll(query?: Q): Promise<Record<string, M>>;
    update(objID: IDType, newData: M, commit?: boolean | string): Promise<void>;
    delete(objID: IDType, commit?: string | boolean): Promise<void>;
    private commitOne;
    private formatObjectName;
    private formatCommitMessage;
    protected getDBRef(objID: IDType | string): string;
    protected getObjID(dbRef: string): IDType;
    setUpIPC(modelName: string): void;
}
export declare const ManagerClass: BaseManagerClass<any, any, ManagerOptions<any>, Backend>;
export default Manager;
