import * as fs from 'fs-extra';
import * as path from 'path';
import AsyncLock from 'async-lock';


type FilesystemPath = string;


export interface FilesystemWrapper<T> {
  /* Spec for filesystem backends
     that can be used with Git filesystem object store.

     It has its own concept of “object IDs”,
     which are references to filesystem entries.
     If backend operates on files of single type,
     object IDs would probably exclude filename extension.
     The Store using this backend would convert object IDs to */

  // TODO: Make non-generic and operate on `any`,
  // let other layers deal with narrower types (?)

  baseDir: string;
  /* Absolute path.
     Backend is not concerned with files outside this path.
     TODO: Could better be made read-only, behind accessor method. */

  read(objID: string, ...args: any[]): Promise<T>;

  readAll(query: { subdir?: string }, ...readArgs: any[]): Promise<T[]>;
  /* Scan filesystem and returns all the objects found. */

  write(objID: string, newData: T | undefined, ...args: any[]): Promise<FilesystemPath[]>;
  /* Updates given object and returns a list of filesystem paths that could be affected.
     If `newData` is undefined, the object is expected to be deleted. */


  // TODO: Following two can be renamed for clarity.

  expandPath(objID: string): string;
  /* Returns an absolute path to object file or root directory,
     given object ID. Adds an extension where applicable.
     Used by read(), write() under the hood. TODO: Should be made private? */

  exists(objID: string): Promise<boolean>;
  /* Given object ID, returns true if the object actually exists.
     Used when storing e.g. to avoid overwriting an existing object. */

  isValidID(filepath: string): Promise<boolean>;
  /* Given a path, returns true if it looks like a valid object ID.

     This is intended to be used for weeding out random files
     that are not part of the database, e.g. system files/directories,
     when loading objects from filesystem.

     This can be as simple as comparing the extension
     but if necessary can do further checks on file/directory contents. */

  parseData(contents: string): T;
  /* Given string contents, returns the object of expeected type
     (e.g., decoding serialized format). */
}


export abstract class AbstractLockingFilesystemWrapper<T> implements FilesystemWrapper<T> {
  /* Basic filesystem backend around Node.js fs-extra,
     providing stub methods for parsing/dumping data from/to raw string file contents
     and implementing locking around file reads/writes
     (locks based on file path, so that it cannot be written to while it’s being read from/written to).
  */

  private fileAccessLock: AsyncLock;

  constructor(public baseDir: string) {
    this.fileAccessLock = new AsyncLock();
  }

  public expandPath(objID: string) {
    return path.join(this.baseDir, objID);
  }

  public makeRelativePath(absPath: string) {
    if (path.isAbsolute(absPath)) {
      return path.relative(this.baseDir, absPath);
    } else {
      throw new Error("Expecting an absolute path, but got relative");
    }
  }

  public async isValidID(value: string) {
    return true;
  }

  public async readAll(query: { subdir?: string }, ...readArgs: any[]) {
    const dir = query.subdir ? path.join(this.baseDir, query.subdir) : this.baseDir;

    const objIDs = await fs.readdir(dir);
    var objs = [];
    for (const objID of objIDs) {
      if (await this.isValidID(objID)) {
        objs.push(await this.read(objID, ...readArgs));
      }
    }
    return objs;
  }

  public async exists(objID: string) {
    return await fs.pathExists(this.expandPath(objID));
  }

  public async read(objID: string, ...args: any[]) {
    const filePath = this.expandPath(objID);
    return await this.fileAccessLock.acquire(filePath, async () => {
      return this.parseData(await fs.readFile(filePath, { encoding: 'utf8' }));
    });
  }

  public async write(objID: string, newContents: T | undefined, ...args: any[]) {
    const filePath = this.expandPath(objID);
    return await this.fileAccessLock.acquire(filePath, async () => {
      if (newContents !== undefined) {
        await fs.writeFile(filePath, this.dumpData(newContents), { encoding: 'utf8' });
      } else {
        await fs.remove(filePath);
      }
      return [this.makeRelativePath(filePath)];
    });
  }

  public abstract parseData(contents: string): T

  protected abstract dumpData(data: T): string

}
