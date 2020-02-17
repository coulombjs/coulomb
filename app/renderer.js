import React from 'react';
import * as log from 'electron-log';
import * as ReactDOM from 'react-dom';
import { NonIdealState, Spinner } from '@blueprintjs/core';
import '!style-loader!css-loader!@blueprintjs/datetime/lib/css/blueprint-datetime.css';
import '!style-loader!css-loader!@blueprintjs/core/lib/css/blueprint.css';
import '!style-loader!css-loader!./normalize.css';
import '!style-loader!css-loader!./renderer.css';
import { useIPCEvent, useIPCValue } from '../ipc/renderer';
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
        return { object: object.value.object, isUpdating: object.isUpdating };
    };
    // Fetch top-level UI component class and render it.
    if (componentImporter) {
        (async () => {
            // Show loading indicator while components are being resolved
            ReactDOM.render(React.createElement(Spinner, null), appRoot);
            // Get props prescribed for each context provider component
            var ctxProviderProps = config.contextProviders.map(item => item.getProps(config));
            log.silly(`C/renderApp: Resolving components`, componentImporter, config.contextProviders);
            // Resolve (import) components in parallel, first UI and then context providers
            const promisedComponents = await Promise.all([
                componentImporter(),
                ...config.contextProviders.map(async (ctxp) => await ctxp.cls()),
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVuZGVyZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zcmMvYXBwL3JlbmRlcmVyLnRzeCJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEtBQUssTUFBTSxPQUFPLENBQUM7QUFDMUIsT0FBTyxLQUFLLEdBQUcsTUFBTSxjQUFjLENBQUM7QUFDcEMsT0FBTyxLQUFLLFFBQVEsTUFBTSxXQUFXLENBQUM7QUFRdEMsT0FBTyxFQUFFLGFBQWEsRUFBRSxPQUFPLEVBQUUsTUFBTSxtQkFBbUIsQ0FBQztBQUUzRCxPQUFPLCtFQUErRSxDQUFDO0FBQ3ZGLE9BQU8sa0VBQWtFLENBQUM7QUFDMUUsT0FBTywwQ0FBMEMsQ0FBQztBQUNsRCxPQUFPLHlDQUF5QyxDQUFDO0FBQ2pELE9BQU8sRUFBRSxXQUFXLEVBQUUsV0FBVyxFQUFFLE1BQU0saUJBQWlCLENBQUM7QUErQzNELDRDQUE0QztBQUM1Qyw4RUFBOEU7QUFDOUUscURBQXFEO0FBQ3JELE1BQU0sQ0FBQyxNQUFNLFNBQVMsR0FBRyxDQUFtRCxNQUFTLEVBQWtCLEVBQUU7SUFFdkcsd0VBQXdFO0lBQ3hFLE1BQU0sT0FBTyxHQUFHLFFBQVEsQ0FBQyxjQUFjLENBQUMsS0FBSyxDQUFnQixDQUFDO0lBRTlELGlEQUFpRDtJQUNqRCxRQUFRLENBQUMsZUFBZSxDQUFDLFNBQVMsQ0FBQyxHQUFHLENBQUMsYUFBYSxPQUFPLENBQUMsUUFBUSxFQUFFLENBQUMsQ0FBQztJQUV4RSwyREFBMkQ7SUFDM0QsTUFBTSxZQUFZLEdBQUcsSUFBSSxlQUFlLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUVqRSxtRUFBbUU7SUFDbkUsTUFBTSxXQUFXLEdBQUcsWUFBWSxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUMxQyxNQUFNLGlCQUFpQixHQUFHLFdBQVcsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLGdCQUFnQixDQUFDLFdBQVcsQ0FBQyxD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LENBQUMsS0FBSyxDQUFDLDZCQUE2QixFQUFFLFdBQVcsQ0FBQyxDQUFDO1FBQ3RELE1BQU0sSUFBSSxLQUFLLENBQUMsNkJBQTZCLENBQUMsQ0FBQztLQUNoRDtBQUVILENBQUMsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBSZWFjdCBmcm9tICdyZWFjdCc7XG5pbXBvcnQgKiBhcyBsb2cgZnJvbSAnZWxlY3Ryb24tbG9nJztcbmltcG9ydCAqIGFzIFJlYWN0RE9NIGZyb20gJ3JlYWN0LWRvbSc7XG5cbmltcG9ydCB7IEFwcENvbmZpZyB9IGZyb20gJy4uL2NvbmZpZy9hcHAnO1xuaW1wb3J0IHsgUmVuZGVyZXJDb25maWcgfSBmcm9tICcuLi9jb25maWcvcmVuZGVyZXInO1xuXG5pbXBvcnQgeyBNb2RlbCwgQW55SURUeXBlIH0gZnJvbSAnLi4vZGIvbW9kZWxzJztcbmltcG9ydCB7IEluZGV4IH0gZnJvbSAnLi4vZGIvcXVlcnknO1xuXG5pbXBvcnQgeyBOb25JZGVhbFN0YXRlLCBTcGlubmVyIH0gZnJvbSAnQGJsdWVwcmludGpzL2NvcmUnO1xuXG5pbXBvcnQgJyFzdHlsZS1sb2FkZXIhY3NzLWxvYWRlciFAYmx1ZXByaW50anMvZGF0ZXRpbWUvbGliL2Nzcy9ibHVlcHJpbnQtZGF0ZXRpbWUuY3NzJztcbmltcG9ydCAnIXN0eWxlLWxvYWRlciFjc3MtbG9hZGVyIUBibHVlcHJpbnRqcy9jb3JlL2xpYi9jc3MvYmx1ZXByaW50LmNzcyc7XG5pbXBvcnQgJyFzdHlsZS1sb2FkZXIhY3NzLWxvYWRlciEuL25vcm1hbGl6ZS5jc3MnO1xuaW1wb3J0ICchc3R5bGUtbG9hZGVyIWNzcy1sb2FkZXIhLi9yZW5kZXJlci5jc3MnO1xuaW1wb3J0IHsgdXNlSVBDRXZlbnQsIHVzZUlQQ1ZhbHVlIH0gZnJvbSAnLi4vaXBjL3JlbmRlcmVyJztcblxuXG5pbnRlcmZhY2UgQXBwUmVuZGVyZXI8QyBleHRlbmRzIFJlbmRlcmVyQ29uZmlnPGFueT4+IHtcbiAgcm9vdDogSFRNTEVsZW1lbnRcbiAgdXNlQ291bnQ6IFVzZUNvdW50SG9vazxDPlxuICB1c2VJRHM6IFVzZUlEc0hvb2s8Qz5cbiAgdXNlTWFueTogVXNlTWFueUhvb2s8Qz5cbiAgdXNlT25lOiBVc2VPbmVIb29rPEM+XG59XG5cblxuLy8gRGF0YSBvcGVyYXRpb24gaG9vayBpbnRlcmZhY2VzXG5cbmludGVyZmFjZSBVc2VNYW55SG9va1Jlc3VsdDxNIGV4dGVuZHMgTW9kZWw+IHtcbiAgb2JqZWN0czogSW5kZXg8TT5cbiAgaXNVcGRhdGluZzogYm9vbGVhblxufVxudHlwZSBVc2VNYW55SG9vazxDIGV4dGVuZHMgUmVuZGVyZXJDb25maWc8YW55Pj4gPVxuPE0gZXh0ZW5kcyBNb2RlbCwgUSBleHRlbmRzIG9iamVjdD5cbihtb2RlbE5hbWU6IGtleW9mIENbXCJhcHBcIl1bXCJkYXRhXCJdLCBxdWVyeTogUSkgPT4gVXNlTWFueUhvb2tSZXN1bHQ8TT5cblxuaW50ZXJmYWNlIFVzZUlEc0hvb2tSZXN1bHQ8SURUeXBlIGV4dGVuZHMgQW55SURUeXBlPiB7XG4gIGlkczogSURUeXBlW11cbiAgaXNVcGRhdGluZzogYm9vbGVhblxufVxudHlwZSBVc2VJRHNIb29rPEMgZXh0ZW5kcyBSZW5kZXJlckNvbmZpZzxhbnk+PiA9XG48SURUeXBlIGV4dGVuZHMgQW55SURUeXBlLCBRIGV4dGVuZHMgb2JqZWN0PlxuKG1vZGVsTmFtZToga2V5b2YgQ1tcImFwcFwiXVtcImRhdGFcIl0sIHF1ZXJ5OiBRKSA9PiBVc2VJRHNIb29rUmVzdWx0PElEVHlwZT5cblxuaW50ZXJmYWNlIFVzZUNvdW50SG9va1Jlc3VsdCB7XG4gIGNvdW50OiBudW1iZXJcbiAgaXNVcGRhdGluZzogYm9vbGVhblxufVxudHlwZSBVc2VDb3VudEhvb2s8QyBleHRlbmRzIFJlbmRlcmVyQ29uZmlnPGFueT4+ID1cbjxRIGV4dGVuZHMgb2JqZWN0PlxuKG1vZGVsTmFtZToga2V5b2YgQ1tcImFwcFwiXVtcImRhdGFcIl0sIHF1ZXJ5OiBRKSA9PiBVc2VDb3VudEhvb2tSZXN1bHRcblxuaW50ZXJmYWNlIFVzZU9uZUhvb2tSZXN1bHQ8TSBleHRlbmRzIE1vZGVsPiB7XG4gIG9iamVjdDogTSB8IG51bGxcbiAgaXNVcGRhdGluZzogYm9vbGVhblxufVxudHlwZSBVc2VPbmVIb29rPEMgZXh0ZW5kcyBSZW5kZXJlckNvbmZpZzxhbnk+PiA9XG48TSBleHRlbmRzIE1vZGVsLCBJRFR5cGUgZXh0ZW5kcyBBbnlJRFR5cGU+XG4obW9kZWxOYW1lOiBrZXlvZiBDW1wiYXBwXCJdW1wiZGF0YVwiXSwgb2JqZWN0SUQ6IElEVHlwZSB8IG51bGwpID0+IFVzZU9uZUhvb2tSZXN1bHQ8TT5cblxuXG4vLyBSZW5kZXIgYXBwbGljYXRpb24gc2NyZWVuIGluIGEgbmV3IHdpbmRvd1xuLy8gd2l0aCBnaXZlbiB0b3AtbGV2ZWwgd2luZG93IFVJIGNvbXBvbmVudCBhbmQgKGlmIGFwcGxpY2FibGUpIGFueSBwYXJhbWV0ZXJzXG4vLyB3cmFwcGVkIGluIGNvbmZpZ3VyZWQgY29udGV4dCBwcm92aWRlciBjb21wb25lbnRzLlxuZXhwb3J0IGNvbnN0IHJlbmRlckFwcCA9IDxBIGV4dGVuZHMgQXBwQ29uZmlnLCBDIGV4dGVuZHMgUmVuZGVyZXJDb25maWc8QT4+KGNvbmZpZzogQyk6IEFwcFJlbmRlcmVyPEM+ID0+IHtcblxuICAvLyBlbGVjdHJvbi13ZWJwYWNrIGd1YXJhbnRlZXMgcHJlc2VuY2Ugb2YgI2FwcCBpbiBpbmRleC5odG1sIGl0IGJ1bmRsZXNcbiAgY29uc3QgYXBwUm9vdCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdhcHAnKSBhcyBIVE1MRWxlbWVudDtcblxuICAvLyBBZGQgYSBjbGFzcyBhbGxvd2luZyBwbGF0Zm9ybS1zcGVjaWZpYyBzdHlsaW5nXG4gIGRvY3VtZW50LmRvY3VtZW50RWxlbWVudC5jbGFzc0xpc3QuYWRkKGBwbGF0Zm9ybS0tJHtwcm9jZXNzLnBsYXRmb3JtfWApO1xuXG4gIC8vIEdldCBhbGwgcGFyYW1zIHBhc3NlZCB0byB0aGUgd2luZG93IHZpYSBHRVQgcXVlcnkgc3RyaW5nXG4gIGNvbnN0IHNlYXJjaFBhcmFtcyA9IG5ldyBVUkxTZWFyY2hQYXJhbXMod2luZG93LmxvY2F0aW9uLnNlYXJjaCk7XG5cbiAgLy8gUHJlcGFyZSBnZXR0ZXIgZm9yIHJlcXVlc3RlZCB0b3AtbGV2ZWwgd2luZG93IFVJIFJlYWN0IGNvbXBvbmVudFxuICBjb25zdCBjb21wb25lbnRJZCA9IHNlYXJjaFBhcmFtcy5nZXQoJ2MnKTtcbiAgY29uc3QgY29tcG9uZW50SW1wb3J0ZXIgPSBjb21wb25lbnRJZCA/IGNvbmZpZy53aW5kb3dDb21wb25lbnRzW2NvbXBvbmVudElkXSA6IG51bGw7XG5cbiAgbG9nLmRlYnVnKGBSZXF1ZXN0ZWQgd2luZG93IGNvbXBvbmVudCAke2NvbXBvbmVudElkfWApO1xuXG5cbiAgLy8gVE9ETzogUmVmYWN0b3Igb3V0IGhvb2sgaW5pdGlhbGl6YXRpb25cblxuICBjb25zdCB1c2VJRHM6IFVzZUlEc0hvb2s8Qz4gPVxuICA8SURUeXBlIGV4dGVuZHMgQW55SURUeXBlLCBRIGV4dGVuZHMgb2JqZWN0ID0gYW55PlxuICAobW9kZWxOYW1lOiBrZXlvZiBBW1wiZGF0YVwiXSwgcXVlcnk/OiBRKSA9PiB7XG4gICAgLyogUXVlcmllcyBkYXRhIGZvciBzcGVjaWZpZWQgbW9kZWwsIGxpc3RlbnMgZm9yIHVwZGF0ZSBldmVudHMgYW5kIHVwZGF0ZXMgdGhlIGRhdGFzZXQuICovXG5cbiAgICBjb25zdCB0cmFja2VkSURzID0gdXNlSVBDVmFsdWU8USwgeyBpZHM6IElEVHlwZVtdIH0+XG4gICAgKGBtb2RlbC0ke21vZGVsTmFtZX0tbGlzdC1pZHNgLCB7IGlkczogW10gfSwgcXVlcnkpO1xuXG4gICAgdXNlSVBDRXZlbnQ8eyBpZHM/OiBzdHJpbmdbXSB9PihgbW9kZWwtJHttb2RlbE5hbWV9LW9iamVjdHMtY2hhbmdlZGAsIGZ1bmN0aW9uICh7IGlkcyB9KSB7XG4gICAgICB0cmFja2VkSURzLnJlZnJlc2goKTtcblxuICAgICAgLy8gU2VlIFRPRE8gYXQgdXNlTWFueSgpLlxuICAgICAgLy9jb25zdCBzdHJpbmdJRHMgPSB0cmFja2VkSURzLnZhbHVlLmlkcy5tYXAoaWQgPT4gYCR7aWR9YCk7XG4gICAgICAvL2NvbnN0IHNob3VsZFJlZnJlc2ggPSBpZHMgIT09IHVuZGVmaW5lZFxuICAgICAgLy8gID8gaWRzLmZpbHRlcihpZCA9PiBzdHJpbmdJRHMuaW5jbHVkZXMoaWQpKS5sZW5ndGggPiAwXG4gICAgICAvLyAgOiB0cnVlO1xuICAgICAgLy9pZiAoc2hvdWxkUmVmcmVzaCkge1xuICAgICAgLy8gIHRyYWNrZWRJRHMucmVmcmVzaCgpO1xuICAgICAgLy99XG4gICAgfSk7XG5cbiAgICByZXR1cm4geyBpZHM6IHRyYWNrZWRJRHMudmFsdWUuaWRzLCBpc1VwZGF0aW5nOiB0cmFja2VkSURzLmlzVXBkYXRpbmcgfTtcbiAgfVxuXG4gIGNvbnN0IHVzZUNvdW50OiBVc2VDb3VudEhvb2s8Qz4gPVxuICA8USBleHRlbmRzIG9iamVjdCA9IGFueT5cbiAgKG1vZGVsTmFtZToga2V5b2YgQVtcImRhdGFcIl0sIHF1ZXJ5PzogUSkgPT4ge1xuICAgIC8qIFF1ZXJpZXMgZGF0YSBmb3Igc3BlY2lmaWVkIG1vZGVsLCBsaXN0ZW5zIGZvciB1cGRhdGUgZXZlbnRzIGFuZCB1cGRhdGVzIHRoZSBkYXRhc2V0LiAqL1xuXG4gICAgY29uc3QgY291bnQgPSB1c2VJUENWYWx1ZTxRLCB7IGNvdW50OiBudW1iZXIgfT5cbiAgICAoYG1vZGVsLSR7bW9kZWxOYW1lfS1jb3VudGAsIHsgY291bnQ6IDAgfSwgcXVlcnkpO1xuXG4gICAgdXNlSVBDRXZlbnQ8eyBpZHM/OiBzdHJpbmdbXSB9PihgbW9kZWwtJHttb2RlbE5hbWV9LW9iamVjdHMtY2hhbmdlZGAsIGZ1bmN0aW9uICgpIHtcbiAgICAgIGNvdW50LnJlZnJlc2goKTtcbiAgICB9KTtcblxuICAgIHJldHVybiB7IGNvdW50OiBjb3VudC52YWx1ZS5jb3VudCwgaXNVcGRhdGluZzogY291bnQuaXNVcGRhdGluZyB9O1xuICB9XG5cbiAgY29uc3QgdXNlTWFueTogVXNlTWFueUhvb2s8Qz4gPVxuICA8TSBleHRlbmRzIE1vZGVsLCBRIGV4dGVuZHMgb2JqZWN0ID0gYW55PlxuICAobW9kZWxOYW1lOiBrZXlvZiBBW1wiZGF0YVwiXSwgcXVlcnk/OiBRKSA9PiB7XG4gICAgLyogUXVlcmllcyBkYXRhIGZvciBzcGVjaWZpZWQgbW9kZWwsIGxpc3RlbnMgZm9yIHVwZGF0ZSBldmVudHMgYW5kIHVwZGF0ZXMgdGhlIGRhdGFzZXQuICovXG5cbiAgICBjb25zdCBvYmplY3RzID0gdXNlSVBDVmFsdWU8USwgSW5kZXg8TT4+XG4gICAgKGBtb2RlbC0ke21vZGVsTmFtZX0tcmVhZC1hbGxgLCB7fSwgcXVlcnkpO1xuXG4gICAgdXNlSVBDRXZlbnQ8eyBpZHM/OiBzdHJpbmdbXSB9PihgbW9kZWwtJHttb2RlbE5hbWV9LW9iamVjdHMtY2hhbmdlZGAsIGZ1bmN0aW9uICh7IGlkcyB9KSB7XG4gICAgICBvYmplY3RzLnJlZnJlc2goKTtcbiAgICAgIC8vIFRPRE86IE9ubHkgcmVmcmVzaCB3aGVuIG5lZWRlZC5cbiAgICAgIC8vIEJlbG93IGNvZGUgd29ya3MsIGV4Y2VwdCBpdCB3b27igJl0IHRyaWdnZXIgcmVmcmVzaFxuICAgICAgLy8gd2hlbiBuZXcgb2JqZWN0cyBhcmUgYWRkZWQ6XG4gICAgICAvLyBsb2cuc2lsbHkoXCJDL3JlbmRlckFwcDogQ2hhbmdlZCBvYmplY3QgSURzXCIsIGlkcyk7XG4gICAgICAvLyBjb25zdCB0cmFja2VkT2JqZWN0SURzID0gT2JqZWN0LmtleXMob2JqZWN0cy52YWx1ZSk7XG4gICAgICAvLyBjb25zdCBzaG91bGRSZWZyZXNoID0gaWRzID09PSB1bmRlZmluZWQgfHwgaWRzLmZpbHRlcihpZCA9PiB0cmFja2VkT2JqZWN0SURzLmluY2x1ZGVzKGlkKSkubGVuZ3RoID4gMDtcbiAgICAgIC8vIGlmIChzaG91bGRSZWZyZXNoKSB7XG4gICAgICAvLyAgIGxvZy5kZWJ1ZyhcIkMvcmVuZGVyQXBwOiBSZWZyZXNoaW5nIG9iamVjdHNcIiwgaWRzKTtcbiAgICAgIC8vICAgb2JqZWN0cy5yZWZyZXNoKCk7XG4gICAgICAvLyB9IGVsc2Uge1xuICAgICAgLy8gICBsb2cuZGVidWcoXCJDL3JlbmRlckFwcDogV2lsbCBub3QgcmVmcmVzaCBvYmplY3RzXCIsIGlkcyk7XG4gICAgICAvLyB9XG4gICAgfSk7XG5cbiAgICByZXR1cm4geyBvYmplY3RzOiBvYmplY3RzLnZhbHVlLCBpc1VwZGF0aW5nOiBvYmplY3RzLmlzVXBkYXRpbmcgfTtcbiAgfVxuXG4gIGNvbnN0IHVzZU9uZTogVXNlT25lSG9vazxDPiA9XG4gIDxNIGV4dGVuZHMgTW9kZWwsIElEVHlwZSBleHRlbmRzIEFueUlEVHlwZT5cbiAgKG1vZGVsTmFtZToga2V5b2YgQVtcImRhdGFcIl0sIG9iamVjdElEOiBJRFR5cGUgfCBudWxsKSA9PiB7XG4gICAgLyogUXVlcmllcyBkYXRhIGZvciBzcGVjaWZpZWQgbW9kZWwsIGxpc3RlbnMgZm9yIHVwZGF0ZSBldmVudHMgYW5kIHVwZGF0ZXMgdGhlIGRhdGFzZXQuICovXG5cbiAgICBjb25zdCBvYmplY3QgPSB1c2VJUENWYWx1ZTx7IG9iamVjdElEOiBJRFR5cGUgfCBudWxsIH0sIHsgb2JqZWN0OiBNIHwgbnVsbCB9PlxuICAgIChgbW9kZWwtJHttb2RlbE5hbWV9LXJlYWQtb25lYCwgeyBvYmplY3Q6IG51bGwgYXMgTSB8IG51bGwgfSwgeyBvYmplY3RJRCB9KTtcblxuICAgIHVzZUlQQ0V2ZW50PHsgaWRzPzogc3RyaW5nW10gfT4oYG1vZGVsLSR7bW9kZWxOYW1lfS1vYmplY3RzLWNoYW5nZWRgLCBmdW5jdGlvbiAoeyBpZHMgfSkge1xuICAgICAgY29uc3Qgc2hvdWxkUmVmcmVzaCA9IGlkcyA9PT0gdW5kZWZpbmVkIHx8IGlkcy5pbmNsdWRlcyhgJHtvYmplY3RJRH1gKTtcbiAgICAgIGlmIChzaG91bGRSZWZyZXNoKSB7XG4gICAgICAgIG9iamVjdC5yZWZyZXNoKCk7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICByZXR1cm4geyBvYmplY3Q6IG9iamVjdC52YWx1ZS5vYmplY3QsIGlzVXBkYXRpbmc6IG9iamVjdC5pc1VwZGF0aW5nIH07XG4gIH1cblxuICAvLyBGZXRjaCB0b3AtbGV2ZWwgVUkgY29tcG9uZW50IGNsYXNzIGFuZCByZW5kZXIgaXQuXG4gIGlmIChjb21wb25lbnRJbXBvcnRlcikge1xuICAgIChhc3luYyAoKSA9PiB7XG4gICAgICAvLyBTaG93IGxvYWRpbmcgaW5kaWNhdG9yIHdoaWxlIGNvbXBvbmVudHMgYXJlIGJlaW5nIHJlc29sdmVkXG4gICAgICBSZWFjdERPTS5yZW5kZXIoPFNwaW5uZXIgLz4sIGFwcFJvb3QpO1xuXG4gICAgICAvLyBHZXQgcHJvcHMgcHJlc2NyaWJlZCBmb3IgZWFjaCBjb250ZXh0IHByb3ZpZGVyIGNvbXBvbmVudFxuICAgICAgdmFyIGN0eFByb3ZpZGVyUHJvcHMgPSBjb25maWcuY29udGV4dFByb3ZpZGVycy5tYXAoaXRlbSA9PiBpdGVtLmdldFByb3BzKGNvbmZpZykpO1xuXG4gICAgICBsb2cuc2lsbHkoXG4gICAgICAgIGBDL3JlbmRlckFwcDogUmVzb2x2aW5nIGNvbXBvbmVudHNgLFxuICAgICAgICBjb21wb25lbnRJbXBvcnRlciwgY29uZmlnLmNvbnRleHRQcm92aWRlcnMpO1xuXG4gICAgICAvLyBSZXNvbHZlIChpbXBvcnQpIGNvbXBvbmVudHMgaW4gcGFyYWxsZWwsIGZpcnN0IFVJIGFuZCB0aGVuIGNvbnRleHQgcHJvdmlkZXJzXG4gICAgICBjb25zdCBwcm9taXNlZENvbXBvbmVudHM6IHsgZGVmYXVsdDogUmVhY3QuRkM8YW55PiB9W10gPSBhd2FpdCBQcm9taXNlLmFsbChbXG4gICAgICAgIGNvbXBvbmVudEltcG9ydGVyKCksXG4gICAgICAgIC4uLmNvbmZpZy5jb250ZXh0UHJvdmlkZXJzLm1hcChhc3luYyAoY3R4cCkgPT4gYXdhaXQgY3R4cC5jbHMoKSksXG4gICAgICBdKTtcblxuICAgICAgbG9nLnNpbGx5KFxuICAgICAgICBgQy9yZW5kZXJBcHA6IFJlc29sdmVkIGNvbXBvbmVudHNgLFxuICAgICAgICBwcm9taXNlZENvbXBvbmVudHMpO1xuXG4gICAgICAvLyBCcmVhayBkb3duIGNvbXBvbmVudHMgaW50byB0b3AtbGV2ZWwgd2luZG93IFVJICYgY29udGV4dCBwcm92aWRlcnNcbiAgICAgIGNvbnN0IFRvcFdpbmRvd0NvbXBvbmVudCA9IHByb21pc2VkQ29tcG9uZW50c1swXS5kZWZhdWx0O1xuICAgICAgdmFyIGN0eFByb3ZpZGVyQ29tcG9uZW50cyA9IHByb21pc2VkQ29tcG9uZW50cy5cbiAgICAgICAgc2xpY2UoMSwgcHJvbWlzZWRDb21wb25lbnRzLmxlbmd0aCkuXG4gICAgICAgIG1hcChpdGVtID0+IGl0ZW0uZGVmYXVsdCk7XG5cbiAgICAgIC8vIFJlb3JkZXIgY29udGV4dCBwcm92aWRlcnMgc28gdGhhdCB0b3AtbW9zdCBpcyB0aGUgbW9zdCBiYXNpY1xuICAgICAgY3R4UHJvdmlkZXJDb21wb25lbnRzLnJldmVyc2UoKTtcbiAgICAgIGN0eFByb3ZpZGVyUHJvcHMucmV2ZXJzZSgpO1xuXG4gICAgICAvLyBXcml0ZSBvdXQgdG9wLWxldmVsIHdpbmRvdyBjb21wb25lbnQgSlNYXG4gICAgICB2YXIgYXBwTWFya3VwID0gPFRvcFdpbmRvd0NvbXBvbmVudCBxdWVyeT17c2VhcmNoUGFyYW1zfSAvPjtcblxuICAgICAgbG9nLmRlYnVnKFxuICAgICAgICBgQy9yZW5kZXJBcHA6IEdvdCBjb250ZXh0IHByb3ZpZGVyIGNvbXBvbmVudHNgLFxuICAgICAgICBjdHhQcm92aWRlckNvbXBvbmVudHMpO1xuXG4gICAgICAvLyBXcmFwIHRoZSBKU1ggaW50byBjb250ZXh0IHByb3ZpZGVyIGNvbXBvbmVudHNcbiAgICAgIGZvciAoY29uc3QgW2lkeCwgQ29udGV4dFByb3ZpZGVyXSBvZiBjdHhQcm92aWRlckNvbXBvbmVudHMuZW50cmllcygpKSB7XG4gICAgICAgIGxvZy52ZXJib3NlKCAgXG4gICAgICAgICAgYEMvcmVuZGVyQXBwOiBJbml0aWFsaXppbmcgY29udGV4dCBwcm92aWRlciAjJHtpZHh9YCxcbiAgICAgICAgICBjdHhQcm92aWRlckNvbXBvbmVudHNbaWR4XSxcbiAgICAgICAgICBjdHhQcm92aWRlclByb3BzW2lkeF0pO1xuXG4gICAgICAgIGFwcE1hcmt1cCA9IChcbiAgICAgICAgICA8Q29udGV4dFByb3ZpZGVyIHsuLi5jdHhQcm92aWRlclByb3BzW2lkeF19PlxuICAgICAgICAgICAge2FwcE1hcmt1cH1cbiAgICAgICAgICA8L0NvbnRleHRQcm92aWRlcj5cbiAgICAgICAgKTtcbiAgICAgIH1cblxuICAgICAgbG9nLmRlYnVnKFwiQy9yZW5kZXJBcHA6IFJlbmRlcmluZ1wiKTtcblxuICAgICAgLy8gUmVuZGVyIHRoZSBKU1hcbiAgICAgIFJlYWN0RE9NLnJlbmRlcihhcHBNYXJrdXAsIGFwcFJvb3QpO1xuICAgIH0pKCk7XG5cbiAgICByZXR1cm4ge1xuICAgICAgcm9vdDogYXBwUm9vdCxcbiAgICAgIHVzZUNvdW50LFxuICAgICAgdXNlSURzLFxuICAgICAgdXNlTWFueSxcbiAgICAgIHVzZU9uZSxcbiAgICB9O1xuXG4gIH0gZWxzZSB7XG4gICAgLy8gQ29tcG9uZW50IHNwZWNpZmllZCBpbiBHRVQgcGFyYW1zIGlzIG5vdCBwcmVzZW50IGluIGFwcCByZW5kZXJlciBjb25maWcuXG4gICAgLy8gVE9ETzogSGFuZGxlIG1pc2NvbmZpZ3VyZWQgUmVhY3QgY29udGV4dCBwcm92aWRlcnMgYW5kIGZhaWxlZCBpbXBvcnQgYXQgcnVudGltZVxuICAgIFJlYWN0RE9NLnJlbmRlcig8Tm9uSWRlYWxTdGF0ZVxuICAgICAgaWNvbj1cImVycm9yXCJcbiAgICAgIHRpdGxlPVwiVW5rbm93biBjb21wb25lbnQgcmVxdWVzdGVkXCIgLz4sIGFwcFJvb3QpO1xuXG4gICAgbG9nLmVycm9yKFwiVW5rbm93biBjb21wb25lbnQgcmVxdWVzdGVkXCIsIGNvbXBvbmVudElkKTtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJVbmtub3duIGNvbXBvbmVudCByZXF1ZXN0ZWRcIik7XG4gIH1cblxufTsiXX0=