import { App } from 'electron';
import { AppConfig } from '../config/app';
import { MainConfig } from '../config/main';
import { SettingManager } from '../settings/main';
import { Backend, ModelManager } from '../db/main/base';
export interface MainApp<A extends AppConfig, M extends MainConfig<A>> {
    app: App;
    isMacOS: boolean;
    isDevelopment: boolean;
    managers: Record<keyof A["data"], ModelManager<any, any>>;
    databases: Record<keyof M["databases"], Backend>;
    openWindow: (windowName: keyof A["windows"]) => void;
    settings: SettingManager;
}
export declare const initMain: <C extends MainConfig<any>>(config: C) => Promise<MainApp<any, C>>;
