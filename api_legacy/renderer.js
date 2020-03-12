/* Simple API on top of Electron’s IPC framework, the `renderer` side.
   Provides functions for sending API requests to fetch/store data and/or open window. */
import { ipcRenderer } from 'electron';
import { reviveJsonValue, getEventNamesForEndpoint, getEventNamesForWindowEndpoint } from './utils';
// TODO (#4): Refactor into generic main APIs, rather than Workspace-centered
// TODO: Implement hook for using time travel APIs with undo/redo
// and transactions for race condition avoidance.
class RequestFailure extends Error {
    constructor(errorMessageList) {
        super(errorMessageList.join('; '));
        this.errorMessageList = errorMessageList;
        Object.setPrototypeOf(this, new.target.prototype);
    }
}
export async function request(endpointName, ...args) {
    // TODO: This does not handle a timeout, so if `main` endpoint is misconfigured and never responds
    // the handler will remain listening
    const eventNames = getEventNamesForEndpoint(endpointName);
    return new Promise((resolve, reject) => {
        function handleResp(evt, rawData) {
            ipcRenderer.removeListener(eventNames.response, handleResp);
            const data = JSON.parse(rawData, reviveJsonValue);
            if (data.errors !== undefined) {
                // Means main is using listen(), new API
                const resp = data;
                if (resp.result === undefined) {
                    if (resp.errors.length > 0) {
                        reject(new RequestFailure(resp.errors));
                    }
                    else {
                        reject(new RequestFailure(["Unknown error"]));
                    }
                }
                resolve(data.result);
            }
            else {
                // Means main is using makeEndpoint(), legacy API
                const resp = data;
                resolve(resp);
            }
        }
        ipcRenderer.on(eventNames.response, handleResp);
        ipcRenderer.send(eventNames.request, ...serializeArgs(args));
    });
}
export function openWindow(endpointName, params) {
    const eventNames = getEventNamesForWindowEndpoint(endpointName);
    ipcRenderer.sendSync(eventNames.request, JSON.stringify(params || {}));
}
function serializeArgs(args) {
    /* Helper function that stringifies an array of objects with JSON.
       We don’t necessarily want Electron to handle that for us,
       because we might want custom parsing for e.g. timestamps in JSON. */
    return args.map(val => JSON.stringify(val));
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVuZGVyZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zcmMvYXBpX2xlZ2FjeS9yZW5kZXJlci50c3giXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7eUZBQ3lGO0FBRXpGLE9BQU8sRUFBRSxXQUFXLEVBQUUsTUFBTSxVQUFVLENBQUM7QUFFdkMsT0FBTyxFQUFlLGVBQWUsRUFBRSx3QkFBd0IsRUFBRSw4QkFBOEIsRUFBRSxNQUFNLFNBQVMsQ0FBQztBQUdqSCw2RUFBNkU7QUFHN0UsaUVBQWlFO0FBQ2pFLGlEQUFpRDtBQUdqRCxNQUFNLGNBQWUsU0FBUSxLQUFLO0lBQ2hDLFlBQW1CLGdCQUEwQjtRQUMzQyxLQUFLLENBQUMsZ0JBQWdCLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7UUFEbEIscUJBQWdCLEdBQWhCLGdCQUFnQixDQUFVO1FBRTNDLE1BQU0sQ0FBQyxjQUFjLENBQUMsSUFBSSxFQUFFLEdBQUcsQ0FBQyxNQUFNLENBQUMsU0FBUyxDQUFDLENBQUM7SUFDcEQsQ0FBQztDQUNGO0FBR0QsTUFBTSxDQUFDLEtBQUssVUFBVSxPQUFPLENBQUksWUFBb0IsRUFBRSxHQUFHLElBQVc7SUFDbkUsa0dBQWtHO0lBQ2xHLG9DQUFvQztJQUVwQyxNQUFNLFVBQVUsR0FBRyx3QkFBd0IsQ0FBQyxZQUFZLENBQUMsQ0FBQztJQUMxRCxPQUFPLElBQUksT0FBTyxDQUFJLENBQUMsT0FBTyxFQUFFLE1BQU0sRUFBRSxFQUFFO1FBQ3hDLFNBQVMsVUFBVSxDQUFDLEdBQVEsRUFBRSxPQUFlO1lBQzNDLFdBQVcsQ0FBQyxjQUFjLENBQUMsVUFBVSxDQUFDLFFBQVEsRUFBRSxVQUFVLENBQUMsQ0FBQztZQUM1RCxNQUFNLElBQUksR0FBUSxJQUFJLENBQUMsS0FBSyxDQUFDLE9BQU8sRUFBRSxlQUFlLENBQUMsQ0FBQztZQUV2RCxJQUFJLElBQUksQ0FBQyxNQUFNLEtBQUssU0FBUyxFQUFFO2dCQUM3Qix3Q0FBd0M7Z0JBQ3hDLE1BQU0sSUFBSSxHQUFtQixJQUFJLENBQUM7Z0JBRWxDLElBQUksSUFBSSxDQUFDLE1BQU0sS0FBSyxTQUFTLEVBQUU7b0JBQzdCLElBQUksSUFBSSxDQUFDLE1BQU0sQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUFFO3dCQUMxQixNQUFNLENBQUMsSUFBSSxjQUFjLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUM7cUJBQ3pDO3lCQUFNO3dCQUNMLE1BQU0sQ0FBQyxJQUFJLGNBQWMsQ0FBQyxDQUFDLGVBQWUsQ0FBQyxDQUFDLENBQUMsQ0FBQztxQkFDL0M7aUJBQ0Y7Z0JBQ0QsT0FBTyxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsQ0FBQzthQUN0QjtpQkFBTTtnQkFDTCxpREFBaUQ7Z0JBQ2pELE1BQU0sSUFBSSxHQUFNLElBQUksQ0FBQztnQkFDckIsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDO2FBQ2Y7UUFDSCxDQUFDO1FBQ0QsV0FBVyxDQUFDLEVBQUUsQ0FBQyxVQUFVLENBQUMsUUFBUSxFQUFFLFVBQVUsQ0FBQyxDQUFDO1FBQ2hELFdBQVcsQ0FBQyxJQUFJLENBQUMsVUFBVSxDQUFDLE9BQU8sRUFBRSxHQUFHLGFBQWEsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDO0lBQy9ELENBQUMsQ0FBQyxDQUFDO0FBQ0wsQ0FBQztBQUdELE1BQU0sVUFBVSxVQUFVLENBQUMsWUFBb0IsRUFBRSxNQUFZO0lBQzNELE1BQU0sVUFBVSxHQUFHLDhCQUE4QixDQUFDLFlBQVksQ0FBQyxDQUFDO0lBQ2hFLFdBQVcsQ0FBQyxRQUFRLENBQUMsVUFBVSxDQUFDLE9BQU8sRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLE1BQU0sSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDO0FBQ3pFLENBQUM7QUFHRCxTQUFTLGFBQWEsQ0FBQyxJQUFXO0lBQ2hDOzsyRUFFdUU7SUFFdkUsT0FBTyxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDO0FBQzlDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKiBTaW1wbGUgQVBJIG9uIHRvcCBvZiBFbGVjdHJvbuKAmXMgSVBDIGZyYW1ld29yaywgdGhlIGByZW5kZXJlcmAgc2lkZS5cbiAgIFByb3ZpZGVzIGZ1bmN0aW9ucyBmb3Igc2VuZGluZyBBUEkgcmVxdWVzdHMgdG8gZmV0Y2gvc3RvcmUgZGF0YSBhbmQvb3Igb3BlbiB3aW5kb3cuICovXG5cbmltcG9ydCB7IGlwY1JlbmRlcmVyIH0gZnJvbSAnZWxlY3Ryb24nO1xuXG5pbXBvcnQgeyBBUElSZXNwb25zZSwgcmV2aXZlSnNvblZhbHVlLCBnZXRFdmVudE5hbWVzRm9yRW5kcG9pbnQsIGdldEV2ZW50TmFtZXNGb3JXaW5kb3dFbmRwb2ludCB9IGZyb20gJy4vdXRpbHMnO1xuXG5cbi8vIFRPRE8gKCM0KTogUmVmYWN0b3IgaW50byBnZW5lcmljIG1haW4gQVBJcywgcmF0aGVyIHRoYW4gV29ya3NwYWNlLWNlbnRlcmVkXG5cblxuLy8gVE9ETzogSW1wbGVtZW50IGhvb2sgZm9yIHVzaW5nIHRpbWUgdHJhdmVsIEFQSXMgd2l0aCB1bmRvL3JlZG9cbi8vIGFuZCB0cmFuc2FjdGlvbnMgZm9yIHJhY2UgY29uZGl0aW9uIGF2b2lkYW5jZS5cblxuXG5jbGFzcyBSZXF1ZXN0RmFpbHVyZSBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IocHVibGljIGVycm9yTWVzc2FnZUxpc3Q6IHN0cmluZ1tdKSB7XG4gICAgc3VwZXIoZXJyb3JNZXNzYWdlTGlzdC5qb2luKCc7ICcpKTtcbiAgICBPYmplY3Quc2V0UHJvdG90eXBlT2YodGhpcywgbmV3LnRhcmdldC5wcm90b3R5cGUpO1xuICB9XG59XG5cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlcXVlc3Q8VD4oZW5kcG9pbnROYW1lOiBzdHJpbmcsIC4uLmFyZ3M6IGFueVtdKTogUHJvbWlzZTxUPiB7XG4gIC8vIFRPRE86IFRoaXMgZG9lcyBub3QgaGFuZGxlIGEgdGltZW91dCwgc28gaWYgYG1haW5gIGVuZHBvaW50IGlzIG1pc2NvbmZpZ3VyZWQgYW5kIG5ldmVyIHJlc3BvbmRzXG4gIC8vIHRoZSBoYW5kbGVyIHdpbGwgcmVtYWluIGxpc3RlbmluZ1xuXG4gIGNvbnN0IGV2ZW50TmFtZXMgPSBnZXRFdmVudE5hbWVzRm9yRW5kcG9pbnQoZW5kcG9pbnROYW1lKTtcbiAgcmV0dXJuIG5ldyBQcm9taXNlPFQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICBmdW5jdGlvbiBoYW5kbGVSZXNwKGV2dDogYW55LCByYXdEYXRhOiBzdHJpbmcpIHtcbiAgICAgIGlwY1JlbmRlcmVyLnJlbW92ZUxpc3RlbmVyKGV2ZW50TmFtZXMucmVzcG9uc2UsIGhhbmRsZVJlc3ApO1xuICAgICAgY29uc3QgZGF0YTogYW55ID0gSlNPTi5wYXJzZShyYXdEYXRhLCByZXZpdmVKc29uVmFsdWUpO1xuXG4gICAgICBpZiAoZGF0YS5lcnJvcnMgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAvLyBNZWFucyBtYWluIGlzIHVzaW5nIGxpc3RlbigpLCBuZXcgQVBJXG4gICAgICAgIGNvbnN0IHJlc3A6IEFQSVJlc3BvbnNlPFQ+ID0gZGF0YTtcblxuICAgICAgICBpZiAocmVzcC5yZXN1bHQgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIGlmIChyZXNwLmVycm9ycy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICByZWplY3QobmV3IFJlcXVlc3RGYWlsdXJlKHJlc3AuZXJyb3JzKSk7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHJlamVjdChuZXcgUmVxdWVzdEZhaWx1cmUoW1wiVW5rbm93biBlcnJvclwiXSkpO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICByZXNvbHZlKGRhdGEucmVzdWx0KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIE1lYW5zIG1haW4gaXMgdXNpbmcgbWFrZUVuZHBvaW50KCksIGxlZ2FjeSBBUElcbiAgICAgICAgY29uc3QgcmVzcDogVCA9IGRhdGE7XG4gICAgICAgIHJlc29sdmUocmVzcCk7XG4gICAgICB9XG4gICAgfVxuICAgIGlwY1JlbmRlcmVyLm9uKGV2ZW50TmFtZXMucmVzcG9uc2UsIGhhbmRsZVJlc3ApO1xuICAgIGlwY1JlbmRlcmVyLnNlbmQoZXZlbnROYW1lcy5yZXF1ZXN0LCAuLi5zZXJpYWxpemVBcmdzKGFyZ3MpKTtcbiAgfSk7XG59XG5cblxuZXhwb3J0IGZ1bmN0aW9uIG9wZW5XaW5kb3coZW5kcG9pbnROYW1lOiBzdHJpbmcsIHBhcmFtcz86IGFueSk6IHZvaWQge1xuICBjb25zdCBldmVudE5hbWVzID0gZ2V0RXZlbnROYW1lc0ZvcldpbmRvd0VuZHBvaW50KGVuZHBvaW50TmFtZSk7XG4gIGlwY1JlbmRlcmVyLnNlbmRTeW5jKGV2ZW50TmFtZXMucmVxdWVzdCwgSlNPTi5zdHJpbmdpZnkocGFyYW1zIHx8IHt9KSk7XG59XG5cblxuZnVuY3Rpb24gc2VyaWFsaXplQXJncyhhcmdzOiBhbnlbXSk6IHN0cmluZ1tdIHtcbiAgLyogSGVscGVyIGZ1bmN0aW9uIHRoYXQgc3RyaW5naWZpZXMgYW4gYXJyYXkgb2Ygb2JqZWN0cyB3aXRoIEpTT04uXG4gICAgIFdlIGRvbuKAmXQgbmVjZXNzYXJpbHkgd2FudCBFbGVjdHJvbiB0byBoYW5kbGUgdGhhdCBmb3IgdXMsXG4gICAgIGJlY2F1c2Ugd2UgbWlnaHQgd2FudCBjdXN0b20gcGFyc2luZyBmb3IgZS5nLiB0aW1lc3RhbXBzIGluIEpTT04uICovXG5cbiAgcmV0dXJuIGFyZ3MubWFwKHZhbCA9PiBKU09OLnN0cmluZ2lmeSh2YWwpKTtcbn1cbiJdfQ==