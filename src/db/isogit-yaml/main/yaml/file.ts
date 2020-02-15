import * as path from 'path';
import * as yaml from 'js-yaml';

import { AbstractLockingFilesystemWrapper } from '../../../main/fs-wrapper';

import { Schema } from './schema';
import { YAML_EXT, YAML } from './base';


class YAMLWrapper<T extends YAML = YAML> extends AbstractLockingFilesystemWrapper<T> {
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

  public async listIDs(query: { subdir?: string }, ...listArg: any[]) {
    const ids = await super.listIDs(query);
    return ids.
    map(id => path.basename(id, YAML_EXT)).
    map(id => query.subdir ? path.join(query.subdir, id) : id);
  }

  public parseData(data: string): any {
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

export default YAMLWrapper;
