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
        return { ids: trackedIDs.value.ids };
    };
    const useCount = (modelName, query) => {
        /* Queries data for specified model, listens for update events and updates the dataset. */
        const count = useIPCValue(`model-${modelName}-count`, { count: 0 }, query);
        useIPCEvent(`model-${modelName}-objects-changed`, function () {
            count.refresh();
        });
        return { count: count.value.count };
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
        return { objects: objects.value };
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
        return { object: object.value.object };
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVuZGVyZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zcmMvYXBwL3JlbmRlcmVyLnRzeCJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEtBQUssTUFBTSxPQUFPLENBQUM7QUFDMUIsT0FBTyxLQUFLLEdBQUcsTUFBTSxjQUFjLENBQUM7QUFDcEMsT0FBTyxLQUFLLFFBQVEsTUFBTSxXQUFXLENBQUM7QUFRdEMsT0FBTyxFQUFFLGFBQWEsRUFBRSxPQUFPLEVBQUUsTUFBTSxtQkFBbUIsQ0FBQztBQUUzRCxPQUFPLCtFQUErRSxDQUFDO0FBQ3ZGLE9BQU8sa0VBQWtFLENBQUM7QUFDMUUsT0FBTywwQ0FBMEMsQ0FBQztBQUNsRCxPQUFPLHlDQUF5QyxDQUFDO0FBQ2pELE9BQU8sRUFBRSxXQUFXLEVBQUUsV0FBVyxFQUFFLE1BQU0saUJBQWlCLENBQUM7QUEyQzNELDRDQUE0QztBQUM1Qyw4RUFBOEU7QUFDOUUscURBQXFEO0FBQ3JELE1BQU0sQ0FBQyxNQUFNLFNBQVMsR0FBRyxDQUFtRCxNQUFTLEVBQWtCLEVBQUU7SUFFdkcsd0VBQXdFO0lBQ3hFLE1BQU0sT0FBTyxHQUFHLFFBQVEsQ0FBQyxjQUFjLENBQUMsS0FBSyxDQUFnQixDQUFDO0lBRTlELGlEQUFpRDtJQUNqRCxRQUFRLENBQUMsZUFBZSxDQUFDLFNBQVMsQ0FBQyxHQUFHLENBQUMsYUFBYSxPQUFPLENBQUMsUUFBUSxFQUFFLENBQUMsQ0FBQztJQUV4RSwyREFBMkQ7SUFDM0QsTUFBTSxZQUFZLEdBQUcsSUFBSSxlQUFlLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUVqRSxtRUFBbUU7SUFDbkUsTUFBTSxXQUFXLEdBQUcsWUFBWSxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUMxQyxNQUFNLGlCQUFpQixHQUFHLFdBQVcsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLGdCQUFnQixDQUFDLFdBQVcsQ0FBQyxD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ZW50IjpbImltcG9ydCBSZWFjdCBmcm9tICdyZWFjdCc7XG5pbXBvcnQgKiBhcyBsb2cgZnJvbSAnZWxlY3Ryb24tbG9nJztcbmltcG9ydCAqIGFzIFJlYWN0RE9NIGZyb20gJ3JlYWN0LWRvbSc7XG5cbmltcG9ydCB7IEFwcENvbmZpZyB9IGZyb20gJy4uL2NvbmZpZy9hcHAnO1xuaW1wb3J0IHsgUmVuZGVyZXJDb25maWcgfSBmcm9tICcuLi9jb25maWcvcmVuZGVyZXInO1xuXG5pbXBvcnQgeyBNb2RlbCwgQW55SURUeXBlIH0gZnJvbSAnLi4vZGIvbW9kZWxzJztcbmltcG9ydCB7IEluZGV4IH0gZnJvbSAnLi4vZGIvcXVlcnknO1xuXG5pbXBvcnQgeyBOb25JZGVhbFN0YXRlLCBTcGlubmVyIH0gZnJvbSAnQGJsdWVwcmludGpzL2NvcmUnO1xuXG5pbXBvcnQgJyFzdHlsZS1sb2FkZXIhY3NzLWxvYWRlciFAYmx1ZXByaW50anMvZGF0ZXRpbWUvbGliL2Nzcy9ibHVlcHJpbnQtZGF0ZXRpbWUuY3NzJztcbmltcG9ydCAnIXN0eWxlLWxvYWRlciFjc3MtbG9hZGVyIUBibHVlcHJpbnRqcy9jb3JlL2xpYi9jc3MvYmx1ZXByaW50LmNzcyc7XG5pbXBvcnQgJyFzdHlsZS1sb2FkZXIhY3NzLWxvYWRlciEuL25vcm1hbGl6ZS5jc3MnO1xuaW1wb3J0ICchc3R5bGUtbG9hZGVyIWNzcy1sb2FkZXIhLi9yZW5kZXJlci5jc3MnO1xuaW1wb3J0IHsgdXNlSVBDRXZlbnQsIHVzZUlQQ1ZhbHVlIH0gZnJvbSAnLi4vaXBjL3JlbmRlcmVyJztcblxuXG5pbnRlcmZhY2UgQXBwUmVuZGVyZXI8QyBleHRlbmRzIFJlbmRlcmVyQ29uZmlnPGFueT4+IHtcbiAgcm9vdDogSFRNTEVsZW1lbnRcbiAgdXNlQ291bnQ6IFVzZUNvdW50SG9vazxDPlxuICB1c2VJRHM6IFVzZUlEc0hvb2s8Qz5cbiAgdXNlTWFueTogVXNlTWFueUhvb2s8Qz5cbiAgdXNlT25lOiBVc2VPbmVIb29rPEM+XG59XG5cblxuLy8gRGF0YSBvcGVyYXRpb24gaG9vayBpbnRlcmZhY2VzXG5cbmludGVyZmFjZSBVc2VNYW55SG9va1Jlc3VsdDxNIGV4dGVuZHMgTW9kZWw+IHtcbiAgb2JqZWN0czogSW5kZXg8TT5cbn1cbnR5cGUgVXNlTWFueUhvb2s8QyBleHRlbmRzIFJlbmRlcmVyQ29uZmlnPGFueT4+ID1cbjxNIGV4dGVuZHMgTW9kZWwsIFEgZXh0ZW5kcyBvYmplY3Q+XG4obW9kZWxOYW1lOiBrZXlvZiBDW1wiYXBwXCJdW1wiZGF0YVwiXSwgcXVlcnk6IFEpID0+IFVzZU1hbnlIb29rUmVzdWx0PE0+XG5cbmludGVyZmFjZSBVc2VJRHNIb29rUmVzdWx0PElEVHlwZSBleHRlbmRzIEFueUlEVHlwZT4ge1xuICBpZHM6IElEVHlwZVtdXG59XG50eXBlIFVzZUlEc0hvb2s8QyBleHRlbmRzIFJlbmRlcmVyQ29uZmlnPGFueT4+ID1cbjxJRFR5cGUgZXh0ZW5kcyBBbnlJRFR5cGUsIFEgZXh0ZW5kcyBvYmplY3Q+XG4obW9kZWxOYW1lOiBrZXlvZiBDW1wiYXBwXCJdW1wiZGF0YVwiXSwgcXVlcnk6IFEpID0+IFVzZUlEc0hvb2tSZXN1bHQ8SURUeXBlPlxuXG5pbnRlcmZhY2UgVXNlQ291bnRIb29rUmVzdWx0IHtcbiAgY291bnQ6IG51bWJlclxufVxudHlwZSBVc2VDb3VudEhvb2s8QyBleHRlbmRzIFJlbmRlcmVyQ29uZmlnPGFueT4+ID1cbjxRIGV4dGVuZHMgb2JqZWN0PlxuKG1vZGVsTmFtZToga2V5b2YgQ1tcImFwcFwiXVtcImRhdGFcIl0sIHF1ZXJ5OiBRKSA9PiBVc2VDb3VudEhvb2tSZXN1bHRcblxuaW50ZXJmYWNlIFVzZU9uZUhvb2tSZXN1bHQ8TSBleHRlbmRzIE1vZGVsPiB7XG4gIG9iamVjdDogTSB8IG51bGxcbn1cbnR5cGUgVXNlT25lSG9vazxDIGV4dGVuZHMgUmVuZGVyZXJDb25maWc8YW55Pj4gPVxuPE0gZXh0ZW5kcyBNb2RlbCwgSURUeXBlIGV4dGVuZHMgQW55SURUeXBlPlxuKG1vZGVsTmFtZToga2V5b2YgQ1tcImFwcFwiXVtcImRhdGFcIl0sIG9iamVjdElEOiBJRFR5cGUgfCBudWxsKSA9PiBVc2VPbmVIb29rUmVzdWx0PE0+XG5cblxuLy8gUmVuZGVyIGFwcGxpY2F0aW9uIHNjcmVlbiBpbiBhIG5ldyB3aW5kb3dcbi8vIHdpdGggZ2l2ZW4gdG9wLWxldmVsIHdpbmRvdyBVSSBjb21wb25lbnQgYW5kIChpZiBhcHBsaWNhYmxlKSBhbnkgcGFyYW1ldGVyc1xuLy8gd3JhcHBlZCBpbiBjb25maWd1cmVkIGNvbnRleHQgcHJvdmlkZXIgY29tcG9uZW50cy5cbmV4cG9ydCBjb25zdCByZW5kZXJBcHAgPSA8QSBleHRlbmRzIEFwcENvbmZpZywgQyBleHRlbmRzIFJlbmRlcmVyQ29uZmlnPEE+Pihjb25maWc6IEMpOiBBcHBSZW5kZXJlcjxDPiA9PiB7XG5cbiAgLy8gZWxlY3Ryb24td2VicGFjayBndWFyYW50ZWVzIHByZXNlbmNlIG9mICNhcHAgaW4gaW5kZXguaHRtbCBpdCBidW5kbGVzXG4gIGNvbnN0IGFwcFJvb3QgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYXBwJykgYXMgSFRNTEVsZW1lbnQ7XG5cbiAgLy8gQWRkIGEgY2xhc3MgYWxsb3dpbmcgcGxhdGZvcm0tc3BlY2lmaWMgc3R5bGluZ1xuICBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuY2xhc3NMaXN0LmFkZChgcGxhdGZvcm0tLSR7cHJvY2Vzcy5wbGF0Zm9ybX1gKTtcblxuICAvLyBHZXQgYWxsIHBhcmFtcyBwYXNzZWQgdG8gdGhlIHdpbmRvdyB2aWEgR0VUIHF1ZXJ5IHN0cmluZ1xuICBjb25zdCBzZWFyY2hQYXJhbXMgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKHdpbmRvdy5sb2NhdGlvbi5zZWFyY2gpO1xuXG4gIC8vIFByZXBhcmUgZ2V0dGVyIGZvciByZXF1ZXN0ZWQgdG9wLWxldmVsIHdpbmRvdyBVSSBSZWFjdCBjb21wb25lbnRcbiAgY29uc3QgY29tcG9uZW50SWQgPSBzZWFyY2hQYXJhbXMuZ2V0KCdjJyk7XG4gIGNvbnN0IGNvbXBvbmVudEltcG9ydGVyID0gY29tcG9uZW50SWQgPyBjb25maWcud2luZG93Q29tcG9uZW50c1tjb21wb25lbnRJZF0gOiBudWxsO1xuXG4gIGxvZy5kZWJ1ZyhgUmVxdWVzdGVkIHdpbmRvdyBjb21wb25lbnQgJHtjb21wb25lbnRJZH1gKTtcblxuXG4gIC8vIFRPRE86IFJlZmFjdG9yIG91dCBob29rIGluaXRpYWxpemF0aW9uXG5cbiAgY29uc3QgdXNlSURzOiBVc2VJRHNIb29rPEM+ID1cbiAgPElEVHlwZSBleHRlbmRzIEFueUlEVHlwZSwgUSBleHRlbmRzIG9iamVjdCA9IGFueT5cbiAgKG1vZGVsTmFtZToga2V5b2YgQVtcImRhdGFcIl0sIHF1ZXJ5PzogUSkgPT4ge1xuICAgIC8qIFF1ZXJpZXMgZGF0YSBmb3Igc3BlY2lmaWVkIG1vZGVsLCBsaXN0ZW5zIGZvciB1cGRhdGUgZXZlbnRzIGFuZCB1cGRhdGVzIHRoZSBkYXRhc2V0LiAqL1xuXG4gICAgY29uc3QgdHJhY2tlZElEcyA9IHVzZUlQQ1ZhbHVlPFEsIHsgaWRzOiBJRFR5cGVbXSB9PlxuICAgIChgbW9kZWwtJHttb2RlbE5hbWV9LWxpc3QtaWRzYCwgeyBpZHM6IFtdIH0sIHF1ZXJ5KTtcblxuICAgIHVzZUlQQ0V2ZW50PHsgaWRzPzogc3RyaW5nW10gfT4oYG1vZGVsLSR7bW9kZWxOYW1lfS1vYmplY3RzLWNoYW5nZWRgLCBmdW5jdGlvbiAoeyBpZHMgfSkge1xuICAgICAgdHJhY2tlZElEcy5yZWZyZXNoKCk7XG5cbiAgICAgIC8vIFNlZSBUT0RPIGF0IHVzZU1hbnkoKS5cbiAgICAgIC8vY29uc3Qgc3RyaW5nSURzID0gdHJhY2tlZElEcy52YWx1ZS5pZHMubWFwKGlkID0+IGAke2lkfWApO1xuICAgICAgLy9jb25zdCBzaG91bGRSZWZyZXNoID0gaWRzICE9PSB1bmRlZmluZWRcbiAgICAgIC8vICA/IGlkcy5maWx0ZXIoaWQgPT4gc3RyaW5nSURzLmluY2x1ZGVzKGlkKSkubGVuZ3RoID4gMFxuICAgICAgLy8gIDogdHJ1ZTtcbiAgICAgIC8vaWYgKHNob3VsZFJlZnJlc2gpIHtcbiAgICAgIC8vICB0cmFja2VkSURzLnJlZnJlc2goKTtcbiAgICAgIC8vfVxuICAgIH0pO1xuXG4gICAgcmV0dXJuIHsgaWRzOiB0cmFja2VkSURzLnZhbHVlLmlkcyB9O1xuICB9XG5cbiAgY29uc3QgdXNlQ291bnQ6IFVzZUNvdW50SG9vazxDPiA9XG4gIDxRIGV4dGVuZHMgb2JqZWN0ID0gYW55PlxuICAobW9kZWxOYW1lOiBrZXlvZiBBW1wiZGF0YVwiXSwgcXVlcnk/OiBRKSA9PiB7XG4gICAgLyogUXVlcmllcyBkYXRhIGZvciBzcGVjaWZpZWQgbW9kZWwsIGxpc3RlbnMgZm9yIHVwZGF0ZSBldmVudHMgYW5kIHVwZGF0ZXMgdGhlIGRhdGFzZXQuICovXG5cbiAgICBjb25zdCBjb3VudCA9IHVzZUlQQ1ZhbHVlPFEsIHsgY291bnQ6IG51bWJlciB9PlxuICAgIChgbW9kZWwtJHttb2RlbE5hbWV9LWNvdW50YCwgeyBjb3VudDogMCB9LCBxdWVyeSk7XG5cbiAgICB1c2VJUENFdmVudDx7IGlkcz86IHN0cmluZ1tdIH0+KGBtb2RlbC0ke21vZGVsTmFtZX0tb2JqZWN0cy1jaGFuZ2VkYCwgZnVuY3Rpb24gKCkge1xuICAgICAgY291bnQucmVmcmVzaCgpO1xuICAgIH0pO1xuXG4gICAgcmV0dXJuIHsgY291bnQ6IGNvdW50LnZhbHVlLmNvdW50IH07XG4gIH1cblxuICBjb25zdCB1c2VNYW55OiBVc2VNYW55SG9vazxDPiA9XG4gIDxNIGV4dGVuZHMgTW9kZWwsIFEgZXh0ZW5kcyBvYmplY3QgPSBhbnk+XG4gIChtb2RlbE5hbWU6IGtleW9mIEFbXCJkYXRhXCJdLCBxdWVyeT86IFEpID0+IHtcbiAgICAvKiBRdWVyaWVzIGRhdGEgZm9yIHNwZWNpZmllZCBtb2RlbCwgbGlzdGVucyBmb3IgdXBkYXRlIGV2ZW50cyBhbmQgdXBkYXRlcyB0aGUgZGF0YXNldC4gKi9cblxuICAgIGNvbnN0IG9iamVjdHMgPSB1c2VJUENWYWx1ZTxRLCBJbmRleDxNPj5cbiAgICAoYG1vZGVsLSR7bW9kZWxOYW1lfS1yZWFkLWFsbGAsIHt9LCBxdWVyeSk7XG5cbiAgICB1c2VJUENFdmVudDx7IGlkcz86IHN0cmluZ1tdIH0+KGBtb2RlbC0ke21vZGVsTmFtZX0tb2JqZWN0cy1jaGFuZ2VkYCwgZnVuY3Rpb24gKHsgaWRzIH0pIHtcbiAgICAgIG9iamVjdHMucmVmcmVzaCgpO1xuICAgICAgLy8gVE9ETzogT25seSByZWZyZXNoIHdoZW4gbmVlZGVkLlxuICAgICAgLy8gQmVsb3cgY29kZSB3b3JrcywgZXhjZXB0IGl0IHdvbuKAmXQgdHJpZ2dlciByZWZyZXNoXG4gICAgICAvLyB3aGVuIG5ldyBvYmplY3RzIGFyZSBhZGRlZDpcbiAgICAgIC8vIGxvZy5zaWxseShcIkMvcmVuZGVyQXBwOiBDaGFuZ2VkIG9iamVjdCBJRHNcIiwgaWRzKTtcbiAgICAgIC8vIGNvbnN0IHRyYWNrZWRPYmplY3RJRHMgPSBPYmplY3Qua2V5cyhvYmplY3RzLnZhbHVlKTtcbiAgICAgIC8vIGNvbnN0IHNob3VsZFJlZnJlc2ggPSBpZHMgPT09IHVuZGVmaW5lZCB8fCBpZHMuZmlsdGVyKGlkID0+IHRyYWNrZWRPYmplY3RJRHMuaW5jbHVkZXMoaWQpKS5sZW5ndGggPiAwO1xuICAgICAgLy8gaWYgKHNob3VsZFJlZnJlc2gpIHtcbiAgICAgIC8vICAgbG9nLmRlYnVnKFwiQy9yZW5kZXJBcHA6IFJlZnJlc2hpbmcgb2JqZWN0c1wiLCBpZHMpO1xuICAgICAgLy8gICBvYmplY3RzLnJlZnJlc2goKTtcbiAgICAgIC8vIH0gZWxzZSB7XG4gICAgICAvLyAgIGxvZy5kZWJ1ZyhcIkMvcmVuZGVyQXBwOiBXaWxsIG5vdCByZWZyZXNoIG9iamVjdHNcIiwgaWRzKTtcbiAgICAgIC8vIH1cbiAgICB9KTtcblxuICAgIHJldHVybiB7IG9iamVjdHM6IG9iamVjdHMudmFsdWUgfTtcbiAgfVxuXG4gIGNvbnN0IHVzZU9uZTogVXNlT25lSG9vazxDPiA9XG4gIDxNIGV4dGVuZHMgTW9kZWwsIElEVHlwZSBleHRlbmRzIEFueUlEVHlwZT5cbiAgKG1vZGVsTmFtZToga2V5b2YgQVtcImRhdGFcIl0sIG9iamVjdElEOiBJRFR5cGUgfCBudWxsKSA9PiB7XG4gICAgLyogUXVlcmllcyBkYXRhIGZvciBzcGVjaWZpZWQgbW9kZWwsIGxpc3RlbnMgZm9yIHVwZGF0ZSBldmVudHMgYW5kIHVwZGF0ZXMgdGhlIGRhdGFzZXQuICovXG5cbiAgICBjb25zdCBvYmplY3QgPSB1c2VJUENWYWx1ZTx7IG9iamVjdElEOiBJRFR5cGUgfCBudWxsIH0sIHsgb2JqZWN0OiBNIHwgbnVsbCB9PlxuICAgIChgbW9kZWwtJHttb2RlbE5hbWV9LXJlYWQtb25lYCwgeyBvYmplY3Q6IG51bGwgYXMgTSB8IG51bGwgfSwgeyBvYmplY3RJRCB9KTtcblxuICAgIHVzZUlQQ0V2ZW50PHsgaWRzPzogc3RyaW5nW10gfT4oYG1vZGVsLSR7bW9kZWxOYW1lfS1vYmplY3RzLWNoYW5nZWRgLCBmdW5jdGlvbiAoeyBpZHMgfSkge1xuICAgICAgY29uc3Qgc2hvdWxkUmVmcmVzaCA9IGlkcyA9PT0gdW5kZWZpbmVkIHx8IGlkcy5pbmNsdWRlcyhgJHtvYmplY3RJRH1gKTtcbiAgICAgIGlmIChzaG91bGRSZWZyZXNoKSB7XG4gICAgICAgIG9iamVjdC5yZWZyZXNoKCk7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICByZXR1cm4geyBvYmplY3Q6IG9iamVjdC52YWx1ZS5vYmplY3QgfTtcbiAgfVxuXG4gIC8vIEZldGNoIHRvcC1sZXZlbCBVSSBjb21wb25lbnQgY2xhc3MgYW5kIHJlbmRlciBpdC5cbiAgaWYgKGNvbXBvbmVudEltcG9ydGVyKSB7XG4gICAgKGFzeW5jICgpID0+IHtcbiAgICAgIC8vIFNob3cgbG9hZGluZyBpbmRpY2F0b3Igd2hpbGUgY29tcG9uZW50cyBhcmUgYmVpbmcgcmVzb2x2ZWRcbiAgICAgIFJlYWN0RE9NLnJlbmRlcig8U3Bpbm5lciAvPiwgYXBwUm9vdCk7XG5cbiAgICAgIC8vIEdldCBwcm9wcyBwcmVzY3JpYmVkIGZvciBlYWNoIGNvbnRleHQgcHJvdmlkZXIgY29tcG9uZW50XG4gICAgICB2YXIgY3R4UHJvdmlkZXJQcm9wcyA9IGNvbmZpZy5jb250ZXh0UHJvdmlkZXJzLm1hcChpdGVtID0+IGl0ZW0uZ2V0UHJvcHMoY29uZmlnKSk7XG5cbiAgICAgIGxvZy5zaWxseShcbiAgICAgICAgYEMvcmVuZGVyQXBwOiBSZXNvbHZpbmcgY29tcG9uZW50c2AsXG4gICAgICAgIGNvbXBvbmVudEltcG9ydGVyLCBjb25maWcuY29udGV4dFByb3ZpZGVycyk7XG5cbiAgICAgIC8vIFJlc29sdmUgKGltcG9ydCkgY29tcG9uZW50cyBpbiBwYXJhbGxlbCwgZmlyc3QgVUkgYW5kIHRoZW4gY29udGV4dCBwcm92aWRlcnNcbiAgICAgIGNvbnN0IHByb21pc2VkQ29tcG9uZW50czogeyBkZWZhdWx0OiBSZWFjdC5GQzxhbnk+IH1bXSA9IGF3YWl0IFByb21pc2UuYWxsKFtcbiAgICAgICAgY29tcG9uZW50SW1wb3J0ZXIoKSxcbiAgICAgICAgLi4uY29uZmlnLmNvbnRleHRQcm92aWRlcnMubWFwKGFzeW5jIChjdHhwKSA9PiBhd2FpdCBjdHhwLmNscygpKSxcbiAgICAgIF0pO1xuXG4gICAgICBsb2cuc2lsbHkoXG4gICAgICAgIGBDL3JlbmRlckFwcDogUmVzb2x2ZWQgY29tcG9uZW50c2AsXG4gICAgICAgIHByb21pc2VkQ29tcG9uZW50cyk7XG5cbiAgICAgIC8vIEJyZWFrIGRvd24gY29tcG9uZW50cyBpbnRvIHRvcC1sZXZlbCB3aW5kb3cgVUkgJiBjb250ZXh0IHByb3ZpZGVyc1xuICAgICAgY29uc3QgVG9wV2luZG93Q29tcG9uZW50ID0gcHJvbWlzZWRDb21wb25lbnRzWzBdLmRlZmF1bHQ7XG4gICAgICB2YXIgY3R4UHJvdmlkZXJDb21wb25lbnRzID0gcHJvbWlzZWRDb21wb25lbnRzLlxuICAgICAgICBzbGljZSgxLCBwcm9taXNlZENvbXBvbmVudHMubGVuZ3RoKS5cbiAgICAgICAgbWFwKGl0ZW0gPT4gaXRlbS5kZWZhdWx0KTtcblxuICAgICAgLy8gUmVvcmRlciBjb250ZXh0IHByb3ZpZGVycyBzbyB0aGF0IHRvcC1tb3N0IGlzIHRoZSBtb3N0IGJhc2ljXG4gICAgICBjdHhQcm92aWRlckNvbXBvbmVudHMucmV2ZXJzZSgpO1xuICAgICAgY3R4UHJvdmlkZXJQcm9wcy5yZXZlcnNlKCk7XG5cbiAgICAgIC8vIFdyaXRlIG91dCB0b3AtbGV2ZWwgd2luZG93IGNvbXBvbmVudCBKU1hcbiAgICAgIHZhciBhcHBNYXJrdXAgPSA8VG9wV2luZG93Q29tcG9uZW50IHF1ZXJ5PXtzZWFyY2hQYXJhbXN9IC8+O1xuXG4gICAgICBsb2cuZGVidWcoXG4gICAgICAgIGBDL3JlbmRlckFwcDogR290IGNvbnRleHQgcHJvdmlkZXIgY29tcG9uZW50c2AsXG4gICAgICAgIGN0eFByb3ZpZGVyQ29tcG9uZW50cyk7XG5cbiAgICAgIC8vIFdyYXAgdGhlIEpTWCBpbnRvIGNvbnRleHQgcHJvdmlkZXIgY29tcG9uZW50c1xuICAgICAgZm9yIChjb25zdCBbaWR4LCBDb250ZXh0UHJvdmlkZXJdIG9mIGN0eFByb3ZpZGVyQ29tcG9uZW50cy5lbnRyaWVzKCkpIHtcbiAgICAgICAgbG9nLnZlcmJvc2UoICBcbiAgICAgICAgICBgQy9yZW5kZXJBcHA6IEluaXRpYWxpemluZyBjb250ZXh0IHByb3ZpZGVyICMke2lkeH1gLFxuICAgICAgICAgIGN0eFByb3ZpZGVyQ29tcG9uZW50c1tpZHhdLFxuICAgICAgICAgIGN0eFByb3ZpZGVyUHJvcHNbaWR4XSk7XG5cbiAgICAgICAgYXBwTWFya3VwID0gKFxuICAgICAgICAgIDxDb250ZXh0UHJvdmlkZXIgey4uLmN0eFByb3ZpZGVyUHJvcHNbaWR4XX0+XG4gICAgICAgICAgICB7YXBwTWFya3VwfVxuICAgICAgICAgIDwvQ29udGV4dFByb3ZpZGVyPlxuICAgICAgICApO1xuICAgICAgfVxuXG4gICAgICBsb2cuZGVidWcoXCJDL3JlbmRlckFwcDogUmVuZGVyaW5nXCIpO1xuXG4gICAgICAvLyBSZW5kZXIgdGhlIEpTWFxuICAgICAgUmVhY3RET00ucmVuZGVyKGFwcE1hcmt1cCwgYXBwUm9vdCk7XG4gICAgfSkoKTtcblxuICAgIHJldHVybiB7XG4gICAgICByb290OiBhcHBSb290LFxuICAgICAgdXNlQ291bnQsXG4gICAgICB1c2VJRHMsXG4gICAgICB1c2VNYW55LFxuICAgICAgdXNlT25lLFxuICAgIH07XG5cbiAgfSBlbHNlIHtcbiAgICAvLyBDb21wb25lbnQgc3BlY2lmaWVkIGluIEdFVCBwYXJhbXMgaXMgbm90IHByZXNlbnQgaW4gYXBwIHJlbmRlcmVyIGNvbmZpZy5cbiAgICAvLyBUT0RPOiBIYW5kbGUgbWlzY29uZmlndXJlZCBSZWFjdCBjb250ZXh0IHByb3ZpZGVycyBhbmQgZmFpbGVkIGltcG9ydCBhdCBydW50aW1lXG4gICAgUmVhY3RET00ucmVuZGVyKDxOb25JZGVhbFN0YXRlXG4gICAgICBpY29uPVwiZXJyb3JcIlxuICAgICAgdGl0bGU9XCJVbmtub3duIGNvbXBvbmVudCByZXF1ZXN0ZWRcIiAvPiwgYXBwUm9vdCk7XG5cbiAgICBsb2cuZXJyb3IoXCJVbmtub3duIGNvbXBvbmVudCByZXF1ZXN0ZWRcIiwgY29tcG9uZW50SWQpO1xuICAgIHRocm93IG5ldyBFcnJvcihcIlVua25vd24gY29tcG9uZW50IHJlcXVlc3RlZFwiKTtcbiAgfVxuXG59OyJdfQ==