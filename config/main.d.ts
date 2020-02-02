import { AppConfig, ModelConfig } from './app';
import { Model } from '../db/models';
import { BackendClass as DatabaseBackendClass, Backend as DatabaseBackend, VersionedManager } from '../db/main/base';
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
        [DT in keyof App["data"]]: ManagerConfig<this["databases"]>;
    };
}
interface DatabaseConfig {
    backend: () => Promise<{
        default: DatabaseBackendClass<any, any, any>;
    }>;
    options: any;
}
export interface ManagerClass<M extends Model, DB extends DatabaseBackend> {
    new (db: DB, managerConfig: ManagerOptions<M>, modelConfig: ModelConfig): VersionedManager<M, any>;
}
export interface ManagerOptions<M extends Model> {
    cls: () => Promise<{
        default: ManagerClass<M, any>;
    }>;
    workDir: string;
    metaFields: (keyof M)[];
    idField: keyof M;
}
export interface ManagerConfig<D extends Record<string, DatabaseConfig>> {
    dbName: string;
    options: ManagerOptions<any>;
}
export {};
