import { AnyIDType, Model } from '../models';
import { SettingManager } from '../../settings/main';
import { Index } from '../query';
import { BackendDescription } from '../base';
import { listen } from '../../ipc/main';


// Generic backend.

export abstract class Backend<IDType = AnyIDType> {
  abstract init(): Promise<void>
  /* Initializes the backend.
     This may involve loading data from remote storage,
     thus initial authentication, etc. */

  abstract describe(): Promise<BackendDescription<any>>

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

  abstract getIndex(idField: string, ...args: any[]): Promise<Index<any>>
  // DEPRECATED: Reading all DB objects without any filtering query will be too slow.

  abstract listIDs(query: object): Promise<IDType[]>
  abstract read(objID: IDType, ...args: any[]): Promise<object>
  abstract create(obj: object, ...args: any[]): Promise<void>
  abstract update(objID: IDType, obj: object, ...args: any[]): Promise<void>
  abstract delete(objID: IDType, ...args: any[]): Promise<void>

  setUpIPC(dbID: string): void {
    /* Initializes IPC endpoints to enable the user to e.g. configure the data store
       or invoke housekeeping or utility routines. */

    const prefix = `db-${dbID}`;

    listen<{}, BackendDescription<any>>
    (`${prefix}-describe`, async () => {
      return await this.describe();
    });

    listen<{ objectID: IDType | null }, { object: object | null }>
    (`${prefix}-read`, async ({ objectID }) => {
      if (objectID === null) {
        return { object: null };
      } else {
        return { object: await this.read(objectID) };
      }
    });
  }
}


export type ManagedDataChangeReporter<IDType> =
(changedIDs?: IDType[]) => Promise<void>;
/* Function of this signature will be passed to manager constructor,
   to be called when manager reports data updates to app windows,
   letting any object lists re-query the data.

   `changedIDs` is intended to avoid unnecessary re-querying.
   An object referenced in it may have been created,
   modified or deleted.
   
   Manager must omit `changedIDs` if it is not sure
   which exactly objects did change. */


export type BackendStatusReporter<Status> =
(payload: Partial<Status>) => Promise<void>;
/* Function of this signature will be passed to backend constructor,
   to be called when backend needs to report status to app windows. */


export interface BackendClass<
    InitialOptions extends object,
    Options extends InitialOptions,
    Status extends object> {
  /* Initial options are supplied by the developer.
     Full options include options configurable by the user, some of which may be required.

     NOTE: By “Option”, backend constructor parameter is meant.
     TODO: This is a misnomer since some of those are non-optional. */

  new (
    options: Options,
    reportBackendStatus: BackendStatusReporter<Status>,
  ): Backend
  // Backend classes are instantiated by the framework during app initialization.

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

export abstract class VersionedBackend<IDType = AnyIDType> extends Backend<IDType> {

  abstract discard(objIDs: IDType[]): Promise<void>
  /* Discard any uncommitted changes made to objects with specified IDs. */

  abstract commit(objIDs: IDType[], commitMessage: string): Promise<void>
  /* Commit any uncommitted changes made to objects with specified IDs,
     with specified commit message. */

  abstract listUncommitted?(): Promise<IDType[]>
  /* List IDs of objects with uncommitted changes. */

}


export abstract class ModelManager<M extends Model, IDType extends AnyIDType, Q extends object = object> {
  /* Passes calls on to corresponding Backend (or subclass) methods,
     but limits their scope only to objects manipulated by this manager. */

  abstract count(query?: Q): Promise<number>
  abstract reportUpdatedData: ManagedDataChangeReporter<IDType>

  abstract listIDs(query?: Q): Promise<IDType[]>
  // TODO: Returned IDs cannot automatically be cast to IDType;
  // get rid of IDType generic and manage types in subclasses?

  abstract readAll(query?: Q): Promise<Index<M>>
  abstract read(id: IDType): Promise<M>
  abstract create(obj: M, ...args: any[]): Promise<void>
  abstract update(objID: IDType, obj: M, ...args: any[]): Promise<void>
  abstract delete(objID: IDType, ...args: unknown[]): Promise<void>

  protected abstract getDBRef(objID: IDType | string): string
  protected abstract getObjID(dbRef: string): IDType

  async init() {}

  setUpIPC(modelName: string) {
    /* Initializes IPC endpoints to query or update data objects. */

    const prefix = `model-${modelName}`;

    listen<{ query?: Q }, { ids: IDType[] }>
    (`${prefix}-list-ids`, async ({ query }) => ({ ids: (await this.listIDs(query)) }));

    listen<{ query?: Q }, { count: number }>
    (`${prefix}-count`, async ({ query }) => ({ count: await this.count(query) }));

    listen<{ query?: Q }, Index<M>>
    (`${prefix}-read-all`, async ({ query }) => this.readAll(query));

    listen<{ objectID: IDType | null }, { object: M | null }>
    (`${prefix}-read-one`, async ({ objectID }) => {
      if (objectID === null) {
        return { object: null };
      } else {
        return { object: await this.read(objectID) };
      }
    });

    listen<{ objectID: IDType, object: M, commit: boolean }, { success: true }>
    (`${prefix}-update-one`, async ({ objectID, object, commit }) => {
      await this.update(objectID, object, commit);
      return { success: true };
    });

    listen<{ objectID: IDType }, { success: true }>
    (`${prefix}-delete-one`, async ({ objectID }) => {
      await this.delete(objectID, true);
      return { success: true };
    });

    listen<{ object: M, commit: boolean }, { success: true }>
    (`${prefix}-create-one`, async ({ object, commit }) => {
      await this.create(object, commit);
      return { success: true };
    });
  }
}


export class CommitError extends Error {
  constructor(public code: string, msg: string) {
    super(msg);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}


// Versioned backend specifically based on local filesystem,
// and requisite manager interface

export abstract class VersionedFilesystemBackend extends VersionedBackend<string> {

  abstract getIndex(idField: string, subdir: string, onlyIDs?: string[]): Promise<Index<any>>

  abstract getLocalFilesystemPath(id: string): Promise<string>

  abstract registerManager(manager: FilesystemManager): void
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

  abstract resetOrphanedFileChanges(): Promise<void>
  /* Housekeeping method for file-based DB backend. */

}


export interface FilesystemManager {

  getLocalFilesystemPath(id: AnyIDType): Promise<string>

  managesFileAtPath(filePath: string): boolean
  /* Determines whether the manager instance is responsible for the file
     under given path. */
}
