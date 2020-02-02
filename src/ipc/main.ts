/* Simple API on top of Electron’s IPC framework, the `main` side.
   Provides functions for handling API requests to fetch/store data and/or open window. */

import * as log from 'electron-log';

import { ipcMain } from 'electron';
import { notifyAllWindows, openWindow, WindowOpenerParams } from '../main/window';
import { APIResponse, getEventNamesForWindowEndpoint } from '../api_legacy/utils';

import { reviveJsonValue } from './utils';


export type Handler<I extends object, O extends object> = (params: I) => Promise<O>;
export function listen<I extends object, O extends object>
(name: string, handler: Handler<I, O>) {
  /* Defines an API endpoint with I input and O output types.
     Takes endpoint name and handler function.

     Handler is expected to be an async function
     that takes deserialized input params and returns the output.

     The endpoint handles input deserialization,
     wrapping the output in response object { errors: string[], result: O },
     and response serialization. */

  ipcMain.handle(name, async (evt: any, rawInput?: string) => {
    let response: APIResponse<O>;

    // We may be able to switch to Electron’s own (de)serialization behavior
    // if we find a way to plug our bespoke `reviveJsonValue`.
    const input: I = JSON.parse(rawInput || '{}', reviveJsonValue);

    try {
      response = { errors: [], result: await handler(input) };
    } catch (e) {
      log.error(`C/ipc: Error handling request to ${name}! ${e.toString()}: ${e.stack}}`);
      response = { errors: [`${e.message}`], result: undefined };
    }

    log.debug(`C/ipc: handled request to ${name}`);

    return JSON.stringify(response);
  });
}


export function unlisten(eventName: string, handler: Handler<any, any>) {
  return ipcMain.removeListener(eventName, handler);
}


listen<{ eventName: string, payload?: any }, { success: true }>
('relay-event-to-all-windows', async ({ eventName, payload }) => {
  await notifyAllWindows(eventName, payload);
  return { success: true };
});


export function makeWindowEndpoint(name: string, getWindowOpts: (params: any) => WindowOpenerParams): void {
  // TODO: Migrate to listen()?
  const eventNames = getEventNamesForWindowEndpoint(name);

  ipcMain.on(eventNames.request, async (evt: any, params?: string) => {
    const parsedParams: any = JSON.parse(params || '{}', reviveJsonValue);
    await openWindow(getWindowOpts(parsedParams));

    const result = JSON.stringify({ errors: [] });
    evt.returnValue = result;
    evt.reply(eventNames.response, result);
  });
}
