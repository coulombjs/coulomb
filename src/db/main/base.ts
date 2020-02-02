import { AnyIDType, Model } from '../models';
import { SettingManager } from '../../settings/main';
import { Index } from '../query';


// Generic backend.

export interface Backend<IDType = AnyIDType> {
  init(): Promise<void>
  /* Initializes the backend.
     This may involve loading data from remote storage,
     thus initial authentication, etc. */

  // Following are data query & update methods.
  // One DB may operate a heterogeneous collection of objects.
  // Recognizing their types is not within DB backend’s scope.
  // These methods rather operate lower-level
  // generic object payloads and object IDs.
  //
  // Recognizing particular data types is Manager’s job:
  // the app would query data objects via corresponding manager,
  // which in turn would call these methods
  // filling in appropriate arguments.
  readAll<T extends Record<string, any>>(...args: any[]): Promise<Index<T>>
  read(objID: IDType, ...args: any[]): Promise<object>
  create<T extends Record<string, any>>(obj: T, ...args: any[]): Promise<void>
  update<T extends Record<string, any>>(objID: IDType, obj: T, ...args: any[]): Promise<void>
  delete(objID: IDType, ...args: any[]): Promise<void>

  setUpIPC?(dbID: string): void
  /* Initializes IPC endpoints to enable e.g. to configure the database
     or invoke specific utility methods from within app’s renderer process. */
}


export interface BackendStatus {
  isMisconfigured: boolean
}

export type BackendStatusReporter<Status extends BackendStatus> = (payload: Partial<Status>) => void;


export interface BackendClass<
    InitialOptions extends object,
    Options extends InitialOptions,
    Status extends BackendStatus> {
  /* Initial options are supplied by the developer.
     Full options include options configurable by the user, some of which may be required.
     NOTE: By “Option”, backend constructor parameter is meant.
     TODO: This is a misnomer since some of those are non-optional. */

  new (
    options: Options,
    reportBackendStatus: BackendStatusReporter<Status>,
  ): Backend
  // Constructor signature.
  // Backend constructor is invoked by the framework during app initialization.

  registerSettingsForConfigurableOptions?(
    settings: SettingManager,
    initialOptions: Partial<InitialOptions>,
    dbID: string): void
  /* Given initial options and a settings manager,
     register user-configurable settings that control this DB’s behavior.
     This method can make a setting required if corresponding option
     is not provided by the developer in the initial options. */

  completeOptionsFromSettings?(
    settings: SettingManager,
    initialOptions: Partial<InitialOptions>,
    dbID: string): Promise<Options>
  /* Given initial options and a settings manager,
     retrieve any user-configured options if needed
     and return full options object required by this backend. */
}


// Versioned backend & compatible manager.

export interface VersionedBackend<T = object, IDType = AnyIDType> extends Backend<IDType> {

  discard(objIDs: IDType[]): Promise<void>
  /* Discard any uncommitted changes made to objects with specified IDs. */

  commit(objIDs: IDType[], commitMessage: string): Promise<void>
  /* Commit any uncommitted changes made to objects with specified IDs,
     with specified commit message. */

  listUncommitted?(): Promise<IDType[]>
  /* List IDs of objects with uncommitted changes. */

}


export interface VersionedManager<M extends Model, IDType extends AnyIDType> {
  /* Passes calls on to corresponding Backend or VersionedBackend methods,
     but limits their scope only to objects manipulated by this manager. */

  setUpIPC?(modelName: string): void
  /* Initializes IPC endpoints to query or update managed data. */

  // Below methods apply to any Backend and could be moved to a generic Manager,
  // but `commit` argument is VersionedBackend-specific.

  create(obj: M, commit: boolean | string): Promise<void>
  update(objID: IDType, obj: M, commit: boolean | string): Promise<void>;
  delete(objID: IDType, commit: boolean | string): Promise<void>;

  // Below methods are VersionedBackend-specific.

  discard?(objIDs: IDType[]): Promise<void>
  commit?(objIDs: IDType[], commitMessage: string): Promise<void>

  listUncommitted?(): Promise<IDType[]>
  /* List IDs of objects with uncommitted changes. */
}


export class CommitError extends Error {
  constructor(public code: string, msg: string) {
    super(msg);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}


// Versioned backend specifically based on local filesystem, and compatible manager.

export interface VersionedFilesystemBackend extends VersionedBackend<object, string> {

  registerManager(manager: VersionedFilesystemManager): void
  /* Enables instances of this backend to keep track of managers,
     which is required for the purpose of excluding files
     created arbitrarily by OS or other software
     from version control (see `resetOrphanedFileChanges()`).

     NOTE: So far this is the only reason DB backend needs to keep track
     of associated managers.
     Could DB backend be made aware of which files
     it’s responsible for?
     Avoiding this dependency on managers
     would be beneficial, if there’s an elegant way of doing it. */

  resetOrphanedFileChanges(): Promise<void>
  /* Housekeeping method for file-based DB backend. */

}


export interface VersionedFilesystemManager {
  managesFileAtPath(filePath: string): boolean
  /* Determines whether the manager instance is responsible for the file
     under given path. */
}
