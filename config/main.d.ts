import { AppConfig, ModelInfo } from './app';
import { Model, AnyIDType } from '../db/models';
import { BackendClass as DatabaseBackendClass, Backend as DatabaseBackend, ManagedDataChangeReporter, ModelManager } from '../db/main/base';
export interface MainConfig<App extends AppConfig> {
    app: App;
    singleInstance: boolean;
    disableGPU: boolean;
    appDataPath: string;
    settingsFileName: string;
    databases: {
        default: DatabaseConfig;
        [dbName: string]: DatabaseConfig;
    };
    managers: {
        [DT in keyof App["data"]]: ManagerConfig<any>;
    };
}
interface DatabaseConfig {
    backend: () => Promise<{
        default: DatabaseBackendClass<any, any, any>;
    }>;
    options: any;
}
export interface ManagerClass<M extends Model, IDType extends AnyIDType, Options extends ManagerOptions<M>, DB extends DatabaseBackend> {
    new (db: DB, managerConfig: Options, modelInfo: ModelInfo, reportChangedData: ManagedDataChangeReporter<IDType>): ModelManager<M, IDType>;
}
export interface ManagerOptions<M extends Model> {
    cls: () => Promise<{
        default: ManagerClass<M, any, any, any>;
    }>;
}
export interface ManagerConfig<M> {
    dbName: string;
    options: ManagerOptions<M>;
}
export {};
