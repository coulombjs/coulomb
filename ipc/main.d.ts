/// <reference types="electron" />
import { WindowOpenerParams } from '../main/window';
export declare type Handler<I extends object, O extends object> = (params: I) => Promise<O>;
export declare function listen<I extends object, O extends object>(name: string, handler: Handler<I, O>): void;
export declare function unlisten(eventName: string, handler: Handler<any, any>): Electron.IpcMain;
export declare function makeWindowEndpoint(name: string, getWindowOpts: (params: any) => WindowOpenerParams): void;
