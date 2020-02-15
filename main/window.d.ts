import { BrowserWindow, MenuItemConstructorOptions } from 'electron';
export declare var windows: BrowserWindow[];
export interface WindowOpenerParams {
    title: string;
    url?: string;
    component?: string;
    componentParams?: string;
    dimensions?: {
        minHeight?: number;
        minWidth?: number;
        height?: number;
        width?: number;
        maxHeight?: number;
        maxWidth?: number;
    };
    frameless?: boolean;
    winParams?: any;
    menuTemplate?: MenuItemConstructorOptions[];
    ignoreCache?: boolean;
}
export declare type WindowOpener = (props: WindowOpenerParams) => Promise<BrowserWindow>;
export declare const openWindow: WindowOpener;
export declare function getWindowByTitle(title: string): BrowserWindow | undefined;
export declare function closeWindow(title: string): void;
export declare function getWindow(func: (win: BrowserWindow) => boolean): BrowserWindow | undefined;
export declare function notifyAllWindows(eventName: string, payload?: any): Promise<void>;
export declare function notifyWindow(windowTitle: string, eventName: string, payload?: any): Promise<void>;
