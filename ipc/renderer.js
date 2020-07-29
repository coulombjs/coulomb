/* Wraps IPC communication in React hooks & locking queue. */
import AsyncLock from 'async-lock';
import * as log from 'electron-log';
import { ipcRenderer } from 'electron';
import { useEffect, useState } from 'react';
import { reviveJsonValue } from './utils';
ipcRenderer.setMaxListeners(50);
;
class IPCFailure extends Error {
    constructor(errorMessageList) {
        super(errorMessageList.join('; '));
        this.errorMessageList = errorMessageList;
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
const ipcEndpointRequestLock = new AsyncLock({ maxPending: 1000 });
export function useIPCEvent(endpointName, handler, memoizeArguments = []) {
    /* Sets up main -> renderer event listener & cleanup on component destruction. */
    function handleEvent(evt, payload) {
        log.silly("C/ipc/useIPCEvent: Handling IPC event", endpointName, payload);
        handler(payload);
    }
    useEffect(() => {
        ipcRenderer.on(endpointName, handleEvent);
        return function cleanup() {
            ipcRenderer.removeListener(endpointName, handleEvent);
        };
    }, memoizeArguments);
}
export function useIPCValue(endpointName, initialValue, payload) {
    /* Invokes an endpoint and provides result state in the form of a hook.
       State can be updated by calling `refresh()`. */
    const [value, updateValue] = useState(initialValue);
    const [errors, updateErrors] = useState([]);
    const [isUpdating, setUpdating] = useState(true);
    const [reqCounter, updateReqCounter] = useState(0);
    const payloadSnapshot = JSON.stringify(payload || {});
    useEffect(() => {
        let cancelled = false;
        async function doQuery() {
            setUpdating(true);
            const resp = await ipcRenderer.invoke(endpointName, payloadSnapshot);
            const data = JSON.parse(resp, reviveJsonValue);
            if (cancelled) {
                return;
            }
            if (data.errors !== undefined) {
                const resp = data;
                if (resp.result === undefined) {
                    if (resp.errors.length > 0) {
                        updateErrors(resp.errors);
                    }
                    else {
                        updateErrors(["Unknown error"]);
                    }
                    updateValue(initialValue);
                }
                else {
                    updateErrors([]);
                    updateValue(data.result);
                }
            }
            else {
                updateValue(data);
            }
            setUpdating(false);
        }
        ;
        doQuery();
        return () => {
            cancelled = true;
        };
    }, [endpointName, reqCounter, payloadSnapshot]);
    return {
        value: value,
        errors: errors,
        isUpdating: isUpdating,
        refresh: () => updateReqCounter(counter => { return counter += 1; }),
        _reqCounter: reqCounter,
    };
}
export async function callIPC(endpointName, payload) {
    return ipcEndpointRequestLock.acquire(endpointName, async function () {
        const rawData = await ipcRenderer.invoke(endpointName, JSON.stringify(payload));
        return new Promise((resolve, reject) => {
            const data = JSON.parse(rawData, reviveJsonValue);
            if (data.errors !== undefined) {
                // Means main is using listen(), new API
                const resp = data;
                if (resp.result === undefined) {
                    if (resp.errors.length > 0) {
                        reject(new IPCFailure(resp.errors));
                    }
                    else {
                        reject(new IPCFailure(["Unknown error"]));
                    }
                }
                resolve(data.result);
            }
            else {
                // Means main is using makeEndpoint(), legacy API
                const result = data;
                resolve(result);
            }
        });
    });
}
export async function relayIPCEvent(payload) {
    return await callIPC('relay-event-to-all-windows', payload);
}
//# sourceMappingURL=renderer.js.map