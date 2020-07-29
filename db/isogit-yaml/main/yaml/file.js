import * as log from 'electron-log';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { AbstractLockingFilesystemWrapper } from '../../../main/fs-wrapper';
import { Schema } from './schema';
import { YAML_EXT } from './base';
class YAMLWrapper extends AbstractLockingFilesystemWrapper {
    isYAMLFile(objID) {
        return path.extname(objID) === YAML_EXT;
    }
    async isValidID(objID) {
        return this.isYAMLFile(objID);
    }
    expandPath(objID) {
        // In this case, path to object should include YAML extension.
        return `${super.expandPath(objID)}${YAML_EXT}`;
    }
    async listIDs(query, ...listArg) {
        const ids = await super.listIDs(query);
        return ids.
            map(id => path.basename(id, YAML_EXT)).
            map(id => query.subdir ? path.join(query.subdir, id) : id);
    }
    parseData(data) {
        return yaml.load(data, { schema: Schema });
    }
    dumpData(data) {
        if (data !== undefined && data !== null) {
            try {
                return yaml.dump(data, {
                    schema: Schema,
                    noRefs: true,
                    noCompatMode: true,
                });
            }
            catch (e) {
                log.debug("Dumping data encountered an exception", data);
                log.error("Failed to dump data.");
                throw e;
            }
        }
        else {
            throw new Error("Attempt to write invalid data (null or undefined)");
        }
    }
}
export default YAMLWrapper;
//# sourceMappingURL=file.js.map