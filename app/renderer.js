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
        }, [objectID]);
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
            var ctxProviderProps = await Promise.all(ctxProviderConfig.map(item => item.getProps(config)));
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVuZGVyZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zcmMvYXBwL3JlbmRlcmVyLnRzeCJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEtBQUssR0FBRyxNQUFNLGNBQWMsQ0FBQztBQUNwQyxPQUFPLEtBQUssTUFBTSxPQUFPLENBQUM7QUFDMUIsT0FBTyxLQUFLLFFBQVEsTUFBTSxXQUFXLENBQUM7QUFFdEMsT0FBTyxFQUFFLGFBQWEsRUFBRSxPQUFPLEVBQUUsTUFBTSxtQkFBbUIsQ0FBQztBQU8zRCxPQUFPLCtFQUErRSxDQUFDO0FBQ3ZGLE9BQU8sa0VBQWtFLENBQUM7QUFDMUUsT0FBTywwQ0FBMEMsQ0FBQztBQUNsRCxPQUFPLHlDQUF5QyxDQUFDO0FBQ2pELE9BQU8sRUFBRSxXQUFXLEVBQUUsV0FBVyxFQUFFLE9BQU8sRUFBRSxNQUFNLGlCQUFpQixDQUFDO0FBc0RwRSw0Q0FBNEM7QUFDNUMsOEVBQThFO0FBQzlFLHFEQUFxRDtBQUNyRCxNQUFNLENBQUMsTUFBTSxTQUFTLEdBQUcsQ0FBbUQsTUFBUyxFQUFrQixFQUFFO0lBRXZHLHdFQUF3RTtJQUN4RSxNQUFNLE9BQU8sR0FBRyxRQUFRLENBQUMsY0FBYyxDQUFDLEtBQUssQ0FBZ0IsQ0FBQztJQUU5RCxpREFBaUQ7SUFDakQsUUFBUSxDQUFDLGVBQWUsQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLGFBQWEsT0FBTyxDQUFDLFFBQVEsRUFBRSxDQUFDLENBQUM7SUFFeEUsMkRBQTJEO0lBQzNELE1BQU0sWUFBWSxHQUFHLElBQUksZUFBZSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsTUFBTSxDQUFDLENBQUM7SUFFakUsbUVBQW1FO0lBQ25FLE1BQU0sV0FBVyxHQUFHLFlBQVksQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUM7SUFDMUMsTUFBTSxpQkFBaUIsR0FBRyxXQUFXLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxnQkFBZ0IsQ0FBQyxX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S0FBSyxFQUFDLDZCQUE2QixHQUFHLEVBQUUsT0FBTyxDQUFDLENBQUM7UUFFbkQsR0FBRyxDQUFDLEtBQUssQ0FBQyw2QkFBNkIsRUFBRSxXQUFXLENBQUMsQ0FBQztRQUN0RCxNQUFNLElBQUksS0FBSyxDQUFDLDZCQUE2QixDQUFDLENBQUM7S0FDaEQ7QUFFSCxDQUFDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBsb2cgZnJvbSAnZWxlY3Ryb24tbG9nJztcbmltcG9ydCBSZWFjdCBmcm9tICdyZWFjdCc7XG5pbXBvcnQgKiBhcyBSZWFjdERPTSBmcm9tICdyZWFjdC1kb20nO1xuXG5pbXBvcnQgeyBOb25JZGVhbFN0YXRlLCBTcGlubmVyIH0gZnJvbSAnQGJsdWVwcmludGpzL2NvcmUnO1xuXG5pbXBvcnQgeyBBcHBDb25maWcgfSBmcm9tICcuLi9jb25maWcvYXBwJztcbmltcG9ydCB7IFJlbmRlcmVyQ29uZmlnIH0gZnJvbSAnLi4vY29uZmlnL3JlbmRlcmVyJztcbmltcG9ydCB7IE1vZGVsLCBBbnlJRFR5cGUgfSBmcm9tICcuLi9kYi9tb2RlbHMnO1xuaW1wb3J0IHsgSW5kZXggfSBmcm9tICcuLi9kYi9xdWVyeSc7XG5cbmltcG9ydCAnIXN0eWxlLWxvYWRlciFjc3MtbG9hZGVyIUBibHVlcHJpbnRqcy9kYXRldGltZS9saWIvY3NzL2JsdWVwcmludC1kYXRldGltZS5jc3MnO1xuaW1wb3J0ICchc3R5bGUtbG9hZGVyIWNzcy1sb2FkZXIhQGJsdWVwcmludGpzL2NvcmUvbGliL2Nzcy9ibHVlcHJpbnQuY3NzJztcbmltcG9ydCAnIXN0eWxlLWxvYWRlciFjc3MtbG9hZGVyIS4vbm9ybWFsaXplLmNzcyc7XG5pbXBvcnQgJyFzdHlsZS1sb2FkZXIhY3NzLWxvYWRlciEuL3JlbmRlcmVyLmNzcyc7XG5pbXBvcnQgeyB1c2VJUENFdmVudCwgdXNlSVBDVmFsdWUsIGNhbGxJUEMgfSBmcm9tICcuLi9pcGMvcmVuZGVyZXInO1xuXG5cbmludGVyZmFjZSBBcHBSZW5kZXJlcjxDIGV4dGVuZHMgUmVuZGVyZXJDb25maWc8YW55Pj4ge1xuICByb290OiBIVE1MRWxlbWVudFxuICB1c2VDb3VudDogVXNlQ291bnRIb29rPEM+XG4gIHVzZUlEczogVXNlSURzSG9vazxDPlxuICB1c2VNYW55OiBVc2VNYW55SG9vazxDPlxuICB1c2VPbmU6IFVzZU9uZUhvb2s8Qz5cblxuICBvcGVuUHJlZGVmaW5lZFdpbmRvdzpcbiAgICAod2luZG93SUQ6IGtleW9mIENbXCJhcHBcIl1bXCJ3aW5kb3dzXCJdLCBwYXJhbXM/OiBvYmplY3QpID0+IFByb21pc2U8dm9pZD5cblxuICBvcGVuT2JqZWN0RWRpdG9yOlxuICAgIChvYmplY3RUeXBlSUQ6IGtleW9mIENbXCJhcHBcIl1bXCJkYXRhXCJdLCBvYmplY3RJRDogYW55LCBwYXJhbXM/OiBzdHJpbmcpID0+IFByb21pc2U8dm9pZD5cbn1cblxuXG4vLyBEYXRhIG9wZXJhdGlvbiBob29rIGludGVyZmFjZXNcblxuaW50ZXJmYWNlIFVzZU1hbnlIb29rUmVzdWx0PE0gZXh0ZW5kcyBNb2RlbD4ge1xuICBvYmplY3RzOiBJbmRleDxNPlxuICBpc1VwZGF0aW5nOiBib29sZWFuXG59XG50eXBlIFVzZU1hbnlIb29rPEMgZXh0ZW5kcyBSZW5kZXJlckNvbmZpZzxhbnk+PiA9XG48TSBleHRlbmRzIE1vZGVsLCBRIGV4dGVuZHMgb2JqZWN0ID0ge30+XG4obW9kZWxOYW1lOiBrZXlvZiBDW1wiYXBwXCJdW1wiZGF0YVwiXSwgcXVlcnk/OiBRKSA9PiBVc2VNYW55SG9va1Jlc3VsdDxNPlxuXG5pbnRlcmZhY2UgVXNlSURzSG9va1Jlc3VsdDxJRFR5cGUgZXh0ZW5kcyBBbnlJRFR5cGU+IHtcbiAgaWRzOiBJRFR5cGVbXVxuICBpc1VwZGF0aW5nOiBib29sZWFuXG59XG50eXBlIFVzZUlEc0hvb2s8QyBleHRlbmRzIFJlbmRlcmVyQ29uZmlnPGFueT4+ID1cbjxJRFR5cGUgZXh0ZW5kcyBBbnlJRFR5cGUsIFEgZXh0ZW5kcyBvYmplY3QgPSB7fT5cbihtb2RlbE5hbWU6IGtleW9mIENbXCJhcHBcIl1bXCJkYXRhXCJdLCBxdWVyeT86IFEpID0+IFVzZUlEc0hvb2tSZXN1bHQ8SURUeXBlPlxuXG5pbnRlcmZhY2UgVXNlQ291bnRIb29rUmVzdWx0IHtcbiAgY291bnQ6IG51bWJlclxuICBpc1VwZGF0aW5nOiBib29sZWFuXG59XG50eXBlIFVzZUNvdW50SG9vazxDIGV4dGVuZHMgUmVuZGVyZXJDb25maWc8YW55Pj4gPVxuPFEgZXh0ZW5kcyBvYmplY3Q+XG4obW9kZWxOYW1lOiBrZXlvZiBDW1wiYXBwXCJdW1wiZGF0YVwiXSwgcXVlcnk6IFEpID0+IFVzZUNvdW50SG9va1Jlc3VsdFxuXG5pbnRlcmZhY2UgVXNlT25lSG9va1Jlc3VsdDxNIGV4dGVuZHMgTW9kZWw+IHtcbiAgb2JqZWN0OiBNIHwgbnVsbFxuICBpc1VwZGF0aW5nOiBib29sZWFuXG4gIHJlZnJlc2g6ICgpID0+IHZvaWRcbn1cbnR5cGUgVXNlT25lSG9vazxDIGV4dGVuZHMgUmVuZGVyZXJDb25maWc8YW55Pj4gPVxuPE0gZXh0ZW5kcyBNb2RlbCwgSURUeXBlIGV4dGVuZHMgQW55SURUeXBlPlxuKG1vZGVsTmFtZToga2V5b2YgQ1tcImFwcFwiXVtcImRhdGFcIl0sIG9iamVjdElEOiBJRFR5cGUgfCBudWxsKSA9PiBVc2VPbmVIb29rUmVzdWx0PE0+XG5cblxuLy8gUmVuZGVyIGFwcGxpY2F0aW9uIHNjcmVlbiBpbiBhIG5ldyB3aW5kb3dcbi8vIHdpdGggZ2l2ZW4gdG9wLWxldmVsIHdpbmRvdyBVSSBjb21wb25lbnQgYW5kIChpZiBhcHBsaWNhYmxlKSBhbnkgcGFyYW1ldGVyc1xuLy8gd3JhcHBlZCBpbiBjb25maWd1cmVkIGNvbnRleHQgcHJvdmlkZXIgY29tcG9uZW50cy5cbmV4cG9ydCBjb25zdCByZW5kZXJBcHAgPSA8QSBleHRlbmRzIEFwcENvbmZpZywgQyBleHRlbmRzIFJlbmRlcmVyQ29uZmlnPEE+Pihjb25maWc6IEMpOiBBcHBSZW5kZXJlcjxDPiA9PiB7XG5cbiAgLy8gZWxlY3Ryb24td2VicGFjayBndWFyYW50ZWVzIHByZXNlbmNlIG9mICNhcHAgaW4gaW5kZXguaHRtbCBpdCBidW5kbGVzXG4gIGNvbnN0IGFwcFJvb3QgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYXBwJykgYXMgSFRNTEVsZW1lbnQ7XG5cbiAgLy8gQWRkIGEgY2xhc3MgYWxsb3dpbmcgcGxhdGZvcm0tc3BlY2lmaWMgc3R5bGluZ1xuICBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuY2xhc3NMaXN0LmFkZChgcGxhdGZvcm0tLSR7cHJvY2Vzcy5wbGF0Zm9ybX1gKTtcblxuICAvLyBHZXQgYWxsIHBhcmFtcyBwYXNzZWQgdG8gdGhlIHdpbmRvdyB2aWEgR0VUIHF1ZXJ5IHN0cmluZ1xuICBjb25zdCBzZWFyY2hQYXJhbXMgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKHdpbmRvdy5sb2NhdGlvbi5zZWFyY2gpO1xuXG4gIC8vIFByZXBhcmUgZ2V0dGVyIGZvciByZXF1ZXN0ZWQgdG9wLWxldmVsIHdpbmRvdyBVSSBSZWFjdCBjb21wb25lbnRcbiAgY29uc3QgY29tcG9uZW50SWQgPSBzZWFyY2hQYXJhbXMuZ2V0KCdjJyk7XG4gIGNvbnN0IGNvbXBvbmVudEltcG9ydGVyID0gY29tcG9uZW50SWQgPyBjb25maWcud2luZG93Q29tcG9uZW50c1tjb21wb25lbnRJZF0gOiBudWxsO1xuXG4gIGxvZy5kZWJ1ZyhgUmVxdWVzdGVkIHdpbmRvdyBjb21wb25lbnQgJHtjb21wb25lbnRJZH1gKTtcblxuXG4gIGNvbnN0IG9wZW5PYmplY3RFZGl0b3IgPSBhc3luYyAoZGF0YVR5cGVJRDoga2V5b2YgQ1tcImFwcFwiXVtcImRhdGFcIl0sIG9iamVjdElEOiBhbnksIHBhcmFtcz86IHN0cmluZykgPT4ge1xuICAgIGlmIChjb25maWcub2JqZWN0RWRpdG9yV2luZG93cyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJObyBvYmplY3QgZWRpdG9yIHdpbmRvd3MgY29uZmlndXJlZFwiKTtcbiAgICB9XG4gICAgY29uc3Qgd2luZG93SUQgPSBjb25maWcub2JqZWN0RWRpdG9yV2luZG93c1tkYXRhVHlwZUlEXTtcbiAgICBjb25zdCB3aW5kb3dPcHRpb25zID0gY29uZmlnLmFwcC53aW5kb3dzW3dpbmRvd0lEIGFzIGtleW9mIHR5cGVvZiBjb25maWcuYXBwLndpbmRvd3NdO1xuICAgIGlmICh3aW5kb3dJRCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJPYmplY3QgZWRpdG9yIHdpbmRvdyBub3QgY29uZmlndXJlZFwiKTtcbiAgICB9XG4gICAgYXdhaXQgY2FsbElQQygnb3Blbi1wcmVkZWZpbmVkLXdpbmRvdycsIHtcbiAgICAgIGlkOiB3aW5kb3dJRCxcbiAgICAgIHBhcmFtczoge1xuICAgICAgICBjb21wb25lbnRQYXJhbXM6IGBvYmplY3RJRD0ke29iamVjdElEfSYke3BhcmFtcyB8fCAnJ31gLFxuICAgICAgICB0aXRsZTogYCR7d2luZG93T3B0aW9ucy5vcGVuZXJQYXJhbXMudGl0bGV9ICgke29iamVjdElEfSlgLFxuICAgICAgfSxcbiAgICB9KTtcbiAgfTtcblxuICBjb25zdCBvcGVuUHJlZGVmaW5lZFdpbmRvdyA9IGFzeW5jICh3aW5kb3dJRDoga2V5b2YgdHlwZW9mIGNvbmZpZ1tcImFwcFwiXVtcIndpbmRvd3NcIl0sIHBhcmFtcz86IG9iamVjdCkgPT4ge1xuICAgIGF3YWl0IGNhbGxJUEMoJ29wZW4tcHJlZGVmaW5lZC13aW5kb3cnLCB7XG4gICAgICBpZDogd2luZG93SUQsXG4gICAgICBwYXJhbXM6IHBhcmFtcyB8fCB7fSxcbiAgICB9KTtcbiAgfTtcblxuXG4gIC8vIFRPRE86IFJlZmFjdG9yIG91dCBob29rIGluaXRpYWxpemF0aW9uXG5cbiAgY29uc3QgdXNlSURzOiBVc2VJRHNIb29rPEM+ID1cbiAgPElEVHlwZSBleHRlbmRzIEFueUlEVHlwZSwgUSBleHRlbmRzIG9iamVjdCA9IHt9PlxuICAobW9kZWxOYW1lOiBrZXlvZiBBW1wiZGF0YVwiXSwgcXVlcnk/OiBRKSA9PiB7XG4gICAgLyogUXVlcmllcyBkYXRhIGZvciBzcGVjaWZpZWQgbW9kZWwsIGxpc3RlbnMgZm9yIHVwZGF0ZSBldmVudHMgYW5kIHVwZGF0ZXMgdGhlIGRhdGFzZXQuICovXG5cbiAgICBjb25zdCB0cmFja2VkSURzID0gdXNlSVBDVmFsdWU8USwgeyBpZHM6IElEVHlwZVtdIH0+XG4gICAgKGBtb2RlbC0ke21vZGVsTmFtZX0tbGlzdC1pZHNgLCB7IGlkczogW10gfSwgcXVlcnkpO1xuXG4gICAgdXNlSVBDRXZlbnQ8eyBpZHM/OiBzdHJpbmdbXSB9PihgbW9kZWwtJHttb2RlbE5hbWV9LW9iamVjdHMtY2hhbmdlZGAsIGZ1bmN0aW9uICh7IGlkcyB9KSB7XG4gICAgICB0cmFja2VkSURzLnJlZnJlc2goKTtcblxuICAgICAgLy8gU2VlIFRPRE8gYXQgdXNlTWFueSgpLlxuICAgICAgLy9jb25zdCBzdHJpbmdJRHMgPSB0cmFja2VkSURzLnZhbHVlLmlkcy5tYXAoaWQgPT4gYCR7aWR9YCk7XG4gICAgICAvL2NvbnN0IHNob3VsZFJlZnJlc2ggPSBpZHMgIT09IHVuZGVmaW5lZFxuICAgICAgLy8gID8gaWRzLmZpbHRlcihpZCA9PiBzdHJpbmdJRHMuaW5jbHVkZXMoaWQpKS5sZW5ndGggPiAwXG4gICAgICAvLyAgOiB0cnVlO1xuICAgICAgLy9pZiAoc2hvdWxkUmVmcmVzaCkge1xuICAgICAgLy8gIHRyYWNrZWRJRHMucmVmcmVzaCgpO1xuICAgICAgLy99XG4gICAgfSk7XG5cbiAgICByZXR1cm4geyBpZHM6IHRyYWNrZWRJRHMudmFsdWUuaWRzLCBpc1VwZGF0aW5nOiB0cmFja2VkSURzLmlzVXBkYXRpbmcgfTtcbiAgfVxuXG4gIGNvbnN0IHVzZUNvdW50OiBVc2VDb3VudEhvb2s8Qz4gPVxuICA8USBleHRlbmRzIG9iamVjdCA9IGFueT5cbiAgKG1vZGVsTmFtZToga2V5b2YgQVtcImRhdGFcIl0sIHF1ZXJ5PzogUSkgPT4ge1xuICAgIC8qIFF1ZXJpZXMgZGF0YSBmb3Igc3BlY2lmaWVkIG1vZGVsLCBsaXN0ZW5zIGZvciB1cGRhdGUgZXZlbnRzIGFuZCB1cGRhdGVzIHRoZSBkYXRhc2V0LiAqL1xuXG4gICAgY29uc3QgY291bnQgPSB1c2VJUENWYWx1ZTxRLCB7IGNvdW50OiBudW1iZXIgfT5cbiAgICAoYG1vZGVsLSR7bW9kZWxOYW1lfS1jb3VudGAsIHsgY291bnQ6IDAgfSwgcXVlcnkpO1xuXG4gICAgdXNlSVBDRXZlbnQ8eyBpZHM/OiBzdHJpbmdbXSB9PihgbW9kZWwtJHttb2RlbE5hbWV9LW9iamVjdHMtY2hhbmdlZGAsIGZ1bmN0aW9uICgpIHtcbiAgICAgIGNvdW50LnJlZnJlc2goKTtcbiAgICB9KTtcblxuICAgIHJldHVybiB7IGNvdW50OiBjb3VudC52YWx1ZS5jb3VudCwgaXNVcGRhdGluZzogY291bnQuaXNVcGRhdGluZyB9O1xuICB9XG5cbiAgY29uc3QgdXNlTWFueTogVXNlTWFueUhvb2s8Qz4gPVxuICA8TSBleHRlbmRzIE1vZGVsLCBRIGV4dGVuZHMgb2JqZWN0ID0ge30+XG4gIChtb2RlbE5hbWU6IGtleW9mIEFbXCJkYXRhXCJdLCBxdWVyeT86IFEpID0+IHtcbiAgICAvKiBRdWVyaWVzIGRhdGEgZm9yIHNwZWNpZmllZCBtb2RlbCwgbGlzdGVucyBmb3IgdXBkYXRlIGV2ZW50cyBhbmQgdXBkYXRlcyB0aGUgZGF0YXNldC4gKi9cblxuICAgIGNvbnN0IG9iamVjdHMgPSB1c2VJUENWYWx1ZTxRLCBJbmRleDxNPj5cbiAgICAoYG1vZGVsLSR7bW9kZWxOYW1lfS1yZWFkLWFsbGAsIHt9LCBxdWVyeSk7XG5cbiAgICB1c2VJUENFdmVudDx7IGlkcz86IHN0cmluZ1tdIH0+KGBtb2RlbC0ke21vZGVsTmFtZX0tb2JqZWN0cy1jaGFuZ2VkYCwgZnVuY3Rpb24gKHsgaWRzIH0pIHtcbiAgICAgIC8vIFRPRE86IGdlbmVyaWMgcXVlcnkgcmVmcmVzaCBJUEMgZXZlbnQvaG9vaz9cblxuICAgICAgb2JqZWN0cy5yZWZyZXNoKCk7XG5cbiAgICAgIC8vIFRPRE86IE9ubHkgcmVmcmVzaCB3aGVuIG5lZWRlZC5cbiAgICAgIC8vIEJlbG93IGNvZGUgd29ya3MsIGV4Y2VwdCBpdCB3b27igJl0IHRyaWdnZXIgcmVmcmVzaFxuICAgICAgLy8gd2hlbiBuZXcgb2JqZWN0cyBhcmUgYWRkZWQ6XG4gICAgICAvLyBsb2cuc2lsbHkoXCJDL3JlbmRlckFwcDogQ2hhbmdlZCBvYmplY3QgSURzXCIsIGlkcyk7XG4gICAgICAvLyBjb25zdCB0cmFja2VkT2JqZWN0SURzID0gT2JqZWN0LmtleXMob2JqZWN0cy52YWx1ZSk7XG4gICAgICAvLyBjb25zdCBzaG91bGRSZWZyZXNoID0gaWRzID09PSB1bmRlZmluZWQgfHwgaWRzLmZpbHRlcihpZCA9PiB0cmFja2VkT2JqZWN0SURzLmluY2x1ZGVzKGlkKSkubGVuZ3RoID4gMDtcbiAgICAgIC8vIGlmIChzaG91bGRSZWZyZXNoKSB7XG4gICAgICAvLyAgIGxvZy5kZWJ1ZyhcIkMvcmVuZGVyQXBwOiBSZWZyZXNoaW5nIG9iamVjdHNcIiwgaWRzKTtcbiAgICAgIC8vICAgb2JqZWN0cy5yZWZyZXNoKCk7XG4gICAgICAvLyB9IGVsc2Uge1xuICAgICAgLy8gICBsb2cuZGVidWcoXCJDL3JlbmRlckFwcDogV2lsbCBub3QgcmVmcmVzaCBvYmplY3RzXCIsIGlkcyk7XG4gICAgICAvLyB9XG4gICAgfSk7XG5cbiAgICByZXR1cm4geyBvYmplY3RzOiBvYmplY3RzLnZhbHVlLCBpc1VwZGF0aW5nOiBvYmplY3RzLmlzVXBkYXRpbmcgfTtcbiAgfVxuXG4gIGNvbnN0IHVzZU9uZTogVXNlT25lSG9vazxDPiA9XG4gIDxNIGV4dGVuZHMgTW9kZWwsIElEVHlwZSBleHRlbmRzIEFueUlEVHlwZT5cbiAgKG1vZGVsTmFtZToga2V5b2YgQVtcImRhdGFcIl0sIG9iamVjdElEOiBJRFR5cGUgfCBudWxsKSA9PiB7XG4gICAgLyogUXVlcmllcyBkYXRhIGZvciBzcGVjaWZpZWQgbW9kZWwsIGxpc3RlbnMgZm9yIHVwZGF0ZSBldmVudHMgYW5kIHVwZGF0ZXMgdGhlIGRhdGFzZXQuICovXG5cbiAgICBjb25zdCBvYmplY3QgPSB1c2VJUENWYWx1ZTx7IG9iamVjdElEOiBJRFR5cGUgfCBudWxsIH0sIHsgb2JqZWN0OiBNIHwgbnVsbCB9PlxuICAgIChgbW9kZWwtJHttb2RlbE5hbWV9LXJlYWQtb25lYCwgeyBvYmplY3Q6IG51bGwgYXMgTSB8IG51bGwgfSwgeyBvYmplY3RJRCB9KTtcblxuICAgIHVzZUlQQ0V2ZW50PHsgaWRzPzogc3RyaW5nW10gfT4oYG1vZGVsLSR7bW9kZWxOYW1lfS1vYmplY3RzLWNoYW5nZWRgLCBmdW5jdGlvbiAoeyBpZHMgfSkge1xuICAgICAgY29uc3Qgc2hvdWxkUmVmcmVzaCA9IGlkcyA9PT0gdW5kZWZpbmVkIHx8IGlkcy5pbmNsdWRlcyhgJHtvYmplY3RJRH1gKTtcbiAgICAgIGlmIChzaG91bGRSZWZyZXNoKSB7XG4gICAgICAgIG9iamVjdC5yZWZyZXNoKCk7XG4gICAgICB9XG4gICAgfSwgW29iamVjdElEXSk7XG5cbiAgICByZXR1cm4ge1xuICAgICAgb2JqZWN0OiBvYmplY3QudmFsdWUub2JqZWN0LFxuICAgICAgaXNVcGRhdGluZzogb2JqZWN0LmlzVXBkYXRpbmcsXG4gICAgICByZWZyZXNoOiAoKSA9PiBvYmplY3QucmVmcmVzaCgpLFxuICAgIH07XG4gIH1cblxuICAvLyBGZXRjaCB0b3AtbGV2ZWwgVUkgY29tcG9uZW50IGNsYXNzIGFuZCByZW5kZXIgaXQuXG4gIGlmIChjb21wb25lbnRJbXBvcnRlcikge1xuICAgIChhc3luYyAoKSA9PiB7XG4gICAgICAvLyBTaG93IGxvYWRpbmcgaW5kaWNhdG9yIHdoaWxlIGNvbXBvbmVudHMgYXJlIGJlaW5nIHJlc29sdmVkXG4gICAgICBSZWFjdERPTS5yZW5kZXIoPFNwaW5uZXIgY2xhc3NOYW1lPVwiaW5pdGlhbC1zcGlubmVyXCIgLz4sIGFwcFJvb3QpO1xuXG4gICAgICBjb25zdCBjdHhQcm92aWRlckNvbmZpZyA9IGNvbmZpZy5jb250ZXh0UHJvdmlkZXJzIHx8IFtdO1xuXG4gICAgICAvLyBHZXQgcHJvcHMgcHJlc2NyaWJlZCBmb3IgZWFjaCBjb250ZXh0IHByb3ZpZGVyIGNvbXBvbmVudFxuICAgICAgdmFyIGN0eFByb3ZpZGVyUHJvcHMgPSBhd2FpdCBQcm9taXNlLmFsbChjdHhQcm92aWRlckNvbmZpZy5tYXAoaXRlbSA9PiBpdGVtLmdldFByb3BzKGNvbmZpZykpKTtcblxuICAgICAgbG9nLnNpbGx5KFxuICAgICAgICBgQy9yZW5kZXJBcHA6IFJlc29sdmluZyBjb21wb25lbnRzYCxcbiAgICAgICAgY29tcG9uZW50SW1wb3J0ZXIsIGN0eFByb3ZpZGVyQ29uZmlnKTtcblxuICAgICAgLy8gUmVzb2x2ZSAoaW1wb3J0KSBjb21wb25lbnRzIGluIHBhcmFsbGVsLCBmaXJzdCBVSSBhbmQgdGhlbiBjb250ZXh0IHByb3ZpZGVyc1xuICAgICAgY29uc3QgcHJvbWlzZWRDb21wb25lbnRzOiB7IGRlZmF1bHQ6IFJlYWN0LkZDPGFueT4gfVtdID0gYXdhaXQgUHJvbWlzZS5hbGwoW1xuICAgICAgICBjb21wb25lbnRJbXBvcnRlcigpLFxuICAgICAgICAuLi5jdHhQcm92aWRlckNvbmZpZy5tYXAoYXN5bmMgKGN0eHApID0+IGF3YWl0IGN0eHAuY2xzKCkpLFxuICAgICAgXSk7XG5cbiAgICAgIGxvZy5zaWxseShcbiAgICAgICAgYEMvcmVuZGVyQXBwOiBSZXNvbHZlZCBjb21wb25lbnRzYCxcbiAgICAgICAgcHJvbWlzZWRDb21wb25lbnRzKTtcblxuICAgICAgLy8gQnJlYWsgZG93biBjb21wb25lbnRzIGludG8gdG9wLWxldmVsIHdpbmRvdyBVSSAmIGNvbnRleHQgcHJvdmlkZXJzXG4gICAgICBjb25zdCBUb3BXaW5kb3dDb21wb25lbnQgPSBwcm9taXNlZENvbXBvbmVudHNbMF0uZGVmYXVsdDtcbiAgICAgIHZhciBjdHhQcm92aWRlckNvbXBvbmVudHMgPSBwcm9taXNlZENvbXBvbmVudHMuXG4gICAgICAgIHNsaWNlKDEsIHByb21pc2VkQ29tcG9uZW50cy5sZW5ndGgpLlxuICAgICAgICBtYXAoaXRlbSA9PiBpdGVtLmRlZmF1bHQpO1xuXG4gICAgICAvLyBSZW9yZGVyIGNvbnRleHQgcHJvdmlkZXJzIHNvIHRoYXQgdG9wLW1vc3QgaXMgdGhlIG1vc3QgYmFzaWNcbiAgICAgIGN0eFByb3ZpZGVyQ29tcG9uZW50cy5yZXZlcnNlKCk7XG4gICAgICBjdHhQcm92aWRlclByb3BzLnJldmVyc2UoKTtcblxuICAgICAgLy8gV3JpdGUgb3V0IHRvcC1sZXZlbCB3aW5kb3cgY29tcG9uZW50IEpTWFxuICAgICAgdmFyIGFwcE1hcmt1cCA9IDxUb3BXaW5kb3dDb21wb25lbnQgcXVlcnk9e3NlYXJjaFBhcmFtc30gLz47XG5cbiAgICAgIGxvZy5kZWJ1ZyhcbiAgICAgICAgYEMvcmVuZGVyQXBwOiBHb3QgY29udGV4dCBwcm92aWRlciBjb21wb25lbnRzYCxcbiAgICAgICAgY3R4UHJvdmlkZXJDb21wb25lbnRzKTtcblxuICAgICAgLy8gV3JhcCB0aGUgSlNYIGludG8gY29udGV4dCBwcm92aWRlciBjb21wb25lbnRzXG4gICAgICBmb3IgKGNvbnN0IFtpZHgsIENvbnRleHRQcm92aWRlcl0gb2YgY3R4UHJvdmlkZXJDb21wb25lbnRzLmVudHJpZXMoKSkge1xuICAgICAgICBsb2cudmVyYm9zZSggIFxuICAgICAgICAgIGBDL3JlbmRlckFwcDogSW5pdGlhbGl6aW5nIGNvbnRleHQgcHJvdmlkZXIgIyR7aWR4fWAsXG4gICAgICAgICAgY3R4UHJvdmlkZXJDb21wb25lbnRzW2lkeF0sXG4gICAgICAgICAgY3R4UHJvdmlkZXJQcm9wc1tpZHhdKTtcblxuICAgICAgICBhcHBNYXJrdXAgPSAoXG4gICAgICAgICAgPENvbnRleHRQcm92aWRlciB7Li4uY3R4UHJvdmlkZXJQcm9wc1tpZHhdfT5cbiAgICAgICAgICAgIHthcHBNYXJrdXB9XG4gICAgICAgICAgPC9Db250ZXh0UHJvdmlkZXI+XG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIGxvZy5kZWJ1ZyhcIkMvcmVuZGVyQXBwOiBSZW5kZXJpbmdcIik7XG5cbiAgICAgIC8vIFJlbmRlciB0aGUgSlNYXG4gICAgICBSZWFjdERPTS5yZW5kZXIoYXBwTWFya3VwLCBhcHBSb290KTtcbiAgICB9KSgpO1xuXG4gICAgcmV0dXJuIHtcbiAgICAgIHJvb3Q6IGFwcFJvb3QsXG4gICAgICB1c2VDb3VudCxcbiAgICAgIHVzZUlEcyxcbiAgICAgIHVzZU1hbnksXG4gICAgICB1c2VPbmUsXG4gICAgICBvcGVuUHJlZGVmaW5lZFdpbmRvdyxcbiAgICAgIG9wZW5PYmplY3RFZGl0b3IsXG4gICAgfTtcblxuICB9IGVsc2Uge1xuICAgIC8vIENvbXBvbmVudCBzcGVjaWZpZWQgaW4gR0VUIHBhcmFtcyBpcyBub3QgcHJlc2VudCBpbiBhcHAgcmVuZGVyZXIgY29uZmlnLlxuICAgIC8vIFRPRE86IEhhbmRsZSBtaXNjb25maWd1cmVkIFJlYWN0IGNvbnRleHQgcHJvdmlkZXJzIGFuZCBmYWlsZWQgaW1wb3J0IGF0IHJ1bnRpbWVcbiAgICBSZWFjdERPTS5yZW5kZXIoPE5vbklkZWFsU3RhdGVcbiAgICAgIGljb249XCJlcnJvclwiXG4gICAgICB0aXRsZT1cIlVua25vd24gY29tcG9uZW50IHJlcXVlc3RlZFwiIC8+LCBhcHBSb290KTtcblxuICAgIGxvZy5lcnJvcihcIlVua25vd24gY29tcG9uZW50IHJlcXVlc3RlZFwiLCBjb21wb25lbnRJZCk7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiVW5rbm93biBjb21wb25lbnQgcmVxdWVzdGVkXCIpO1xuICB9XG5cbn07Il19