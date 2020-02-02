import * as path from 'path';
import * as fs from 'fs-extra';
import * as yaml from 'js-yaml';

import { AbstractLockingFilesystemWrapper } from '../../../main/fs-wrapper';

import { Schema } from './schema';


const YAML_EXT = '.yaml';


interface YAML {
  [prop: string]: YAML
}


interface YAMLDirectoryStoreableContents extends YAML {
  meta: YAML
}


export class YAMLWrapper<T extends YAML = YAML> extends AbstractLockingFilesystemWrapper<T> {
  protected isYAMLFile(objID: string) {
    return path.extname(objID) === YAML_EXT;
  }

  public async isValidID(objID: string) {
    return this.isYAMLFile(objID);
  }

  public expandPath(objID: string) {
    // In this case, path to object should include YAML extension.
    return `${super.expandPath(objID)}${YAML_EXT}`;
  }

  protected parseData(data: string): any {
    return yaml.load(data, { schema: Schema });
  }

  protected dumpData(data: any): string {
    if (data !== undefined && data !== null) {
      return yaml.dump(data, {
        schema: Schema,
        noRefs: true,
        noCompatMode: true,
      });

    } else {
      throw new Error("Attempt to write invalid data (null or undefined)");

    }
  }
}


export class YAMLDirectoryWrapper extends YAMLWrapper<YAML> {

  constructor(baseDir: string) { super(baseDir); }

  private expandDirectoryPath(objID: string) {
    return path.join(this.baseDir, objID);
  }

  public async exists(objID: string) {
    const dirPath = this.expandDirectoryPath(objID);
    if (await fs.pathExists(dirPath)) {
      const stat = await fs.stat(dirPath);
      if (!stat.isDirectory()) {
        throw new Error("File is expected to be a directory");
      }
      return true;
    }
    return false;
  }

  public async isValidID(value: string) {
    const metaFile = path.join(this.expandDirectoryPath(value), `meta${YAML_EXT}`);
    let metaFileIsFile: boolean;
    try {
      metaFileIsFile = (await fs.stat(metaFile)).isFile();
    } catch (e) {
      return false;
    }
    if (!metaFileIsFile) {
      return false;
    }
    return metaFileIsFile;
  }

  public async read(objID: string, metaFields: string[]) {
    const objAbsPath = this.expandDirectoryPath(objID);

    const metaId = 'meta';

    const metaAbsPath = path.join(objAbsPath, `${metaId}${YAML_EXT}`);
    let metaFileIsFile: boolean;
    try {
      metaFileIsFile = (await fs.stat(metaAbsPath)).isFile();
    } catch (e) {
      throw new Error(`Exception accessing meta file for ${objID}: ${metaAbsPath}: ${e.toString()} ${e.stack}`);
    }
    if (!metaFileIsFile) {
      throw new Error(`Meta file for ${objID} is not a file: ${metaAbsPath}`);
    }

    var objData: YAML = {};

    const metaPath = path.join(objID, metaId);
    const meta = await super.read(metaPath) || {};
    for (const key of metaFields) {
      objData[key] = meta[key as string];
    }

    const dirContents = await fs.readdir(objAbsPath);
    for (const filename of dirContents) {
      if (this.isYAMLFile(filename)) {
        const fieldName = path.basename(filename, YAML_EXT);
        if (fieldName != 'meta') {
          objData[fieldName] = await super.read(path.join(objID, fieldName));
        }
      }
    }

    // Blindly hope that data structure loaded from YAML
    // is valid for given type.
    return objData;
  }

  public async write<R extends YAML>(objID: string, newData?: R, metaFields?: (keyof R)[]) {
    const objPath = this.expandDirectoryPath(objID);

    if (newData !== undefined && metaFields !== undefined) {
      await fs.ensureDir(objPath);

      var dataToStore: YAMLDirectoryStoreableContents = { meta: {} };
      var modifiedPaths = [] as string[];

      for (const key of Object.keys(newData)) {
        if (metaFields.indexOf(key) >= 0) {
          dataToStore.meta[key] = newData[key];
        } else {
          dataToStore[key] = newData[key];
        }
      }

      for (const [fieldName, fieldValue] of Object.entries(dataToStore)) {
        modifiedPaths = [
          ...modifiedPaths,
          ...(await super.write(path.join(objID, fieldName), fieldValue)),
        ];
      }

      return modifiedPaths;

    } else if (newData !== undefined) {
      throw new Error("metaFields is not specified");

    } else {
      // Writing ``undefined`` should cause FS wrapper to delete the file from filesystem
      return super.write(objID, newData);
    }
  }
}
