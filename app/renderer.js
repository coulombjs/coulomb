import React from 'react';
import * as log from 'electron-log';
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
            ReactDOM.render(React.createElement(Spinner, null), appRoot);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVuZGVyZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zcmMvYXBwL3JlbmRlcmVyLnRzeCJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEtBQUssTUFBTSxPQUFPLENBQUM7QUFDMUIsT0FBTyxLQUFLLEdBQUcsTUFBTSxjQUFjLENBQUM7QUFDcEMsT0FBTyxLQUFLLFFBQVEsTUFBTSxXQUFXLENBQUM7QUFRdEMsT0FBTyxFQUFFLGFBQWEsRUFBRSxPQUFPLEVBQUUsTUFBTSxtQkFBbUIsQ0FBQztBQUUzRCxPQUFPLCtFQUErRSxDQUFDO0FBQ3ZGLE9BQU8sa0VBQWtFLENBQUM7QUFDMUUsT0FBTywwQ0FBMEMsQ0FBQztBQUNsRCxPQUFPLHlDQUF5QyxDQUFDO0FBQ2pELE9BQU8sRUFBRSxXQUFXLEVBQUUsV0FBVyxFQUFFLE9BQU8sRUFBRSxNQUFNLGlCQUFpQixDQUFDO0FBc0RwRSw0Q0FBNEM7QUFDNUMsOEVBQThFO0FBQzlFLHFEQUFxRDtBQUNyRCxNQUFNLENBQUMsTUFBTSxTQUFTLEdBQUcsQ0FBbUQsTUFBUyxFQUFrQixFQUFFO0lBRXZHLHdFQUF3RTtJQUN4RSxNQUFNLE9BQU8sR0FBRyxRQUFRLENBQUMsY0FBYyxDQUFDLEtBQUssQ0FBZ0IsQ0FBQztJQUU5RCxpREFBaUQ7SUFDakQsUUFBUSxDQUFDLGVBQWUsQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLGFBQWEsT0FBTyxDQUFDLFFBQVEsRUFBRSxDQUFDLENBQUM7SUFFeEUsMkRBQTJEO0lBQzNELE1BQU0sWUFBWSxHQUFHLElBQUksZUFBZSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsTUFBTSxDQUFDLENBQUM7SUFFakUsbUVBQW1FO0lBQ25FLE1BQU0sV0FBVyxHQUFHLFlBQVksQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUM7SUFDMUMsTUFBTSxpQkFBaUIsR0FBRyxXQUFXLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxnQkFBZ0IsQ0FBQyxX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NkIsRUFBRSxXQUFXLENBQUMsQ0FBQztRQUN0RCxNQUFNLElBQUksS0FBSyxDQUFDLDZCQUE2QixDQUFDLENBQUM7S0FDaEQ7QUFFSCxDQUFDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgUmVhY3QgZnJvbSAncmVhY3QnO1xuaW1wb3J0ICogYXMgbG9nIGZyb20gJ2VsZWN0cm9uLWxvZyc7XG5pbXBvcnQgKiBhcyBSZWFjdERPTSBmcm9tICdyZWFjdC1kb20nO1xuXG5pbXBvcnQgeyBBcHBDb25maWcgfSBmcm9tICcuLi9jb25maWcvYXBwJztcbmltcG9ydCB7IFJlbmRlcmVyQ29uZmlnIH0gZnJvbSAnLi4vY29uZmlnL3JlbmRlcmVyJztcblxuaW1wb3J0IHsgTW9kZWwsIEFueUlEVHlwZSB9IGZyb20gJy4uL2RiL21vZGVscyc7XG5pbXBvcnQgeyBJbmRleCB9IGZyb20gJy4uL2RiL3F1ZXJ5JztcblxuaW1wb3J0IHsgTm9uSWRlYWxTdGF0ZSwgU3Bpbm5lciB9IGZyb20gJ0BibHVlcHJpbnRqcy9jb3JlJztcblxuaW1wb3J0ICchc3R5bGUtbG9hZGVyIWNzcy1sb2FkZXIhQGJsdWVwcmludGpzL2RhdGV0aW1lL2xpYi9jc3MvYmx1ZXByaW50LWRhdGV0aW1lLmNzcyc7XG5pbXBvcnQgJyFzdHlsZS1sb2FkZXIhY3NzLWxvYWRlciFAYmx1ZXByaW50anMvY29yZS9saWIvY3NzL2JsdWVwcmludC5jc3MnO1xuaW1wb3J0ICchc3R5bGUtbG9hZGVyIWNzcy1sb2FkZXIhLi9ub3JtYWxpemUuY3NzJztcbmltcG9ydCAnIXN0eWxlLWxvYWRlciFjc3MtbG9hZGVyIS4vcmVuZGVyZXIuY3NzJztcbmltcG9ydCB7IHVzZUlQQ0V2ZW50LCB1c2VJUENWYWx1ZSwgY2FsbElQQyB9IGZyb20gJy4uL2lwYy9yZW5kZXJlcic7XG5cblxuaW50ZXJmYWNlIEFwcFJlbmRlcmVyPEMgZXh0ZW5kcyBSZW5kZXJlckNvbmZpZzxhbnk+PiB7XG4gIHJvb3Q6IEhUTUxFbGVtZW50XG4gIHVzZUNvdW50OiBVc2VDb3VudEhvb2s8Qz5cbiAgdXNlSURzOiBVc2VJRHNIb29rPEM+XG4gIHVzZU1hbnk6IFVzZU1hbnlIb29rPEM+XG4gIHVzZU9uZTogVXNlT25lSG9vazxDPlxuXG4gIG9wZW5QcmVkZWZpbmVkV2luZG93OlxuICAgICh3aW5kb3dJRDoga2V5b2YgQ1tcImFwcFwiXVtcIndpbmRvd3NcIl0sIHBhcmFtcz86IG9iamVjdCkgPT4gUHJvbWlzZTx2b2lkPlxuXG4gIG9wZW5PYmplY3RFZGl0b3I6XG4gICAgKG9iamVjdFR5cGVJRDoga2V5b2YgQ1tcImFwcFwiXVtcImRhdGFcIl0sIG9iamVjdElEOiBhbnksIHBhcmFtcz86IHN0cmluZykgPT4gUHJvbWlzZTx2b2lkPlxufVxuXG5cbi8vIERhdGEgb3BlcmF0aW9uIGhvb2sgaW50ZXJmYWNlc1xuXG5pbnRlcmZhY2UgVXNlTWFueUhvb2tSZXN1bHQ8TSBleHRlbmRzIE1vZGVsPiB7XG4gIG9iamVjdHM6IEluZGV4PE0+XG4gIGlzVXBkYXRpbmc6IGJvb2xlYW5cbn1cbnR5cGUgVXNlTWFueUhvb2s8QyBleHRlbmRzIFJlbmRlcmVyQ29uZmlnPGFueT4+ID1cbjxNIGV4dGVuZHMgTW9kZWwsIFEgZXh0ZW5kcyBvYmplY3QgPSB7fT5cbihtb2RlbE5hbWU6IGtleW9mIENbXCJhcHBcIl1bXCJkYXRhXCJdLCBxdWVyeT86IFEpID0+IFVzZU1hbnlIb29rUmVzdWx0PE0+XG5cbmludGVyZmFjZSBVc2VJRHNIb29rUmVzdWx0PElEVHlwZSBleHRlbmRzIEFueUlEVHlwZT4ge1xuICBpZHM6IElEVHlwZVtdXG4gIGlzVXBkYXRpbmc6IGJvb2xlYW5cbn1cbnR5cGUgVXNlSURzSG9vazxDIGV4dGVuZHMgUmVuZGVyZXJDb25maWc8YW55Pj4gPVxuPElEVHlwZSBleHRlbmRzIEFueUlEVHlwZSwgUSBleHRlbmRzIG9iamVjdCA9IHt9PlxuKG1vZGVsTmFtZToga2V5b2YgQ1tcImFwcFwiXVtcImRhdGFcIl0sIHF1ZXJ5PzogUSkgPT4gVXNlSURzSG9va1Jlc3VsdDxJRFR5cGU+XG5cbmludGVyZmFjZSBVc2VDb3VudEhvb2tSZXN1bHQge1xuICBjb3VudDogbnVtYmVyXG4gIGlzVXBkYXRpbmc6IGJvb2xlYW5cbn1cbnR5cGUgVXNlQ291bnRIb29rPEMgZXh0ZW5kcyBSZW5kZXJlckNvbmZpZzxhbnk+PiA9XG48USBleHRlbmRzIG9iamVjdD5cbihtb2RlbE5hbWU6IGtleW9mIENbXCJhcHBcIl1bXCJkYXRhXCJdLCBxdWVyeTogUSkgPT4gVXNlQ291bnRIb29rUmVzdWx0XG5cbmludGVyZmFjZSBVc2VPbmVIb29rUmVzdWx0PE0gZXh0ZW5kcyBNb2RlbD4ge1xuICBvYmplY3Q6IE0gfCBudWxsXG4gIGlzVXBkYXRpbmc6IGJvb2xlYW5cbiAgcmVmcmVzaDogKCkgPT4gdm9pZFxufVxudHlwZSBVc2VPbmVIb29rPEMgZXh0ZW5kcyBSZW5kZXJlckNvbmZpZzxhbnk+PiA9XG48TSBleHRlbmRzIE1vZGVsLCBJRFR5cGUgZXh0ZW5kcyBBbnlJRFR5cGU+XG4obW9kZWxOYW1lOiBrZXlvZiBDW1wiYXBwXCJdW1wiZGF0YVwiXSwgb2JqZWN0SUQ6IElEVHlwZSB8IG51bGwpID0+IFVzZU9uZUhvb2tSZXN1bHQ8TT5cblxuXG4vLyBSZW5kZXIgYXBwbGljYXRpb24gc2NyZWVuIGluIGEgbmV3IHdpbmRvd1xuLy8gd2l0aCBnaXZlbiB0b3AtbGV2ZWwgd2luZG93IFVJIGNvbXBvbmVudCBhbmQgKGlmIGFwcGxpY2FibGUpIGFueSBwYXJhbWV0ZXJzXG4vLyB3cmFwcGVkIGluIGNvbmZpZ3VyZWQgY29udGV4dCBwcm92aWRlciBjb21wb25lbnRzLlxuZXhwb3J0IGNvbnN0IHJlbmRlckFwcCA9IDxBIGV4dGVuZHMgQXBwQ29uZmlnLCBDIGV4dGVuZHMgUmVuZGVyZXJDb25maWc8QT4+KGNvbmZpZzogQyk6IEFwcFJlbmRlcmVyPEM+ID0+IHtcblxuICAvLyBlbGVjdHJvbi13ZWJwYWNrIGd1YXJhbnRlZXMgcHJlc2VuY2Ugb2YgI2FwcCBpbiBpbmRleC5odG1sIGl0IGJ1bmRsZXNcbiAgY29uc3QgYXBwUm9vdCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdhcHAnKSBhcyBIVE1MRWxlbWVudDtcblxuICAvLyBBZGQgYSBjbGFzcyBhbGxvd2luZyBwbGF0Zm9ybS1zcGVjaWZpYyBzdHlsaW5nXG4gIGRvY3VtZW50LmRvY3VtZW50RWxlbWVudC5jbGFzc0xpc3QuYWRkKGBwbGF0Zm9ybS0tJHtwcm9jZXNzLnBsYXRmb3JtfWApO1xuXG4gIC8vIEdldCBhbGwgcGFyYW1zIHBhc3NlZCB0byB0aGUgd2luZG93IHZpYSBHRVQgcXVlcnkgc3RyaW5nXG4gIGNvbnN0IHNlYXJjaFBhcmFtcyA9IG5ldyBVUkxTZWFyY2hQYXJhbXMod2luZG93LmxvY2F0aW9uLnNlYXJjaCk7XG5cbiAgLy8gUHJlcGFyZSBnZXR0ZXIgZm9yIHJlcXVlc3RlZCB0b3AtbGV2ZWwgd2luZG93IFVJIFJlYWN0IGNvbXBvbmVudFxuICBjb25zdCBjb21wb25lbnRJZCA9IHNlYXJjaFBhcmFtcy5nZXQoJ2MnKTtcbiAgY29uc3QgY29tcG9uZW50SW1wb3J0ZXIgPSBjb21wb25lbnRJZCA/IGNvbmZpZy53aW5kb3dDb21wb25lbnRzW2NvbXBvbmVudElkXSA6IG51bGw7XG5cbiAgbG9nLmRlYnVnKGBSZXF1ZXN0ZWQgd2luZG93IGNvbXBvbmVudCAke2NvbXBvbmVudElkfWApO1xuXG5cbiAgY29uc3Qgb3Blbk9iamVjdEVkaXRvciA9IGFzeW5jIChkYXRhVHlwZUlEOiBrZXlvZiBDW1wiYXBwXCJdW1wiZGF0YVwiXSwgb2JqZWN0SUQ6IGFueSwgcGFyYW1zPzogc3RyaW5nKSA9PiB7XG4gICAgaWYgKGNvbmZpZy5vYmplY3RFZGl0b3JXaW5kb3dzID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIk5vIG9iamVjdCBlZGl0b3Igd2luZG93cyBjb25maWd1cmVkXCIpO1xuICAgIH1cbiAgICBjb25zdCB3aW5kb3dJRCA9IGNvbmZpZy5vYmplY3RFZGl0b3JXaW5kb3dzW2RhdGFUeXBlSURdO1xuICAgIGNvbnN0IHdpbmRvd09wdGlvbnMgPSBjb25maWcuYXBwLndpbmRvd3Nbd2luZG93SUQgYXMga2V5b2YgdHlwZW9mIGNvbmZpZy5hcHAud2luZG93c107XG4gICAgaWYgKHdpbmRvd0lEID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIk9iamVjdCBlZGl0b3Igd2luZG93IG5vdCBjb25maWd1cmVkXCIpO1xuICAgIH1cbiAgICBhd2FpdCBjYWxsSVBDKCdvcGVuLXByZWRlZmluZWQtd2luZG93Jywge1xuICAgICAgaWQ6IHdpbmRvd0lELFxuICAgICAgcGFyYW1zOiB7XG4gICAgICAgIGNvbXBvbmVudFBhcmFtczogYG9iamVjdElEPSR7b2JqZWN0SUR9JiR7cGFyYW1zIHx8ICcnfWAsXG4gICAgICAgIHRpdGxlOiBgJHt3aW5kb3dPcHRpb25zLm9wZW5lclBhcmFtcy50aXRsZX0gKCR7b2JqZWN0SUR9KWAsXG4gICAgICB9LFxuICAgIH0pO1xuICB9O1xuXG4gIGNvbnN0IG9wZW5QcmVkZWZpbmVkV2luZG93ID0gYXN5bmMgKHdpbmRvd0lEOiBrZXlvZiB0eXBlb2YgY29uZmlnW1wiYXBwXCJdW1wid2luZG93c1wiXSwgcGFyYW1zPzogb2JqZWN0KSA9PiB7XG4gICAgYXdhaXQgY2FsbElQQygnb3Blbi1wcmVkZWZpbmVkLXdpbmRvdycsIHtcbiAgICAgIGlkOiB3aW5kb3dJRCxcbiAgICAgIHBhcmFtczogcGFyYW1zIHx8IHt9LFxuICAgIH0pO1xuICB9O1xuXG5cbiAgLy8gVE9ETzogUmVmYWN0b3Igb3V0IGhvb2sgaW5pdGlhbGl6YXRpb25cblxuICBjb25zdCB1c2VJRHM6IFVzZUlEc0hvb2s8Qz4gPVxuICA8SURUeXBlIGV4dGVuZHMgQW55SURUeXBlLCBRIGV4dGVuZHMgb2JqZWN0ID0ge30+XG4gIChtb2RlbE5hbWU6IGtleW9mIEFbXCJkYXRhXCJdLCBxdWVyeT86IFEpID0+IHtcbiAgICAvKiBRdWVyaWVzIGRhdGEgZm9yIHNwZWNpZmllZCBtb2RlbCwgbGlzdGVucyBmb3IgdXBkYXRlIGV2ZW50cyBhbmQgdXBkYXRlcyB0aGUgZGF0YXNldC4gKi9cblxuICAgIGNvbnN0IHRyYWNrZWRJRHMgPSB1c2VJUENWYWx1ZTxRLCB7IGlkczogSURUeXBlW10gfT5cbiAgICAoYG1vZGVsLSR7bW9kZWxOYW1lfS1saXN0LWlkc2AsIHsgaWRzOiBbXSB9LCBxdWVyeSk7XG5cbiAgICB1c2VJUENFdmVudDx7IGlkcz86IHN0cmluZ1tdIH0+KGBtb2RlbC0ke21vZGVsTmFtZX0tb2JqZWN0cy1jaGFuZ2VkYCwgZnVuY3Rpb24gKHsgaWRzIH0pIHtcbiAgICAgIHRyYWNrZWRJRHMucmVmcmVzaCgpO1xuXG4gICAgICAvLyBTZWUgVE9ETyBhdCB1c2VNYW55KCkuXG4gICAgICAvL2NvbnN0IHN0cmluZ0lEcyA9IHRyYWNrZWRJRHMudmFsdWUuaWRzLm1hcChpZCA9PiBgJHtpZH1gKTtcbiAgICAgIC8vY29uc3Qgc2hvdWxkUmVmcmVzaCA9IGlkcyAhPT0gdW5kZWZpbmVkXG4gICAgICAvLyAgPyBpZHMuZmlsdGVyKGlkID0+IHN0cmluZ0lEcy5pbmNsdWRlcyhpZCkpLmxlbmd0aCA+IDBcbiAgICAgIC8vICA6IHRydWU7XG4gICAgICAvL2lmIChzaG91bGRSZWZyZXNoKSB7XG4gICAgICAvLyAgdHJhY2tlZElEcy5yZWZyZXNoKCk7XG4gICAgICAvL31cbiAgICB9KTtcblxuICAgIHJldHVybiB7IGlkczogdHJhY2tlZElEcy52YWx1ZS5pZHMsIGlzVXBkYXRpbmc6IHRyYWNrZWRJRHMuaXNVcGRhdGluZyB9O1xuICB9XG5cbiAgY29uc3QgdXNlQ291bnQ6IFVzZUNvdW50SG9vazxDPiA9XG4gIDxRIGV4dGVuZHMgb2JqZWN0ID0gYW55PlxuICAobW9kZWxOYW1lOiBrZXlvZiBBW1wiZGF0YVwiXSwgcXVlcnk/OiBRKSA9PiB7XG4gICAgLyogUXVlcmllcyBkYXRhIGZvciBzcGVjaWZpZWQgbW9kZWwsIGxpc3RlbnMgZm9yIHVwZGF0ZSBldmVudHMgYW5kIHVwZGF0ZXMgdGhlIGRhdGFzZXQuICovXG5cbiAgICBjb25zdCBjb3VudCA9IHVzZUlQQ1ZhbHVlPFEsIHsgY291bnQ6IG51bWJlciB9PlxuICAgIChgbW9kZWwtJHttb2RlbE5hbWV9LWNvdW50YCwgeyBjb3VudDogMCB9LCBxdWVyeSk7XG5cbiAgICB1c2VJUENFdmVudDx7IGlkcz86IHN0cmluZ1tdIH0+KGBtb2RlbC0ke21vZGVsTmFtZX0tb2JqZWN0cy1jaGFuZ2VkYCwgZnVuY3Rpb24gKCkge1xuICAgICAgY291bnQucmVmcmVzaCgpO1xuICAgIH0pO1xuXG4gICAgcmV0dXJuIHsgY291bnQ6IGNvdW50LnZhbHVlLmNvdW50LCBpc1VwZGF0aW5nOiBjb3VudC5pc1VwZGF0aW5nIH07XG4gIH1cblxuICBjb25zdCB1c2VNYW55OiBVc2VNYW55SG9vazxDPiA9XG4gIDxNIGV4dGVuZHMgTW9kZWwsIFEgZXh0ZW5kcyBvYmplY3QgPSB7fT5cbiAgKG1vZGVsTmFtZToga2V5b2YgQVtcImRhdGFcIl0sIHF1ZXJ5PzogUSkgPT4ge1xuICAgIC8qIFF1ZXJpZXMgZGF0YSBmb3Igc3BlY2lmaWVkIG1vZGVsLCBsaXN0ZW5zIGZvciB1cGRhdGUgZXZlbnRzIGFuZCB1cGRhdGVzIHRoZSBkYXRhc2V0LiAqL1xuXG4gICAgY29uc3Qgb2JqZWN0cyA9IHVzZUlQQ1ZhbHVlPFEsIEluZGV4PE0+PlxuICAgIChgbW9kZWwtJHttb2RlbE5hbWV9LXJlYWQtYWxsYCwge30sIHF1ZXJ5KTtcblxuICAgIHVzZUlQQ0V2ZW50PHsgaWRzPzogc3RyaW5nW10gfT4oYG1vZGVsLSR7bW9kZWxOYW1lfS1vYmplY3RzLWNoYW5nZWRgLCBmdW5jdGlvbiAoeyBpZHMgfSkge1xuICAgICAgLy8gVE9ETzogZ2VuZXJpYyBxdWVyeSByZWZyZXNoIElQQyBldmVudC9ob29rP1xuXG4gICAgICBvYmplY3RzLnJlZnJlc2goKTtcblxuICAgICAgLy8gVE9ETzogT25seSByZWZyZXNoIHdoZW4gbmVlZGVkLlxuICAgICAgLy8gQmVsb3cgY29kZSB3b3JrcywgZXhjZXB0IGl0IHdvbuKAmXQgdHJpZ2dlciByZWZyZXNoXG4gICAgICAvLyB3aGVuIG5ldyBvYmplY3RzIGFyZSBhZGRlZDpcbiAgICAgIC8vIGxvZy5zaWxseShcIkMvcmVuZGVyQXBwOiBDaGFuZ2VkIG9iamVjdCBJRHNcIiwgaWRzKTtcbiAgICAgIC8vIGNvbnN0IHRyYWNrZWRPYmplY3RJRHMgPSBPYmplY3Qua2V5cyhvYmplY3RzLnZhbHVlKTtcbiAgICAgIC8vIGNvbnN0IHNob3VsZFJlZnJlc2ggPSBpZHMgPT09IHVuZGVmaW5lZCB8fCBpZHMuZmlsdGVyKGlkID0+IHRyYWNrZWRPYmplY3RJRHMuaW5jbHVkZXMoaWQpKS5sZW5ndGggPiAwO1xuICAgICAgLy8gaWYgKHNob3VsZFJlZnJlc2gpIHtcbiAgICAgIC8vICAgbG9nLmRlYnVnKFwiQy9yZW5kZXJBcHA6IFJlZnJlc2hpbmcgb2JqZWN0c1wiLCBpZHMpO1xuICAgICAgLy8gICBvYmplY3RzLnJlZnJlc2goKTtcbiAgICAgIC8vIH0gZWxzZSB7XG4gICAgICAvLyAgIGxvZy5kZWJ1ZyhcIkMvcmVuZGVyQXBwOiBXaWxsIG5vdCByZWZyZXNoIG9iamVjdHNcIiwgaWRzKTtcbiAgICAgIC8vIH1cbiAgICB9KTtcblxuICAgIHJldHVybiB7IG9iamVjdHM6IG9iamVjdHMudmFsdWUsIGlzVXBkYXRpbmc6IG9iamVjdHMuaXNVcGRhdGluZyB9O1xuICB9XG5cbiAgY29uc3QgdXNlT25lOiBVc2VPbmVIb29rPEM+ID1cbiAgPE0gZXh0ZW5kcyBNb2RlbCwgSURUeXBlIGV4dGVuZHMgQW55SURUeXBlPlxuICAobW9kZWxOYW1lOiBrZXlvZiBBW1wiZGF0YVwiXSwgb2JqZWN0SUQ6IElEVHlwZSB8IG51bGwpID0+IHtcbiAgICAvKiBRdWVyaWVzIGRhdGEgZm9yIHNwZWNpZmllZCBtb2RlbCwgbGlzdGVucyBmb3IgdXBkYXRlIGV2ZW50cyBhbmQgdXBkYXRlcyB0aGUgZGF0YXNldC4gKi9cblxuICAgIGNvbnN0IG9iamVjdCA9IHVzZUlQQ1ZhbHVlPHsgb2JqZWN0SUQ6IElEVHlwZSB8IG51bGwgfSwgeyBvYmplY3Q6IE0gfCBudWxsIH0+XG4gICAgKGBtb2RlbC0ke21vZGVsTmFtZX0tcmVhZC1vbmVgLCB7IG9iamVjdDogbnVsbCBhcyBNIHwgbnVsbCB9LCB7IG9iamVjdElEIH0pO1xuXG4gICAgdXNlSVBDRXZlbnQ8eyBpZHM/OiBzdHJpbmdbXSB9PihgbW9kZWwtJHttb2RlbE5hbWV9LW9iamVjdHMtY2hhbmdlZGAsIGZ1bmN0aW9uICh7IGlkcyB9KSB7XG4gICAgICBjb25zdCBzaG91bGRSZWZyZXNoID0gaWRzID09PSB1bmRlZmluZWQgfHwgaWRzLmluY2x1ZGVzKGAke29iamVjdElEfWApO1xuICAgICAgaWYgKHNob3VsZFJlZnJlc2gpIHtcbiAgICAgICAgb2JqZWN0LnJlZnJlc2goKTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIHJldHVybiB7XG4gICAgICBvYmplY3Q6IG9iamVjdC52YWx1ZS5vYmplY3QsXG4gICAgICBpc1VwZGF0aW5nOiBvYmplY3QuaXNVcGRhdGluZyxcbiAgICAgIHJlZnJlc2g6ICgpID0+IG9iamVjdC5yZWZyZXNoKCksXG4gICAgfTtcbiAgfVxuXG4gIC8vIEZldGNoIHRvcC1sZXZlbCBVSSBjb21wb25lbnQgY2xhc3MgYW5kIHJlbmRlciBpdC5cbiAgaWYgKGNvbXBvbmVudEltcG9ydGVyKSB7XG4gICAgKGFzeW5jICgpID0+IHtcbiAgICAgIC8vIFNob3cgbG9hZGluZyBpbmRpY2F0b3Igd2hpbGUgY29tcG9uZW50cyBhcmUgYmVpbmcgcmVzb2x2ZWRcbiAgICAgIFJlYWN0RE9NLnJlbmRlcig8U3Bpbm5lciAvPiwgYXBwUm9vdCk7XG5cbiAgICAgIGNvbnN0IGN0eFByb3ZpZGVyQ29uZmlnID0gY29uZmlnLmNvbnRleHRQcm92aWRlcnMgfHwgW107XG5cbiAgICAgIC8vIEdldCBwcm9wcyBwcmVzY3JpYmVkIGZvciBlYWNoIGNvbnRleHQgcHJvdmlkZXIgY29tcG9uZW50XG4gICAgICB2YXIgY3R4UHJvdmlkZXJQcm9wcyA9IGN0eFByb3ZpZGVyQ29uZmlnLm1hcChpdGVtID0+IGl0ZW0uZ2V0UHJvcHMoY29uZmlnKSk7XG5cbiAgICAgIGxvZy5zaWxseShcbiAgICAgICAgYEMvcmVuZGVyQXBwOiBSZXNvbHZpbmcgY29tcG9uZW50c2AsXG4gICAgICAgIGNvbXBvbmVudEltcG9ydGVyLCBjdHhQcm92aWRlckNvbmZpZyk7XG5cbiAgICAgIC8vIFJlc29sdmUgKGltcG9ydCkgY29tcG9uZW50cyBpbiBwYXJhbGxlbCwgZmlyc3QgVUkgYW5kIHRoZW4gY29udGV4dCBwcm92aWRlcnNcbiAgICAgIGNvbnN0IHByb21pc2VkQ29tcG9uZW50czogeyBkZWZhdWx0OiBSZWFjdC5GQzxhbnk+IH1bXSA9IGF3YWl0IFByb21pc2UuYWxsKFtcbiAgICAgICAgY29tcG9uZW50SW1wb3J0ZXIoKSxcbiAgICAgICAgLi4uY3R4UHJvdmlkZXJDb25maWcubWFwKGFzeW5jIChjdHhwKSA9PiBhd2FpdCBjdHhwLmNscygpKSxcbiAgICAgIF0pO1xuXG4gICAgICBsb2cuc2lsbHkoXG4gICAgICAgIGBDL3JlbmRlckFwcDogUmVzb2x2ZWQgY29tcG9uZW50c2AsXG4gICAgICAgIHByb21pc2VkQ29tcG9uZW50cyk7XG5cbiAgICAgIC8vIEJyZWFrIGRvd24gY29tcG9uZW50cyBpbnRvIHRvcC1sZXZlbCB3aW5kb3cgVUkgJiBjb250ZXh0IHByb3ZpZGVyc1xuICAgICAgY29uc3QgVG9wV2luZG93Q29tcG9uZW50ID0gcHJvbWlzZWRDb21wb25lbnRzWzBdLmRlZmF1bHQ7XG4gICAgICB2YXIgY3R4UHJvdmlkZXJDb21wb25lbnRzID0gcHJvbWlzZWRDb21wb25lbnRzLlxuICAgICAgICBzbGljZSgxLCBwcm9taXNlZENvbXBvbmVudHMubGVuZ3RoKS5cbiAgICAgICAgbWFwKGl0ZW0gPT4gaXRlbS5kZWZhdWx0KTtcblxuICAgICAgLy8gUmVvcmRlciBjb250ZXh0IHByb3ZpZGVycyBzbyB0aGF0IHRvcC1tb3N0IGlzIHRoZSBtb3N0IGJhc2ljXG4gICAgICBjdHhQcm92aWRlckNvbXBvbmVudHMucmV2ZXJzZSgpO1xuICAgICAgY3R4UHJvdmlkZXJQcm9wcy5yZXZlcnNlKCk7XG5cbiAgICAgIC8vIFdyaXRlIG91dCB0b3AtbGV2ZWwgd2luZG93IGNvbXBvbmVudCBKU1hcbiAgICAgIHZhciBhcHBNYXJrdXAgPSA8VG9wV2luZG93Q29tcG9uZW50IHF1ZXJ5PXtzZWFyY2hQYXJhbXN9IC8+O1xuXG4gICAgICBsb2cuZGVidWcoXG4gICAgICAgIGBDL3JlbmRlckFwcDogR290IGNvbnRleHQgcHJvdmlkZXIgY29tcG9uZW50c2AsXG4gICAgICAgIGN0eFByb3ZpZGVyQ29tcG9uZW50cyk7XG5cbiAgICAgIC8vIFdyYXAgdGhlIEpTWCBpbnRvIGNvbnRleHQgcHJvdmlkZXIgY29tcG9uZW50c1xuICAgICAgZm9yIChjb25zdCBbaWR4LCBDb250ZXh0UHJvdmlkZXJdIG9mIGN0eFByb3ZpZGVyQ29tcG9uZW50cy5lbnRyaWVzKCkpIHtcbiAgICAgICAgbG9nLnZlcmJvc2UoICBcbiAgICAgICAgICBgQy9yZW5kZXJBcHA6IEluaXRpYWxpemluZyBjb250ZXh0IHByb3ZpZGVyICMke2lkeH1gLFxuICAgICAgICAgIGN0eFByb3ZpZGVyQ29tcG9uZW50c1tpZHhdLFxuICAgICAgICAgIGN0eFByb3ZpZGVyUHJvcHNbaWR4XSk7XG5cbiAgICAgICAgYXBwTWFya3VwID0gKFxuICAgICAgICAgIDxDb250ZXh0UHJvdmlkZXIgey4uLmN0eFByb3ZpZGVyUHJvcHNbaWR4XX0+XG4gICAgICAgICAgICB7YXBwTWFya3VwfVxuICAgICAgICAgIDwvQ29udGV4dFByb3ZpZGVyPlxuICAgICAgICApO1xuICAgICAgfVxuXG4gICAgICBsb2cuZGVidWcoXCJDL3JlbmRlckFwcDogUmVuZGVyaW5nXCIpO1xuXG4gICAgICAvLyBSZW5kZXIgdGhlIEpTWFxuICAgICAgUmVhY3RET00ucmVuZGVyKGFwcE1hcmt1cCwgYXBwUm9vdCk7XG4gICAgfSkoKTtcblxuICAgIHJldHVybiB7XG4gICAgICByb290OiBhcHBSb290LFxuICAgICAgdXNlQ291bnQsXG4gICAgICB1c2VJRHMsXG4gICAgICB1c2VNYW55LFxuICAgICAgdXNlT25lLFxuICAgICAgb3BlblByZWRlZmluZWRXaW5kb3csXG4gICAgICBvcGVuT2JqZWN0RWRpdG9yLFxuICAgIH07XG5cbiAgfSBlbHNlIHtcbiAgICAvLyBDb21wb25lbnQgc3BlY2lmaWVkIGluIEdFVCBwYXJhbXMgaXMgbm90IHByZXNlbnQgaW4gYXBwIHJlbmRlcmVyIGNvbmZpZy5cbiAgICAvLyBUT0RPOiBIYW5kbGUgbWlzY29uZmlndXJlZCBSZWFjdCBjb250ZXh0IHByb3ZpZGVycyBhbmQgZmFpbGVkIGltcG9ydCBhdCBydW50aW1lXG4gICAgUmVhY3RET00ucmVuZGVyKDxOb25JZGVhbFN0YXRlXG4gICAgICBpY29uPVwiZXJyb3JcIlxuICAgICAgdGl0bGU9XCJVbmtub3duIGNvbXBvbmVudCByZXF1ZXN0ZWRcIiAvPiwgYXBwUm9vdCk7XG5cbiAgICBsb2cuZXJyb3IoXCJVbmtub3duIGNvbXBvbmVudCByZXF1ZXN0ZWRcIiwgY29tcG9uZW50SWQpO1xuICAgIHRocm93IG5ldyBFcnJvcihcIlVua25vd24gY29tcG9uZW50IHJlcXVlc3RlZFwiKTtcbiAgfVxuXG59OyJdfQ==