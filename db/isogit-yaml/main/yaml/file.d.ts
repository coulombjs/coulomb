import { AbstractLockingFilesystemWrapper } from '../../../main/fs-wrapper';
import { YAML } from './base';
declare class YAMLWrapper<T extends YAML = YAML> extends AbstractLockingFilesystemWrapper<T> {
    protected isYAMLFile(objID: string): boolean;
    isValidID(objID: string): Promise<boolean>;
    expandPath(objID: string): string;
    listIDs(query: {
        subdir?: string;
    }, ...listArg: any[]): Promise<string[]>;
    parseData(data: string): any;
    protected dumpData(data: any): string;
}
export default YAMLWrapper;
