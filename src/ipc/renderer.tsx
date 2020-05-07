/* Wraps IPC communication in React hooks & locking queue. */

import AsyncLock from 'async-lock';
import * as log from 'electron-log';
import { ipcRenderer } from 'electron';
import { useEffect, useState } from 'react';

import { reviveJsonValue } from './utils';


ipcRenderer.setMaxListeners(50);


interface IPCHook<T> {
  value: T
  errors: string[]
  isUpdating: boolean
  refresh: () => void
  _reqCounter: number
}

interface IPCResponse<O> {
  errors: string[]
  result: O | undefined
};

class IPCFailure extends Error {
  constructor(public errorMessageList: string[]) {
    super(errorMessageList.join('; '));
    Object.setPrototypeOf(this, new.target.prototype);
  }
}


const ipcEndpointRequestLock = new AsyncLock({ maxPending: 1000 });


export function useIPCEvent<P extends object>
(endpointName: string, handler: (payload: P) => void) {
  /* Sets up main -> renderer event listener & cleanup on component destruction. */

  function handleEvent(evt: Electron.Event, payload: P) {
    log.silly("C/ipc/useIPCEvent: Handling IPC event", endpointName);
    handler(payload);
  }

  useEffect(() => {
    ipcRenderer.on(endpointName, handleEvent);
    return function cleanup() {
      ipcRenderer.removeListener(endpointName, handleEvent);
    }
  }, []);
}


export function useIPCValue<I extends object, O>
(endpointName: string, initialValue: O, payload?: I): IPCHook<O> {
  /* Invokes an endpoint and provides result state in the form of a hook.
     State can be updated by calling `refresh()`. */

  const [value, updateValue] = useState(initialValue);
  const [errors, updateErrors] = useState([] as string[]);
  const [isUpdating, setUpdating] = useState(true);

  const [reqCounter, updateReqCounter] = useState(0);
  const payloadSnapshot = JSON.stringify(payload || {});

  useEffect(() => {
    let cancelled = false;

    async function doQuery() {
      setUpdating(true);

      const resp = await ipcRenderer.invoke(endpointName, payloadSnapshot);
      const data = JSON.parse(resp, reviveJsonValue);

      if (cancelled) { return; }

      if (data.errors !== undefined) {
        const resp = data as IPCResponse<O>;

        if (resp.result === undefined) {
          if (resp.errors.length > 0) {
            updateErrors(resp.errors);
          } else {
            updateErrors(["Unknown error"]);
          }
          updateValue(initialValue);
        } else {
          updateErrors([]);
          updateValue(data.result);
        }
      } else {
        updateValue(data as O);
      }

      setUpdating(false);
    };

    doQuery();

    return () => {
      cancelled = true;
    }

  }, [endpointName, reqCounter, payloadSnapshot]);

  return {
    value: value,
    errors: errors,
    isUpdating: isUpdating,
    refresh: () => updateReqCounter(counter => { return counter += 1 }),
    _reqCounter: reqCounter,
  };
}


export async function callIPC<I extends object, O>
(endpointName: string, payload?: I): Promise<O> {
  return ipcEndpointRequestLock.acquire(endpointName, async function () {
    const rawData = await ipcRenderer.invoke(endpointName, JSON.stringify(payload));
    return new Promise<O>((resolve, reject) => {
      const data = JSON.parse(rawData, reviveJsonValue);
      if (data.errors !== undefined) {
        // Means main is using listen(), new API
        const resp: IPCResponse<O> = data;

        if (resp.result === undefined) {
          if (resp.errors.length > 0) {
            reject(new IPCFailure(resp.errors));
          } else {
            reject(new IPCFailure(["Unknown error"]));
          }
        }
        resolve(data.result);
      } else {
        // Means main is using makeEndpoint(), legacy API
        const result: O = data;
        resolve(result);
      }
    });
  });
}


export async function relayIPCEvent
<
  I extends object = { eventName: string, eventPayload?: any },
  O = { success: true },
>
(payload: I): Promise<O> {
  return await callIPC<I, O>('relay-event-to-all-windows', payload);
}
