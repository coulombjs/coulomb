import * as log from 'electron-log';
import React from 'react';
import * as ReactDOM from 'react-dom';
import { NonIdealState, Spinner } from '@blueprintjs/core';
import '!style-loader!css-loader!@blueprintjs/datetime/lib/css/blueprint-datetime.css';
import '!style-loader!css-loader!@blueprintjs/core/lib/css/blueprint.css';
import '!style-loader!css-loader!./normalize.css';
import '!style-loader!css-loader!./renderer.css';
import { useIPCEvent, useIPCValue, callIPC } from '../ipc/renderer';
// Render application screen in a new window
// with given top-level window UI component and (if applicable) any parameters
// wrapped in configured context provider components.
export const renderApp = (config) => {
    // electron-webpack guarantees presence of #app in index.html it bundles
    const appRoot = document.getElementById('app');
    // Add a class allowing platform-specific styling
    document.documentElement.classList.add(`platform--${process.platform}`);
    // Get all params passed to the window via GET query string
    const searchParams = new URLSearchParams(window.location.search);
    // Prepare getter for requested top-level window UI React component
    const componentId = searchParams.get('c');
    const componentImporter = componentId ? config.windowComponents[componentId] : null;
    log.debug(`Requested window component ${componentId}`);
    const openObjectEditor = async (dataTypeID, objectID, params) => {
        if (config.objectEditorWindows === undefined) {
            throw new Error("No object editor windows configured");
        }
        const windowID = config.objectEditorWindows[dataTypeID];
        const windowOptions = config.app.windows[windowID];
        if (windowID === undefined) {
            throw new Error("Object editor window not configured");
        }
        await callIPC('open-predefined-window', {
            id: windowID,
            params: {
                componentParams: `objectID=${objectID}&${params || ''}`,
                title: `${windowOptions.openerParams.title} (${objectID})`,
            },
        });
    };
    const openPredefinedWindow = async (windowID, params) => {
        await callIPC('open-predefined-window', {
            id: windowID,
            params: params || {},
        });
    };
    // TODO: Refactor out hook initialization
    const useIDs = (modelName, query) => {
        /* Queries data for specified model, listens for update events and updates the dataset. */
        const trackedIDs = useIPCValue(`model-${modelName}-list-ids`, { ids: [] }, query);
        useIPCEvent(`model-${modelName}-objects-changed`, function ({ ids }) {
            trackedIDs.refresh();
            // See TODO at useMany().
            //const stringIDs = trackedIDs.value.ids.map(id => `${id}`);
            //const shouldRefresh = ids !== undefined
            //  ? ids.filter(id => stringIDs.includes(id)).length > 0
            //  : true;
            //if (shouldRefresh) {
            //  trackedIDs.refresh();
            //}
        });
        return { ids: trackedIDs.value.ids, isUpdating: trackedIDs.isUpdating };
    };
    const useCount = (modelName, query) => {
        /* Queries data for specified model, listens for update events and updates the dataset. */
        const count = useIPCValue(`model-${modelName}-count`, { count: 0 }, query);
        useIPCEvent(`model-${modelName}-objects-changed`, function () {
            count.refresh();
        });
        return { count: count.value.count, isUpdating: count.isUpdating };
    };
    const useMany = (modelName, query) => {
        /* Queries data for specified model, listens for update events and updates the dataset. */
        const objects = useIPCValue(`model-${modelName}-read-all`, {}, query);
        useIPCEvent(`model-${modelName}-objects-changed`, function ({ ids }) {
            // TODO: generic query refresh IPC event/hook?
            objects.refresh();
            // TODO: Only refresh when needed.
            // Below code works, except it won’t trigger refresh
            // when new objects are added:
            // log.silly("C/renderApp: Changed object IDs", ids);
            // const trackedObjectIDs = Object.keys(objects.value);
            // const shouldRefresh = ids === undefined || ids.filter(id => trackedObjectIDs.includes(id)).length > 0;
            // if (shouldRefresh) {
            //   log.debug("C/renderApp: Refreshing objects", ids);
            //   objects.refresh();
            // } else {
            //   log.debug("C/renderApp: Will not refresh objects", ids);
            // }
        });
        return { objects: objects.value, isUpdating: objects.isUpdating };
    };
    const useOne = (modelName, objectID) => {
        /* Queries data for specified model, listens for update events and updates the dataset. */
        const object = useIPCValue(`model-${modelName}-read-one`, { object: null }, { objectID });
        useIPCEvent(`model-${modelName}-objects-changed`, function ({ ids }) {
            const shouldRefresh = ids === undefined || ids.includes(`${objectID}`);
            if (shouldRefresh) {
                object.refresh();
            }
        });
        return {
            object: object.value.object,
            isUpdating: object.isUpdating,
            refresh: () => object.refresh(),
        };
    };
    // Fetch top-level UI component class and render it.
    if (componentImporter) {
        (async () => {
            // Show loading indicator while components are being resolved
            ReactDOM.render(React.createElement(Spinner, { className: "initial-spinner" }), appRoot);
            const ctxProviderConfig = config.contextProviders || [];
            // Get props prescribed for each context provider component
            var ctxProviderProps = ctxProviderConfig.map(item => item.getProps(config));
            log.silly(`C/renderApp: Resolving components`, componentImporter, ctxProviderConfig);
            // Resolve (import) components in parallel, first UI and then context providers
            const promisedComponents = await Promise.all([
                componentImporter(),
                ...ctxProviderConfig.map(async (ctxp) => await ctxp.cls()),
            ]);
            log.silly(`C/renderApp: Resolved components`, promisedComponents);
            // Break down components into top-level window UI & context providers
            const TopWindowComponent = promisedComponents[0].default;
            var ctxProviderComponents = promisedComponents.
                slice(1, promisedComponents.length).
                map(item => item.default);
            // Reorder context providers so that top-most is the most basic
            ctxProviderComponents.reverse();
            ctxProviderProps.reverse();
            // Write out top-level window component JSX
            var appMarkup = React.createElement(TopWindowComponent, { query: searchParams });
            log.debug(`C/renderApp: Got context provider components`, ctxProviderComponents);
            // Wrap the JSX into context provider components
            for (const [idx, ContextProvider] of ctxProviderComponents.entries()) {
                log.verbose(`C/renderApp: Initializing context provider #${idx}`, ctxProviderComponents[idx], ctxProviderProps[idx]);
                appMarkup = (React.createElement(ContextProvider, Object.assign({}, ctxProviderProps[idx]), appMarkup));
            }
            log.debug("C/renderApp: Rendering");
            // Render the JSX
            ReactDOM.render(appMarkup, appRoot);
        })();
        return {
            root: appRoot,
            useCount,
            useIDs,
            useMany,
            useOne,
            openPredefinedWindow,
            openObjectEditor,
        };
    }
    else {
        // Component specified in GET params is not present in app renderer config.
        // TODO: Handle misconfigured React context providers and failed import at runtime
        ReactDOM.render(React.createElement(NonIdealState, { icon: "error", title: "Unknown component requested" }), appRoot);
        log.error("Unknown component requested", componentId);
        throw new Error("Unknown component requested");
    }
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVuZGVyZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zcmMvYXBwL3JlbmRlcmVyLnRzeCJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEtBQUssR0FBRyxNQUFNLGNBQWMsQ0FBQztBQUNwQyxPQUFPLEtBQUssTUFBTSxPQUFPLENBQUM7QUFDMUIsT0FBTyxLQUFLLFFBQVEsTUFBTSxXQUFXLENBQUM7QUFFdEMsT0FBTyxFQUFFLGFBQWEsRUFBRSxPQUFPLEVBQUUsTUFBTSxtQkFBbUIsQ0FBQztBQU8zRCxPQUFPLCtFQUErRSxDQUFDO0FBQ3ZGLE9BQU8sa0VBQWtFLENBQUM7QUFDMUUsT0FBTywwQ0FBMEMsQ0FBQztBQUNsRCxPQUFPLHlDQUF5QyxDQUFDO0FBQ2pELE9BQU8sRUFBRSxXQUFXLEVBQUUsV0FBVyxFQUFFLE9BQU8sRUFBRSxNQUFNLGlCQUFpQixDQUFDO0FBc0RwRSw0Q0FBNEM7QUFDNUMsOEVBQThFO0FBQzlFLHFEQUFxRDtBQUNyRCxNQUFNLENBQUMsTUFBTSxTQUFTLEdBQUcsQ0FBbUQsTUFBUyxFQUFrQixFQUFFO0lBRXZHLHdFQUF3RTtJQUN4RSxNQUFNLE9BQU8sR0FBRyxRQUFRLENBQUMsY0FBYyxDQUFDLEtBQUssQ0FBZ0IsQ0FBQztJQUU5RCxpREFBaUQ7SUFDakQsUUFBUSxDQUFDLGVBQWUsQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLGFBQWEsT0FBTyxDQUFDLFFBQVEsRUFBRSxDQUFDLENBQUM7SUFFeEUsMkRBQTJEO0lBQzNELE1BQU0sWUFBWSxHQUFHLElBQUksZUFBZSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsTUFBTSxDQUFDLENBQUM7SUFFakUsbUVBQW1FO0lBQ25FLE1BQU0sV0FBVyxHQUFHLFlBQVksQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUM7SUFDMUMsTUFBTSxpQkFBaUIsR0FBRyxXQUFXLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxnQkFBZ0IsQ0FBQyxX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QUcsQ0FBQyxLQUFLLENBQUMsNkJBQTZCLEVBQUUsV0FBVyxDQUFDLENBQUM7UUFDdEQsTUFBTSxJQUFJLEtBQUssQ0FBQyw2QkFBNkIsQ0FBQyxDQUFDO0tBQ2hEO0FBRUgsQ0FBQyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgbG9nIGZyb20gJ2VsZWN0cm9uLWxvZyc7XG5pbXBvcnQgUmVhY3QgZnJvbSAncmVhY3QnO1xuaW1wb3J0ICogYXMgUmVhY3RET00gZnJvbSAncmVhY3QtZG9tJztcblxuaW1wb3J0IHsgTm9uSWRlYWxTdGF0ZSwgU3Bpbm5lciB9IGZyb20gJ0BibHVlcHJpbnRqcy9jb3JlJztcblxuaW1wb3J0IHsgQXBwQ29uZmlnIH0gZnJvbSAnLi4vY29uZmlnL2FwcCc7XG5pbXBvcnQgeyBSZW5kZXJlckNvbmZpZyB9IGZyb20gJy4uL2NvbmZpZy9yZW5kZXJlcic7XG5pbXBvcnQgeyBNb2RlbCwgQW55SURUeXBlIH0gZnJvbSAnLi4vZGIvbW9kZWxzJztcbmltcG9ydCB7IEluZGV4IH0gZnJvbSAnLi4vZGIvcXVlcnknO1xuXG5pbXBvcnQgJyFzdHlsZS1sb2FkZXIhY3NzLWxvYWRlciFAYmx1ZXByaW50anMvZGF0ZXRpbWUvbGliL2Nzcy9ibHVlcHJpbnQtZGF0ZXRpbWUuY3NzJztcbmltcG9ydCAnIXN0eWxlLWxvYWRlciFjc3MtbG9hZGVyIUBibHVlcHJpbnRqcy9jb3JlL2xpYi9jc3MvYmx1ZXByaW50LmNzcyc7XG5pbXBvcnQgJyFzdHlsZS1sb2FkZXIhY3NzLWxvYWRlciEuL25vcm1hbGl6ZS5jc3MnO1xuaW1wb3J0ICchc3R5bGUtbG9hZGVyIWNzcy1sb2FkZXIhLi9yZW5kZXJlci5jc3MnO1xuaW1wb3J0IHsgdXNlSVBDRXZlbnQsIHVzZUlQQ1ZhbHVlLCBjYWxsSVBDIH0gZnJvbSAnLi4vaXBjL3JlbmRlcmVyJztcblxuXG5pbnRlcmZhY2UgQXBwUmVuZGVyZXI8QyBleHRlbmRzIFJlbmRlcmVyQ29uZmlnPGFueT4+IHtcbiAgcm9vdDogSFRNTEVsZW1lbnRcbiAgdXNlQ291bnQ6IFVzZUNvdW50SG9vazxDPlxuICB1c2VJRHM6IFVzZUlEc0hvb2s8Qz5cbiAgdXNlTWFueTogVXNlTWFueUhvb2s8Qz5cbiAgdXNlT25lOiBVc2VPbmVIb29rPEM+XG5cbiAgb3BlblByZWRlZmluZWRXaW5kb3c6XG4gICAgKHdpbmRvd0lEOiBrZXlvZiBDW1wiYXBwXCJdW1wid2luZG93c1wiXSwgcGFyYW1zPzogb2JqZWN0KSA9PiBQcm9taXNlPHZvaWQ+XG5cbiAgb3Blbk9iamVjdEVkaXRvcjpcbiAgICAob2JqZWN0VHlwZUlEOiBrZXlvZiBDW1wiYXBwXCJdW1wiZGF0YVwiXSwgb2JqZWN0SUQ6IGFueSwgcGFyYW1zPzogc3RyaW5nKSA9PiBQcm9taXNlPHZvaWQ+XG59XG5cblxuLy8gRGF0YSBvcGVyYXRpb24gaG9vayBpbnRlcmZhY2VzXG5cbmludGVyZmFjZSBVc2VNYW55SG9va1Jlc3VsdDxNIGV4dGVuZHMgTW9kZWw+IHtcbiAgb2JqZWN0czogSW5kZXg8TT5cbiAgaXNVcGRhdGluZzogYm9vbGVhblxufVxudHlwZSBVc2VNYW55SG9vazxDIGV4dGVuZHMgUmVuZGVyZXJDb25maWc8YW55Pj4gPVxuPE0gZXh0ZW5kcyBNb2RlbCwgUSBleHRlbmRzIG9iamVjdCA9IHt9PlxuKG1vZGVsTmFtZToga2V5b2YgQ1tcImFwcFwiXVtcImRhdGFcIl0sIHF1ZXJ5PzogUSkgPT4gVXNlTWFueUhvb2tSZXN1bHQ8TT5cblxuaW50ZXJmYWNlIFVzZUlEc0hvb2tSZXN1bHQ8SURUeXBlIGV4dGVuZHMgQW55SURUeXBlPiB7XG4gIGlkczogSURUeXBlW11cbiAgaXNVcGRhdGluZzogYm9vbGVhblxufVxudHlwZSBVc2VJRHNIb29rPEMgZXh0ZW5kcyBSZW5kZXJlckNvbmZpZzxhbnk+PiA9XG48SURUeXBlIGV4dGVuZHMgQW55SURUeXBlLCBRIGV4dGVuZHMgb2JqZWN0ID0ge30+XG4obW9kZWxOYW1lOiBrZXlvZiBDW1wiYXBwXCJdW1wiZGF0YVwiXSwgcXVlcnk/OiBRKSA9PiBVc2VJRHNIb29rUmVzdWx0PElEVHlwZT5cblxuaW50ZXJmYWNlIFVzZUNvdW50SG9va1Jlc3VsdCB7XG4gIGNvdW50OiBudW1iZXJcbiAgaXNVcGRhdGluZzogYm9vbGVhblxufVxudHlwZSBVc2VDb3VudEhvb2s8QyBleHRlbmRzIFJlbmRlcmVyQ29uZmlnPGFueT4+ID1cbjxRIGV4dGVuZHMgb2JqZWN0PlxuKG1vZGVsTmFtZToga2V5b2YgQ1tcImFwcFwiXVtcImRhdGFcIl0sIHF1ZXJ5OiBRKSA9PiBVc2VDb3VudEhvb2tSZXN1bHRcblxuaW50ZXJmYWNlIFVzZU9uZUhvb2tSZXN1bHQ8TSBleHRlbmRzIE1vZGVsPiB7XG4gIG9iamVjdDogTSB8IG51bGxcbiAgaXNVcGRhdGluZzogYm9vbGVhblxuICByZWZyZXNoOiAoKSA9PiB2b2lkXG59XG50eXBlIFVzZU9uZUhvb2s8QyBleHRlbmRzIFJlbmRlcmVyQ29uZmlnPGFueT4+ID1cbjxNIGV4dGVuZHMgTW9kZWwsIElEVHlwZSBleHRlbmRzIEFueUlEVHlwZT5cbihtb2RlbE5hbWU6IGtleW9mIENbXCJhcHBcIl1bXCJkYXRhXCJdLCBvYmplY3RJRDogSURUeXBlIHwgbnVsbCkgPT4gVXNlT25lSG9va1Jlc3VsdDxNPlxuXG5cbi8vIFJlbmRlciBhcHBsaWNhdGlvbiBzY3JlZW4gaW4gYSBuZXcgd2luZG93XG4vLyB3aXRoIGdpdmVuIHRvcC1sZXZlbCB3aW5kb3cgVUkgY29tcG9uZW50IGFuZCAoaWYgYXBwbGljYWJsZSkgYW55IHBhcmFtZXRlcnNcbi8vIHdyYXBwZWQgaW4gY29uZmlndXJlZCBjb250ZXh0IHByb3ZpZGVyIGNvbXBvbmVudHMuXG5leHBvcnQgY29uc3QgcmVuZGVyQXBwID0gPEEgZXh0ZW5kcyBBcHBDb25maWcsIEMgZXh0ZW5kcyBSZW5kZXJlckNvbmZpZzxBPj4oY29uZmlnOiBDKTogQXBwUmVuZGVyZXI8Qz4gPT4ge1xuXG4gIC8vIGVsZWN0cm9uLXdlYnBhY2sgZ3VhcmFudGVlcyBwcmVzZW5jZSBvZiAjYXBwIGluIGluZGV4Lmh0bWwgaXQgYnVuZGxlc1xuICBjb25zdCBhcHBSb290ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2FwcCcpIGFzIEhUTUxFbGVtZW50O1xuXG4gIC8vIEFkZCBhIGNsYXNzIGFsbG93aW5nIHBsYXRmb3JtLXNwZWNpZmljIHN0eWxpbmdcbiAgZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LmNsYXNzTGlzdC5hZGQoYHBsYXRmb3JtLS0ke3Byb2Nlc3MucGxhdGZvcm19YCk7XG5cbiAgLy8gR2V0IGFsbCBwYXJhbXMgcGFzc2VkIHRvIHRoZSB3aW5kb3cgdmlhIEdFVCBxdWVyeSBzdHJpbmdcbiAgY29uc3Qgc2VhcmNoUGFyYW1zID0gbmV3IFVSTFNlYXJjaFBhcmFtcyh3aW5kb3cubG9jYXRpb24uc2VhcmNoKTtcblxuICAvLyBQcmVwYXJlIGdldHRlciBmb3IgcmVxdWVzdGVkIHRvcC1sZXZlbCB3aW5kb3cgVUkgUmVhY3QgY29tcG9uZW50XG4gIGNvbnN0IGNvbXBvbmVudElkID0gc2VhcmNoUGFyYW1zLmdldCgnYycpO1xuICBjb25zdCBjb21wb25lbnRJbXBvcnRlciA9IGNvbXBvbmVudElkID8gY29uZmlnLndpbmRvd0NvbXBvbmVudHNbY29tcG9uZW50SWRdIDogbnVsbDtcblxuICBsb2cuZGVidWcoYFJlcXVlc3RlZCB3aW5kb3cgY29tcG9uZW50ICR7Y29tcG9uZW50SWR9YCk7XG5cblxuICBjb25zdCBvcGVuT2JqZWN0RWRpdG9yID0gYXN5bmMgKGRhdGFUeXBlSUQ6IGtleW9mIENbXCJhcHBcIl1bXCJkYXRhXCJdLCBvYmplY3RJRDogYW55LCBwYXJhbXM/OiBzdHJpbmcpID0+IHtcbiAgICBpZiAoY29uZmlnLm9iamVjdEVkaXRvcldpbmRvd3MgPT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiTm8gb2JqZWN0IGVkaXRvciB3aW5kb3dzIGNvbmZpZ3VyZWRcIik7XG4gICAgfVxuICAgIGNvbnN0IHdpbmRvd0lEID0gY29uZmlnLm9iamVjdEVkaXRvcldpbmRvd3NbZGF0YVR5cGVJRF07XG4gICAgY29uc3Qgd2luZG93T3B0aW9ucyA9IGNvbmZpZy5hcHAud2luZG93c1t3aW5kb3dJRCBhcyBrZXlvZiB0eXBlb2YgY29uZmlnLmFwcC53aW5kb3dzXTtcbiAgICBpZiAod2luZG93SUQgPT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiT2JqZWN0IGVkaXRvciB3aW5kb3cgbm90IGNvbmZpZ3VyZWRcIik7XG4gICAgfVxuICAgIGF3YWl0IGNhbGxJUEMoJ29wZW4tcHJlZGVmaW5lZC13aW5kb3cnLCB7XG4gICAgICBpZDogd2luZG93SUQsXG4gICAgICBwYXJhbXM6IHtcbiAgICAgICAgY29tcG9uZW50UGFyYW1zOiBgb2JqZWN0SUQ9JHtvYmplY3RJRH0mJHtwYXJhbXMgfHwgJyd9YCxcbiAgICAgICAgdGl0bGU6IGAke3dpbmRvd09wdGlvbnMub3BlbmVyUGFyYW1zLnRpdGxlfSAoJHtvYmplY3RJRH0pYCxcbiAgICAgIH0sXG4gICAgfSk7XG4gIH07XG5cbiAgY29uc3Qgb3BlblByZWRlZmluZWRXaW5kb3cgPSBhc3luYyAod2luZG93SUQ6IGtleW9mIHR5cGVvZiBjb25maWdbXCJhcHBcIl1bXCJ3aW5kb3dzXCJdLCBwYXJhbXM/OiBvYmplY3QpID0+IHtcbiAgICBhd2FpdCBjYWxsSVBDKCdvcGVuLXByZWRlZmluZWQtd2luZG93Jywge1xuICAgICAgaWQ6IHdpbmRvd0lELFxuICAgICAgcGFyYW1zOiBwYXJhbXMgfHwge30sXG4gICAgfSk7XG4gIH07XG5cblxuICAvLyBUT0RPOiBSZWZhY3RvciBvdXQgaG9vayBpbml0aWFsaXphdGlvblxuXG4gIGNvbnN0IHVzZUlEczogVXNlSURzSG9vazxDPiA9XG4gIDxJRFR5cGUgZXh0ZW5kcyBBbnlJRFR5cGUsIFEgZXh0ZW5kcyBvYmplY3QgPSB7fT5cbiAgKG1vZGVsTmFtZToga2V5b2YgQVtcImRhdGFcIl0sIHF1ZXJ5PzogUSkgPT4ge1xuICAgIC8qIFF1ZXJpZXMgZGF0YSBmb3Igc3BlY2lmaWVkIG1vZGVsLCBsaXN0ZW5zIGZvciB1cGRhdGUgZXZlbnRzIGFuZCB1cGRhdGVzIHRoZSBkYXRhc2V0LiAqL1xuXG4gICAgY29uc3QgdHJhY2tlZElEcyA9IHVzZUlQQ1ZhbHVlPFEsIHsgaWRzOiBJRFR5cGVbXSB9PlxuICAgIChgbW9kZWwtJHttb2RlbE5hbWV9LWxpc3QtaWRzYCwgeyBpZHM6IFtdIH0sIHF1ZXJ5KTtcblxuICAgIHVzZUlQQ0V2ZW50PHsgaWRzPzogc3RyaW5nW10gfT4oYG1vZGVsLSR7bW9kZWxOYW1lfS1vYmplY3RzLWNoYW5nZWRgLCBmdW5jdGlvbiAoeyBpZHMgfSkge1xuICAgICAgdHJhY2tlZElEcy5yZWZyZXNoKCk7XG5cbiAgICAgIC8vIFNlZSBUT0RPIGF0IHVzZU1hbnkoKS5cbiAgICAgIC8vY29uc3Qgc3RyaW5nSURzID0gdHJhY2tlZElEcy52YWx1ZS5pZHMubWFwKGlkID0+IGAke2lkfWApO1xuICAgICAgLy9jb25zdCBzaG91bGRSZWZyZXNoID0gaWRzICE9PSB1bmRlZmluZWRcbiAgICAgIC8vICA/IGlkcy5maWx0ZXIoaWQgPT4gc3RyaW5nSURzLmluY2x1ZGVzKGlkKSkubGVuZ3RoID4gMFxuICAgICAgLy8gIDogdHJ1ZTtcbiAgICAgIC8vaWYgKHNob3VsZFJlZnJlc2gpIHtcbiAgICAgIC8vICB0cmFja2VkSURzLnJlZnJlc2goKTtcbiAgICAgIC8vfVxuICAgIH0pO1xuXG4gICAgcmV0dXJuIHsgaWRzOiB0cmFja2VkSURzLnZhbHVlLmlkcywgaXNVcGRhdGluZzogdHJhY2tlZElEcy5pc1VwZGF0aW5nIH07XG4gIH1cblxuICBjb25zdCB1c2VDb3VudDogVXNlQ291bnRIb29rPEM+ID1cbiAgPFEgZXh0ZW5kcyBvYmplY3QgPSBhbnk+XG4gIChtb2RlbE5hbWU6IGtleW9mIEFbXCJkYXRhXCJdLCBxdWVyeT86IFEpID0+IHtcbiAgICAvKiBRdWVyaWVzIGRhdGEgZm9yIHNwZWNpZmllZCBtb2RlbCwgbGlzdGVucyBmb3IgdXBkYXRlIGV2ZW50cyBhbmQgdXBkYXRlcyB0aGUgZGF0YXNldC4gKi9cblxuICAgIGNvbnN0IGNvdW50ID0gdXNlSVBDVmFsdWU8USwgeyBjb3VudDogbnVtYmVyIH0+XG4gICAgKGBtb2RlbC0ke21vZGVsTmFtZX0tY291bnRgLCB7IGNvdW50OiAwIH0sIHF1ZXJ5KTtcblxuICAgIHVzZUlQQ0V2ZW50PHsgaWRzPzogc3RyaW5nW10gfT4oYG1vZGVsLSR7bW9kZWxOYW1lfS1vYmplY3RzLWNoYW5nZWRgLCBmdW5jdGlvbiAoKSB7XG4gICAgICBjb3VudC5yZWZyZXNoKCk7XG4gICAgfSk7XG5cbiAgICByZXR1cm4geyBjb3VudDogY291bnQudmFsdWUuY291bnQsIGlzVXBkYXRpbmc6IGNvdW50LmlzVXBkYXRpbmcgfTtcbiAgfVxuXG4gIGNvbnN0IHVzZU1hbnk6IFVzZU1hbnlIb29rPEM+ID1cbiAgPE0gZXh0ZW5kcyBNb2RlbCwgUSBleHRlbmRzIG9iamVjdCA9IHt9PlxuICAobW9kZWxOYW1lOiBrZXlvZiBBW1wiZGF0YVwiXSwgcXVlcnk/OiBRKSA9PiB7XG4gICAgLyogUXVlcmllcyBkYXRhIGZvciBzcGVjaWZpZWQgbW9kZWwsIGxpc3RlbnMgZm9yIHVwZGF0ZSBldmVudHMgYW5kIHVwZGF0ZXMgdGhlIGRhdGFzZXQuICovXG5cbiAgICBjb25zdCBvYmplY3RzID0gdXNlSVBDVmFsdWU8USwgSW5kZXg8TT4+XG4gICAgKGBtb2RlbC0ke21vZGVsTmFtZX0tcmVhZC1hbGxgLCB7fSwgcXVlcnkpO1xuXG4gICAgdXNlSVBDRXZlbnQ8eyBpZHM/OiBzdHJpbmdbXSB9PihgbW9kZWwtJHttb2RlbE5hbWV9LW9iamVjdHMtY2hhbmdlZGAsIGZ1bmN0aW9uICh7IGlkcyB9KSB7XG4gICAgICAvLyBUT0RPOiBnZW5lcmljIHF1ZXJ5IHJlZnJlc2ggSVBDIGV2ZW50L2hvb2s/XG5cbiAgICAgIG9iamVjdHMucmVmcmVzaCgpO1xuXG4gICAgICAvLyBUT0RPOiBPbmx5IHJlZnJlc2ggd2hlbiBuZWVkZWQuXG4gICAgICAvLyBCZWxvdyBjb2RlIHdvcmtzLCBleGNlcHQgaXQgd29u4oCZdCB0cmlnZ2VyIHJlZnJlc2hcbiAgICAgIC8vIHdoZW4gbmV3IG9iamVjdHMgYXJlIGFkZGVkOlxuICAgICAgLy8gbG9nLnNpbGx5KFwiQy9yZW5kZXJBcHA6IENoYW5nZWQgb2JqZWN0IElEc1wiLCBpZHMpO1xuICAgICAgLy8gY29uc3QgdHJhY2tlZE9iamVjdElEcyA9IE9iamVjdC5rZXlzKG9iamVjdHMudmFsdWUpO1xuICAgICAgLy8gY29uc3Qgc2hvdWxkUmVmcmVzaCA9IGlkcyA9PT0gdW5kZWZpbmVkIHx8IGlkcy5maWx0ZXIoaWQgPT4gdHJhY2tlZE9iamVjdElEcy5pbmNsdWRlcyhpZCkpLmxlbmd0aCA+IDA7XG4gICAgICAvLyBpZiAoc2hvdWxkUmVmcmVzaCkge1xuICAgICAgLy8gICBsb2cuZGVidWcoXCJDL3JlbmRlckFwcDogUmVmcmVzaGluZyBvYmplY3RzXCIsIGlkcyk7XG4gICAgICAvLyAgIG9iamVjdHMucmVmcmVzaCgpO1xuICAgICAgLy8gfSBlbHNlIHtcbiAgICAgIC8vICAgbG9nLmRlYnVnKFwiQy9yZW5kZXJBcHA6IFdpbGwgbm90IHJlZnJlc2ggb2JqZWN0c1wiLCBpZHMpO1xuICAgICAgLy8gfVxuICAgIH0pO1xuXG4gICAgcmV0dXJuIHsgb2JqZWN0czogb2JqZWN0cy52YWx1ZSwgaXNVcGRhdGluZzogb2JqZWN0cy5pc1VwZGF0aW5nIH07XG4gIH1cblxuICBjb25zdCB1c2VPbmU6IFVzZU9uZUhvb2s8Qz4gPVxuICA8TSBleHRlbmRzIE1vZGVsLCBJRFR5cGUgZXh0ZW5kcyBBbnlJRFR5cGU+XG4gIChtb2RlbE5hbWU6IGtleW9mIEFbXCJkYXRhXCJdLCBvYmplY3RJRDogSURUeXBlIHwgbnVsbCkgPT4ge1xuICAgIC8qIFF1ZXJpZXMgZGF0YSBmb3Igc3BlY2lmaWVkIG1vZGVsLCBsaXN0ZW5zIGZvciB1cGRhdGUgZXZlbnRzIGFuZCB1cGRhdGVzIHRoZSBkYXRhc2V0LiAqL1xuXG4gICAgY29uc3Qgb2JqZWN0ID0gdXNlSVBDVmFsdWU8eyBvYmplY3RJRDogSURUeXBlIHwgbnVsbCB9LCB7IG9iamVjdDogTSB8IG51bGwgfT5cbiAgICAoYG1vZGVsLSR7bW9kZWxOYW1lfS1yZWFkLW9uZWAsIHsgb2JqZWN0OiBudWxsIGFzIE0gfCBudWxsIH0sIHsgb2JqZWN0SUQgfSk7XG5cbiAgICB1c2VJUENFdmVudDx7IGlkcz86IHN0cmluZ1tdIH0+KGBtb2RlbC0ke21vZGVsTmFtZX0tb2JqZWN0cy1jaGFuZ2VkYCwgZnVuY3Rpb24gKHsgaWRzIH0pIHtcbiAgICAgIGNvbnN0IHNob3VsZFJlZnJlc2ggPSBpZHMgPT09IHVuZGVmaW5lZCB8fCBpZHMuaW5jbHVkZXMoYCR7b2JqZWN0SUR9YCk7XG4gICAgICBpZiAoc2hvdWxkUmVmcmVzaCkge1xuICAgICAgICBvYmplY3QucmVmcmVzaCgpO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgcmV0dXJuIHtcbiAgICAgIG9iamVjdDogb2JqZWN0LnZhbHVlLm9iamVjdCxcbiAgICAgIGlzVXBkYXRpbmc6IG9iamVjdC5pc1VwZGF0aW5nLFxuICAgICAgcmVmcmVzaDogKCkgPT4gb2JqZWN0LnJlZnJlc2goKSxcbiAgICB9O1xuICB9XG5cbiAgLy8gRmV0Y2ggdG9wLWxldmVsIFVJIGNvbXBvbmVudCBjbGFzcyBhbmQgcmVuZGVyIGl0LlxuICBpZiAoY29tcG9uZW50SW1wb3J0ZXIpIHtcbiAgICAoYXN5bmMgKCkgPT4ge1xuICAgICAgLy8gU2hvdyBsb2FkaW5nIGluZGljYXRvciB3aGlsZSBjb21wb25lbnRzIGFyZSBiZWluZyByZXNvbHZlZFxuICAgICAgUmVhY3RET00ucmVuZGVyKDxTcGlubmVyIGNsYXNzTmFtZT1cImluaXRpYWwtc3Bpbm5lclwiIC8+LCBhcHBSb290KTtcblxuICAgICAgY29uc3QgY3R4UHJvdmlkZXJDb25maWcgPSBjb25maWcuY29udGV4dFByb3ZpZGVycyB8fCBbXTtcblxuICAgICAgLy8gR2V0IHByb3BzIHByZXNjcmliZWQgZm9yIGVhY2ggY29udGV4dCBwcm92aWRlciBjb21wb25lbnRcbiAgICAgIHZhciBjdHhQcm92aWRlclByb3BzID0gY3R4UHJvdmlkZXJDb25maWcubWFwKGl0ZW0gPT4gaXRlbS5nZXRQcm9wcyhjb25maWcpKTtcblxuICAgICAgbG9nLnNpbGx5KFxuICAgICAgICBgQy9yZW5kZXJBcHA6IFJlc29sdmluZyBjb21wb25lbnRzYCxcbiAgICAgICAgY29tcG9uZW50SW1wb3J0ZXIsIGN0eFByb3ZpZGVyQ29uZmlnKTtcblxuICAgICAgLy8gUmVzb2x2ZSAoaW1wb3J0KSBjb21wb25lbnRzIGluIHBhcmFsbGVsLCBmaXJzdCBVSSBhbmQgdGhlbiBjb250ZXh0IHByb3ZpZGVyc1xuICAgICAgY29uc3QgcHJvbWlzZWRDb21wb25lbnRzOiB7IGRlZmF1bHQ6IFJlYWN0LkZDPGFueT4gfVtdID0gYXdhaXQgUHJvbWlzZS5hbGwoW1xuICAgICAgICBjb21wb25lbnRJbXBvcnRlcigpLFxuICAgICAgICAuLi5jdHhQcm92aWRlckNvbmZpZy5tYXAoYXN5bmMgKGN0eHApID0+IGF3YWl0IGN0eHAuY2xzKCkpLFxuICAgICAgXSk7XG5cbiAgICAgIGxvZy5zaWxseShcbiAgICAgICAgYEMvcmVuZGVyQXBwOiBSZXNvbHZlZCBjb21wb25lbnRzYCxcbiAgICAgICAgcHJvbWlzZWRDb21wb25lbnRzKTtcblxuICAgICAgLy8gQnJlYWsgZG93biBjb21wb25lbnRzIGludG8gdG9wLWxldmVsIHdpbmRvdyBVSSAmIGNvbnRleHQgcHJvdmlkZXJzXG4gICAgICBjb25zdCBUb3BXaW5kb3dDb21wb25lbnQgPSBwcm9taXNlZENvbXBvbmVudHNbMF0uZGVmYXVsdDtcbiAgICAgIHZhciBjdHhQcm92aWRlckNvbXBvbmVudHMgPSBwcm9taXNlZENvbXBvbmVudHMuXG4gICAgICAgIHNsaWNlKDEsIHByb21pc2VkQ29tcG9uZW50cy5sZW5ndGgpLlxuICAgICAgICBtYXAoaXRlbSA9PiBpdGVtLmRlZmF1bHQpO1xuXG4gICAgICAvLyBSZW9yZGVyIGNvbnRleHQgcHJvdmlkZXJzIHNvIHRoYXQgdG9wLW1vc3QgaXMgdGhlIG1vc3QgYmFzaWNcbiAgICAgIGN0eFByb3ZpZGVyQ29tcG9uZW50cy5yZXZlcnNlKCk7XG4gICAgICBjdHhQcm92aWRlclByb3BzLnJldmVyc2UoKTtcblxuICAgICAgLy8gV3JpdGUgb3V0IHRvcC1sZXZlbCB3aW5kb3cgY29tcG9uZW50IEpTWFxuICAgICAgdmFyIGFwcE1hcmt1cCA9IDxUb3BXaW5kb3dDb21wb25lbnQgcXVlcnk9e3NlYXJjaFBhcmFtc30gLz47XG5cbiAgICAgIGxvZy5kZWJ1ZyhcbiAgICAgICAgYEMvcmVuZGVyQXBwOiBHb3QgY29udGV4dCBwcm92aWRlciBjb21wb25lbnRzYCxcbiAgICAgICAgY3R4UHJvdmlkZXJDb21wb25lbnRzKTtcblxuICAgICAgLy8gV3JhcCB0aGUgSlNYIGludG8gY29udGV4dCBwcm92aWRlciBjb21wb25lbnRzXG4gICAgICBmb3IgKGNvbnN0IFtpZHgsIENvbnRleHRQcm92aWRlcl0gb2YgY3R4UHJvdmlkZXJDb21wb25lbnRzLmVudHJpZXMoKSkge1xuICAgICAgICBsb2cudmVyYm9zZSggIFxuICAgICAgICAgIGBDL3JlbmRlckFwcDogSW5pdGlhbGl6aW5nIGNvbnRleHQgcHJvdmlkZXIgIyR7aWR4fWAsXG4gICAgICAgICAgY3R4UHJvdmlkZXJDb21wb25lbnRzW2lkeF0sXG4gICAgICAgICAgY3R4UHJvdmlkZXJQcm9wc1tpZHhdKTtcblxuICAgICAgICBhcHBNYXJrdXAgPSAoXG4gICAgICAgICAgPENvbnRleHRQcm92aWRlciB7Li4uY3R4UHJvdmlkZXJQcm9wc1tpZHhdfT5cbiAgICAgICAgICAgIHthcHBNYXJrdXB9XG4gICAgICAgICAgPC9Db250ZXh0UHJvdmlkZXI+XG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIGxvZy5kZWJ1ZyhcIkMvcmVuZGVyQXBwOiBSZW5kZXJpbmdcIik7XG5cbiAgICAgIC8vIFJlbmRlciB0aGUgSlNYXG4gICAgICBSZWFjdERPTS5yZW5kZXIoYXBwTWFya3VwLCBhcHBSb290KTtcbiAgICB9KSgpO1xuXG4gICAgcmV0dXJuIHtcbiAgICAgIHJvb3Q6IGFwcFJvb3QsXG4gICAgICB1c2VDb3VudCxcbiAgICAgIHVzZUlEcyxcbiAgICAgIHVzZU1hbnksXG4gICAgICB1c2VPbmUsXG4gICAgICBvcGVuUHJlZGVmaW5lZFdpbmRvdyxcbiAgICAgIG9wZW5PYmplY3RFZGl0b3IsXG4gICAgfTtcblxuICB9IGVsc2Uge1xuICAgIC8vIENvbXBvbmVudCBzcGVjaWZpZWQgaW4gR0VUIHBhcmFtcyBpcyBub3QgcHJlc2VudCBpbiBhcHAgcmVuZGVyZXIgY29uZmlnLlxuICAgIC8vIFRPRE86IEhhbmRsZSBtaXNjb25maWd1cmVkIFJlYWN0IGNvbnRleHQgcHJvdmlkZXJzIGFuZCBmYWlsZWQgaW1wb3J0IGF0IHJ1bnRpbWVcbiAgICBSZWFjdERPTS5yZW5kZXIoPE5vbklkZWFsU3RhdGVcbiAgICAgIGljb249XCJlcnJvclwiXG4gICAgICB0aXRsZT1cIlVua25vd24gY29tcG9uZW50IHJlcXVlc3RlZFwiIC8+LCBhcHBSb290KTtcblxuICAgIGxvZy5lcnJvcihcIlVua25vd24gY29tcG9uZW50IHJlcXVlc3RlZFwiLCBjb21wb25lbnRJZCk7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiVW5rbm93biBjb21wb25lbnQgcmVxdWVzdGVkXCIpO1xuICB9XG5cbn07Il19