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
            const stringIDs = trackedIDs.value.ids.map(id => `${id}`);
            const shouldRefresh = ids !== undefined
                ? ids.filter(id => stringIDs.includes(id)).length > 0
                : true;
            if (shouldRefresh) {
                trackedIDs.refresh();
            }
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
            const trackedObjectIDs = Object.keys(objects.value);
            const shouldRefresh = ids !== undefined
                ? ids.filter(id => trackedObjectIDs.includes(id)).length > 0
                : true;
            if (shouldRefresh) {
                objects.refresh();
            }
        });
        return { objects: objects.value };
    };
    const useOne = (modelName, objectID) => {
        /* Queries data for specified model, listens for update events and updates the dataset. */
        const object = useIPCValue(`model-${modelName}-read-one`, { object: null }, { objectID });
        useIPCEvent(`model-${modelName}-objects-changed`, function ({ ids }) {
            const shouldRefresh = ids !== undefined
                ? ids.includes(`${objectID}`)
                : true;
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVuZGVyZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zcmMvYXBwL3JlbmRlcmVyLnRzeCJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEtBQUssTUFBTSxPQUFPLENBQUM7QUFDMUIsT0FBTyxLQUFLLEdBQUcsTUFBTSxjQUFjLENBQUM7QUFDcEMsT0FBTyxLQUFLLFFBQVEsTUFBTSxXQUFXLENBQUM7QUFRdEMsT0FBTyxFQUFFLGFBQWEsRUFBRSxPQUFPLEVBQUUsTUFBTSxtQkFBbUIsQ0FBQztBQUUzRCxPQUFPLCtFQUErRSxDQUFDO0FBQ3ZGLE9BQU8sa0VBQWtFLENBQUM7QUFDMUUsT0FBTywwQ0FBMEMsQ0FBQztBQUNsRCxPQUFPLHlDQUF5QyxDQUFDO0FBQ2pELE9BQU8sRUFBRSxXQUFXLEVBQUUsV0FBVyxFQUFFLE1BQU0saUJBQWlCLENBQUM7QUEyQzNELDRDQUE0QztBQUM1Qyw4RUFBOEU7QUFDOUUscURBQXFEO0FBQ3JELE1BQU0sQ0FBQyxNQUFNLFNBQVMsR0FBRyxDQUFtRCxNQUFTLEVBQWtCLEVBQUU7SUFFdkcsd0VBQXdFO0lBQ3hFLE1BQU0sT0FBTyxHQUFHLFFBQVEsQ0FBQyxjQUFjLENBQUMsS0FBSyxDQUFnQixDQUFDO0lBRTlELGlEQUFpRDtJQUNqRCxRQUFRLENBQUMsZUFBZSxDQUFDLFNBQVMsQ0FBQyxHQUFHLENBQUMsYUFBYSxPQUFPLENBQUMsUUFBUSxFQUFFLENBQUMsQ0FBQztJQUV4RSwyREFBMkQ7SUFDM0QsTUFBTSxZQUFZLEdBQUcsSUFBSSxlQUFlLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUVqRSxtRUFBbUU7SUFDbkUsTUFBTSxXQUFXLEdBQUcsWUFBWSxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUMxQyxNQUFNLGlCQUFpQixHQUFHLFdBQVcsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLGdCQUFnQixDQUFDLFdBQVcsQ0FBQyxD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QUMsRUFBRSxDQUFDO1FBRUwsT0FBTztZQUNMLElBQUksRUFBRSxPQUFPO1lBQ2IsUUFBUTtZQUNSLE1BQU07WUFDTixPQUFPO1lBQ1AsTUFBTTtTQUNQLENBQUM7S0FFSDtTQUFNO1FBQ0wsMkVBQTJFO1FBQzNFLGtGQUFrRjtRQUNsRixRQUFRLENBQUMsTUFBTSxDQUFDLG9CQUFDLGFBQWEsSUFDNUIsSUFBSSxFQUFDLE9BQU8sRUFDWixLQUFLLEVBQUMsNkJBQTZCLEdBQUcsRUFBRSxPQUFPLENBQUMsQ0FBQztRQUVuRCxHQUFHLENBQUMsS0FBSyxDQUFDLDZCQUE2QixFQUFFLFdBQVcsQ0FBQyxDQUFDO1FBQ3RELE1BQU0sSUFBSSxLQUFLLENBQUMsNkJBQTZCLENBQUMsQ0FBQztLQUNoRDtBQUVILENBQUMsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBSZWFjdCBmcm9tICdyZWFjdCc7XG5pbXBvcnQgKiBhcyBsb2cgZnJvbSAnZWxlY3Ryb24tbG9nJztcbmltcG9ydCAqIGFzIFJlYWN0RE9NIGZyb20gJ3JlYWN0LWRvbSc7XG5cbmltcG9ydCB7IEFwcENvbmZpZyB9IGZyb20gJy4uL2NvbmZpZy9hcHAnO1xuaW1wb3J0IHsgUmVuZGVyZXJDb25maWcgfSBmcm9tICcuLi9jb25maWcvcmVuZGVyZXInO1xuXG5pbXBvcnQgeyBNb2RlbCwgQW55SURUeXBlIH0gZnJvbSAnLi4vZGIvbW9kZWxzJztcbmltcG9ydCB7IEluZGV4IH0gZnJvbSAnLi4vZGIvcXVlcnknO1xuXG5pbXBvcnQgeyBOb25JZGVhbFN0YXRlLCBTcGlubmVyIH0gZnJvbSAnQGJsdWVwcmludGpzL2NvcmUnO1xuXG5pbXBvcnQgJyFzdHlsZS1sb2FkZXIhY3NzLWxvYWRlciFAYmx1ZXByaW50anMvZGF0ZXRpbWUvbGliL2Nzcy9ibHVlcHJpbnQtZGF0ZXRpbWUuY3NzJztcbmltcG9ydCAnIXN0eWxlLWxvYWRlciFjc3MtbG9hZGVyIUBibHVlcHJpbnRqcy9jb3JlL2xpYi9jc3MvYmx1ZXByaW50LmNzcyc7XG5pbXBvcnQgJyFzdHlsZS1sb2FkZXIhY3NzLWxvYWRlciEuL25vcm1hbGl6ZS5jc3MnO1xuaW1wb3J0ICchc3R5bGUtbG9hZGVyIWNzcy1sb2FkZXIhLi9yZW5kZXJlci5jc3MnO1xuaW1wb3J0IHsgdXNlSVBDRXZlbnQsIHVzZUlQQ1ZhbHVlIH0gZnJvbSAnLi4vaXBjL3JlbmRlcmVyJztcblxuXG5pbnRlcmZhY2UgQXBwUmVuZGVyZXI8QyBleHRlbmRzIFJlbmRlcmVyQ29uZmlnPGFueT4+IHtcbiAgcm9vdDogSFRNTEVsZW1lbnRcbiAgdXNlQ291bnQ6IFVzZUNvdW50SG9vazxDPlxuICB1c2VJRHM6IFVzZUlEc0hvb2s8Qz5cbiAgdXNlTWFueTogVXNlTWFueUhvb2s8Qz5cbiAgdXNlT25lOiBVc2VPbmVIb29rPEM+XG59XG5cblxuLy8gRGF0YSBvcGVyYXRpb24gaG9vayBpbnRlcmZhY2VzXG5cbmludGVyZmFjZSBVc2VNYW55SG9va1Jlc3VsdDxNIGV4dGVuZHMgTW9kZWw+IHtcbiAgb2JqZWN0czogSW5kZXg8TT5cbn1cbnR5cGUgVXNlTWFueUhvb2s8QyBleHRlbmRzIFJlbmRlcmVyQ29uZmlnPGFueT4+ID1cbjxNIGV4dGVuZHMgTW9kZWwsIFEgZXh0ZW5kcyBvYmplY3Q+XG4obW9kZWxOYW1lOiBrZXlvZiBDW1wiYXBwXCJdW1wiZGF0YVwiXSwgcXVlcnk6IFEpID0+IFVzZU1hbnlIb29rUmVzdWx0PE0+XG5cbmludGVyZmFjZSBVc2VJRHNIb29rUmVzdWx0PElEVHlwZSBleHRlbmRzIEFueUlEVHlwZT4ge1xuICBpZHM6IElEVHlwZVtdXG59XG50eXBlIFVzZUlEc0hvb2s8QyBleHRlbmRzIFJlbmRlcmVyQ29uZmlnPGFueT4+ID1cbjxJRFR5cGUgZXh0ZW5kcyBBbnlJRFR5cGUsIFEgZXh0ZW5kcyBvYmplY3Q+XG4obW9kZWxOYW1lOiBrZXlvZiBDW1wiYXBwXCJdW1wiZGF0YVwiXSwgcXVlcnk6IFEpID0+IFVzZUlEc0hvb2tSZXN1bHQ8SURUeXBlPlxuXG5pbnRlcmZhY2UgVXNlQ291bnRIb29rUmVzdWx0IHtcbiAgY291bnQ6IG51bWJlclxufVxudHlwZSBVc2VDb3VudEhvb2s8QyBleHRlbmRzIFJlbmRlcmVyQ29uZmlnPGFueT4+ID1cbjxRIGV4dGVuZHMgb2JqZWN0PlxuKG1vZGVsTmFtZToga2V5b2YgQ1tcImFwcFwiXVtcImRhdGFcIl0sIHF1ZXJ5OiBRKSA9PiBVc2VDb3VudEhvb2tSZXN1bHRcblxuaW50ZXJmYWNlIFVzZU9uZUhvb2tSZXN1bHQ8TSBleHRlbmRzIE1vZGVsPiB7XG4gIG9iamVjdDogTSB8IG51bGxcbn1cbnR5cGUgVXNlT25lSG9vazxDIGV4dGVuZHMgUmVuZGVyZXJDb25maWc8YW55Pj4gPVxuPE0gZXh0ZW5kcyBNb2RlbCwgSURUeXBlIGV4dGVuZHMgQW55SURUeXBlPlxuKG1vZGVsTmFtZToga2V5b2YgQ1tcImFwcFwiXVtcImRhdGFcIl0sIG9iamVjdElEOiBJRFR5cGUgfCBudWxsKSA9PiBVc2VPbmVIb29rUmVzdWx0PE0+XG5cblxuLy8gUmVuZGVyIGFwcGxpY2F0aW9uIHNjcmVlbiBpbiBhIG5ldyB3aW5kb3dcbi8vIHdpdGggZ2l2ZW4gdG9wLWxldmVsIHdpbmRvdyBVSSBjb21wb25lbnQgYW5kIChpZiBhcHBsaWNhYmxlKSBhbnkgcGFyYW1ldGVyc1xuLy8gd3JhcHBlZCBpbiBjb25maWd1cmVkIGNvbnRleHQgcHJvdmlkZXIgY29tcG9uZW50cy5cbmV4cG9ydCBjb25zdCByZW5kZXJBcHAgPSA8QSBleHRlbmRzIEFwcENvbmZpZywgQyBleHRlbmRzIFJlbmRlcmVyQ29uZmlnPEE+Pihjb25maWc6IEMpOiBBcHBSZW5kZXJlcjxDPiA9PiB7XG5cbiAgLy8gZWxlY3Ryb24td2VicGFjayBndWFyYW50ZWVzIHByZXNlbmNlIG9mICNhcHAgaW4gaW5kZXguaHRtbCBpdCBidW5kbGVzXG4gIGNvbnN0IGFwcFJvb3QgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYXBwJykgYXMgSFRNTEVsZW1lbnQ7XG5cbiAgLy8gQWRkIGEgY2xhc3MgYWxsb3dpbmcgcGxhdGZvcm0tc3BlY2lmaWMgc3R5bGluZ1xuICBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuY2xhc3NMaXN0LmFkZChgcGxhdGZvcm0tLSR7cHJvY2Vzcy5wbGF0Zm9ybX1gKTtcblxuICAvLyBHZXQgYWxsIHBhcmFtcyBwYXNzZWQgdG8gdGhlIHdpbmRvdyB2aWEgR0VUIHF1ZXJ5IHN0cmluZ1xuICBjb25zdCBzZWFyY2hQYXJhbXMgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKHdpbmRvdy5sb2NhdGlvbi5zZWFyY2gpO1xuXG4gIC8vIFByZXBhcmUgZ2V0dGVyIGZvciByZXF1ZXN0ZWQgdG9wLWxldmVsIHdpbmRvdyBVSSBSZWFjdCBjb21wb25lbnRcbiAgY29uc3QgY29tcG9uZW50SWQgPSBzZWFyY2hQYXJhbXMuZ2V0KCdjJyk7XG4gIGNvbnN0IGNvbXBvbmVudEltcG9ydGVyID0gY29tcG9uZW50SWQgPyBjb25maWcud2luZG93Q29tcG9uZW50c1tjb21wb25lbnRJZF0gOiBudWxsO1xuXG4gIGxvZy5kZWJ1ZyhgUmVxdWVzdGVkIHdpbmRvdyBjb21wb25lbnQgJHtjb21wb25lbnRJZH1gKTtcblxuXG4gIC8vIFRPRE86IFJlZmFjdG9yIG91dCBob29rIGluaXRpYWxpemF0aW9uXG5cbiAgY29uc3QgdXNlSURzOiBVc2VJRHNIb29rPEM+ID1cbiAgPElEVHlwZSBleHRlbmRzIEFueUlEVHlwZSwgUSBleHRlbmRzIG9iamVjdCA9IGFueT5cbiAgKG1vZGVsTmFtZToga2V5b2YgQVtcImRhdGFcIl0sIHF1ZXJ5PzogUSkgPT4ge1xuICAgIC8qIFF1ZXJpZXMgZGF0YSBmb3Igc3BlY2lmaWVkIG1vZGVsLCBsaXN0ZW5zIGZvciB1cGRhdGUgZXZlbnRzIGFuZCB1cGRhdGVzIHRoZSBkYXRhc2V0LiAqL1xuXG4gICAgY29uc3QgdHJhY2tlZElEcyA9IHVzZUlQQ1ZhbHVlPFEsIHsgaWRzOiBJRFR5cGVbXSB9PlxuICAgIChgbW9kZWwtJHttb2RlbE5hbWV9LWxpc3QtaWRzYCwgeyBpZHM6IFtdIH0sIHF1ZXJ5KTtcblxuICAgIHVzZUlQQ0V2ZW50PHsgaWRzPzogc3RyaW5nW10gfT4oYG1vZGVsLSR7bW9kZWxOYW1lfS1vYmplY3RzLWNoYW5nZWRgLCBmdW5jdGlvbiAoeyBpZHMgfSkge1xuICAgICAgY29uc3Qgc3RyaW5nSURzID0gdHJhY2tlZElEcy52YWx1ZS5pZHMubWFwKGlkID0+IGAke2lkfWApO1xuICAgICAgY29uc3Qgc2hvdWxkUmVmcmVzaCA9IGlkcyAhPT0gdW5kZWZpbmVkXG4gICAgICAgID8gaWRzLmZpbHRlcihpZCA9PiBzdHJpbmdJRHMuaW5jbHVkZXMoaWQpKS5sZW5ndGggPiAwXG4gICAgICAgIDogdHJ1ZTtcbiAgICAgIGlmIChzaG91bGRSZWZyZXNoKSB7XG4gICAgICAgIHRyYWNrZWRJRHMucmVmcmVzaCgpO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgcmV0dXJuIHsgaWRzOiB0cmFja2VkSURzLnZhbHVlLmlkcyB9O1xuICB9XG5cbiAgY29uc3QgdXNlQ291bnQ6IFVzZUNvdW50SG9vazxDPiA9XG4gIDxRIGV4dGVuZHMgb2JqZWN0ID0gYW55PlxuICAobW9kZWxOYW1lOiBrZXlvZiBBW1wiZGF0YVwiXSwgcXVlcnk/OiBRKSA9PiB7XG4gICAgLyogUXVlcmllcyBkYXRhIGZvciBzcGVjaWZpZWQgbW9kZWwsIGxpc3RlbnMgZm9yIHVwZGF0ZSBldmVudHMgYW5kIHVwZGF0ZXMgdGhlIGRhdGFzZXQuICovXG5cbiAgICBjb25zdCBjb3VudCA9IHVzZUlQQ1ZhbHVlPFEsIHsgY291bnQ6IG51bWJlciB9PlxuICAgIChgbW9kZWwtJHttb2RlbE5hbWV9LWNvdW50YCwgeyBjb3VudDogMCB9LCBxdWVyeSk7XG5cbiAgICB1c2VJUENFdmVudDx7IGlkcz86IHN0cmluZ1tdIH0+KGBtb2RlbC0ke21vZGVsTmFtZX0tb2JqZWN0cy1jaGFuZ2VkYCwgZnVuY3Rpb24gKCkge1xuICAgICAgY291bnQucmVmcmVzaCgpO1xuICAgIH0pO1xuXG4gICAgcmV0dXJuIHsgY291bnQ6IGNvdW50LnZhbHVlLmNvdW50IH07XG4gIH1cblxuICBjb25zdCB1c2VNYW55OiBVc2VNYW55SG9vazxDPiA9XG4gIDxNIGV4dGVuZHMgTW9kZWwsIFEgZXh0ZW5kcyBvYmplY3QgPSBhbnk+XG4gIChtb2RlbE5hbWU6IGtleW9mIEFbXCJkYXRhXCJdLCBxdWVyeT86IFEpID0+IHtcbiAgICAvKiBRdWVyaWVzIGRhdGEgZm9yIHNwZWNpZmllZCBtb2RlbCwgbGlzdGVucyBmb3IgdXBkYXRlIGV2ZW50cyBhbmQgdXBkYXRlcyB0aGUgZGF0YXNldC4gKi9cblxuICAgIGNvbnN0IG9iamVjdHMgPSB1c2VJUENWYWx1ZTxRLCBJbmRleDxNPj5cbiAgICAoYG1vZGVsLSR7bW9kZWxOYW1lfS1yZWFkLWFsbGAsIHt9LCBxdWVyeSk7XG5cbiAgICB1c2VJUENFdmVudDx7IGlkcz86IHN0cmluZ1tdIH0+KGBtb2RlbC0ke21vZGVsTmFtZX0tb2JqZWN0cy1jaGFuZ2VkYCwgZnVuY3Rpb24gKHsgaWRzIH0pIHtcbiAgICAgIGNvbnN0IHRyYWNrZWRPYmplY3RJRHMgPSBPYmplY3Qua2V5cyhvYmplY3RzLnZhbHVlKTtcbiAgICAgIGNvbnN0IHNob3VsZFJlZnJlc2ggPSBpZHMgIT09IHVuZGVmaW5lZFxuICAgICAgICA/IGlkcy5maWx0ZXIoaWQgPT4gdHJhY2tlZE9iamVjdElEcy5pbmNsdWRlcyhpZCkpLmxlbmd0aCA+IDBcbiAgICAgICAgOiB0cnVlO1xuICAgICAgaWYgKHNob3VsZFJlZnJlc2gpIHtcbiAgICAgICAgb2JqZWN0cy5yZWZyZXNoKCk7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICByZXR1cm4geyBvYmplY3RzOiBvYmplY3RzLnZhbHVlIH07XG4gIH1cblxuICBjb25zdCB1c2VPbmU6IFVzZU9uZUhvb2s8Qz4gPVxuICA8TSBleHRlbmRzIE1vZGVsLCBJRFR5cGUgZXh0ZW5kcyBBbnlJRFR5cGU+XG4gIChtb2RlbE5hbWU6IGtleW9mIEFbXCJkYXRhXCJdLCBvYmplY3RJRDogSURUeXBlIHwgbnVsbCkgPT4ge1xuICAgIC8qIFF1ZXJpZXMgZGF0YSBmb3Igc3BlY2lmaWVkIG1vZGVsLCBsaXN0ZW5zIGZvciB1cGRhdGUgZXZlbnRzIGFuZCB1cGRhdGVzIHRoZSBkYXRhc2V0LiAqL1xuXG4gICAgY29uc3Qgb2JqZWN0ID0gdXNlSVBDVmFsdWU8eyBvYmplY3RJRDogSURUeXBlIHwgbnVsbCB9LCB7IG9iamVjdDogTSB8IG51bGwgfT5cbiAgICAoYG1vZGVsLSR7bW9kZWxOYW1lfS1yZWFkLW9uZWAsIHsgb2JqZWN0OiBudWxsIGFzIE0gfCBudWxsIH0sIHsgb2JqZWN0SUQgfSk7XG5cbiAgICB1c2VJUENFdmVudDx7IGlkcz86IHN0cmluZ1tdIH0+KGBtb2RlbC0ke21vZGVsTmFtZX0tb2JqZWN0cy1jaGFuZ2VkYCwgZnVuY3Rpb24gKHsgaWRzIH0pIHtcbiAgICAgIGNvbnN0IHNob3VsZFJlZnJlc2ggPSBpZHMgIT09IHVuZGVmaW5lZFxuICAgICAgICA/IGlkcy5pbmNsdWRlcyhgJHtvYmplY3RJRH1gKVxuICAgICAgICA6IHRydWU7XG4gICAgICBpZiAoc2hvdWxkUmVmcmVzaCkge1xuICAgICAgICBvYmplY3QucmVmcmVzaCgpO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgcmV0dXJuIHsgb2JqZWN0OiBvYmplY3QudmFsdWUub2JqZWN0IH07XG4gIH1cblxuICAvLyBGZXRjaCB0b3AtbGV2ZWwgVUkgY29tcG9uZW50IGNsYXNzIGFuZCByZW5kZXIgaXQuXG4gIGlmIChjb21wb25lbnRJbXBvcnRlcikge1xuICAgIChhc3luYyAoKSA9PiB7XG4gICAgICAvLyBTaG93IGxvYWRpbmcgaW5kaWNhdG9yIHdoaWxlIGNvbXBvbmVudHMgYXJlIGJlaW5nIHJlc29sdmVkXG4gICAgICBSZWFjdERPTS5yZW5kZXIoPFNwaW5uZXIgLz4sIGFwcFJvb3QpO1xuXG4gICAgICAvLyBHZXQgcHJvcHMgcHJlc2NyaWJlZCBmb3IgZWFjaCBjb250ZXh0IHByb3ZpZGVyIGNvbXBvbmVudFxuICAgICAgdmFyIGN0eFByb3ZpZGVyUHJvcHMgPSBjb25maWcuY29udGV4dFByb3ZpZGVycy5tYXAoaXRlbSA9PiBpdGVtLmdldFByb3BzKGNvbmZpZykpO1xuXG4gICAgICBsb2cuc2lsbHkoXG4gICAgICAgIGBDL3JlbmRlckFwcDogUmVzb2x2aW5nIGNvbXBvbmVudHNgLFxuICAgICAgICBjb21wb25lbnRJbXBvcnRlciwgY29uZmlnLmNvbnRleHRQcm92aWRlcnMpO1xuXG4gICAgICAvLyBSZXNvbHZlIChpbXBvcnQpIGNvbXBvbmVudHMgaW4gcGFyYWxsZWwsIGZpcnN0IFVJIGFuZCB0aGVuIGNvbnRleHQgcHJvdmlkZXJzXG4gICAgICBjb25zdCBwcm9taXNlZENvbXBvbmVudHM6IHsgZGVmYXVsdDogUmVhY3QuRkM8YW55PiB9W10gPSBhd2FpdCBQcm9taXNlLmFsbChbXG4gICAgICAgIGNvbXBvbmVudEltcG9ydGVyKCksXG4gICAgICAgIC4uLmNvbmZpZy5jb250ZXh0UHJvdmlkZXJzLm1hcChhc3luYyAoY3R4cCkgPT4gYXdhaXQgY3R4cC5jbHMoKSksXG4gICAgICBdKTtcblxuICAgICAgbG9nLnNpbGx5KFxuICAgICAgICBgQy9yZW5kZXJBcHA6IFJlc29sdmVkIGNvbXBvbmVudHNgLFxuICAgICAgICBwcm9taXNlZENvbXBvbmVudHMpO1xuXG4gICAgICAvLyBCcmVhayBkb3duIGNvbXBvbmVudHMgaW50byB0b3AtbGV2ZWwgd2luZG93IFVJICYgY29udGV4dCBwcm92aWRlcnNcbiAgICAgIGNvbnN0IFRvcFdpbmRvd0NvbXBvbmVudCA9IHByb21pc2VkQ29tcG9uZW50c1swXS5kZWZhdWx0O1xuICAgICAgdmFyIGN0eFByb3ZpZGVyQ29tcG9uZW50cyA9IHByb21pc2VkQ29tcG9uZW50cy5cbiAgICAgICAgc2xpY2UoMSwgcHJvbWlzZWRDb21wb25lbnRzLmxlbmd0aCkuXG4gICAgICAgIG1hcChpdGVtID0+IGl0ZW0uZGVmYXVsdCk7XG5cbiAgICAgIC8vIFJlb3JkZXIgY29udGV4dCBwcm92aWRlcnMgc28gdGhhdCB0b3AtbW9zdCBpcyB0aGUgbW9zdCBiYXNpY1xuICAgICAgY3R4UHJvdmlkZXJDb21wb25lbnRzLnJldmVyc2UoKTtcbiAgICAgIGN0eFByb3ZpZGVyUHJvcHMucmV2ZXJzZSgpO1xuXG4gICAgICAvLyBXcml0ZSBvdXQgdG9wLWxldmVsIHdpbmRvdyBjb21wb25lbnQgSlNYXG4gICAgICB2YXIgYXBwTWFya3VwID0gPFRvcFdpbmRvd0NvbXBvbmVudCBxdWVyeT17c2VhcmNoUGFyYW1zfSAvPjtcblxuICAgICAgbG9nLmRlYnVnKFxuICAgICAgICBgQy9yZW5kZXJBcHA6IEdvdCBjb250ZXh0IHByb3ZpZGVyIGNvbXBvbmVudHNgLFxuICAgICAgICBjdHhQcm92aWRlckNvbXBvbmVudHMpO1xuXG4gICAgICAvLyBXcmFwIHRoZSBKU1ggaW50byBjb250ZXh0IHByb3ZpZGVyIGNvbXBvbmVudHNcbiAgICAgIGZvciAoY29uc3QgW2lkeCwgQ29udGV4dFByb3ZpZGVyXSBvZiBjdHhQcm92aWRlckNvbXBvbmVudHMuZW50cmllcygpKSB7XG4gICAgICAgIGxvZy52ZXJib3NlKCAgXG4gICAgICAgICAgYEMvcmVuZGVyQXBwOiBJbml0aWFsaXppbmcgY29udGV4dCBwcm92aWRlciAjJHtpZHh9YCxcbiAgICAgICAgICBjdHhQcm92aWRlckNvbXBvbmVudHNbaWR4XSxcbiAgICAgICAgICBjdHhQcm92aWRlclByb3BzW2lkeF0pO1xuXG4gICAgICAgIGFwcE1hcmt1cCA9IChcbiAgICAgICAgICA8Q29udGV4dFByb3ZpZGVyIHsuLi5jdHhQcm92aWRlclByb3BzW2lkeF19PlxuICAgICAgICAgICAge2FwcE1hcmt1cH1cbiAgICAgICAgICA8L0NvbnRleHRQcm92aWRlcj5cbiAgICAgICAgKTtcbiAgICAgIH1cblxuICAgICAgbG9nLmRlYnVnKFwiQy9yZW5kZXJBcHA6IFJlbmRlcmluZ1wiKTtcblxuICAgICAgLy8gUmVuZGVyIHRoZSBKU1hcbiAgICAgIFJlYWN0RE9NLnJlbmRlcihhcHBNYXJrdXAsIGFwcFJvb3QpO1xuICAgIH0pKCk7XG5cbiAgICByZXR1cm4ge1xuICAgICAgcm9vdDogYXBwUm9vdCxcbiAgICAgIHVzZUNvdW50LFxuICAgICAgdXNlSURzLFxuICAgICAgdXNlTWFueSxcbiAgICAgIHVzZU9uZSxcbiAgICB9O1xuXG4gIH0gZWxzZSB7XG4gICAgLy8gQ29tcG9uZW50IHNwZWNpZmllZCBpbiBHRVQgcGFyYW1zIGlzIG5vdCBwcmVzZW50IGluIGFwcCByZW5kZXJlciBjb25maWcuXG4gICAgLy8gVE9ETzogSGFuZGxlIG1pc2NvbmZpZ3VyZWQgUmVhY3QgY29udGV4dCBwcm92aWRlcnMgYW5kIGZhaWxlZCBpbXBvcnQgYXQgcnVudGltZVxuICAgIFJlYWN0RE9NLnJlbmRlcig8Tm9uSWRlYWxTdGF0ZVxuICAgICAgaWNvbj1cImVycm9yXCJcbiAgICAgIHRpdGxlPVwiVW5rbm93biBjb21wb25lbnQgcmVxdWVzdGVkXCIgLz4sIGFwcFJvb3QpO1xuXG4gICAgbG9nLmVycm9yKFwiVW5rbm93biBjb21wb25lbnQgcmVxdWVzdGVkXCIsIGNvbXBvbmVudElkKTtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJVbmtub3duIGNvbXBvbmVudCByZXF1ZXN0ZWRcIik7XG4gIH1cblxufTsiXX0=