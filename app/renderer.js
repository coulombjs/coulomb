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
            console.debug("Changed", modelName, ids);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVuZGVyZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zcmMvYXBwL3JlbmRlcmVyLnRzeCJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEtBQUssR0FBRyxNQUFNLGNBQWMsQ0FBQztBQUNwQyxPQUFPLEtBQUssTUFBTSxPQUFPLENBQUM7QUFDMUIsT0FBTyxLQUFLLFFBQVEsTUFBTSxXQUFXLENBQUM7QUFFdEMsT0FBTyxFQUFFLGFBQWEsRUFBRSxPQUFPLEVBQUUsTUFBTSxtQkFBbUIsQ0FBQztBQU8zRCxPQUFPLCtFQUErRSxDQUFDO0FBQ3ZGLE9BQU8sa0VBQWtFLENBQUM7QUFDMUUsT0FBTywwQ0FBMEMsQ0FBQztBQUNsRCxPQUFPLHlDQUF5QyxDQUFDO0FBQ2pELE9BQU8sRUFBRSxXQUFXLEVBQUUsV0FBVyxFQUFFLE9BQU8sRUFBRSxNQUFNLGlCQUFpQixDQUFDO0FBc0RwRSw0Q0FBNEM7QUFDNUMsOEVBQThFO0FBQzlFLHFEQUFxRDtBQUNyRCxNQUFNLENBQUMsTUFBTSxTQUFTLEdBQUcsQ0FBbUQsTUFBUyxFQUFrQixFQUFFO0lBRXZHLHdFQUF3RTtJQUN4RSxNQUFNLE9BQU8sR0FBRyxRQUFRLENBQUMsY0FBYyxDQUFDLEtBQUssQ0FBZ0IsQ0FBQztJQUU5RCxpREFBaUQ7SUFDakQsUUFBUSxDQUFDLGVBQWUsQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLGFBQWEsT0FBTyxDQUFDLFFBQVEsRUFBRSxDQUFDLENBQUM7SUFFeEUsMkRBQTJEO0lBQzNELE1BQU0sWUFBWSxHQUFHLElBQUksZUFBZSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsTUFBTSxDQUFDLENBQUM7SUFFakUsbUVBQW1FO0lBQ25FLE1BQU0sV0FBVyxHQUFHLFlBQVksQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUM7SUFDMUMsTUFBTSxpQkFBaUIsR0FBRyxXQUFXLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxnQkFBZ0IsQ0FBQyxX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LE9BQU8sRUFDWixLQUFLLEVBQUMsNkJBQTZCLEdBQUcsRUFBRSxPQUFPLENBQUMsQ0FBQztRQUVuRCxHQUFHLENBQUMsS0FBSyxDQUFDLDZCQUE2QixFQUFFLFdBQVcsQ0FBQyxDQUFDO1FBQ3RELE1BQU0sSUFBSSxLQUFLLENBQUMsNkJBQTZCLENBQUMsQ0FBQztLQUNoRDtBQUVILENBQUMsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGxvZyBmcm9tICdlbGVjdHJvbi1sb2cnO1xuaW1wb3J0IFJlYWN0IGZyb20gJ3JlYWN0JztcbmltcG9ydCAqIGFzIFJlYWN0RE9NIGZyb20gJ3JlYWN0LWRvbSc7XG5cbmltcG9ydCB7IE5vbklkZWFsU3RhdGUsIFNwaW5uZXIgfSBmcm9tICdAYmx1ZXByaW50anMvY29yZSc7XG5cbmltcG9ydCB7IEFwcENvbmZpZyB9IGZyb20gJy4uL2NvbmZpZy9hcHAnO1xuaW1wb3J0IHsgUmVuZGVyZXJDb25maWcgfSBmcm9tICcuLi9jb25maWcvcmVuZGVyZXInO1xuaW1wb3J0IHsgTW9kZWwsIEFueUlEVHlwZSB9IGZyb20gJy4uL2RiL21vZGVscyc7XG5pbXBvcnQgeyBJbmRleCB9IGZyb20gJy4uL2RiL3F1ZXJ5JztcblxuaW1wb3J0ICchc3R5bGUtbG9hZGVyIWNzcy1sb2FkZXIhQGJsdWVwcmludGpzL2RhdGV0aW1lL2xpYi9jc3MvYmx1ZXByaW50LWRhdGV0aW1lLmNzcyc7XG5pbXBvcnQgJyFzdHlsZS1sb2FkZXIhY3NzLWxvYWRlciFAYmx1ZXByaW50anMvY29yZS9saWIvY3NzL2JsdWVwcmludC5jc3MnO1xuaW1wb3J0ICchc3R5bGUtbG9hZGVyIWNzcy1sb2FkZXIhLi9ub3JtYWxpemUuY3NzJztcbmltcG9ydCAnIXN0eWxlLWxvYWRlciFjc3MtbG9hZGVyIS4vcmVuZGVyZXIuY3NzJztcbmltcG9ydCB7IHVzZUlQQ0V2ZW50LCB1c2VJUENWYWx1ZSwgY2FsbElQQyB9IGZyb20gJy4uL2lwYy9yZW5kZXJlcic7XG5cblxuaW50ZXJmYWNlIEFwcFJlbmRlcmVyPEMgZXh0ZW5kcyBSZW5kZXJlckNvbmZpZzxhbnk+PiB7XG4gIHJvb3Q6IEhUTUxFbGVtZW50XG4gIHVzZUNvdW50OiBVc2VDb3VudEhvb2s8Qz5cbiAgdXNlSURzOiBVc2VJRHNIb29rPEM+XG4gIHVzZU1hbnk6IFVzZU1hbnlIb29rPEM+XG4gIHVzZU9uZTogVXNlT25lSG9vazxDPlxuXG4gIG9wZW5QcmVkZWZpbmVkV2luZG93OlxuICAgICh3aW5kb3dJRDoga2V5b2YgQ1tcImFwcFwiXVtcIndpbmRvd3NcIl0sIHBhcmFtcz86IG9iamVjdCkgPT4gUHJvbWlzZTx2b2lkPlxuXG4gIG9wZW5PYmplY3RFZGl0b3I6XG4gICAgKG9iamVjdFR5cGVJRDoga2V5b2YgQ1tcImFwcFwiXVtcImRhdGFcIl0sIG9iamVjdElEOiBhbnksIHBhcmFtcz86IHN0cmluZykgPT4gUHJvbWlzZTx2b2lkPlxufVxuXG5cbi8vIERhdGEgb3BlcmF0aW9uIGhvb2sgaW50ZXJmYWNlc1xuXG5pbnRlcmZhY2UgVXNlTWFueUhvb2tSZXN1bHQ8TSBleHRlbmRzIE1vZGVsPiB7XG4gIG9iamVjdHM6IEluZGV4PE0+XG4gIGlzVXBkYXRpbmc6IGJvb2xlYW5cbn1cbnR5cGUgVXNlTWFueUhvb2s8QyBleHRlbmRzIFJlbmRlcmVyQ29uZmlnPGFueT4+ID1cbjxNIGV4dGVuZHMgTW9kZWwsIFEgZXh0ZW5kcyBvYmplY3QgPSB7fT5cbihtb2RlbE5hbWU6IGtleW9mIENbXCJhcHBcIl1bXCJkYXRhXCJdLCBxdWVyeT86IFEpID0+IFVzZU1hbnlIb29rUmVzdWx0PE0+XG5cbmludGVyZmFjZSBVc2VJRHNIb29rUmVzdWx0PElEVHlwZSBleHRlbmRzIEFueUlEVHlwZT4ge1xuICBpZHM6IElEVHlwZVtdXG4gIGlzVXBkYXRpbmc6IGJvb2xlYW5cbn1cbnR5cGUgVXNlSURzSG9vazxDIGV4dGVuZHMgUmVuZGVyZXJDb25maWc8YW55Pj4gPVxuPElEVHlwZSBleHRlbmRzIEFueUlEVHlwZSwgUSBleHRlbmRzIG9iamVjdCA9IHt9PlxuKG1vZGVsTmFtZToga2V5b2YgQ1tcImFwcFwiXVtcImRhdGFcIl0sIHF1ZXJ5PzogUSkgPT4gVXNlSURzSG9va1Jlc3VsdDxJRFR5cGU+XG5cbmludGVyZmFjZSBVc2VDb3VudEhvb2tSZXN1bHQge1xuICBjb3VudDogbnVtYmVyXG4gIGlzVXBkYXRpbmc6IGJvb2xlYW5cbn1cbnR5cGUgVXNlQ291bnRIb29rPEMgZXh0ZW5kcyBSZW5kZXJlckNvbmZpZzxhbnk+PiA9XG48USBleHRlbmRzIG9iamVjdD5cbihtb2RlbE5hbWU6IGtleW9mIENbXCJhcHBcIl1bXCJkYXRhXCJdLCBxdWVyeTogUSkgPT4gVXNlQ291bnRIb29rUmVzdWx0XG5cbmludGVyZmFjZSBVc2VPbmVIb29rUmVzdWx0PE0gZXh0ZW5kcyBNb2RlbD4ge1xuICBvYmplY3Q6IE0gfCBudWxsXG4gIGlzVXBkYXRpbmc6IGJvb2xlYW5cbiAgcmVmcmVzaDogKCkgPT4gdm9pZFxufVxudHlwZSBVc2VPbmVIb29rPEMgZXh0ZW5kcyBSZW5kZXJlckNvbmZpZzxhbnk+PiA9XG48TSBleHRlbmRzIE1vZGVsLCBJRFR5cGUgZXh0ZW5kcyBBbnlJRFR5cGU+XG4obW9kZWxOYW1lOiBrZXlvZiBDW1wiYXBwXCJdW1wiZGF0YVwiXSwgb2JqZWN0SUQ6IElEVHlwZSB8IG51bGwpID0+IFVzZU9uZUhvb2tSZXN1bHQ8TT5cblxuXG4vLyBSZW5kZXIgYXBwbGljYXRpb24gc2NyZWVuIGluIGEgbmV3IHdpbmRvd1xuLy8gd2l0aCBnaXZlbiB0b3AtbGV2ZWwgd2luZG93IFVJIGNvbXBvbmVudCBhbmQgKGlmIGFwcGxpY2FibGUpIGFueSBwYXJhbWV0ZXJzXG4vLyB3cmFwcGVkIGluIGNvbmZpZ3VyZWQgY29udGV4dCBwcm92aWRlciBjb21wb25lbnRzLlxuZXhwb3J0IGNvbnN0IHJlbmRlckFwcCA9IDxBIGV4dGVuZHMgQXBwQ29uZmlnLCBDIGV4dGVuZHMgUmVuZGVyZXJDb25maWc8QT4+KGNvbmZpZzogQyk6IEFwcFJlbmRlcmVyPEM+ID0+IHtcblxuICAvLyBlbGVjdHJvbi13ZWJwYWNrIGd1YXJhbnRlZXMgcHJlc2VuY2Ugb2YgI2FwcCBpbiBpbmRleC5odG1sIGl0IGJ1bmRsZXNcbiAgY29uc3QgYXBwUm9vdCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdhcHAnKSBhcyBIVE1MRWxlbWVudDtcblxuICAvLyBBZGQgYSBjbGFzcyBhbGxvd2luZyBwbGF0Zm9ybS1zcGVjaWZpYyBzdHlsaW5nXG4gIGRvY3VtZW50LmRvY3VtZW50RWxlbWVudC5jbGFzc0xpc3QuYWRkKGBwbGF0Zm9ybS0tJHtwcm9jZXNzLnBsYXRmb3JtfWApO1xuXG4gIC8vIEdldCBhbGwgcGFyYW1zIHBhc3NlZCB0byB0aGUgd2luZG93IHZpYSBHRVQgcXVlcnkgc3RyaW5nXG4gIGNvbnN0IHNlYXJjaFBhcmFtcyA9IG5ldyBVUkxTZWFyY2hQYXJhbXMod2luZG93LmxvY2F0aW9uLnNlYXJjaCk7XG5cbiAgLy8gUHJlcGFyZSBnZXR0ZXIgZm9yIHJlcXVlc3RlZCB0b3AtbGV2ZWwgd2luZG93IFVJIFJlYWN0IGNvbXBvbmVudFxuICBjb25zdCBjb21wb25lbnRJZCA9IHNlYXJjaFBhcmFtcy5nZXQoJ2MnKTtcbiAgY29uc3QgY29tcG9uZW50SW1wb3J0ZXIgPSBjb21wb25lbnRJZCA/IGNvbmZpZy53aW5kb3dDb21wb25lbnRzW2NvbXBvbmVudElkXSA6IG51bGw7XG5cbiAgbG9nLmRlYnVnKGBSZXF1ZXN0ZWQgd2luZG93IGNvbXBvbmVudCAke2NvbXBvbmVudElkfWApO1xuXG5cbiAgY29uc3Qgb3Blbk9iamVjdEVkaXRvciA9IGFzeW5jIChkYXRhVHlwZUlEOiBrZXlvZiBDW1wiYXBwXCJdW1wiZGF0YVwiXSwgb2JqZWN0SUQ6IGFueSwgcGFyYW1zPzogc3RyaW5nKSA9PiB7XG4gICAgaWYgKGNvbmZpZy5vYmplY3RFZGl0b3JXaW5kb3dzID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIk5vIG9iamVjdCBlZGl0b3Igd2luZG93cyBjb25maWd1cmVkXCIpO1xuICAgIH1cbiAgICBjb25zdCB3aW5kb3dJRCA9IGNvbmZpZy5vYmplY3RFZGl0b3JXaW5kb3dzW2RhdGFUeXBlSURdO1xuICAgIGNvbnN0IHdpbmRvd09wdGlvbnMgPSBjb25maWcuYXBwLndpbmRvd3Nbd2luZG93SUQgYXMga2V5b2YgdHlwZW9mIGNvbmZpZy5hcHAud2luZG93c107XG4gICAgaWYgKHdpbmRvd0lEID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIk9iamVjdCBlZGl0b3Igd2luZG93IG5vdCBjb25maWd1cmVkXCIpO1xuICAgIH1cbiAgICBhd2FpdCBjYWxsSVBDKCdvcGVuLXByZWRlZmluZWQtd2luZG93Jywge1xuICAgICAgaWQ6IHdpbmRvd0lELFxuICAgICAgcGFyYW1zOiB7XG4gICAgICAgIGNvbXBvbmVudFBhcmFtczogYG9iamVjdElEPSR7b2JqZWN0SUR9JiR7cGFyYW1zIHx8ICcnfWAsXG4gICAgICAgIHRpdGxlOiBgJHt3aW5kb3dPcHRpb25zLm9wZW5lclBhcmFtcy50aXRsZX0gKCR7b2JqZWN0SUR9KWAsXG4gICAgICB9LFxuICAgIH0pO1xuICB9O1xuXG4gIGNvbnN0IG9wZW5QcmVkZWZpbmVkV2luZG93ID0gYXN5bmMgKHdpbmRvd0lEOiBrZXlvZiB0eXBlb2YgY29uZmlnW1wiYXBwXCJdW1wid2luZG93c1wiXSwgcGFyYW1zPzogb2JqZWN0KSA9PiB7XG4gICAgYXdhaXQgY2FsbElQQygnb3Blbi1wcmVkZWZpbmVkLXdpbmRvdycsIHtcbiAgICAgIGlkOiB3aW5kb3dJRCxcbiAgICAgIHBhcmFtczogcGFyYW1zIHx8IHt9LFxuICAgIH0pO1xuICB9O1xuXG5cbiAgLy8gVE9ETzogUmVmYWN0b3Igb3V0IGhvb2sgaW5pdGlhbGl6YXRpb25cblxuICBjb25zdCB1c2VJRHM6IFVzZUlEc0hvb2s8Qz4gPVxuICA8SURUeXBlIGV4dGVuZHMgQW55SURUeXBlLCBRIGV4dGVuZHMgb2JqZWN0ID0ge30+XG4gIChtb2RlbE5hbWU6IGtleW9mIEFbXCJkYXRhXCJdLCBxdWVyeT86IFEpID0+IHtcbiAgICAvKiBRdWVyaWVzIGRhdGEgZm9yIHNwZWNpZmllZCBtb2RlbCwgbGlzdGVucyBmb3IgdXBkYXRlIGV2ZW50cyBhbmQgdXBkYXRlcyB0aGUgZGF0YXNldC4gKi9cblxuICAgIGNvbnN0IHRyYWNrZWRJRHMgPSB1c2VJUENWYWx1ZTxRLCB7IGlkczogSURUeXBlW10gfT5cbiAgICAoYG1vZGVsLSR7bW9kZWxOYW1lfS1saXN0LWlkc2AsIHsgaWRzOiBbXSB9LCBxdWVyeSk7XG5cbiAgICB1c2VJUENFdmVudDx7IGlkcz86IHN0cmluZ1tdIH0+KGBtb2RlbC0ke21vZGVsTmFtZX0tb2JqZWN0cy1jaGFuZ2VkYCwgZnVuY3Rpb24gKHsgaWRzIH0pIHtcbiAgICAgIHRyYWNrZWRJRHMucmVmcmVzaCgpO1xuXG4gICAgICAvLyBTZWUgVE9ETyBhdCB1c2VNYW55KCkuXG4gICAgICAvL2NvbnN0IHN0cmluZ0lEcyA9IHRyYWNrZWRJRHMudmFsdWUuaWRzLm1hcChpZCA9PiBgJHtpZH1gKTtcbiAgICAgIC8vY29uc3Qgc2hvdWxkUmVmcmVzaCA9IGlkcyAhPT0gdW5kZWZpbmVkXG4gICAgICAvLyAgPyBpZHMuZmlsdGVyKGlkID0+IHN0cmluZ0lEcy5pbmNsdWRlcyhpZCkpLmxlbmd0aCA+IDBcbiAgICAgIC8vICA6IHRydWU7XG4gICAgICAvL2lmIChzaG91bGRSZWZyZXNoKSB7XG4gICAgICAvLyAgdHJhY2tlZElEcy5yZWZyZXNoKCk7XG4gICAgICAvL31cbiAgICB9KTtcblxuICAgIHJldHVybiB7IGlkczogdHJhY2tlZElEcy52YWx1ZS5pZHMsIGlzVXBkYXRpbmc6IHRyYWNrZWRJRHMuaXNVcGRhdGluZyB9O1xuICB9XG5cbiAgY29uc3QgdXNlQ291bnQ6IFVzZUNvdW50SG9vazxDPiA9XG4gIDxRIGV4dGVuZHMgb2JqZWN0ID0gYW55PlxuICAobW9kZWxOYW1lOiBrZXlvZiBBW1wiZGF0YVwiXSwgcXVlcnk/OiBRKSA9PiB7XG4gICAgLyogUXVlcmllcyBkYXRhIGZvciBzcGVjaWZpZWQgbW9kZWwsIGxpc3RlbnMgZm9yIHVwZGF0ZSBldmVudHMgYW5kIHVwZGF0ZXMgdGhlIGRhdGFzZXQuICovXG5cbiAgICBjb25zdCBjb3VudCA9IHVzZUlQQ1ZhbHVlPFEsIHsgY291bnQ6IG51bWJlciB9PlxuICAgIChgbW9kZWwtJHttb2RlbE5hbWV9LWNvdW50YCwgeyBjb3VudDogMCB9LCBxdWVyeSk7XG5cbiAgICB1c2VJUENFdmVudDx7IGlkcz86IHN0cmluZ1tdIH0+KGBtb2RlbC0ke21vZGVsTmFtZX0tb2JqZWN0cy1jaGFuZ2VkYCwgZnVuY3Rpb24gKCkge1xuICAgICAgY291bnQucmVmcmVzaCgpO1xuICAgIH0pO1xuXG4gICAgcmV0dXJuIHsgY291bnQ6IGNvdW50LnZhbHVlLmNvdW50LCBpc1VwZGF0aW5nOiBjb3VudC5pc1VwZGF0aW5nIH07XG4gIH1cblxuICBjb25zdCB1c2VNYW55OiBVc2VNYW55SG9vazxDPiA9XG4gIDxNIGV4dGVuZHMgTW9kZWwsIFEgZXh0ZW5kcyBvYmplY3QgPSB7fT5cbiAgKG1vZGVsTmFtZToga2V5b2YgQVtcImRhdGFcIl0sIHF1ZXJ5PzogUSkgPT4ge1xuICAgIC8qIFF1ZXJpZXMgZGF0YSBmb3Igc3BlY2lmaWVkIG1vZGVsLCBsaXN0ZW5zIGZvciB1cGRhdGUgZXZlbnRzIGFuZCB1cGRhdGVzIHRoZSBkYXRhc2V0LiAqL1xuXG4gICAgY29uc3Qgb2JqZWN0cyA9IHVzZUlQQ1ZhbHVlPFEsIEluZGV4PE0+PlxuICAgIChgbW9kZWwtJHttb2RlbE5hbWV9LXJlYWQtYWxsYCwge30sIHF1ZXJ5KTtcblxuICAgIHVzZUlQQ0V2ZW50PHsgaWRzPzogc3RyaW5nW10gfT4oYG1vZGVsLSR7bW9kZWxOYW1lfS1vYmplY3RzLWNoYW5nZWRgLCBmdW5jdGlvbiAoeyBpZHMgfSkge1xuICAgICAgLy8gVE9ETzogZ2VuZXJpYyBxdWVyeSByZWZyZXNoIElQQyBldmVudC9ob29rP1xuICAgICAgY29uc29sZS5kZWJ1ZyhcIkNoYW5nZWRcIiwgbW9kZWxOYW1lLCBpZHMpXG5cbiAgICAgIG9iamVjdHMucmVmcmVzaCgpO1xuXG4gICAgICAvLyBUT0RPOiBPbmx5IHJlZnJlc2ggd2hlbiBuZWVkZWQuXG4gICAgICAvLyBCZWxvdyBjb2RlIHdvcmtzLCBleGNlcHQgaXQgd29u4oCZdCB0cmlnZ2VyIHJlZnJlc2hcbiAgICAgIC8vIHdoZW4gbmV3IG9iamVjdHMgYXJlIGFkZGVkOlxuICAgICAgLy8gbG9nLnNpbGx5KFwiQy9yZW5kZXJBcHA6IENoYW5nZWQgb2JqZWN0IElEc1wiLCBpZHMpO1xuICAgICAgLy8gY29uc3QgdHJhY2tlZE9iamVjdElEcyA9IE9iamVjdC5rZXlzKG9iamVjdHMudmFsdWUpO1xuICAgICAgLy8gY29uc3Qgc2hvdWxkUmVmcmVzaCA9IGlkcyA9PT0gdW5kZWZpbmVkIHx8IGlkcy5maWx0ZXIoaWQgPT4gdHJhY2tlZE9iamVjdElEcy5pbmNsdWRlcyhpZCkpLmxlbmd0aCA+IDA7XG4gICAgICAvLyBpZiAoc2hvdWxkUmVmcmVzaCkge1xuICAgICAgLy8gICBsb2cuZGVidWcoXCJDL3JlbmRlckFwcDogUmVmcmVzaGluZyBvYmplY3RzXCIsIGlkcyk7XG4gICAgICAvLyAgIG9iamVjdHMucmVmcmVzaCgpO1xuICAgICAgLy8gfSBlbHNlIHtcbiAgICAgIC8vICAgbG9nLmRlYnVnKFwiQy9yZW5kZXJBcHA6IFdpbGwgbm90IHJlZnJlc2ggb2JqZWN0c1wiLCBpZHMpO1xuICAgICAgLy8gfVxuICAgIH0pO1xuXG4gICAgcmV0dXJuIHsgb2JqZWN0czogb2JqZWN0cy52YWx1ZSwgaXNVcGRhdGluZzogb2JqZWN0cy5pc1VwZGF0aW5nIH07XG4gIH1cblxuICBjb25zdCB1c2VPbmU6IFVzZU9uZUhvb2s8Qz4gPVxuICA8TSBleHRlbmRzIE1vZGVsLCBJRFR5cGUgZXh0ZW5kcyBBbnlJRFR5cGU+XG4gIChtb2RlbE5hbWU6IGtleW9mIEFbXCJkYXRhXCJdLCBvYmplY3RJRDogSURUeXBlIHwgbnVsbCkgPT4ge1xuICAgIC8qIFF1ZXJpZXMgZGF0YSBmb3Igc3BlY2lmaWVkIG1vZGVsLCBsaXN0ZW5zIGZvciB1cGRhdGUgZXZlbnRzIGFuZCB1cGRhdGVzIHRoZSBkYXRhc2V0LiAqL1xuXG4gICAgY29uc3Qgb2JqZWN0ID0gdXNlSVBDVmFsdWU8eyBvYmplY3RJRDogSURUeXBlIHwgbnVsbCB9LCB7IG9iamVjdDogTSB8IG51bGwgfT5cbiAgICAoYG1vZGVsLSR7bW9kZWxOYW1lfS1yZWFkLW9uZWAsIHsgb2JqZWN0OiBudWxsIGFzIE0gfCBudWxsIH0sIHsgb2JqZWN0SUQgfSk7XG5cbiAgICB1c2VJUENFdmVudDx7IGlkcz86IHN0cmluZ1tdIH0+KGBtb2RlbC0ke21vZGVsTmFtZX0tb2JqZWN0cy1jaGFuZ2VkYCwgZnVuY3Rpb24gKHsgaWRzIH0pIHtcbiAgICAgIGNvbnN0IHNob3VsZFJlZnJlc2ggPSBpZHMgPT09IHVuZGVmaW5lZCB8fCBpZHMuaW5jbHVkZXMoYCR7b2JqZWN0SUR9YCk7XG4gICAgICBpZiAoc2hvdWxkUmVmcmVzaCkge1xuICAgICAgICBvYmplY3QucmVmcmVzaCgpO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgcmV0dXJuIHtcbiAgICAgIG9iamVjdDogb2JqZWN0LnZhbHVlLm9iamVjdCxcbiAgICAgIGlzVXBkYXRpbmc6IG9iamVjdC5pc1VwZGF0aW5nLFxuICAgICAgcmVmcmVzaDogKCkgPT4gb2JqZWN0LnJlZnJlc2goKSxcbiAgICB9O1xuICB9XG5cbiAgLy8gRmV0Y2ggdG9wLWxldmVsIFVJIGNvbXBvbmVudCBjbGFzcyBhbmQgcmVuZGVyIGl0LlxuICBpZiAoY29tcG9uZW50SW1wb3J0ZXIpIHtcbiAgICAoYXN5bmMgKCkgPT4ge1xuICAgICAgLy8gU2hvdyBsb2FkaW5nIGluZGljYXRvciB3aGlsZSBjb21wb25lbnRzIGFyZSBiZWluZyByZXNvbHZlZFxuICAgICAgUmVhY3RET00ucmVuZGVyKDxTcGlubmVyIGNsYXNzTmFtZT1cImluaXRpYWwtc3Bpbm5lclwiIC8+LCBhcHBSb290KTtcblxuICAgICAgY29uc3QgY3R4UHJvdmlkZXJDb25maWcgPSBjb25maWcuY29udGV4dFByb3ZpZGVycyB8fCBbXTtcblxuICAgICAgLy8gR2V0IHByb3BzIHByZXNjcmliZWQgZm9yIGVhY2ggY29udGV4dCBwcm92aWRlciBjb21wb25lbnRcbiAgICAgIHZhciBjdHhQcm92aWRlclByb3BzID0gY3R4UHJvdmlkZXJDb25maWcubWFwKGl0ZW0gPT4gaXRlbS5nZXRQcm9wcyhjb25maWcpKTtcblxuICAgICAgbG9nLnNpbGx5KFxuICAgICAgICBgQy9yZW5kZXJBcHA6IFJlc29sdmluZyBjb21wb25lbnRzYCxcbiAgICAgICAgY29tcG9uZW50SW1wb3J0ZXIsIGN0eFByb3ZpZGVyQ29uZmlnKTtcblxuICAgICAgLy8gUmVzb2x2ZSAoaW1wb3J0KSBjb21wb25lbnRzIGluIHBhcmFsbGVsLCBmaXJzdCBVSSBhbmQgdGhlbiBjb250ZXh0IHByb3ZpZGVyc1xuICAgICAgY29uc3QgcHJvbWlzZWRDb21wb25lbnRzOiB7IGRlZmF1bHQ6IFJlYWN0LkZDPGFueT4gfVtdID0gYXdhaXQgUHJvbWlzZS5hbGwoW1xuICAgICAgICBjb21wb25lbnRJbXBvcnRlcigpLFxuICAgICAgICAuLi5jdHhQcm92aWRlckNvbmZpZy5tYXAoYXN5bmMgKGN0eHApID0+IGF3YWl0IGN0eHAuY2xzKCkpLFxuICAgICAgXSk7XG5cbiAgICAgIGxvZy5zaWxseShcbiAgICAgICAgYEMvcmVuZGVyQXBwOiBSZXNvbHZlZCBjb21wb25lbnRzYCxcbiAgICAgICAgcHJvbWlzZWRDb21wb25lbnRzKTtcblxuICAgICAgLy8gQnJlYWsgZG93biBjb21wb25lbnRzIGludG8gdG9wLWxldmVsIHdpbmRvdyBVSSAmIGNvbnRleHQgcHJvdmlkZXJzXG4gICAgICBjb25zdCBUb3BXaW5kb3dDb21wb25lbnQgPSBwcm9taXNlZENvbXBvbmVudHNbMF0uZGVmYXVsdDtcbiAgICAgIHZhciBjdHhQcm92aWRlckNvbXBvbmVudHMgPSBwcm9taXNlZENvbXBvbmVudHMuXG4gICAgICAgIHNsaWNlKDEsIHByb21pc2VkQ29tcG9uZW50cy5sZW5ndGgpLlxuICAgICAgICBtYXAoaXRlbSA9PiBpdGVtLmRlZmF1bHQpO1xuXG4gICAgICAvLyBSZW9yZGVyIGNvbnRleHQgcHJvdmlkZXJzIHNvIHRoYXQgdG9wLW1vc3QgaXMgdGhlIG1vc3QgYmFzaWNcbiAgICAgIGN0eFByb3ZpZGVyQ29tcG9uZW50cy5yZXZlcnNlKCk7XG4gICAgICBjdHhQcm92aWRlclByb3BzLnJldmVyc2UoKTtcblxuICAgICAgLy8gV3JpdGUgb3V0IHRvcC1sZXZlbCB3aW5kb3cgY29tcG9uZW50IEpTWFxuICAgICAgdmFyIGFwcE1hcmt1cCA9IDxUb3BXaW5kb3dDb21wb25lbnQgcXVlcnk9e3NlYXJjaFBhcmFtc30gLz47XG5cbiAgICAgIGxvZy5kZWJ1ZyhcbiAgICAgICAgYEMvcmVuZGVyQXBwOiBHb3QgY29udGV4dCBwcm92aWRlciBjb21wb25lbnRzYCxcbiAgICAgICAgY3R4UHJvdmlkZXJDb21wb25lbnRzKTtcblxuICAgICAgLy8gV3JhcCB0aGUgSlNYIGludG8gY29udGV4dCBwcm92aWRlciBjb21wb25lbnRzXG4gICAgICBmb3IgKGNvbnN0IFtpZHgsIENvbnRleHRQcm92aWRlcl0gb2YgY3R4UHJvdmlkZXJDb21wb25lbnRzLmVudHJpZXMoKSkge1xuICAgICAgICBsb2cudmVyYm9zZSggIFxuICAgICAgICAgIGBDL3JlbmRlckFwcDogSW5pdGlhbGl6aW5nIGNvbnRleHQgcHJvdmlkZXIgIyR7aWR4fWAsXG4gICAgICAgICAgY3R4UHJvdmlkZXJDb21wb25lbnRzW2lkeF0sXG4gICAgICAgICAgY3R4UHJvdmlkZXJQcm9wc1tpZHhdKTtcblxuICAgICAgICBhcHBNYXJrdXAgPSAoXG4gICAgICAgICAgPENvbnRleHRQcm92aWRlciB7Li4uY3R4UHJvdmlkZXJQcm9wc1tpZHhdfT5cbiAgICAgICAgICAgIHthcHBNYXJrdXB9XG4gICAgICAgICAgPC9Db250ZXh0UHJvdmlkZXI+XG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIGxvZy5kZWJ1ZyhcIkMvcmVuZGVyQXBwOiBSZW5kZXJpbmdcIik7XG5cbiAgICAgIC8vIFJlbmRlciB0aGUgSlNYXG4gICAgICBSZWFjdERPTS5yZW5kZXIoYXBwTWFya3VwLCBhcHBSb290KTtcbiAgICB9KSgpO1xuXG4gICAgcmV0dXJuIHtcbiAgICAgIHJvb3Q6IGFwcFJvb3QsXG4gICAgICB1c2VDb3VudCxcbiAgICAgIHVzZUlEcyxcbiAgICAgIHVzZU1hbnksXG4gICAgICB1c2VPbmUsXG4gICAgICBvcGVuUHJlZGVmaW5lZFdpbmRvdyxcbiAgICAgIG9wZW5PYmplY3RFZGl0b3IsXG4gICAgfTtcblxuICB9IGVsc2Uge1xuICAgIC8vIENvbXBvbmVudCBzcGVjaWZpZWQgaW4gR0VUIHBhcmFtcyBpcyBub3QgcHJlc2VudCBpbiBhcHAgcmVuZGVyZXIgY29uZmlnLlxuICAgIC8vIFRPRE86IEhhbmRsZSBtaXNjb25maWd1cmVkIFJlYWN0IGNvbnRleHQgcHJvdmlkZXJzIGFuZCBmYWlsZWQgaW1wb3J0IGF0IHJ1bnRpbWVcbiAgICBSZWFjdERPTS5yZW5kZXIoPE5vbklkZWFsU3RhdGVcbiAgICAgIGljb249XCJlcnJvclwiXG4gICAgICB0aXRsZT1cIlVua25vd24gY29tcG9uZW50IHJlcXVlc3RlZFwiIC8+LCBhcHBSb290KTtcblxuICAgIGxvZy5lcnJvcihcIlVua25vd24gY29tcG9uZW50IHJlcXVlc3RlZFwiLCBjb21wb25lbnRJZCk7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiVW5rbm93biBjb21wb25lbnQgcmVxdWVzdGVkXCIpO1xuICB9XG5cbn07Il19