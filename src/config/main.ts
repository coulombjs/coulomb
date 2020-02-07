import { AppConfig, ModelInfo } from './app';
import { Model } from '../db/models';
import {
  BackendClass as DatabaseBackendClass,
  Backend as DatabaseBackend,
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
    [DT in keyof App["data"]]: ManagerConfig<this["databases"]>
  }
}


// Databases

interface DatabaseConfig {
  backend: () => Promise<{ default: DatabaseBackendClass<any, any, any> }>

  // If not all options are supplied in configuration in code,
  // the missing ones will be required from the user via initial configuration window.
  options: any
}


// Model managers

export interface ManagerClass<M extends Model, DB extends DatabaseBackend> {
  new (db: DB, managerConfig: ManagerOptions<M>, modelInfo: ModelInfo): ModelManager<M, any>
}

export interface ManagerOptions<M extends Model> {
  /* Options specific to Isomorphic Git-YAML model manager.
     TODO: Should be moved into isogit-yaml module. */

  // Model manager class resolver
  cls: () => Promise<{ default: ManagerClass<M, any> }>

  // Path to data for this model, relative to DB’s work directory
  workDir: string

  // List of fields that go into meta.yaml
  metaFields: (keyof M)[]

  // Name of model field containing unqiue identifier equivalent
  idField: keyof M
}

export interface ManagerConfig<D extends Record<string, DatabaseConfig>> {
  // The corresponding key in MainConfig["databases"]
  dbName: string

  // Any options to be passed to manager constructor,
  // must conform to class in corresponding ManagerOptions
  options: ManagerOptions<any>
}
