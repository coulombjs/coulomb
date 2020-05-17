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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVuZGVyZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zcmMvYXBwL3JlbmRlcmVyLnRzeCJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEtBQUssTUFBTSxPQUFPLENBQUM7QUFDMUIsT0FBTyxLQUFLLEdBQUcsTUFBTSxjQUFjLENBQUM7QUFDcEMsT0FBTyxLQUFLLFFBQVEsTUFBTSxXQUFXLENBQUM7QUFRdEMsT0FBTyxFQUFFLGFBQWEsRUFBRSxPQUFPLEVBQUUsTUFBTSxtQkFBbUIsQ0FBQztBQUUzRCxPQUFPLCtFQUErRSxDQUFDO0FBQ3ZGLE9BQU8sa0VBQWtFLENBQUM7QUFDMUUsT0FBTywwQ0FBMEMsQ0FBQztBQUNsRCxPQUFPLHlDQUF5QyxDQUFDO0FBQ2pELE9BQU8sRUFBRSxXQUFXLEVBQUUsV0FBVyxFQUFFLE9BQU8sRUFBRSxNQUFNLGlCQUFpQixDQUFDO0FBc0RwRSw0Q0FBNEM7QUFDNUMsOEVBQThFO0FBQzlFLHFEQUFxRDtBQUNyRCxNQUFNLENBQUMsTUFBTSxTQUFTLEdBQUcsQ0FBbUQsTUFBUyxFQUFrQixFQUFFO0lBRXZHLHdFQUF3RTtJQUN4RSxNQUFNLE9BQU8sR0FBRyxRQUFRLENBQUMsY0FBYyxDQUFDLEtBQUssQ0FBZ0IsQ0FBQztJQUU5RCxpREFBaUQ7SUFDakQsUUFBUSxDQUFDLGVBQWUsQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLGFBQWEsT0FBTyxDQUFDLFFBQVEsRUFBRSxDQUFDLENBQUM7SUFFeEUsMkRBQTJEO0lBQzNELE1BQU0sWUFBWSxHQUFHLElBQUksZUFBZSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsTUFBTSxDQUFDLENBQUM7SUFFakUsbUVBQW1FO0lBQ25FLE1BQU0sV0FBVyxHQUFHLFlBQVksQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUM7SUFDMUMsTUFBTSxpQkFBaUIsR0FBRyxXQUFXLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxnQkFBZ0IsQ0FBQyxX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QUcsQ0FBQyxLQUFLLENBQUMsNkJBQTZCLEVBQUUsV0FBVyxDQUFDLENBQUM7UUFDdEQsTUFBTSxJQUFJLEtBQUssQ0FBQyw2QkFBNkIsQ0FBQyxDQUFDO0tBQ2hEO0FBRUgsQ0FBQyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IFJlYWN0IGZyb20gJ3JlYWN0JztcbmltcG9ydCAqIGFzIGxvZyBmcm9tICdlbGVjdHJvbi1sb2cnO1xuaW1wb3J0ICogYXMgUmVhY3RET00gZnJvbSAncmVhY3QtZG9tJztcblxuaW1wb3J0IHsgQXBwQ29uZmlnIH0gZnJvbSAnLi4vY29uZmlnL2FwcCc7XG5pbXBvcnQgeyBSZW5kZXJlckNvbmZpZyB9IGZyb20gJy4uL2NvbmZpZy9yZW5kZXJlcic7XG5cbmltcG9ydCB7IE1vZGVsLCBBbnlJRFR5cGUgfSBmcm9tICcuLi9kYi9tb2RlbHMnO1xuaW1wb3J0IHsgSW5kZXggfSBmcm9tICcuLi9kYi9xdWVyeSc7XG5cbmltcG9ydCB7IE5vbklkZWFsU3RhdGUsIFNwaW5uZXIgfSBmcm9tICdAYmx1ZXByaW50anMvY29yZSc7XG5cbmltcG9ydCAnIXN0eWxlLWxvYWRlciFjc3MtbG9hZGVyIUBibHVlcHJpbnRqcy9kYXRldGltZS9saWIvY3NzL2JsdWVwcmludC1kYXRldGltZS5jc3MnO1xuaW1wb3J0ICchc3R5bGUtbG9hZGVyIWNzcy1sb2FkZXIhQGJsdWVwcmludGpzL2NvcmUvbGliL2Nzcy9ibHVlcHJpbnQuY3NzJztcbmltcG9ydCAnIXN0eWxlLWxvYWRlciFjc3MtbG9hZGVyIS4vbm9ybWFsaXplLmNzcyc7XG5pbXBvcnQgJyFzdHlsZS1sb2FkZXIhY3NzLWxvYWRlciEuL3JlbmRlcmVyLmNzcyc7XG5pbXBvcnQgeyB1c2VJUENFdmVudCwgdXNlSVBDVmFsdWUsIGNhbGxJUEMgfSBmcm9tICcuLi9pcGMvcmVuZGVyZXInO1xuXG5cbmludGVyZmFjZSBBcHBSZW5kZXJlcjxDIGV4dGVuZHMgUmVuZGVyZXJDb25maWc8YW55Pj4ge1xuICByb290OiBIVE1MRWxlbWVudFxuICB1c2VDb3VudDogVXNlQ291bnRIb29rPEM+XG4gIHVzZUlEczogVXNlSURzSG9vazxDPlxuICB1c2VNYW55OiBVc2VNYW55SG9vazxDPlxuICB1c2VPbmU6IFVzZU9uZUhvb2s8Qz5cblxuICBvcGVuUHJlZGVmaW5lZFdpbmRvdzpcbiAgICAod2luZG93SUQ6IGtleW9mIENbXCJhcHBcIl1bXCJ3aW5kb3dzXCJdLCBwYXJhbXM/OiBvYmplY3QpID0+IFByb21pc2U8dm9pZD5cblxuICBvcGVuT2JqZWN0RWRpdG9yOlxuICAgIChvYmplY3RUeXBlSUQ6IGtleW9mIENbXCJhcHBcIl1bXCJkYXRhXCJdLCBvYmplY3RJRDogYW55LCBwYXJhbXM/OiBzdHJpbmcpID0+IFByb21pc2U8dm9pZD5cbn1cblxuXG4vLyBEYXRhIG9wZXJhdGlvbiBob29rIGludGVyZmFjZXNcblxuaW50ZXJmYWNlIFVzZU1hbnlIb29rUmVzdWx0PE0gZXh0ZW5kcyBNb2RlbD4ge1xuICBvYmplY3RzOiBJbmRleDxNPlxuICBpc1VwZGF0aW5nOiBib29sZWFuXG59XG50eXBlIFVzZU1hbnlIb29rPEMgZXh0ZW5kcyBSZW5kZXJlckNvbmZpZzxhbnk+PiA9XG48TSBleHRlbmRzIE1vZGVsLCBRIGV4dGVuZHMgb2JqZWN0ID0ge30+XG4obW9kZWxOYW1lOiBrZXlvZiBDW1wiYXBwXCJdW1wiZGF0YVwiXSwgcXVlcnk/OiBRKSA9PiBVc2VNYW55SG9va1Jlc3VsdDxNPlxuXG5pbnRlcmZhY2UgVXNlSURzSG9va1Jlc3VsdDxJRFR5cGUgZXh0ZW5kcyBBbnlJRFR5cGU+IHtcbiAgaWRzOiBJRFR5cGVbXVxuICBpc1VwZGF0aW5nOiBib29sZWFuXG59XG50eXBlIFVzZUlEc0hvb2s8QyBleHRlbmRzIFJlbmRlcmVyQ29uZmlnPGFueT4+ID1cbjxJRFR5cGUgZXh0ZW5kcyBBbnlJRFR5cGUsIFEgZXh0ZW5kcyBvYmplY3QgPSB7fT5cbihtb2RlbE5hbWU6IGtleW9mIENbXCJhcHBcIl1bXCJkYXRhXCJdLCBxdWVyeT86IFEpID0+IFVzZUlEc0hvb2tSZXN1bHQ8SURUeXBlPlxuXG5pbnRlcmZhY2UgVXNlQ291bnRIb29rUmVzdWx0IHtcbiAgY291bnQ6IG51bWJlclxuICBpc1VwZGF0aW5nOiBib29sZWFuXG59XG50eXBlIFVzZUNvdW50SG9vazxDIGV4dGVuZHMgUmVuZGVyZXJDb25maWc8YW55Pj4gPVxuPFEgZXh0ZW5kcyBvYmplY3Q+XG4obW9kZWxOYW1lOiBrZXlvZiBDW1wiYXBwXCJdW1wiZGF0YVwiXSwgcXVlcnk6IFEpID0+IFVzZUNvdW50SG9va1Jlc3VsdFxuXG5pbnRlcmZhY2UgVXNlT25lSG9va1Jlc3VsdDxNIGV4dGVuZHMgTW9kZWw+IHtcbiAgb2JqZWN0OiBNIHwgbnVsbFxuICBpc1VwZGF0aW5nOiBib29sZWFuXG4gIHJlZnJlc2g6ICgpID0+IHZvaWRcbn1cbnR5cGUgVXNlT25lSG9vazxDIGV4dGVuZHMgUmVuZGVyZXJDb25maWc8YW55Pj4gPVxuPE0gZXh0ZW5kcyBNb2RlbCwgSURUeXBlIGV4dGVuZHMgQW55SURUeXBlPlxuKG1vZGVsTmFtZToga2V5b2YgQ1tcImFwcFwiXVtcImRhdGFcIl0sIG9iamVjdElEOiBJRFR5cGUgfCBudWxsKSA9PiBVc2VPbmVIb29rUmVzdWx0PE0+XG5cblxuLy8gUmVuZGVyIGFwcGxpY2F0aW9uIHNjcmVlbiBpbiBhIG5ldyB3aW5kb3dcbi8vIHdpdGggZ2l2ZW4gdG9wLWxldmVsIHdpbmRvdyBVSSBjb21wb25lbnQgYW5kIChpZiBhcHBsaWNhYmxlKSBhbnkgcGFyYW1ldGVyc1xuLy8gd3JhcHBlZCBpbiBjb25maWd1cmVkIGNvbnRleHQgcHJvdmlkZXIgY29tcG9uZW50cy5cbmV4cG9ydCBjb25zdCByZW5kZXJBcHAgPSA8QSBleHRlbmRzIEFwcENvbmZpZywgQyBleHRlbmRzIFJlbmRlcmVyQ29uZmlnPEE+Pihjb25maWc6IEMpOiBBcHBSZW5kZXJlcjxDPiA9PiB7XG5cbiAgLy8gZWxlY3Ryb24td2VicGFjayBndWFyYW50ZWVzIHByZXNlbmNlIG9mICNhcHAgaW4gaW5kZXguaHRtbCBpdCBidW5kbGVzXG4gIGNvbnN0IGFwcFJvb3QgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYXBwJykgYXMgSFRNTEVsZW1lbnQ7XG5cbiAgLy8gQWRkIGEgY2xhc3MgYWxsb3dpbmcgcGxhdGZvcm0tc3BlY2lmaWMgc3R5bGluZ1xuICBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuY2xhc3NMaXN0LmFkZChgcGxhdGZvcm0tLSR7cHJvY2Vzcy5wbGF0Zm9ybX1gKTtcblxuICAvLyBHZXQgYWxsIHBhcmFtcyBwYXNzZWQgdG8gdGhlIHdpbmRvdyB2aWEgR0VUIHF1ZXJ5IHN0cmluZ1xuICBjb25zdCBzZWFyY2hQYXJhbXMgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKHdpbmRvdy5sb2NhdGlvbi5zZWFyY2gpO1xuXG4gIC8vIFByZXBhcmUgZ2V0dGVyIGZvciByZXF1ZXN0ZWQgdG9wLWxldmVsIHdpbmRvdyBVSSBSZWFjdCBjb21wb25lbnRcbiAgY29uc3QgY29tcG9uZW50SWQgPSBzZWFyY2hQYXJhbXMuZ2V0KCdjJyk7XG4gIGNvbnN0IGNvbXBvbmVudEltcG9ydGVyID0gY29tcG9uZW50SWQgPyBjb25maWcud2luZG93Q29tcG9uZW50c1tjb21wb25lbnRJZF0gOiBudWxsO1xuXG4gIGxvZy5kZWJ1ZyhgUmVxdWVzdGVkIHdpbmRvdyBjb21wb25lbnQgJHtjb21wb25lbnRJZH1gKTtcblxuXG4gIGNvbnN0IG9wZW5PYmplY3RFZGl0b3IgPSBhc3luYyAoZGF0YVR5cGVJRDoga2V5b2YgQ1tcImFwcFwiXVtcImRhdGFcIl0sIG9iamVjdElEOiBhbnksIHBhcmFtcz86IHN0cmluZykgPT4ge1xuICAgIGlmIChjb25maWcub2JqZWN0RWRpdG9yV2luZG93cyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJObyBvYmplY3QgZWRpdG9yIHdpbmRvd3MgY29uZmlndXJlZFwiKTtcbiAgICB9XG4gICAgY29uc3Qgd2luZG93SUQgPSBjb25maWcub2JqZWN0RWRpdG9yV2luZG93c1tkYXRhVHlwZUlEXTtcbiAgICBjb25zdCB3aW5kb3dPcHRpb25zID0gY29uZmlnLmFwcC53aW5kb3dzW3dpbmRvd0lEIGFzIGtleW9mIHR5cGVvZiBjb25maWcuYXBwLndpbmRvd3NdO1xuICAgIGlmICh3aW5kb3dJRCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJPYmplY3QgZWRpdG9yIHdpbmRvdyBub3QgY29uZmlndXJlZFwiKTtcbiAgICB9XG4gICAgYXdhaXQgY2FsbElQQygnb3Blbi1wcmVkZWZpbmVkLXdpbmRvdycsIHtcbiAgICAgIGlkOiB3aW5kb3dJRCxcbiAgICAgIHBhcmFtczoge1xuICAgICAgICBjb21wb25lbnRQYXJhbXM6IGBvYmplY3RJRD0ke29iamVjdElEfSYke3BhcmFtcyB8fCAnJ31gLFxuICAgICAgICB0aXRsZTogYCR7d2luZG93T3B0aW9ucy5vcGVuZXJQYXJhbXMudGl0bGV9ICgke29iamVjdElEfSlgLFxuICAgICAgfSxcbiAgICB9KTtcbiAgfTtcblxuICBjb25zdCBvcGVuUHJlZGVmaW5lZFdpbmRvdyA9IGFzeW5jICh3aW5kb3dJRDoga2V5b2YgdHlwZW9mIGNvbmZpZ1tcImFwcFwiXVtcIndpbmRvd3NcIl0sIHBhcmFtcz86IG9iamVjdCkgPT4ge1xuICAgIGF3YWl0IGNhbGxJUEMoJ29wZW4tcHJlZGVmaW5lZC13aW5kb3cnLCB7XG4gICAgICBpZDogd2luZG93SUQsXG4gICAgICBwYXJhbXM6IHBhcmFtcyB8fCB7fSxcbiAgICB9KTtcbiAgfTtcblxuXG4gIC8vIFRPRE86IFJlZmFjdG9yIG91dCBob29rIGluaXRpYWxpemF0aW9uXG5cbiAgY29uc3QgdXNlSURzOiBVc2VJRHNIb29rPEM+ID1cbiAgPElEVHlwZSBleHRlbmRzIEFueUlEVHlwZSwgUSBleHRlbmRzIG9iamVjdCA9IHt9PlxuICAobW9kZWxOYW1lOiBrZXlvZiBBW1wiZGF0YVwiXSwgcXVlcnk/OiBRKSA9PiB7XG4gICAgLyogUXVlcmllcyBkYXRhIGZvciBzcGVjaWZpZWQgbW9kZWwsIGxpc3RlbnMgZm9yIHVwZGF0ZSBldmVudHMgYW5kIHVwZGF0ZXMgdGhlIGRhdGFzZXQuICovXG5cbiAgICBjb25zdCB0cmFja2VkSURzID0gdXNlSVBDVmFsdWU8USwgeyBpZHM6IElEVHlwZVtdIH0+XG4gICAgKGBtb2RlbC0ke21vZGVsTmFtZX0tbGlzdC1pZHNgLCB7IGlkczogW10gfSwgcXVlcnkpO1xuXG4gICAgdXNlSVBDRXZlbnQ8eyBpZHM/OiBzdHJpbmdbXSB9PihgbW9kZWwtJHttb2RlbE5hbWV9LW9iamVjdHMtY2hhbmdlZGAsIGZ1bmN0aW9uICh7IGlkcyB9KSB7XG4gICAgICB0cmFja2VkSURzLnJlZnJlc2goKTtcblxuICAgICAgLy8gU2VlIFRPRE8gYXQgdXNlTWFueSgpLlxuICAgICAgLy9jb25zdCBzdHJpbmdJRHMgPSB0cmFja2VkSURzLnZhbHVlLmlkcy5tYXAoaWQgPT4gYCR7aWR9YCk7XG4gICAgICAvL2NvbnN0IHNob3VsZFJlZnJlc2ggPSBpZHMgIT09IHVuZGVmaW5lZFxuICAgICAgLy8gID8gaWRzLmZpbHRlcihpZCA9PiBzdHJpbmdJRHMuaW5jbHVkZXMoaWQpKS5sZW5ndGggPiAwXG4gICAgICAvLyAgOiB0cnVlO1xuICAgICAgLy9pZiAoc2hvdWxkUmVmcmVzaCkge1xuICAgICAgLy8gIHRyYWNrZWRJRHMucmVmcmVzaCgpO1xuICAgICAgLy99XG4gICAgfSk7XG5cbiAgICByZXR1cm4geyBpZHM6IHRyYWNrZWRJRHMudmFsdWUuaWRzLCBpc1VwZGF0aW5nOiB0cmFja2VkSURzLmlzVXBkYXRpbmcgfTtcbiAgfVxuXG4gIGNvbnN0IHVzZUNvdW50OiBVc2VDb3VudEhvb2s8Qz4gPVxuICA8USBleHRlbmRzIG9iamVjdCA9IGFueT5cbiAgKG1vZGVsTmFtZToga2V5b2YgQVtcImRhdGFcIl0sIHF1ZXJ5PzogUSkgPT4ge1xuICAgIC8qIFF1ZXJpZXMgZGF0YSBmb3Igc3BlY2lmaWVkIG1vZGVsLCBsaXN0ZW5zIGZvciB1cGRhdGUgZXZlbnRzIGFuZCB1cGRhdGVzIHRoZSBkYXRhc2V0LiAqL1xuXG4gICAgY29uc3QgY291bnQgPSB1c2VJUENWYWx1ZTxRLCB7IGNvdW50OiBudW1iZXIgfT5cbiAgICAoYG1vZGVsLSR7bW9kZWxOYW1lfS1jb3VudGAsIHsgY291bnQ6IDAgfSwgcXVlcnkpO1xuXG4gICAgdXNlSVBDRXZlbnQ8eyBpZHM/OiBzdHJpbmdbXSB9PihgbW9kZWwtJHttb2RlbE5hbWV9LW9iamVjdHMtY2hhbmdlZGAsIGZ1bmN0aW9uICgpIHtcbiAgICAgIGNvdW50LnJlZnJlc2goKTtcbiAgICB9KTtcblxuICAgIHJldHVybiB7IGNvdW50OiBjb3VudC52YWx1ZS5jb3VudCwgaXNVcGRhdGluZzogY291bnQuaXNVcGRhdGluZyB9O1xuICB9XG5cbiAgY29uc3QgdXNlTWFueTogVXNlTWFueUhvb2s8Qz4gPVxuICA8TSBleHRlbmRzIE1vZGVsLCBRIGV4dGVuZHMgb2JqZWN0ID0ge30+XG4gIChtb2RlbE5hbWU6IGtleW9mIEFbXCJkYXRhXCJdLCBxdWVyeT86IFEpID0+IHtcbiAgICAvKiBRdWVyaWVzIGRhdGEgZm9yIHNwZWNpZmllZCBtb2RlbCwgbGlzdGVucyBmb3IgdXBkYXRlIGV2ZW50cyBhbmQgdXBkYXRlcyB0aGUgZGF0YXNldC4gKi9cblxuICAgIGNvbnN0IG9iamVjdHMgPSB1c2VJUENWYWx1ZTxRLCBJbmRleDxNPj5cbiAgICAoYG1vZGVsLSR7bW9kZWxOYW1lfS1yZWFkLWFsbGAsIHt9LCBxdWVyeSk7XG5cbiAgICB1c2VJUENFdmVudDx7IGlkcz86IHN0cmluZ1tdIH0+KGBtb2RlbC0ke21vZGVsTmFtZX0tb2JqZWN0cy1jaGFuZ2VkYCwgZnVuY3Rpb24gKHsgaWRzIH0pIHtcbiAgICAgIC8vIFRPRE86IGdlbmVyaWMgcXVlcnkgcmVmcmVzaCBJUEMgZXZlbnQvaG9vaz9cblxuICAgICAgb2JqZWN0cy5yZWZyZXNoKCk7XG5cbiAgICAgIC8vIFRPRE86IE9ubHkgcmVmcmVzaCB3aGVuIG5lZWRlZC5cbiAgICAgIC8vIEJlbG93IGNvZGUgd29ya3MsIGV4Y2VwdCBpdCB3b27igJl0IHRyaWdnZXIgcmVmcmVzaFxuICAgICAgLy8gd2hlbiBuZXcgb2JqZWN0cyBhcmUgYWRkZWQ6XG4gICAgICAvLyBsb2cuc2lsbHkoXCJDL3JlbmRlckFwcDogQ2hhbmdlZCBvYmplY3QgSURzXCIsIGlkcyk7XG4gICAgICAvLyBjb25zdCB0cmFja2VkT2JqZWN0SURzID0gT2JqZWN0LmtleXMob2JqZWN0cy52YWx1ZSk7XG4gICAgICAvLyBjb25zdCBzaG91bGRSZWZyZXNoID0gaWRzID09PSB1bmRlZmluZWQgfHwgaWRzLmZpbHRlcihpZCA9PiB0cmFja2VkT2JqZWN0SURzLmluY2x1ZGVzKGlkKSkubGVuZ3RoID4gMDtcbiAgICAgIC8vIGlmIChzaG91bGRSZWZyZXNoKSB7XG4gICAgICAvLyAgIGxvZy5kZWJ1ZyhcIkMvcmVuZGVyQXBwOiBSZWZyZXNoaW5nIG9iamVjdHNcIiwgaWRzKTtcbiAgICAgIC8vICAgb2JqZWN0cy5yZWZyZXNoKCk7XG4gICAgICAvLyB9IGVsc2Uge1xuICAgICAgLy8gICBsb2cuZGVidWcoXCJDL3JlbmRlckFwcDogV2lsbCBub3QgcmVmcmVzaCBvYmplY3RzXCIsIGlkcyk7XG4gICAgICAvLyB9XG4gICAgfSk7XG5cbiAgICByZXR1cm4geyBvYmplY3RzOiBvYmplY3RzLnZhbHVlLCBpc1VwZGF0aW5nOiBvYmplY3RzLmlzVXBkYXRpbmcgfTtcbiAgfVxuXG4gIGNvbnN0IHVzZU9uZTogVXNlT25lSG9vazxDPiA9XG4gIDxNIGV4dGVuZHMgTW9kZWwsIElEVHlwZSBleHRlbmRzIEFueUlEVHlwZT5cbiAgKG1vZGVsTmFtZToga2V5b2YgQVtcImRhdGFcIl0sIG9iamVjdElEOiBJRFR5cGUgfCBudWxsKSA9PiB7XG4gICAgLyogUXVlcmllcyBkYXRhIGZvciBzcGVjaWZpZWQgbW9kZWwsIGxpc3RlbnMgZm9yIHVwZGF0ZSBldmVudHMgYW5kIHVwZGF0ZXMgdGhlIGRhdGFzZXQuICovXG5cbiAgICBjb25zdCBvYmplY3QgPSB1c2VJUENWYWx1ZTx7IG9iamVjdElEOiBJRFR5cGUgfCBudWxsIH0sIHsgb2JqZWN0OiBNIHwgbnVsbCB9PlxuICAgIChgbW9kZWwtJHttb2RlbE5hbWV9LXJlYWQtb25lYCwgeyBvYmplY3Q6IG51bGwgYXMgTSB8IG51bGwgfSwgeyBvYmplY3RJRCB9KTtcblxuICAgIHVzZUlQQ0V2ZW50PHsgaWRzPzogc3RyaW5nW10gfT4oYG1vZGVsLSR7bW9kZWxOYW1lfS1vYmplY3RzLWNoYW5nZWRgLCBmdW5jdGlvbiAoeyBpZHMgfSkge1xuICAgICAgY29uc3Qgc2hvdWxkUmVmcmVzaCA9IGlkcyA9PT0gdW5kZWZpbmVkIHx8IGlkcy5pbmNsdWRlcyhgJHtvYmplY3RJRH1gKTtcbiAgICAgIGlmIChzaG91bGRSZWZyZXNoKSB7XG4gICAgICAgIG9iamVjdC5yZWZyZXNoKCk7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICByZXR1cm4ge1xuICAgICAgb2JqZWN0OiBvYmplY3QudmFsdWUub2JqZWN0LFxuICAgICAgaXNVcGRhdGluZzogb2JqZWN0LmlzVXBkYXRpbmcsXG4gICAgICByZWZyZXNoOiAoKSA9PiBvYmplY3QucmVmcmVzaCgpLFxuICAgIH07XG4gIH1cblxuICAvLyBGZXRjaCB0b3AtbGV2ZWwgVUkgY29tcG9uZW50IGNsYXNzIGFuZCByZW5kZXIgaXQuXG4gIGlmIChjb21wb25lbnRJbXBvcnRlcikge1xuICAgIChhc3luYyAoKSA9PiB7XG4gICAgICAvLyBTaG93IGxvYWRpbmcgaW5kaWNhdG9yIHdoaWxlIGNvbXBvbmVudHMgYXJlIGJlaW5nIHJlc29sdmVkXG4gICAgICBSZWFjdERPTS5yZW5kZXIoPFNwaW5uZXIgY2xhc3NOYW1lPVwiaW5pdGlhbC1zcGlubmVyXCIgLz4sIGFwcFJvb3QpO1xuXG4gICAgICBjb25zdCBjdHhQcm92aWRlckNvbmZpZyA9IGNvbmZpZy5jb250ZXh0UHJvdmlkZXJzIHx8IFtdO1xuXG4gICAgICAvLyBHZXQgcHJvcHMgcHJlc2NyaWJlZCBmb3IgZWFjaCBjb250ZXh0IHByb3ZpZGVyIGNvbXBvbmVudFxuICAgICAgdmFyIGN0eFByb3ZpZGVyUHJvcHMgPSBjdHhQcm92aWRlckNvbmZpZy5tYXAoaXRlbSA9PiBpdGVtLmdldFByb3BzKGNvbmZpZykpO1xuXG4gICAgICBsb2cuc2lsbHkoXG4gICAgICAgIGBDL3JlbmRlckFwcDogUmVzb2x2aW5nIGNvbXBvbmVudHNgLFxuICAgICAgICBjb21wb25lbnRJbXBvcnRlciwgY3R4UHJvdmlkZXJDb25maWcpO1xuXG4gICAgICAvLyBSZXNvbHZlIChpbXBvcnQpIGNvbXBvbmVudHMgaW4gcGFyYWxsZWwsIGZpcnN0IFVJIGFuZCB0aGVuIGNvbnRleHQgcHJvdmlkZXJzXG4gICAgICBjb25zdCBwcm9taXNlZENvbXBvbmVudHM6IHsgZGVmYXVsdDogUmVhY3QuRkM8YW55PiB9W10gPSBhd2FpdCBQcm9taXNlLmFsbChbXG4gICAgICAgIGNvbXBvbmVudEltcG9ydGVyKCksXG4gICAgICAgIC4uLmN0eFByb3ZpZGVyQ29uZmlnLm1hcChhc3luYyAoY3R4cCkgPT4gYXdhaXQgY3R4cC5jbHMoKSksXG4gICAgICBdKTtcblxuICAgICAgbG9nLnNpbGx5KFxuICAgICAgICBgQy9yZW5kZXJBcHA6IFJlc29sdmVkIGNvbXBvbmVudHNgLFxuICAgICAgICBwcm9taXNlZENvbXBvbmVudHMpO1xuXG4gICAgICAvLyBCcmVhayBkb3duIGNvbXBvbmVudHMgaW50byB0b3AtbGV2ZWwgd2luZG93IFVJICYgY29udGV4dCBwcm92aWRlcnNcbiAgICAgIGNvbnN0IFRvcFdpbmRvd0NvbXBvbmVudCA9IHByb21pc2VkQ29tcG9uZW50c1swXS5kZWZhdWx0O1xuICAgICAgdmFyIGN0eFByb3ZpZGVyQ29tcG9uZW50cyA9IHByb21pc2VkQ29tcG9uZW50cy5cbiAgICAgICAgc2xpY2UoMSwgcHJvbWlzZWRDb21wb25lbnRzLmxlbmd0aCkuXG4gICAgICAgIG1hcChpdGVtID0+IGl0ZW0uZGVmYXVsdCk7XG5cbiAgICAgIC8vIFJlb3JkZXIgY29udGV4dCBwcm92aWRlcnMgc28gdGhhdCB0b3AtbW9zdCBpcyB0aGUgbW9zdCBiYXNpY1xuICAgICAgY3R4UHJvdmlkZXJDb21wb25lbnRzLnJldmVyc2UoKTtcbiAgICAgIGN0eFByb3ZpZGVyUHJvcHMucmV2ZXJzZSgpO1xuXG4gICAgICAvLyBXcml0ZSBvdXQgdG9wLWxldmVsIHdpbmRvdyBjb21wb25lbnQgSlNYXG4gICAgICB2YXIgYXBwTWFya3VwID0gPFRvcFdpbmRvd0NvbXBvbmVudCBxdWVyeT17c2VhcmNoUGFyYW1zfSAvPjtcblxuICAgICAgbG9nLmRlYnVnKFxuICAgICAgICBgQy9yZW5kZXJBcHA6IEdvdCBjb250ZXh0IHByb3ZpZGVyIGNvbXBvbmVudHNgLFxuICAgICAgICBjdHhQcm92aWRlckNvbXBvbmVudHMpO1xuXG4gICAgICAvLyBXcmFwIHRoZSBKU1ggaW50byBjb250ZXh0IHByb3ZpZGVyIGNvbXBvbmVudHNcbiAgICAgIGZvciAoY29uc3QgW2lkeCwgQ29udGV4dFByb3ZpZGVyXSBvZiBjdHhQcm92aWRlckNvbXBvbmVudHMuZW50cmllcygpKSB7XG4gICAgICAgIGxvZy52ZXJib3NlKCAgXG4gICAgICAgICAgYEMvcmVuZGVyQXBwOiBJbml0aWFsaXppbmcgY29udGV4dCBwcm92aWRlciAjJHtpZHh9YCxcbiAgICAgICAgICBjdHhQcm92aWRlckNvbXBvbmVudHNbaWR4XSxcbiAgICAgICAgICBjdHhQcm92aWRlclByb3BzW2lkeF0pO1xuXG4gICAgICAgIGFwcE1hcmt1cCA9IChcbiAgICAgICAgICA8Q29udGV4dFByb3ZpZGVyIHsuLi5jdHhQcm92aWRlclByb3BzW2lkeF19PlxuICAgICAgICAgICAge2FwcE1hcmt1cH1cbiAgICAgICAgICA8L0NvbnRleHRQcm92aWRlcj5cbiAgICAgICAgKTtcbiAgICAgIH1cblxuICAgICAgbG9nLmRlYnVnKFwiQy9yZW5kZXJBcHA6IFJlbmRlcmluZ1wiKTtcblxuICAgICAgLy8gUmVuZGVyIHRoZSBKU1hcbiAgICAgIFJlYWN0RE9NLnJlbmRlcihhcHBNYXJrdXAsIGFwcFJvb3QpO1xuICAgIH0pKCk7XG5cbiAgICByZXR1cm4ge1xuICAgICAgcm9vdDogYXBwUm9vdCxcbiAgICAgIHVzZUNvdW50LFxuICAgICAgdXNlSURzLFxuICAgICAgdXNlTWFueSxcbiAgICAgIHVzZU9uZSxcbiAgICAgIG9wZW5QcmVkZWZpbmVkV2luZG93LFxuICAgICAgb3Blbk9iamVjdEVkaXRvcixcbiAgICB9O1xuXG4gIH0gZWxzZSB7XG4gICAgLy8gQ29tcG9uZW50IHNwZWNpZmllZCBpbiBHRVQgcGFyYW1zIGlzIG5vdCBwcmVzZW50IGluIGFwcCByZW5kZXJlciBjb25maWcuXG4gICAgLy8gVE9ETzogSGFuZGxlIG1pc2NvbmZpZ3VyZWQgUmVhY3QgY29udGV4dCBwcm92aWRlcnMgYW5kIGZhaWxlZCBpbXBvcnQgYXQgcnVudGltZVxuICAgIFJlYWN0RE9NLnJlbmRlcig8Tm9uSWRlYWxTdGF0ZVxuICAgICAgaWNvbj1cImVycm9yXCJcbiAgICAgIHRpdGxlPVwiVW5rbm93biBjb21wb25lbnQgcmVxdWVzdGVkXCIgLz4sIGFwcFJvb3QpO1xuXG4gICAgbG9nLmVycm9yKFwiVW5rbm93biBjb21wb25lbnQgcmVxdWVzdGVkXCIsIGNvbXBvbmVudElkKTtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJVbmtub3duIGNvbXBvbmVudCByZXF1ZXN0ZWRcIik7XG4gIH1cblxufTsiXX0=