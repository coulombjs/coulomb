import { AppConfig, ModelInfo } from './app';
import { Model, AnyIDType } from '../db/models';
import {
  BackendClass as DatabaseBackendClass,
  Backend as DatabaseBackend,
  ManagedDataChangeReporter,
  ModelManager,
} from '../db/main/base';


export interface MainConfig<App extends AppConfig> {
  app: App
  singleInstance: boolean
  disableGPU: boolean
  appDataPath: string
  settingsFileName: string
  databases: {
    default: DatabaseConfig
    [dbName: string]: DatabaseConfig
  }
  managers: {
    [DT in keyof App["data"]]: ManagerConfig<any>
  }
}


// Databases

interface DatabaseConfig {
  backend: DatabaseBackendClass<any, any, any>

  // If not all options are supplied in configuration in code,
  // the missing ones will be required from the user via initial configuration window.
  options: Record<string, any>
}


// Model managers

export interface ManagerClass<
  M extends Model,
  IDType extends AnyIDType,
  Options extends ManagerOptions<M>,
  DB extends DatabaseBackend> {

  new (
    db: DB,
    managerConfig: Options,
    modelInfo: ModelInfo,
    reportChangedData: ManagedDataChangeReporter<IDType>): ModelManager<M, IDType>
}

export interface ManagerOptions<M extends Model> {
  /* Options specific to Isomorphic Git-YAML model manager.
     TODO: Should be moved into isogit-yaml module. */

  // Model manager class resolver
  cls: ManagerClass<M, any, any, any>
}

export interface ManagerConfig<M> {
  // The corresponding key in MainConfig["databases"]
  dbName: string

  // Any options to be passed to manager constructor,
  // must conform to class in corresponding ManagerOptions
  options: ManagerOptions<M>
}
