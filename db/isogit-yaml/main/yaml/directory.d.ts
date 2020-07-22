import { YAML } from './base';
import { default as YAMLWrapper } from './file';
declare class YAMLDirectoryWrapper extends YAMLWrapper<YAML> {
    constructor(baseDir: string);
    private expandDirectoryPath;
    exists(objID: string): Promise<boolean>;
    isValidID(value: string): Promise<boolean>;
    read(objID: string, metaFields: string[]): Promise<YAML>;
    write<R extends YAML>(objID: string, newData?: R, metaFields?: (keyof R)[]): Promise<string[]>;
}
export default YAMLDirectoryWrapper;
