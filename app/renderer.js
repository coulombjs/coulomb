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
        if (windowID === undefined) {
            throw new Error("Object editor window not configured");
        }
        await callIPC('open-predefined-window', {
            id: windowID,
            params: { componentParams: `objectID=${objectID}&${params || ''}` },
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVuZGVyZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zcmMvYXBwL3JlbmRlcmVyLnRzeCJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEtBQUssTUFBTSxPQUFPLENBQUM7QUFDMUIsT0FBTyxLQUFLLEdBQUcsTUFBTSxjQUFjLENBQUM7QUFDcEMsT0FBTyxLQUFLLFFBQVEsTUFBTSxXQUFXLENBQUM7QUFRdEMsT0FBTyxFQUFFLGFBQWEsRUFBRSxPQUFPLEVBQUUsTUFBTSxtQkFBbUIsQ0FBQztBQUUzRCxPQUFPLCtFQUErRSxDQUFDO0FBQ3ZGLE9BQU8sa0VBQWtFLENBQUM7QUFDMUUsT0FBTywwQ0FBMEMsQ0FBQztBQUNsRCxPQUFPLHlDQUF5QyxDQUFDO0FBQ2pELE9BQU8sRUFBRSxXQUFXLEVBQUUsV0FBVyxFQUFFLE9BQU8sRUFBRSxNQUFNLGlCQUFpQixDQUFDO0FBc0RwRSw0Q0FBNEM7QUFDNUMsOEVBQThFO0FBQzlFLHFEQUFxRDtBQUNyRCxNQUFNLENBQUMsTUFBTSxTQUFTLEdBQUcsQ0FBbUQsTUFBUyxFQUFrQixFQUFFO0lBRXZHLHdFQUF3RTtJQUN4RSxNQUFNLE9BQU8sR0FBRyxRQUFRLENBQUMsY0FBYyxDQUFDLEtBQUssQ0FBZ0IsQ0FBQztJQUU5RCxpREFBaUQ7SUFDakQsUUFBUSxDQUFDLGVBQWUsQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLGFBQWEsT0FBTyxDQUFDLFFBQVEsRUFBRSxDQUFDLENBQUM7SUFFeEUsMkRBQTJEO0lBQzNELE1BQU0sWUFBWSxHQUFHLElBQUksZUFBZSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsTUFBTSxDQUFDLENBQUM7SUFFakUsbUVBQW1FO0lBQ25FLE1BQU0sV0FBVyxHQUFHLFlBQVksQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUM7SUFDMUMsTUFBTSxpQkFBaUIsR0FBRyxXQUFXLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxnQkFBZ0IsQ0FBQyxX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dCc7XG5pbXBvcnQgKiBhcyBsb2cgZnJvbSAnZWxlY3Ryb24tbG9nJztcbmltcG9ydCAqIGFzIFJlYWN0RE9NIGZyb20gJ3JlYWN0LWRvbSc7XG5cbmltcG9ydCB7IEFwcENvbmZpZyB9IGZyb20gJy4uL2NvbmZpZy9hcHAnO1xuaW1wb3J0IHsgUmVuZGVyZXJDb25maWcgfSBmcm9tICcuLi9jb25maWcvcmVuZGVyZXInO1xuXG5pbXBvcnQgeyBNb2RlbCwgQW55SURUeXBlIH0gZnJvbSAnLi4vZGIvbW9kZWxzJztcbmltcG9ydCB7IEluZGV4IH0gZnJvbSAnLi4vZGIvcXVlcnknO1xuXG5pbXBvcnQgeyBOb25JZGVhbFN0YXRlLCBTcGlubmVyIH0gZnJvbSAnQGJsdWVwcmludGpzL2NvcmUnO1xuXG5pbXBvcnQgJyFzdHlsZS1sb2FkZXIhY3NzLWxvYWRlciFAYmx1ZXByaW50anMvZGF0ZXRpbWUvbGliL2Nzcy9ibHVlcHJpbnQtZGF0ZXRpbWUuY3NzJztcbmltcG9ydCAnIXN0eWxlLWxvYWRlciFjc3MtbG9hZGVyIUBibHVlcHJpbnRqcy9jb3JlL2xpYi9jc3MvYmx1ZXByaW50LmNzcyc7XG5pbXBvcnQgJyFzdHlsZS1sb2FkZXIhY3NzLWxvYWRlciEuL25vcm1hbGl6ZS5jc3MnO1xuaW1wb3J0ICchc3R5bGUtbG9hZGVyIWNzcy1sb2FkZXIhLi9yZW5kZXJlci5jc3MnO1xuaW1wb3J0IHsgdXNlSVBDRXZlbnQsIHVzZUlQQ1ZhbHVlLCBjYWxsSVBDIH0gZnJvbSAnLi4vaXBjL3JlbmRlcmVyJztcblxuXG5pbnRlcmZhY2UgQXBwUmVuZGVyZXI8QyBleHRlbmRzIFJlbmRlcmVyQ29uZmlnPGFueT4+IHtcbiAgcm9vdDogSFRNTEVsZW1lbnRcbiAgdXNlQ291bnQ6IFVzZUNvdW50SG9vazxDPlxuICB1c2VJRHM6IFVzZUlEc0hvb2s8Qz5cbiAgdXNlTWFueTogVXNlTWFueUhvb2s8Qz5cbiAgdXNlT25lOiBVc2VPbmVIb29rPEM+XG5cbiAgb3BlblByZWRlZmluZWRXaW5kb3c6XG4gICAgKHdpbmRvd0lEOiBrZXlvZiBDW1wiYXBwXCJdW1wid2luZG93c1wiXSwgcGFyYW1zPzogb2JqZWN0KSA9PiBQcm9taXNlPHZvaWQ+XG5cbiAgb3Blbk9iamVjdEVkaXRvcjpcbiAgICAob2JqZWN0VHlwZUlEOiBrZXlvZiBDW1wiYXBwXCJdW1wiZGF0YVwiXSwgb2JqZWN0SUQ6IGFueSwgcGFyYW1zPzogc3RyaW5nKSA9PiBQcm9taXNlPHZvaWQ+XG59XG5cblxuLy8gRGF0YSBvcGVyYXRpb24gaG9vayBpbnRlcmZhY2VzXG5cbmludGVyZmFjZSBVc2VNYW55SG9va1Jlc3VsdDxNIGV4dGVuZHMgTW9kZWw+IHtcbiAgb2JqZWN0czogSW5kZXg8TT5cbiAgaXNVcGRhdGluZzogYm9vbGVhblxufVxudHlwZSBVc2VNYW55SG9vazxDIGV4dGVuZHMgUmVuZGVyZXJDb25maWc8YW55Pj4gPVxuPE0gZXh0ZW5kcyBNb2RlbCwgUSBleHRlbmRzIG9iamVjdCA9IHt9PlxuKG1vZGVsTmFtZToga2V5b2YgQ1tcImFwcFwiXVtcImRhdGFcIl0sIHF1ZXJ5PzogUSkgPT4gVXNlTWFueUhvb2tSZXN1bHQ8TT5cblxuaW50ZXJmYWNlIFVzZUlEc0hvb2tSZXN1bHQ8SURUeXBlIGV4dGVuZHMgQW55SURUeXBlPiB7XG4gIGlkczogSURUeXBlW11cbiAgaXNVcGRhdGluZzogYm9vbGVhblxufVxudHlwZSBVc2VJRHNIb29rPEMgZXh0ZW5kcyBSZW5kZXJlckNvbmZpZzxhbnk+PiA9XG48SURUeXBlIGV4dGVuZHMgQW55SURUeXBlLCBRIGV4dGVuZHMgb2JqZWN0ID0ge30+XG4obW9kZWxOYW1lOiBrZXlvZiBDW1wiYXBwXCJdW1wiZGF0YVwiXSwgcXVlcnk/OiBRKSA9PiBVc2VJRHNIb29rUmVzdWx0PElEVHlwZT5cblxuaW50ZXJmYWNlIFVzZUNvdW50SG9va1Jlc3VsdCB7XG4gIGNvdW50OiBudW1iZXJcbiAgaXNVcGRhdGluZzogYm9vbGVhblxufVxudHlwZSBVc2VDb3VudEhvb2s8QyBleHRlbmRzIFJlbmRlcmVyQ29uZmlnPGFueT4+ID1cbjxRIGV4dGVuZHMgb2JqZWN0PlxuKG1vZGVsTmFtZToga2V5b2YgQ1tcImFwcFwiXVtcImRhdGFcIl0sIHF1ZXJ5OiBRKSA9PiBVc2VDb3VudEhvb2tSZXN1bHRcblxuaW50ZXJmYWNlIFVzZU9uZUhvb2tSZXN1bHQ8TSBleHRlbmRzIE1vZGVsPiB7XG4gIG9iamVjdDogTSB8IG51bGxcbiAgaXNVcGRhdGluZzogYm9vbGVhblxuICByZWZyZXNoOiAoKSA9PiB2b2lkXG59XG50eXBlIFVzZU9uZUhvb2s8QyBleHRlbmRzIFJlbmRlcmVyQ29uZmlnPGFueT4+ID1cbjxNIGV4dGVuZHMgTW9kZWwsIElEVHlwZSBleHRlbmRzIEFueUlEVHlwZT5cbihtb2RlbE5hbWU6IGtleW9mIENbXCJhcHBcIl1bXCJkYXRhXCJdLCBvYmplY3RJRDogSURUeXBlIHwgbnVsbCkgPT4gVXNlT25lSG9va1Jlc3VsdDxNPlxuXG5cbi8vIFJlbmRlciBhcHBsaWNhdGlvbiBzY3JlZW4gaW4gYSBuZXcgd2luZG93XG4vLyB3aXRoIGdpdmVuIHRvcC1sZXZlbCB3aW5kb3cgVUkgY29tcG9uZW50IGFuZCAoaWYgYXBwbGljYWJsZSkgYW55IHBhcmFtZXRlcnNcbi8vIHdyYXBwZWQgaW4gY29uZmlndXJlZCBjb250ZXh0IHByb3ZpZGVyIGNvbXBvbmVudHMuXG5leHBvcnQgY29uc3QgcmVuZGVyQXBwID0gPEEgZXh0ZW5kcyBBcHBDb25maWcsIEMgZXh0ZW5kcyBSZW5kZXJlckNvbmZpZzxBPj4oY29uZmlnOiBDKTogQXBwUmVuZGVyZXI8Qz4gPT4ge1xuXG4gIC8vIGVsZWN0cm9uLXdlYnBhY2sgZ3VhcmFudGVlcyBwcmVzZW5jZSBvZiAjYXBwIGluIGluZGV4Lmh0bWwgaXQgYnVuZGxlc1xuICBjb25zdCBhcHBSb290ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2FwcCcpIGFzIEhUTUxFbGVtZW50O1xuXG4gIC8vIEFkZCBhIGNsYXNzIGFsbG93aW5nIHBsYXRmb3JtLXNwZWNpZmljIHN0eWxpbmdcbiAgZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LmNsYXNzTGlzdC5hZGQoYHBsYXRmb3JtLS0ke3Byb2Nlc3MucGxhdGZvcm19YCk7XG5cbiAgLy8gR2V0IGFsbCBwYXJhbXMgcGFzc2VkIHRvIHRoZSB3aW5kb3cgdmlhIEdFVCBxdWVyeSBzdHJpbmdcbiAgY29uc3Qgc2VhcmNoUGFyYW1zID0gbmV3IFVSTFNlYXJjaFBhcmFtcyh3aW5kb3cubG9jYXRpb24uc2VhcmNoKTtcblxuICAvLyBQcmVwYXJlIGdldHRlciBmb3IgcmVxdWVzdGVkIHRvcC1sZXZlbCB3aW5kb3cgVUkgUmVhY3QgY29tcG9uZW50XG4gIGNvbnN0IGNvbXBvbmVudElkID0gc2VhcmNoUGFyYW1zLmdldCgnYycpO1xuICBjb25zdCBjb21wb25lbnRJbXBvcnRlciA9IGNvbXBvbmVudElkID8gY29uZmlnLndpbmRvd0NvbXBvbmVudHNbY29tcG9uZW50SWRdIDogbnVsbDtcblxuICBsb2cuZGVidWcoYFJlcXVlc3RlZCB3aW5kb3cgY29tcG9uZW50ICR7Y29tcG9uZW50SWR9YCk7XG5cblxuICBjb25zdCBvcGVuT2JqZWN0RWRpdG9yID0gYXN5bmMgKGRhdGFUeXBlSUQ6IGtleW9mIENbXCJhcHBcIl1bXCJkYXRhXCJdLCBvYmplY3RJRDogYW55LCBwYXJhbXM/OiBzdHJpbmcpID0+IHtcbiAgICBpZiAoY29uZmlnLm9iamVjdEVkaXRvcldpbmRvd3MgPT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiTm8gb2JqZWN0IGVkaXRvciB3aW5kb3dzIGNvbmZpZ3VyZWRcIik7XG4gICAgfVxuICAgIGNvbnN0IHdpbmRvd0lEID0gY29uZmlnLm9iamVjdEVkaXRvcldpbmRvd3NbZGF0YVR5cGVJRF07XG4gICAgaWYgKHdpbmRvd0lEID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIk9iamVjdCBlZGl0b3Igd2luZG93IG5vdCBjb25maWd1cmVkXCIpO1xuICAgIH1cbiAgICBhd2FpdCBjYWxsSVBDKCdvcGVuLXByZWRlZmluZWQtd2luZG93Jywge1xuICAgICAgaWQ6IHdpbmRvd0lELFxuICAgICAgcGFyYW1zOiB7IGNvbXBvbmVudFBhcmFtczogYG9iamVjdElEPSR7b2JqZWN0SUR9JiR7cGFyYW1zIHx8ICcnfWAgfSxcbiAgICB9KTtcbiAgfTtcblxuICBjb25zdCBvcGVuUHJlZGVmaW5lZFdpbmRvdyA9IGFzeW5jICh3aW5kb3dJRDoga2V5b2YgdHlwZW9mIGNvbmZpZ1tcImFwcFwiXVtcIndpbmRvd3NcIl0sIHBhcmFtcz86IG9iamVjdCkgPT4ge1xuICAgIGF3YWl0IGNhbGxJUEMoJ29wZW4tcHJlZGVmaW5lZC13aW5kb3cnLCB7XG4gICAgICBpZDogd2luZG93SUQsXG4gICAgICBwYXJhbXM6IHBhcmFtcyB8fCB7fSxcbiAgICB9KTtcbiAgfTtcblxuXG4gIC8vIFRPRE86IFJlZmFjdG9yIG91dCBob29rIGluaXRpYWxpemF0aW9uXG5cbiAgY29uc3QgdXNlSURzOiBVc2VJRHNIb29rPEM+ID1cbiAgPElEVHlwZSBleHRlbmRzIEFueUlEVHlwZSwgUSBleHRlbmRzIG9iamVjdCA9IHt9PlxuICAobW9kZWxOYW1lOiBrZXlvZiBBW1wiZGF0YVwiXSwgcXVlcnk/OiBRKSA9PiB7XG4gICAgLyogUXVlcmllcyBkYXRhIGZvciBzcGVjaWZpZWQgbW9kZWwsIGxpc3RlbnMgZm9yIHVwZGF0ZSBldmVudHMgYW5kIHVwZGF0ZXMgdGhlIGRhdGFzZXQuICovXG5cbiAgICBjb25zdCB0cmFja2VkSURzID0gdXNlSVBDVmFsdWU8USwgeyBpZHM6IElEVHlwZVtdIH0+XG4gICAgKGBtb2RlbC0ke21vZGVsTmFtZX0tbGlzdC1pZHNgLCB7IGlkczogW10gfSwgcXVlcnkpO1xuXG4gICAgdXNlSVBDRXZlbnQ8eyBpZHM/OiBzdHJpbmdbXSB9PihgbW9kZWwtJHttb2RlbE5hbWV9LW9iamVjdHMtY2hhbmdlZGAsIGZ1bmN0aW9uICh7IGlkcyB9KSB7XG4gICAgICB0cmFja2VkSURzLnJlZnJlc2goKTtcblxuICAgICAgLy8gU2VlIFRPRE8gYXQgdXNlTWFueSgpLlxuICAgICAgLy9jb25zdCBzdHJpbmdJRHMgPSB0cmFja2VkSURzLnZhbHVlLmlkcy5tYXAoaWQgPT4gYCR7aWR9YCk7XG4gICAgICAvL2NvbnN0IHNob3VsZFJlZnJlc2ggPSBpZHMgIT09IHVuZGVmaW5lZFxuICAgICAgLy8gID8gaWRzLmZpbHRlcihpZCA9PiBzdHJpbmdJRHMuaW5jbHVkZXMoaWQpKS5sZW5ndGggPiAwXG4gICAgICAvLyAgOiB0cnVlO1xuICAgICAgLy9pZiAoc2hvdWxkUmVmcmVzaCkge1xuICAgICAgLy8gIHRyYWNrZWRJRHMucmVmcmVzaCgpO1xuICAgICAgLy99XG4gICAgfSk7XG5cbiAgICByZXR1cm4geyBpZHM6IHRyYWNrZWRJRHMudmFsdWUuaWRzLCBpc1VwZGF0aW5nOiB0cmFja2VkSURzLmlzVXBkYXRpbmcgfTtcbiAgfVxuXG4gIGNvbnN0IHVzZUNvdW50OiBVc2VDb3VudEhvb2s8Qz4gPVxuICA8USBleHRlbmRzIG9iamVjdCA9IGFueT5cbiAgKG1vZGVsTmFtZToga2V5b2YgQVtcImRhdGFcIl0sIHF1ZXJ5PzogUSkgPT4ge1xuICAgIC8qIFF1ZXJpZXMgZGF0YSBmb3Igc3BlY2lmaWVkIG1vZGVsLCBsaXN0ZW5zIGZvciB1cGRhdGUgZXZlbnRzIGFuZCB1cGRhdGVzIHRoZSBkYXRhc2V0LiAqL1xuXG4gICAgY29uc3QgY291bnQgPSB1c2VJUENWYWx1ZTxRLCB7IGNvdW50OiBudW1iZXIgfT5cbiAgICAoYG1vZGVsLSR7bW9kZWxOYW1lfS1jb3VudGAsIHsgY291bnQ6IDAgfSwgcXVlcnkpO1xuXG4gICAgdXNlSVBDRXZlbnQ8eyBpZHM/OiBzdHJpbmdbXSB9PihgbW9kZWwtJHttb2RlbE5hbWV9LW9iamVjdHMtY2hhbmdlZGAsIGZ1bmN0aW9uICgpIHtcbiAgICAgIGNvdW50LnJlZnJlc2goKTtcbiAgICB9KTtcblxuICAgIHJldHVybiB7IGNvdW50OiBjb3VudC52YWx1ZS5jb3VudCwgaXNVcGRhdGluZzogY291bnQuaXNVcGRhdGluZyB9O1xuICB9XG5cbiAgY29uc3QgdXNlTWFueTogVXNlTWFueUhvb2s8Qz4gPVxuICA8TSBleHRlbmRzIE1vZGVsLCBRIGV4dGVuZHMgb2JqZWN0ID0ge30+XG4gIChtb2RlbE5hbWU6IGtleW9mIEFbXCJkYXRhXCJdLCBxdWVyeT86IFEpID0+IHtcbiAgICAvKiBRdWVyaWVzIGRhdGEgZm9yIHNwZWNpZmllZCBtb2RlbCwgbGlzdGVucyBmb3IgdXBkYXRlIGV2ZW50cyBhbmQgdXBkYXRlcyB0aGUgZGF0YXNldC4gKi9cblxuICAgIGNvbnN0IG9iamVjdHMgPSB1c2VJUENWYWx1ZTxRLCBJbmRleDxNPj5cbiAgICAoYG1vZGVsLSR7bW9kZWxOYW1lfS1yZWFkLWFsbGAsIHt9LCBxdWVyeSk7XG5cbiAgICB1c2VJUENFdmVudDx7IGlkcz86IHN0cmluZ1tdIH0+KGBtb2RlbC0ke21vZGVsTmFtZX0tb2JqZWN0cy1jaGFuZ2VkYCwgZnVuY3Rpb24gKHsgaWRzIH0pIHtcbiAgICAgIC8vIFRPRE86IGdlbmVyaWMgcXVlcnkgcmVmcmVzaCBJUEMgZXZlbnQvaG9vaz9cblxuICAgICAgb2JqZWN0cy5yZWZyZXNoKCk7XG5cbiAgICAgIC8vIFRPRE86IE9ubHkgcmVmcmVzaCB3aGVuIG5lZWRlZC5cbiAgICAgIC8vIEJlbG93IGNvZGUgd29ya3MsIGV4Y2VwdCBpdCB3b27igJl0IHRyaWdnZXIgcmVmcmVzaFxuICAgICAgLy8gd2hlbiBuZXcgb2JqZWN0cyBhcmUgYWRkZWQ6XG4gICAgICAvLyBsb2cuc2lsbHkoXCJDL3JlbmRlckFwcDogQ2hhbmdlZCBvYmplY3QgSURzXCIsIGlkcyk7XG4gICAgICAvLyBjb25zdCB0cmFja2VkT2JqZWN0SURzID0gT2JqZWN0LmtleXMob2JqZWN0cy52YWx1ZSk7XG4gICAgICAvLyBjb25zdCBzaG91bGRSZWZyZXNoID0gaWRzID09PSB1bmRlZmluZWQgfHwgaWRzLmZpbHRlcihpZCA9PiB0cmFja2VkT2JqZWN0SURzLmluY2x1ZGVzKGlkKSkubGVuZ3RoID4gMDtcbiAgICAgIC8vIGlmIChzaG91bGRSZWZyZXNoKSB7XG4gICAgICAvLyAgIGxvZy5kZWJ1ZyhcIkMvcmVuZGVyQXBwOiBSZWZyZXNoaW5nIG9iamVjdHNcIiwgaWRzKTtcbiAgICAgIC8vICAgb2JqZWN0cy5yZWZyZXNoKCk7XG4gICAgICAvLyB9IGVsc2Uge1xuICAgICAgLy8gICBsb2cuZGVidWcoXCJDL3JlbmRlckFwcDogV2lsbCBub3QgcmVmcmVzaCBvYmplY3RzXCIsIGlkcyk7XG4gICAgICAvLyB9XG4gICAgfSk7XG5cbiAgICByZXR1cm4geyBvYmplY3RzOiBvYmplY3RzLnZhbHVlLCBpc1VwZGF0aW5nOiBvYmplY3RzLmlzVXBkYXRpbmcgfTtcbiAgfVxuXG4gIGNvbnN0IHVzZU9uZTogVXNlT25lSG9vazxDPiA9XG4gIDxNIGV4dGVuZHMgTW9kZWwsIElEVHlwZSBleHRlbmRzIEFueUlEVHlwZT5cbiAgKG1vZGVsTmFtZToga2V5b2YgQVtcImRhdGFcIl0sIG9iamVjdElEOiBJRFR5cGUgfCBudWxsKSA9PiB7XG4gICAgLyogUXVlcmllcyBkYXRhIGZvciBzcGVjaWZpZWQgbW9kZWwsIGxpc3RlbnMgZm9yIHVwZGF0ZSBldmVudHMgYW5kIHVwZGF0ZXMgdGhlIGRhdGFzZXQuICovXG5cbiAgICBjb25zdCBvYmplY3QgPSB1c2VJUENWYWx1ZTx7IG9iamVjdElEOiBJRFR5cGUgfCBudWxsIH0sIHsgb2JqZWN0OiBNIHwgbnVsbCB9PlxuICAgIChgbW9kZWwtJHttb2RlbE5hbWV9LXJlYWQtb25lYCwgeyBvYmplY3Q6IG51bGwgYXMgTSB8IG51bGwgfSwgeyBvYmplY3RJRCB9KTtcblxuICAgIHVzZUlQQ0V2ZW50PHsgaWRzPzogc3RyaW5nW10gfT4oYG1vZGVsLSR7bW9kZWxOYW1lfS1vYmplY3RzLWNoYW5nZWRgLCBmdW5jdGlvbiAoeyBpZHMgfSkge1xuICAgICAgY29uc3Qgc2hvdWxkUmVmcmVzaCA9IGlkcyA9PT0gdW5kZWZpbmVkIHx8IGlkcy5pbmNsdWRlcyhgJHtvYmplY3RJRH1gKTtcbiAgICAgIGlmIChzaG91bGRSZWZyZXNoKSB7XG4gICAgICAgIG9iamVjdC5yZWZyZXNoKCk7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICByZXR1cm4ge1xuICAgICAgb2JqZWN0OiBvYmplY3QudmFsdWUub2JqZWN0LFxuICAgICAgaXNVcGRhdGluZzogb2JqZWN0LmlzVXBkYXRpbmcsXG4gICAgICByZWZyZXNoOiAoKSA9PiBvYmplY3QucmVmcmVzaCgpLFxuICAgIH07XG4gIH1cblxuICAvLyBGZXRjaCB0b3AtbGV2ZWwgVUkgY29tcG9uZW50IGNsYXNzIGFuZCByZW5kZXIgaXQuXG4gIGlmIChjb21wb25lbnRJbXBvcnRlcikge1xuICAgIChhc3luYyAoKSA9PiB7XG4gICAgICAvLyBTaG93IGxvYWRpbmcgaW5kaWNhdG9yIHdoaWxlIGNvbXBvbmVudHMgYXJlIGJlaW5nIHJlc29sdmVkXG4gICAgICBSZWFjdERPTS5yZW5kZXIoPFNwaW5uZXIgLz4sIGFwcFJvb3QpO1xuXG4gICAgICBjb25zdCBjdHhQcm92aWRlckNvbmZpZyA9IGNvbmZpZy5jb250ZXh0UHJvdmlkZXJzIHx8IFtdO1xuXG4gICAgICAvLyBHZXQgcHJvcHMgcHJlc2NyaWJlZCBmb3IgZWFjaCBjb250ZXh0IHByb3ZpZGVyIGNvbXBvbmVudFxuICAgICAgdmFyIGN0eFByb3ZpZGVyUHJvcHMgPSBjdHhQcm92aWRlckNvbmZpZy5tYXAoaXRlbSA9PiBpdGVtLmdldFByb3BzKGNvbmZpZykpO1xuXG4gICAgICBsb2cuc2lsbHkoXG4gICAgICAgIGBDL3JlbmRlckFwcDogUmVzb2x2aW5nIGNvbXBvbmVudHNgLFxuICAgICAgICBjb21wb25lbnRJbXBvcnRlciwgY3R4UHJvdmlkZXJDb25maWcpO1xuXG4gICAgICAvLyBSZXNvbHZlIChpbXBvcnQpIGNvbXBvbmVudHMgaW4gcGFyYWxsZWwsIGZpcnN0IFVJIGFuZCB0aGVuIGNvbnRleHQgcHJvdmlkZXJzXG4gICAgICBjb25zdCBwcm9taXNlZENvbXBvbmVudHM6IHsgZGVmYXVsdDogUmVhY3QuRkM8YW55PiB9W10gPSBhd2FpdCBQcm9taXNlLmFsbChbXG4gICAgICAgIGNvbXBvbmVudEltcG9ydGVyKCksXG4gICAgICAgIC4uLmN0eFByb3ZpZGVyQ29uZmlnLm1hcChhc3luYyAoY3R4cCkgPT4gYXdhaXQgY3R4cC5jbHMoKSksXG4gICAgICBdKTtcblxuICAgICAgbG9nLnNpbGx5KFxuICAgICAgICBgQy9yZW5kZXJBcHA6IFJlc29sdmVkIGNvbXBvbmVudHNgLFxuICAgICAgICBwcm9taXNlZENvbXBvbmVudHMpO1xuXG4gICAgICAvLyBCcmVhayBkb3duIGNvbXBvbmVudHMgaW50byB0b3AtbGV2ZWwgd2luZG93IFVJICYgY29udGV4dCBwcm92aWRlcnNcbiAgICAgIGNvbnN0IFRvcFdpbmRvd0NvbXBvbmVudCA9IHByb21pc2VkQ29tcG9uZW50c1swXS5kZWZhdWx0O1xuICAgICAgdmFyIGN0eFByb3ZpZGVyQ29tcG9uZW50cyA9IHByb21pc2VkQ29tcG9uZW50cy5cbiAgICAgICAgc2xpY2UoMSwgcHJvbWlzZWRDb21wb25lbnRzLmxlbmd0aCkuXG4gICAgICAgIG1hcChpdGVtID0+IGl0ZW0uZGVmYXVsdCk7XG5cbiAgICAgIC8vIFJlb3JkZXIgY29udGV4dCBwcm92aWRlcnMgc28gdGhhdCB0b3AtbW9zdCBpcyB0aGUgbW9zdCBiYXNpY1xuICAgICAgY3R4UHJvdmlkZXJDb21wb25lbnRzLnJldmVyc2UoKTtcbiAgICAgIGN0eFByb3ZpZGVyUHJvcHMucmV2ZXJzZSgpO1xuXG4gICAgICAvLyBXcml0ZSBvdXQgdG9wLWxldmVsIHdpbmRvdyBjb21wb25lbnQgSlNYXG4gICAgICB2YXIgYXBwTWFya3VwID0gPFRvcFdpbmRvd0NvbXBvbmVudCBxdWVyeT17c2VhcmNoUGFyYW1zfSAvPjtcblxuICAgICAgbG9nLmRlYnVnKFxuICAgICAgICBgQy9yZW5kZXJBcHA6IEdvdCBjb250ZXh0IHByb3ZpZGVyIGNvbXBvbmVudHNgLFxuICAgICAgICBjdHhQcm92aWRlckNvbXBvbmVudHMpO1xuXG4gICAgICAvLyBXcmFwIHRoZSBKU1ggaW50byBjb250ZXh0IHByb3ZpZGVyIGNvbXBvbmVudHNcbiAgICAgIGZvciAoY29uc3QgW2lkeCwgQ29udGV4dFByb3ZpZGVyXSBvZiBjdHhQcm92aWRlckNvbXBvbmVudHMuZW50cmllcygpKSB7XG4gICAgICAgIGxvZy52ZXJib3NlKCAgXG4gICAgICAgICAgYEMvcmVuZGVyQXBwOiBJbml0aWFsaXppbmcgY29udGV4dCBwcm92aWRlciAjJHtpZHh9YCxcbiAgICAgICAgICBjdHhQcm92aWRlckNvbXBvbmVudHNbaWR4XSxcbiAgICAgICAgICBjdHhQcm92aWRlclByb3BzW2lkeF0pO1xuXG4gICAgICAgIGFwcE1hcmt1cCA9IChcbiAgICAgICAgICA8Q29udGV4dFByb3ZpZGVyIHsuLi5jdHhQcm92aWRlclByb3BzW2lkeF19PlxuICAgICAgICAgICAge2FwcE1hcmt1cH1cbiAgICAgICAgICA8L0NvbnRleHRQcm92aWRlcj5cbiAgICAgICAgKTtcbiAgICAgIH1cblxuICAgICAgbG9nLmRlYnVnKFwiQy9yZW5kZXJBcHA6IFJlbmRlcmluZ1wiKTtcblxuICAgICAgLy8gUmVuZGVyIHRoZSBKU1hcbiAgICAgIFJlYWN0RE9NLnJlbmRlcihhcHBNYXJrdXAsIGFwcFJvb3QpO1xuICAgIH0pKCk7XG5cbiAgICByZXR1cm4ge1xuICAgICAgcm9vdDogYXBwUm9vdCxcbiAgICAgIHVzZUNvdW50LFxuICAgICAgdXNlSURzLFxuICAgICAgdXNlTWFueSxcbiAgICAgIHVzZU9uZSxcbiAgICAgIG9wZW5QcmVkZWZpbmVkV2luZG93LFxuICAgICAgb3Blbk9iamVjdEVkaXRvcixcbiAgICB9O1xuXG4gIH0gZWxzZSB7XG4gICAgLy8gQ29tcG9uZW50IHNwZWNpZmllZCBpbiBHRVQgcGFyYW1zIGlzIG5vdCBwcmVzZW50IGluIGFwcCByZW5kZXJlciBjb25maWcuXG4gICAgLy8gVE9ETzogSGFuZGxlIG1pc2NvbmZpZ3VyZWQgUmVhY3QgY29udGV4dCBwcm92aWRlcnMgYW5kIGZhaWxlZCBpbXBvcnQgYXQgcnVudGltZVxuICAgIFJlYWN0RE9NLnJlbmRlcig8Tm9uSWRlYWxTdGF0ZVxuICAgICAgaWNvbj1cImVycm9yXCJcbiAgICAgIHRpdGxlPVwiVW5rbm93biBjb21wb25lbnQgcmVxdWVzdGVkXCIgLz4sIGFwcFJvb3QpO1xuXG4gICAgbG9nLmVycm9yKFwiVW5rbm93biBjb21wb25lbnQgcmVxdWVzdGVkXCIsIGNvbXBvbmVudElkKTtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJVbmtub3duIGNvbXBvbmVudCByZXF1ZXN0ZWRcIik7XG4gIH1cblxufTsiXX0=