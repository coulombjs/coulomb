import { AbstractLockingFilesystemWrapper } from '../../../main/fs-wrapper';
interface YAML {
    [prop: string]: YAML;
}
export declare class YAMLWrapper<T extends YAML = YAML> extends AbstractLockingFilesystemWrapper<T> {
    protected isYAMLFile(objID: string): boolean;
    isValidID(objID: string): Promise<boolean>;
    expandPath(objID: string): string;
    protected parseData(data: string): any;
    protected dumpData(data: any): string;
}
export declare class YAMLDirectoryWrapper extends YAMLWrapper<YAML> {
    constructor(baseDir: string);
    private expandDirectoryPath;
    exists(objID: string): Promise<boolean>;
    isValidID(value: string): Promise<boolean>;
    read(objID: string, metaFields: string[]): Promise<YAML>;
    write<R extends YAML>(objID: string, newData?: R, metaFields?: (keyof R)[]): Promise<string[]>;
}
export {};
