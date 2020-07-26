/* Simple API on top of Electron’s IPC framework, the `renderer` side.
   Provides functions for sending API requests to fetch/store data and/or open window. */

import { ipcRenderer } from 'electron';

import { APIResponse, reviveJsonValue, getEventNamesForEndpoint, getEventNamesForWindowEndpoint } from './utils';


// TODO (#4): Refactor into generic main APIs, rather than Workspace-centered


// TODO: Implement hook for using time travel APIs with undo/redo
// and transactions for race condition avoidance.


class RequestFailure extends Error {
  constructor(public errorMessageList: string[]) {
    super(errorMessageList.join('; '));
    Object.setPrototypeOf(this, new.target.prototype);
  }
}


export async function request<T>(endpointName: string, ...args: any[]): Promise<T> {
  // TODO: This does not handle a timeout, so if `main` endpoint is misconfigured and never responds
  // the handler will remain listening

  const eventNames = getEventNamesForEndpoint(endpointName);
  return new Promise<T>((resolve, reject) => {
    function handleResp(evt: any, rawData: string) {
      ipcRenderer.removeListener(eventNames.response, handleResp);
      const data: any = JSON.parse(rawData, reviveJsonValue);

      if (data.errors !== undefined) {
        // Means main is using listen(), new API
        const resp: APIResponse<T> = data;

        if (resp.result === undefined) {
          if (resp.errors.length > 0) {
            reject(new RequestFailure(resp.errors));
          } else {
            reject(new RequestFailure(["Unknown error"]));
          }
        }
        resolve(data.result);
      } else {
        // Means main is using makeEndpoint(), legacy API
        const resp: T = data;
        resolve(resp);
      }
    }
    ipcRenderer.on(eventNames.response, handleResp);
    ipcRenderer.send(eventNames.request, ...serializeArgs(args));
  });
}


export function openWindow(endpointName: string, params?: any): void {
  const eventNames = getEventNamesForWindowEndpoint(endpointName);
  ipcRenderer.sendSync(eventNames.request, JSON.stringify(params || {}));
}


function serializeArgs(args: any[]): string[] {
  /* Helper function that stringifies an array of objects with JSON.
     We don’t necessarily want Electron to handle that for us,
     because we might want custom parsing for e.g. timestamps in JSON. */

  return args.map(val => JSON.stringify(val));
}
