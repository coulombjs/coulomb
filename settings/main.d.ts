export interface Pane {
    id: string;
    label: string;
    icon?: string;
}
export declare class Setting<T> {
    paneID: string;
    id: string;
    input: 'text' | 'number';
    required: boolean;
    label: string;
    helpText?: string | undefined;
    constructor(paneID: string, id: string, input: 'text' | 'number', required: boolean, label: string, helpText?: string | undefined);
    toUseable(val: unknown): T;
    toStoreable(val: T): any;
}
export declare class SettingManager {
    appDataPath: string;
    settingsFileName: string;
    private registry;
    private panes;
    private data;
    private yaml;
    private settingsPath;
    constructor(appDataPath: string, settingsFileName: string);
    listMissingRequiredSettings(): Promise<string[]>;
    getValue(id: string): Promise<unknown>;
    setValue(id: string, val: unknown): Promise<void>;
    deleteValue(id: string): Promise<void>;
    private commit;
    private get;
    register(setting: Setting<any>): void;
    configurePane(pane: Pane): void;
    setUpIPC(): void;
}
