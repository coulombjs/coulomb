/* Wraps IPC communication in React hooks & locking queue. */
import { debounce } from 'throttle-debounce';
import AsyncLock from 'async-lock';
import * as log from 'electron-log';
import { ipcRenderer } from 'electron';
import { useEffect, useState } from 'react';
import { reviveJsonValue } from './utils';
var cache = {};
class IPCFailure extends Error {
    constructor(errorMessageList) {
        super(errorMessageList.join('; '));
        this.errorMessageList = errorMessageList;
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
export function useIPCEvent(endpointName, handler) {
    /* Sets up main -> renderer event listener & cleanup on component destruction. */
    useEffect(() => {
        function handleEvent(evt, payload) {
            log.debug("Handling IPC event", endpointName);
            handler(payload);
        }
        ipcRenderer.on(endpointName, handleEvent);
        return function cleanup() {
            ipcRenderer.removeListener(endpointName, handleEvent);
        };
    }, []);
}
export function useIPCValue(endpointName, initialValue, payload) {
    /* Invokes an endpoint and provides result state in the form of a hook.
       State can be updated by calling `refresh()`. */
    const [value, updateValue] = useState(initialValue);
    const [errors, updateErrors] = useState([]);
    const [isUpdating, setUpdating] = useState(false);
    const [reqCounter, updateReqCounter] = useState(0);
    const payloadSnapshot = JSON.stringify(payload || {});
    useEffect(() => {
        setUpdating(false);
    }, [value]);
    useEffect(() => {
        setUpdating(true);
        const cacheKey = `${endpointName}${reqCounter}${payloadSnapshot}`;
        const doQuery = debounce(400, async () => {
            let resp;
            const cachedResp = cache[cacheKey];
            if (cachedResp !== undefined) {
                resp = cachedResp;
            }
            else {
                //(async () => {
                //updateValue(initialValue);
                resp = await ipcEndpointRequestLock.acquire(endpointName, async function () {
                    const payloadToSend = JSON.stringify(payload || {});
                    return await ipcRenderer.invoke(endpointName, payloadToSend);
                });
                cache[cacheKey] = resp;
                //})();
            }
            const data = JSON.parse(resp, reviveJsonValue);
            if (data.errors !== undefined) {
                const resp = data;
                if (resp.result === undefined) {
                    if (resp.errors.length > 0) {
                        updateErrors(resp.errors);
                    }
                    else {
                        updateErrors(["Unknown error"]);
                    }
                }
                else {
                    updateValue(data.result);
                }
            }
            else {
                updateValue(data);
            }
        });
        doQuery();
    }, [reqCounter, payloadSnapshot]);
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
const ipcEndpointRequestLock = new AsyncLock({ maxPending: 100000 });
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVuZGVyZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zcmMvaXBjL3JlbmRlcmVyLnRzeCJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSw2REFBNkQ7QUFFN0QsT0FBTyxFQUFFLFFBQVEsRUFBRSxNQUFNLG1CQUFtQixDQUFDO0FBQzdDLE9BQU8sU0FBUyxNQUFNLFlBQVksQ0FBQztBQUNuQyxPQUFPLEtBQUssR0FBRyxNQUFNLGNBQWMsQ0FBQztBQUNwQyxPQUFPLEVBQUUsV0FBVyxFQUFFLE1BQU0sVUFBVSxDQUFDO0FBQ3ZDLE9BQU8sRUFBRSxTQUFTLEVBQUUsUUFBUSxFQUFFLE1BQU0sT0FBTyxDQUFDO0FBRTVDLE9BQU8sRUFBRSxlQUFlLEVBQUUsTUFBTSxTQUFTLENBQUM7QUFHMUMsSUFBSSxLQUFLLEdBQTBCLEVBQUUsQ0FBQztBQVN0QyxNQUFNLFVBQVcsU0FBUSxLQUFLO0lBQzVCLFlBQW1CLGdCQUEwQjtRQUMzQyxLQUFLLENBQUMsZ0JBQWdCLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7UUFEbEIscUJBQWdCLEdBQWhCLGdCQUFnQixDQUFVO1FBRTNDLE1BQU0sQ0FBQyxjQUFjLENBQUMsSUFBSSxFQUFFLEdBQUcsQ0FBQyxNQUFNLENBQUMsU0FBUyxDQUFDLENBQUM7SUFDcEQsQ0FBQztDQUNGO0FBR0QsTUFBTSxVQUFVLFdBQVcsQ0FDMUIsWUFBb0IsRUFBRSxPQUE2QjtJQUNsRCxpRkFBaUY7SUFFakYsU0FBUyxDQUFDLEdBQUcsRUFBRTtRQUNiLFNBQVMsV0FBVyxDQUFDLEdBQW1CLEVBQUUsT0FBVTtZQUNsRCxHQUFHLENBQUMsS0FBSyxDQUFDLG9CQUFvQixFQUFFLFlBQVksQ0FBQyxDQUFDO1lBQzlDLE9BQU8sQ0FBQyxPQUFPLENBQUMsQ0FBQztRQUNuQixDQUFDO1FBQ0QsV0FBVyxDQUFDLEVBQUUsQ0FBQyxZQUFZLEVBQUUsV0FBVyxDQUFDLENBQUM7UUFDMUMsT0FBTyxTQUFTLE9BQU87WUFDckIsV0FBVyxDQUFDLGNBQWMsQ0FBQyxZQUFZLEVBQUUsV0FBVyxDQUFDLENBQUM7UUFDeEQsQ0FBQyxDQUFBO0lBQ0gsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDO0FBQ1QsQ0FBQztBQUdELE1BQU0sVUFBVSxXQUFXLENBQzFCLFlBQW9CLEVBQUUsWUFBZSxFQUFFLE9BQVc7SUFDakQ7c0RBQ2tEO0lBRWxELE1BQU0sQ0FBQyxLQUFLLEVBQUUsV0FBVyxDQUFDLEdBQUcsUUFBUSxDQUFDLFlBQVksQ0FBQyxDQUFDO0lBQ3BELE1BQU0sQ0FBQyxNQUFNLEVBQUUsWUFBWSxDQUFDLEdBQUcsUUFBUSxDQUFDLEVBQWMsQ0FBQyxDQUFDO0lBQ3hELE1BQU0sQ0FBQyxVQUFVLEVBQUUsV0FBVyxDQUFDLEdBQUcsUUFBUSxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBRWxELE1BQU0sQ0FBQyxVQUFVLEVBQUUsZ0JBQWdCLENBQUMsR0FBRyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDbkQsTUFBTSxlQUFlLEdBQUcsSUFBSSxDQUFDLFNBQVMsQ0FBQyxPQUFPLElBQUksRUFBRSxDQUFDLENBQUM7SUFFdEQsU0FBUyxDQUFDLEdBQUcsRUFBRTtRQUNiLFdBQVcsQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUNyQixDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO0lBRVosU0FBUyxDQUFDLEdBQUcsRUFBRTtRQUNiLFdBQVcsQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUVsQixNQUFNLFFBQVEsR0FBRyxHQUFHLFlBQVksR0FBRyxVQUFVLEdBQUcsZUFBZSxFQUFFLENBQUM7UUFFbEUsTUFBTSxPQUFPLEdBQUcsUUFBUSxDQUFDLEdBQUcsRUFBRSxLQUFLLElBQUksRUFBRTtZQUV2QyxJQUFJLElBQVksQ0FBQztZQUNqQixNQUFNLFVBQVUsR0FBRyxLQUFLLENBQUMsUUFBUSxDQUFDLENBQUM7WUFFbkMsSUFBSSxVQUFVLEtBQUssU0FBUyxFQUFFO2dCQUM1QixJQUFJLEdBQUcsVUFBVSxDQUFDO2FBQ25CO2lCQUFNO2dCQUNMLGdCQUFnQjtnQkFDaEIsNEJBQTRCO2dCQUU1QixJQUFJLEdBQUcsTUFBTSxzQkFBc0IsQ0FBQyxPQUFPLENBQUMsWUFBWSxFQUFFLEtBQUs7b0JBQzdELE1BQU0sYUFBYSxHQUFHLElBQUksQ0FBQyxTQUFTLENBQUMsT0FBTyxJQUFJLEVBQUUsQ0FBQyxDQUFDO29CQUNwRCxPQUFPLE1BQU0sV0FBVyxDQUFDLE1BQU0sQ0FBQyxZQUFZLEVBQUUsYUFBYSxDQUFDLENBQUM7Z0JBQy9ELENBQUMsQ0FBQyxDQUFDO2dCQUVILEtBQUssQ0FBQyxRQUFRLENBQUMsR0FBRyxJQUFJLENBQUM7Z0JBQ3ZCLE9BQU87YUFDUjtZQUVELE1BQU0sSUFBSSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLGVBQWUsQ0FBQyxDQUFDO1lBRS9DLElBQUksSUFBSSxDQUFDLE1BQU0sS0FBSyxTQUFTLEVBQUU7Z0JBQzdCLE1BQU0sSUFBSSxHQUFHLElBQXNCLENBQUM7Z0JBRXBDLElBQUksSUFBSSxDQUFDLE1BQU0sS0FBSyxTQUFTLEVBQUU7b0JBQzdCLElBQUksSUFBSSxDQUFDLE1BQU0sQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUFFO3dCQUMxQixZQUFZLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDO3FCQUMzQjt5QkFBTTt3QkFDTCxZQUFZLENBQUMsQ0FBQyxlQUFlLENBQUMsQ0FBQyxDQUFDO3FCQUNqQztpQkFDRjtxQkFBTTtvQkFDTCxXQUFXLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDO2lCQUMxQjthQUNGO2lCQUFNO2dCQUNMLFdBQVcsQ0FBQyxJQUFTLENBQUMsQ0FBQzthQUN4QjtRQUNILENBQUMsQ0FBQyxDQUFDO1FBRUgsT0FBTyxFQUFFLENBQUM7SUFDWixDQUFDLEVBQUUsQ0FBQyxVQUFVLEVBQUUsZUFBZSxDQUFDLENBQUMsQ0FBQztJQUVsQyxPQUFPO1FBQ0wsS0FBSyxFQUFFLEtBQUs7UUFDWixNQUFNLEVBQUUsTUFBTTtRQUNkLFVBQVUsRUFBRSxVQUFVO1FBQ3RCLE9BQU8sRUFBRSxHQUFHLEVBQUUsQ0FBQyxnQkFBZ0IsQ0FBQyxPQUFPLENBQUMsRUFBRSxHQUFHLE9BQU8sT0FBTyxJQUFJLENBQUMsQ0FBQSxDQUFDLENBQUMsQ0FBQztRQUNuRSxXQUFXLEVBQUUsVUFBVTtLQUN4QixDQUFDO0FBQ0osQ0FBQztBQUdELE1BQU0sQ0FBQyxLQUFLLFVBQVUsT0FBTyxDQUM1QixZQUFvQixFQUFFLE9BQVc7SUFDaEMsT0FBTyxzQkFBc0IsQ0FBQyxPQUFPLENBQUMsWUFBWSxFQUFFLEtBQUs7UUFDdkQsTUFBTSxPQUFPLEdBQUcsTUFBTSxXQUFXLENBQUMsTUFBTSxDQUFDLFlBQVksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUM7UUFDaEYsT0FBTyxJQUFJLE9BQU8sQ0FBSSxDQUFDLE9BQU8sRUFBRSxNQUFNLEVBQUUsRUFBRTtZQUN4QyxNQUFNLElBQUksR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLE9BQU8sRUFBRSxlQUFlLENBQUMsQ0FBQztZQUNsRCxJQUFJLElBQUksQ0FBQyxNQUFNLEtBQUssU0FBUyxFQUFFO2dCQUM3Qix3Q0FBd0M7Z0JBQ3hDLE1BQU0sSUFBSSxHQUFtQixJQUFJLENBQUM7Z0JBRWxDLElBQUksSUFBSSxDQUFDLE1BQU0sS0FBSyxTQUFTLEVBQUU7b0JBQzdCLElBQUksSUFBSSxDQUFDLE1BQU0sQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUFFO3dCQUMxQixNQUFNLENBQUMsSUFBSSxVQUFVLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUM7cUJBQ3JDO3lCQUFNO3dCQUNMLE1BQU0sQ0FBQyxJQUFJLFVBQVUsQ0FBQyxDQUFDLGVBQWUsQ0FBQyxDQUFDLENBQUMsQ0FBQztxQkFDM0M7aUJBQ0Y7Z0JBQ0QsT0FBTyxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsQ0FBQzthQUN0QjtpQkFBTTtnQkFDTCxpREFBaUQ7Z0JBQ2pELE1BQU0sTUFBTSxHQUFNLElBQUksQ0FBQztnQkFDdkIsT0FBTyxDQUFDLE1BQU0sQ0FBQyxDQUFDO2FBQ2pCO1FBQ0gsQ0FBQyxDQUFDLENBQUM7SUFDTCxDQUFDLENBQUMsQ0FBQztBQUNMLENBQUM7QUFHRCxNQUFNLENBQUMsS0FBSyxVQUFVLGFBQWEsQ0FLbEMsT0FBVTtJQUNULE9BQU8sTUFBTSxPQUFPLENBQU8sNEJBQTRCLEVBQUUsT0FBTyxDQUFDLENBQUM7QUFDcEUsQ0FBQztBQVlELE1BQU0sc0JBQXNCLEdBQUcsSUFBSSxTQUFTLENBQUMsRUFBRSxVQUFVLEVBQUUsTUFBTSxFQUFFLENBQUMsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qIFdyYXBzIElQQyBjb21tdW5pY2F0aW9uIGluIFJlYWN0IGhvb2tzICYgbG9ja2luZyBxdWV1ZS4gKi9cblxuaW1wb3J0IHsgZGVib3VuY2UgfSBmcm9tICd0aHJvdHRsZS1kZWJvdW5jZSc7XG5pbXBvcnQgQXN5bmNMb2NrIGZyb20gJ2FzeW5jLWxvY2snO1xuaW1wb3J0ICogYXMgbG9nIGZyb20gJ2VsZWN0cm9uLWxvZyc7XG5pbXBvcnQgeyBpcGNSZW5kZXJlciB9IGZyb20gJ2VsZWN0cm9uJztcbmltcG9ydCB7IHVzZUVmZmVjdCwgdXNlU3RhdGUgfSBmcm9tICdyZWFjdCc7XG5cbmltcG9ydCB7IHJldml2ZUpzb25WYWx1ZSB9IGZyb20gJy4vdXRpbHMnO1xuXG5cbnZhciBjYWNoZTogeyBbaWQ6IHN0cmluZ106IGFueSB9ID0ge307XG5cblxudHlwZSBJUENSZXNwb25zZTxPPiA9IHtcbiAgZXJyb3JzOiBzdHJpbmdbXVxuICByZXN1bHQ6IE8gfCB1bmRlZmluZWRcbn07XG5cblxuY2xhc3MgSVBDRmFpbHVyZSBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IocHVibGljIGVycm9yTWVzc2FnZUxpc3Q6IHN0cmluZ1tdKSB7XG4gICAgc3VwZXIoZXJyb3JNZXNzYWdlTGlzdC5qb2luKCc7ICcpKTtcbiAgICBPYmplY3Quc2V0UHJvdG90eXBlT2YodGhpcywgbmV3LnRhcmdldC5wcm90b3R5cGUpO1xuICB9XG59XG5cblxuZXhwb3J0IGZ1bmN0aW9uIHVzZUlQQ0V2ZW50PFAgZXh0ZW5kcyBvYmplY3Q+XG4oZW5kcG9pbnROYW1lOiBzdHJpbmcsIGhhbmRsZXI6IChwYXlsb2FkOiBQKSA9PiB2b2lkKSB7XG4gIC8qIFNldHMgdXAgbWFpbiAtPiByZW5kZXJlciBldmVudCBsaXN0ZW5lciAmIGNsZWFudXAgb24gY29tcG9uZW50IGRlc3RydWN0aW9uLiAqL1xuXG4gIHVzZUVmZmVjdCgoKSA9PiB7XG4gICAgZnVuY3Rpb24gaGFuZGxlRXZlbnQoZXZ0OiBFbGVjdHJvbi5FdmVudCwgcGF5bG9hZDogUCkge1xuICAgICAgbG9nLmRlYnVnKFwiSGFuZGxpbmcgSVBDIGV2ZW50XCIsIGVuZHBvaW50TmFtZSk7XG4gICAgICBoYW5kbGVyKHBheWxvYWQpO1xuICAgIH1cbiAgICBpcGNSZW5kZXJlci5vbihlbmRwb2ludE5hbWUsIGhhbmRsZUV2ZW50KTtcbiAgICByZXR1cm4gZnVuY3Rpb24gY2xlYW51cCgpIHtcbiAgICAgIGlwY1JlbmRlcmVyLnJlbW92ZUxpc3RlbmVyKGVuZHBvaW50TmFtZSwgaGFuZGxlRXZlbnQpO1xuICAgIH1cbiAgfSwgW10pO1xufVxuXG5cbmV4cG9ydCBmdW5jdGlvbiB1c2VJUENWYWx1ZTxJIGV4dGVuZHMgb2JqZWN0LCBPPlxuKGVuZHBvaW50TmFtZTogc3RyaW5nLCBpbml0aWFsVmFsdWU6IE8sIHBheWxvYWQ/OiBJKTogSVBDSG9vazxPPiB7XG4gIC8qIEludm9rZXMgYW4gZW5kcG9pbnQgYW5kIHByb3ZpZGVzIHJlc3VsdCBzdGF0ZSBpbiB0aGUgZm9ybSBvZiBhIGhvb2suXG4gICAgIFN0YXRlIGNhbiBiZSB1cGRhdGVkIGJ5IGNhbGxpbmcgYHJlZnJlc2goKWAuICovXG5cbiAgY29uc3QgW3ZhbHVlLCB1cGRhdGVWYWx1ZV0gPSB1c2VTdGF0ZShpbml0aWFsVmFsdWUpO1xuICBjb25zdCBbZXJyb3JzLCB1cGRhdGVFcnJvcnNdID0gdXNlU3RhdGUoW10gYXMgc3RyaW5nW10pO1xuICBjb25zdCBbaXNVcGRhdGluZywgc2V0VXBkYXRpbmddID0gdXNlU3RhdGUoZmFsc2UpO1xuXG4gIGNvbnN0IFtyZXFDb3VudGVyLCB1cGRhdGVSZXFDb3VudGVyXSA9IHVzZVN0YXRlKDApO1xuICBjb25zdCBwYXlsb2FkU25hcHNob3QgPSBKU09OLnN0cmluZ2lmeShwYXlsb2FkIHx8IHt9KTtcblxuICB1c2VFZmZlY3QoKCkgPT4ge1xuICAgIHNldFVwZGF0aW5nKGZhbHNlKTtcbiAgfSwgW3ZhbHVlXSk7XG5cbiAgdXNlRWZmZWN0KCgpID0+IHtcbiAgICBzZXRVcGRhdGluZyh0cnVlKTtcblxuICAgIGNvbnN0IGNhY2hlS2V5ID0gYCR7ZW5kcG9pbnROYW1lfSR7cmVxQ291bnRlcn0ke3BheWxvYWRTbmFwc2hvdH1gO1xuXG4gICAgY29uc3QgZG9RdWVyeSA9IGRlYm91bmNlKDQwMCwgYXN5bmMgKCkgPT4ge1xuXG4gICAgICBsZXQgcmVzcDogc3RyaW5nO1xuICAgICAgY29uc3QgY2FjaGVkUmVzcCA9IGNhY2hlW2NhY2hlS2V5XTtcblxuICAgICAgaWYgKGNhY2hlZFJlc3AgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICByZXNwID0gY2FjaGVkUmVzcDtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vKGFzeW5jICgpID0+IHtcbiAgICAgICAgLy91cGRhdGVWYWx1ZShpbml0aWFsVmFsdWUpO1xuXG4gICAgICAgIHJlc3AgPSBhd2FpdCBpcGNFbmRwb2ludFJlcXVlc3RMb2NrLmFjcXVpcmUoZW5kcG9pbnROYW1lLCBhc3luYyBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgY29uc3QgcGF5bG9hZFRvU2VuZCA9IEpTT04uc3RyaW5naWZ5KHBheWxvYWQgfHwge30pO1xuICAgICAgICAgIHJldHVybiBhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoZW5kcG9pbnROYW1lLCBwYXlsb2FkVG9TZW5kKTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgY2FjaGVbY2FjaGVLZXldID0gcmVzcDtcbiAgICAgICAgLy99KSgpO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBkYXRhID0gSlNPTi5wYXJzZShyZXNwLCByZXZpdmVKc29uVmFsdWUpO1xuXG4gICAgICBpZiAoZGF0YS5lcnJvcnMgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICBjb25zdCByZXNwID0gZGF0YSBhcyBJUENSZXNwb25zZTxPPjtcblxuICAgICAgICBpZiAocmVzcC5yZXN1bHQgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIGlmIChyZXNwLmVycm9ycy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICB1cGRhdGVFcnJvcnMocmVzcC5lcnJvcnMpO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB1cGRhdGVFcnJvcnMoW1wiVW5rbm93biBlcnJvclwiXSk7XG4gICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHVwZGF0ZVZhbHVlKGRhdGEucmVzdWx0KTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdXBkYXRlVmFsdWUoZGF0YSBhcyBPKTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIGRvUXVlcnkoKTtcbiAgfSwgW3JlcUNvdW50ZXIsIHBheWxvYWRTbmFwc2hvdF0pO1xuXG4gIHJldHVybiB7XG4gICAgdmFsdWU6IHZhbHVlLFxuICAgIGVycm9yczogZXJyb3JzLFxuICAgIGlzVXBkYXRpbmc6IGlzVXBkYXRpbmcsXG4gICAgcmVmcmVzaDogKCkgPT4gdXBkYXRlUmVxQ291bnRlcihjb3VudGVyID0+IHsgcmV0dXJuIGNvdW50ZXIgKz0gMSB9KSxcbiAgICBfcmVxQ291bnRlcjogcmVxQ291bnRlcixcbiAgfTtcbn1cblxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY2FsbElQQzxJIGV4dGVuZHMgb2JqZWN0LCBPPlxuKGVuZHBvaW50TmFtZTogc3RyaW5nLCBwYXlsb2FkPzogSSk6IFByb21pc2U8Tz4ge1xuICByZXR1cm4gaXBjRW5kcG9pbnRSZXF1ZXN0TG9jay5hY3F1aXJlKGVuZHBvaW50TmFtZSwgYXN5bmMgZnVuY3Rpb24gKCkge1xuICAgIGNvbnN0IHJhd0RhdGEgPSBhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoZW5kcG9pbnROYW1lLCBKU09OLnN0cmluZ2lmeShwYXlsb2FkKSk7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlPE8+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgIGNvbnN0IGRhdGEgPSBKU09OLnBhcnNlKHJhd0RhdGEsIHJldml2ZUpzb25WYWx1ZSk7XG4gICAgICBpZiAoZGF0YS5lcnJvcnMgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAvLyBNZWFucyBtYWluIGlzIHVzaW5nIGxpc3RlbigpLCBuZXcgQVBJXG4gICAgICAgIGNvbnN0IHJlc3A6IElQQ1Jlc3BvbnNlPE8+ID0gZGF0YTtcblxuICAgICAgICBpZiAocmVzcC5yZXN1bHQgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIGlmIChyZXNwLmVycm9ycy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICByZWplY3QobmV3IElQQ0ZhaWx1cmUocmVzcC5lcnJvcnMpKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcmVqZWN0KG5ldyBJUENGYWlsdXJlKFtcIlVua25vd24gZXJyb3JcIl0pKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgcmVzb2x2ZShkYXRhLnJlc3VsdCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyBNZWFucyBtYWluIGlzIHVzaW5nIG1ha2VFbmRwb2ludCgpLCBsZWdhY3kgQVBJXG4gICAgICAgIGNvbnN0IHJlc3VsdDogTyA9IGRhdGE7XG4gICAgICAgIHJlc29sdmUocmVzdWx0KTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfSk7XG59XG5cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlbGF5SVBDRXZlbnRcbjxcbiAgSSBleHRlbmRzIG9iamVjdCA9IHsgZXZlbnROYW1lOiBzdHJpbmcsIGV2ZW50UGF5bG9hZD86IGFueSB9LFxuICBPID0geyBzdWNjZXNzOiB0cnVlIH0sXG4+XG4ocGF5bG9hZDogSSk6IFByb21pc2U8Tz4ge1xuICByZXR1cm4gYXdhaXQgY2FsbElQQzxJLCBPPigncmVsYXktZXZlbnQtdG8tYWxsLXdpbmRvd3MnLCBwYXlsb2FkKTtcbn1cblxuXG5pbnRlcmZhY2UgSVBDSG9vazxUPiB7XG4gIHZhbHVlOiBUXG4gIGVycm9yczogc3RyaW5nW11cbiAgaXNVcGRhdGluZzogYm9vbGVhblxuICByZWZyZXNoOiAoKSA9PiB2b2lkXG4gIF9yZXFDb3VudGVyOiBudW1iZXJcbn1cblxuXG5jb25zdCBpcGNFbmRwb2ludFJlcXVlc3RMb2NrID0gbmV3IEFzeW5jTG9jayh7IG1heFBlbmRpbmc6IDEwMDAwMCB9KTsiXX0=