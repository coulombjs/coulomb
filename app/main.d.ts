import { App } from 'electron';
import { AppConfig } from '../config/app';
import { MainConfig } from '../config/main';
import { VersionedFilesystemBackend, VersionedManager } from '../db/main/base';
export declare let main: MainApp<any, any>;
export declare const initMain: <C extends MainConfig<any>>(config: C) => Promise<MainApp<any, C>>;
export interface MainApp<A extends AppConfig, M extends MainConfig<A>> {
    app: App;
    isMacOS: boolean;
    isDevelopment: boolean;
    managers: Record<keyof A["data"], VersionedManager<any, any>>;
    databases: Record<keyof M["databases"], VersionedFilesystemBackend>;
    openWindow: (windowName: keyof A["windows"]) => void;
}
