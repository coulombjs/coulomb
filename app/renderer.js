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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVuZGVyZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi9zcmMvYXBwL3JlbmRlcmVyLnRzeCJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEtBQUssTUFBTSxPQUFPLENBQUM7QUFDMUIsT0FBTyxLQUFLLEdBQUcsTUFBTSxjQUFjLENBQUM7QUFDcEMsT0FBTyxLQUFLLFFBQVEsTUFBTSxXQUFXLENBQUM7QUFRdEMsT0FBTyxFQUFFLGFBQWEsRUFBRSxPQUFPLEVBQUUsTUFBTSxtQkFBbUIsQ0FBQztBQUUzRCxPQUFPLCtFQUErRSxDQUFDO0FBQ3ZGLE9BQU8sa0VBQWtFLENBQUM7QUFDMUUsT0FBTywwQ0FBMEMsQ0FBQztBQUNsRCxPQUFPLHlDQUF5QyxDQUFDO0FBQ2pELE9BQU8sRUFBRSxXQUFXLEVBQUUsV0FBVyxFQUFFLE1BQU0saUJBQWlCLENBQUM7QUErQzNELDRDQUE0QztBQUM1Qyw4RUFBOEU7QUFDOUUscURBQXFEO0FBQ3JELE1BQU0sQ0FBQyxNQUFNLFNBQVMsR0FBRyxDQUFtRCxNQUFTLEVBQWtCLEVBQUU7SUFFdkcsd0VBQXdFO0lBQ3hFLE1BQU0sT0FBTyxHQUFHLFFBQVEsQ0FBQyxjQUFjLENBQUMsS0FBSyxDQUFnQixDQUFDO0lBRTlELGlEQUFpRDtJQUNqRCxRQUFRLENBQUMsZUFBZSxDQUFDLFNBQVMsQ0FBQyxHQUFHLENBQUMsYUFBYSxPQUFPLENBQUMsUUFBUSxFQUFFLENBQUMsQ0FBQztJQUV4RSwyREFBMkQ7SUFDM0QsTUFBTSxZQUFZLEdBQUcsSUFBSSxlQUFlLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUVqRSxtRUFBbUU7SUFDbkUsTUFBTSxXQUFXLEdBQUcsWUFBWSxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUMxQyxNQUFNLGlCQUFpQixHQUFHLFdBQVcsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLGdCQUFnQixDQUFDLFdBQVcsQ0FBQyxD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T0FBTyxDQUFDLENBQUM7UUFFbkQsR0FBRyxDQUFDLEtBQUssQ0FBQyw2QkFBNkIsRUFBRSxXQUFXLENBQUMsQ0FBQztRQUN0RCxNQUFNLElBQUksS0FBSyxDQUFDLDZCQUE2QixDQUFDLENBQUM7S0FDaEQ7QUFFSCxDQUFDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgUmVhY3QgZnJvbSAncmVhY3QnO1xuaW1wb3J0ICogYXMgbG9nIGZyb20gJ2VsZWN0cm9uLWxvZyc7XG5pbXBvcnQgKiBhcyBSZWFjdERPTSBmcm9tICdyZWFjdC1kb20nO1xuXG5pbXBvcnQgeyBBcHBDb25maWcgfSBmcm9tICcuLi9jb25maWcvYXBwJztcbmltcG9ydCB7IFJlbmRlcmVyQ29uZmlnIH0gZnJvbSAnLi4vY29uZmlnL3JlbmRlcmVyJztcblxuaW1wb3J0IHsgTW9kZWwsIEFueUlEVHlwZSB9IGZyb20gJy4uL2RiL21vZGVscyc7XG5pbXBvcnQgeyBJbmRleCB9IGZyb20gJy4uL2RiL3F1ZXJ5JztcblxuaW1wb3J0IHsgTm9uSWRlYWxTdGF0ZSwgU3Bpbm5lciB9IGZyb20gJ0BibHVlcHJpbnRqcy9jb3JlJztcblxuaW1wb3J0ICchc3R5bGUtbG9hZGVyIWNzcy1sb2FkZXIhQGJsdWVwcmludGpzL2RhdGV0aW1lL2xpYi9jc3MvYmx1ZXByaW50LWRhdGV0aW1lLmNzcyc7XG5pbXBvcnQgJyFzdHlsZS1sb2FkZXIhY3NzLWxvYWRlciFAYmx1ZXByaW50anMvY29yZS9saWIvY3NzL2JsdWVwcmludC5jc3MnO1xuaW1wb3J0ICchc3R5bGUtbG9hZGVyIWNzcy1sb2FkZXIhLi9ub3JtYWxpemUuY3NzJztcbmltcG9ydCAnIXN0eWxlLWxvYWRlciFjc3MtbG9hZGVyIS4vcmVuZGVyZXIuY3NzJztcbmltcG9ydCB7IHVzZUlQQ0V2ZW50LCB1c2VJUENWYWx1ZSB9IGZyb20gJy4uL2lwYy9yZW5kZXJlcic7XG5cblxuaW50ZXJmYWNlIEFwcFJlbmRlcmVyPEMgZXh0ZW5kcyBSZW5kZXJlckNvbmZpZzxhbnk+PiB7XG4gIHJvb3Q6IEhUTUxFbGVtZW50XG4gIHVzZUNvdW50OiBVc2VDb3VudEhvb2s8Qz5cbiAgdXNlSURzOiBVc2VJRHNIb29rPEM+XG4gIHVzZU1hbnk6IFVzZU1hbnlIb29rPEM+XG4gIHVzZU9uZTogVXNlT25lSG9vazxDPlxufVxuXG5cbi8vIERhdGEgb3BlcmF0aW9uIGhvb2sgaW50ZXJmYWNlc1xuXG5pbnRlcmZhY2UgVXNlTWFueUhvb2tSZXN1bHQ8TSBleHRlbmRzIE1vZGVsPiB7XG4gIG9iamVjdHM6IEluZGV4PE0+XG4gIGlzVXBkYXRpbmc6IGJvb2xlYW5cbn1cbnR5cGUgVXNlTWFueUhvb2s8QyBleHRlbmRzIFJlbmRlcmVyQ29uZmlnPGFueT4+ID1cbjxNIGV4dGVuZHMgTW9kZWwsIFEgZXh0ZW5kcyBvYmplY3Q+XG4obW9kZWxOYW1lOiBrZXlvZiBDW1wiYXBwXCJdW1wiZGF0YVwiXSwgcXVlcnk6IFEpID0+IFVzZU1hbnlIb29rUmVzdWx0PE0+XG5cbmludGVyZmFjZSBVc2VJRHNIb29rUmVzdWx0PElEVHlwZSBleHRlbmRzIEFueUlEVHlwZT4ge1xuICBpZHM6IElEVHlwZVtdXG4gIGlzVXBkYXRpbmc6IGJvb2xlYW5cbn1cbnR5cGUgVXNlSURzSG9vazxDIGV4dGVuZHMgUmVuZGVyZXJDb25maWc8YW55Pj4gPVxuPElEVHlwZSBleHRlbmRzIEFueUlEVHlwZSwgUSBleHRlbmRzIG9iamVjdD5cbihtb2RlbE5hbWU6IGtleW9mIENbXCJhcHBcIl1bXCJkYXRhXCJdLCBxdWVyeTogUSkgPT4gVXNlSURzSG9va1Jlc3VsdDxJRFR5cGU+XG5cbmludGVyZmFjZSBVc2VDb3VudEhvb2tSZXN1bHQge1xuICBjb3VudDogbnVtYmVyXG4gIGlzVXBkYXRpbmc6IGJvb2xlYW5cbn1cbnR5cGUgVXNlQ291bnRIb29rPEMgZXh0ZW5kcyBSZW5kZXJlckNvbmZpZzxhbnk+PiA9XG48USBleHRlbmRzIG9iamVjdD5cbihtb2RlbE5hbWU6IGtleW9mIENbXCJhcHBcIl1bXCJkYXRhXCJdLCBxdWVyeTogUSkgPT4gVXNlQ291bnRIb29rUmVzdWx0XG5cbmludGVyZmFjZSBVc2VPbmVIb29rUmVzdWx0PE0gZXh0ZW5kcyBNb2RlbD4ge1xuICBvYmplY3Q6IE0gfCBudWxsXG4gIGlzVXBkYXRpbmc6IGJvb2xlYW5cbn1cbnR5cGUgVXNlT25lSG9vazxDIGV4dGVuZHMgUmVuZGVyZXJDb25maWc8YW55Pj4gPVxuPE0gZXh0ZW5kcyBNb2RlbCwgSURUeXBlIGV4dGVuZHMgQW55SURUeXBlPlxuKG1vZGVsTmFtZToga2V5b2YgQ1tcImFwcFwiXVtcImRhdGFcIl0sIG9iamVjdElEOiBJRFR5cGUgfCBudWxsKSA9PiBVc2VPbmVIb29rUmVzdWx0PE0+XG5cblxuLy8gUmVuZGVyIGFwcGxpY2F0aW9uIHNjcmVlbiBpbiBhIG5ldyB3aW5kb3dcbi8vIHdpdGggZ2l2ZW4gdG9wLWxldmVsIHdpbmRvdyBVSSBjb21wb25lbnQgYW5kIChpZiBhcHBsaWNhYmxlKSBhbnkgcGFyYW1ldGVyc1xuLy8gd3JhcHBlZCBpbiBjb25maWd1cmVkIGNvbnRleHQgcHJvdmlkZXIgY29tcG9uZW50cy5cbmV4cG9ydCBjb25zdCByZW5kZXJBcHAgPSA8QSBleHRlbmRzIEFwcENvbmZpZywgQyBleHRlbmRzIFJlbmRlcmVyQ29uZmlnPEE+Pihjb25maWc6IEMpOiBBcHBSZW5kZXJlcjxDPiA9PiB7XG5cbiAgLy8gZWxlY3Ryb24td2VicGFjayBndWFyYW50ZWVzIHByZXNlbmNlIG9mICNhcHAgaW4gaW5kZXguaHRtbCBpdCBidW5kbGVzXG4gIGNvbnN0IGFwcFJvb3QgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYXBwJykgYXMgSFRNTEVsZW1lbnQ7XG5cbiAgLy8gQWRkIGEgY2xhc3MgYWxsb3dpbmcgcGxhdGZvcm0tc3BlY2lmaWMgc3R5bGluZ1xuICBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuY2xhc3NMaXN0LmFkZChgcGxhdGZvcm0tLSR7cHJvY2Vzcy5wbGF0Zm9ybX1gKTtcblxuICAvLyBHZXQgYWxsIHBhcmFtcyBwYXNzZWQgdG8gdGhlIHdpbmRvdyB2aWEgR0VUIHF1ZXJ5IHN0cmluZ1xuICBjb25zdCBzZWFyY2hQYXJhbXMgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKHdpbmRvdy5sb2NhdGlvbi5zZWFyY2gpO1xuXG4gIC8vIFByZXBhcmUgZ2V0dGVyIGZvciByZXF1ZXN0ZWQgdG9wLWxldmVsIHdpbmRvdyBVSSBSZWFjdCBjb21wb25lbnRcbiAgY29uc3QgY29tcG9uZW50SWQgPSBzZWFyY2hQYXJhbXMuZ2V0KCdjJyk7XG4gIGNvbnN0IGNvbXBvbmVudEltcG9ydGVyID0gY29tcG9uZW50SWQgPyBjb25maWcud2luZG93Q29tcG9uZW50c1tjb21wb25lbnRJZF0gOiBudWxsO1xuXG4gIGxvZy5kZWJ1ZyhgUmVxdWVzdGVkIHdpbmRvdyBjb21wb25lbnQgJHtjb21wb25lbnRJZH1gKTtcblxuXG4gIC8vIFRPRE86IFJlZmFjdG9yIG91dCBob29rIGluaXRpYWxpemF0aW9uXG5cbiAgY29uc3QgdXNlSURzOiBVc2VJRHNIb29rPEM+ID1cbiAgPElEVHlwZSBleHRlbmRzIEFueUlEVHlwZSwgUSBleHRlbmRzIG9iamVjdCA9IGFueT5cbiAgKG1vZGVsTmFtZToga2V5b2YgQVtcImRhdGFcIl0sIHF1ZXJ5PzogUSkgPT4ge1xuICAgIC8qIFF1ZXJpZXMgZGF0YSBmb3Igc3BlY2lmaWVkIG1vZGVsLCBsaXN0ZW5zIGZvciB1cGRhdGUgZXZlbnRzIGFuZCB1cGRhdGVzIHRoZSBkYXRhc2V0LiAqL1xuXG4gICAgY29uc3QgdHJhY2tlZElEcyA9IHVzZUlQQ1ZhbHVlPFEsIHsgaWRzOiBJRFR5cGVbXSB9PlxuICAgIChgbW9kZWwtJHttb2RlbE5hbWV9LWxpc3QtaWRzYCwgeyBpZHM6IFtdIH0sIHF1ZXJ5KTtcblxuICAgIHVzZUlQQ0V2ZW50PHsgaWRzPzogc3RyaW5nW10gfT4oYG1vZGVsLSR7bW9kZWxOYW1lfS1vYmplY3RzLWNoYW5nZWRgLCBmdW5jdGlvbiAoeyBpZHMgfSkge1xuICAgICAgdHJhY2tlZElEcy5yZWZyZXNoKCk7XG5cbiAgICAgIC8vIFNlZSBUT0RPIGF0IHVzZU1hbnkoKS5cbiAgICAgIC8vY29uc3Qgc3RyaW5nSURzID0gdHJhY2tlZElEcy52YWx1ZS5pZHMubWFwKGlkID0+IGAke2lkfWApO1xuICAgICAgLy9jb25zdCBzaG91bGRSZWZyZXNoID0gaWRzICE9PSB1bmRlZmluZWRcbiAgICAgIC8vICA/IGlkcy5maWx0ZXIoaWQgPT4gc3RyaW5nSURzLmluY2x1ZGVzKGlkKSkubGVuZ3RoID4gMFxuICAgICAgLy8gIDogdHJ1ZTtcbiAgICAgIC8vaWYgKHNob3VsZFJlZnJlc2gpIHtcbiAgICAgIC8vICB0cmFja2VkSURzLnJlZnJlc2goKTtcbiAgICAgIC8vfVxuICAgIH0pO1xuXG4gICAgcmV0dXJuIHsgaWRzOiB0cmFja2VkSURzLnZhbHVlLmlkcywgaXNVcGRhdGluZzogdHJhY2tlZElEcy5pc1VwZGF0aW5nIH07XG4gIH1cblxuICBjb25zdCB1c2VDb3VudDogVXNlQ291bnRIb29rPEM+ID1cbiAgPFEgZXh0ZW5kcyBvYmplY3QgPSBhbnk+XG4gIChtb2RlbE5hbWU6IGtleW9mIEFbXCJkYXRhXCJdLCBxdWVyeT86IFEpID0+IHtcbiAgICAvKiBRdWVyaWVzIGRhdGEgZm9yIHNwZWNpZmllZCBtb2RlbCwgbGlzdGVucyBmb3IgdXBkYXRlIGV2ZW50cyBhbmQgdXBkYXRlcyB0aGUgZGF0YXNldC4gKi9cblxuICAgIGNvbnN0IGNvdW50ID0gdXNlSVBDVmFsdWU8USwgeyBjb3VudDogbnVtYmVyIH0+XG4gICAgKGBtb2RlbC0ke21vZGVsTmFtZX0tY291bnRgLCB7IGNvdW50OiAwIH0sIHF1ZXJ5KTtcblxuICAgIHVzZUlQQ0V2ZW50PHsgaWRzPzogc3RyaW5nW10gfT4oYG1vZGVsLSR7bW9kZWxOYW1lfS1vYmplY3RzLWNoYW5nZWRgLCBmdW5jdGlvbiAoKSB7XG4gICAgICBjb3VudC5yZWZyZXNoKCk7XG4gICAgfSk7XG5cbiAgICByZXR1cm4geyBjb3VudDogY291bnQudmFsdWUuY291bnQsIGlzVXBkYXRpbmc6IGNvdW50LmlzVXBkYXRpbmcgfTtcbiAgfVxuXG4gIGNvbnN0IHVzZU1hbnk6IFVzZU1hbnlIb29rPEM+ID1cbiAgPE0gZXh0ZW5kcyBNb2RlbCwgUSBleHRlbmRzIG9iamVjdCA9IGFueT5cbiAgKG1vZGVsTmFtZToga2V5b2YgQVtcImRhdGFcIl0sIHF1ZXJ5PzogUSkgPT4ge1xuICAgIC8qIFF1ZXJpZXMgZGF0YSBmb3Igc3BlY2lmaWVkIG1vZGVsLCBsaXN0ZW5zIGZvciB1cGRhdGUgZXZlbnRzIGFuZCB1cGRhdGVzIHRoZSBkYXRhc2V0LiAqL1xuXG4gICAgY29uc3Qgb2JqZWN0cyA9IHVzZUlQQ1ZhbHVlPFEsIEluZGV4PE0+PlxuICAgIChgbW9kZWwtJHttb2RlbE5hbWV9LXJlYWQtYWxsYCwge30sIHF1ZXJ5KTtcblxuICAgIHVzZUlQQ0V2ZW50PHsgaWRzPzogc3RyaW5nW10gfT4oYG1vZGVsLSR7bW9kZWxOYW1lfS1vYmplY3RzLWNoYW5nZWRgLCBmdW5jdGlvbiAoeyBpZHMgfSkge1xuICAgICAgb2JqZWN0cy5yZWZyZXNoKCk7XG4gICAgICAvLyBUT0RPOiBPbmx5IHJlZnJlc2ggd2hlbiBuZWVkZWQuXG4gICAgICAvLyBCZWxvdyBjb2RlIHdvcmtzLCBleGNlcHQgaXQgd29u4oCZdCB0cmlnZ2VyIHJlZnJlc2hcbiAgICAgIC8vIHdoZW4gbmV3IG9iamVjdHMgYXJlIGFkZGVkOlxuICAgICAgLy8gbG9nLnNpbGx5KFwiQy9yZW5kZXJBcHA6IENoYW5nZWQgb2JqZWN0IElEc1wiLCBpZHMpO1xuICAgICAgLy8gY29uc3QgdHJhY2tlZE9iamVjdElEcyA9IE9iamVjdC5rZXlzKG9iamVjdHMudmFsdWUpO1xuICAgICAgLy8gY29uc3Qgc2hvdWxkUmVmcmVzaCA9IGlkcyA9PT0gdW5kZWZpbmVkIHx8IGlkcy5maWx0ZXIoaWQgPT4gdHJhY2tlZE9iamVjdElEcy5pbmNsdWRlcyhpZCkpLmxlbmd0aCA+IDA7XG4gICAgICAvLyBpZiAoc2hvdWxkUmVmcmVzaCkge1xuICAgICAgLy8gICBsb2cuZGVidWcoXCJDL3JlbmRlckFwcDogUmVmcmVzaGluZyBvYmplY3RzXCIsIGlkcyk7XG4gICAgICAvLyAgIG9iamVjdHMucmVmcmVzaCgpO1xuICAgICAgLy8gfSBlbHNlIHtcbiAgICAgIC8vICAgbG9nLmRlYnVnKFwiQy9yZW5kZXJBcHA6IFdpbGwgbm90IHJlZnJlc2ggb2JqZWN0c1wiLCBpZHMpO1xuICAgICAgLy8gfVxuICAgIH0pO1xuXG4gICAgcmV0dXJuIHsgb2JqZWN0czogb2JqZWN0cy52YWx1ZSwgaXNVcGRhdGluZzogb2JqZWN0cy5pc1VwZGF0aW5nIH07XG4gIH1cblxuICBjb25zdCB1c2VPbmU6IFVzZU9uZUhvb2s8Qz4gPVxuICA8TSBleHRlbmRzIE1vZGVsLCBJRFR5cGUgZXh0ZW5kcyBBbnlJRFR5cGU+XG4gIChtb2RlbE5hbWU6IGtleW9mIEFbXCJkYXRhXCJdLCBvYmplY3RJRDogSURUeXBlIHwgbnVsbCkgPT4ge1xuICAgIC8qIFF1ZXJpZXMgZGF0YSBmb3Igc3BlY2lmaWVkIG1vZGVsLCBsaXN0ZW5zIGZvciB1cGRhdGUgZXZlbnRzIGFuZCB1cGRhdGVzIHRoZSBkYXRhc2V0LiAqL1xuXG4gICAgY29uc3Qgb2JqZWN0ID0gdXNlSVBDVmFsdWU8eyBvYmplY3RJRDogSURUeXBlIHwgbnVsbCB9LCB7IG9iamVjdDogTSB8IG51bGwgfT5cbiAgICAoYG1vZGVsLSR7bW9kZWxOYW1lfS1yZWFkLW9uZWAsIHsgb2JqZWN0OiBudWxsIGFzIE0gfCBudWxsIH0sIHsgb2JqZWN0SUQgfSk7XG5cbiAgICB1c2VJUENFdmVudDx7IGlkcz86IHN0cmluZ1tdIH0+KGBtb2RlbC0ke21vZGVsTmFtZX0tb2JqZWN0cy1jaGFuZ2VkYCwgZnVuY3Rpb24gKHsgaWRzIH0pIHtcbiAgICAgIGNvbnN0IHNob3VsZFJlZnJlc2ggPSBpZHMgPT09IHVuZGVmaW5lZCB8fCBpZHMuaW5jbHVkZXMoYCR7b2JqZWN0SUR9YCk7XG4gICAgICBpZiAoc2hvdWxkUmVmcmVzaCkge1xuICAgICAgICBvYmplY3QucmVmcmVzaCgpO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgcmV0dXJuIHsgb2JqZWN0OiBvYmplY3QudmFsdWUub2JqZWN0LCBpc1VwZGF0aW5nOiBvYmplY3QuaXNVcGRhdGluZyB9O1xuICB9XG5cbiAgLy8gRmV0Y2ggdG9wLWxldmVsIFVJIGNvbXBvbmVudCBjbGFzcyBhbmQgcmVuZGVyIGl0LlxuICBpZiAoY29tcG9uZW50SW1wb3J0ZXIpIHtcbiAgICAoYXN5bmMgKCkgPT4ge1xuICAgICAgLy8gU2hvdyBsb2FkaW5nIGluZGljYXRvciB3aGlsZSBjb21wb25lbnRzIGFyZSBiZWluZyByZXNvbHZlZFxuICAgICAgUmVhY3RET00ucmVuZGVyKDxTcGlubmVyIC8+LCBhcHBSb290KTtcblxuICAgICAgY29uc3QgY3R4UHJvdmlkZXJDb25maWcgPSBjb25maWcuY29udGV4dFByb3ZpZGVycyB8fCBbXTtcblxuICAgICAgLy8gR2V0IHByb3BzIHByZXNjcmliZWQgZm9yIGVhY2ggY29udGV4dCBwcm92aWRlciBjb21wb25lbnRcbiAgICAgIHZhciBjdHhQcm92aWRlclByb3BzID0gY3R4UHJvdmlkZXJDb25maWcubWFwKGl0ZW0gPT4gaXRlbS5nZXRQcm9wcyhjb25maWcpKTtcblxuICAgICAgbG9nLnNpbGx5KFxuICAgICAgICBgQy9yZW5kZXJBcHA6IFJlc29sdmluZyBjb21wb25lbnRzYCxcbiAgICAgICAgY29tcG9uZW50SW1wb3J0ZXIsIGN0eFByb3ZpZGVyQ29uZmlnKTtcblxuICAgICAgLy8gUmVzb2x2ZSAoaW1wb3J0KSBjb21wb25lbnRzIGluIHBhcmFsbGVsLCBmaXJzdCBVSSBhbmQgdGhlbiBjb250ZXh0IHByb3ZpZGVyc1xuICAgICAgY29uc3QgcHJvbWlzZWRDb21wb25lbnRzOiB7IGRlZmF1bHQ6IFJlYWN0LkZDPGFueT4gfVtdID0gYXdhaXQgUHJvbWlzZS5hbGwoW1xuICAgICAgICBjb21wb25lbnRJbXBvcnRlcigpLFxuICAgICAgICAuLi5jdHhQcm92aWRlckNvbmZpZy5tYXAoYXN5bmMgKGN0eHApID0+IGF3YWl0IGN0eHAuY2xzKCkpLFxuICAgICAgXSk7XG5cbiAgICAgIGxvZy5zaWxseShcbiAgICAgICAgYEMvcmVuZGVyQXBwOiBSZXNvbHZlZCBjb21wb25lbnRzYCxcbiAgICAgICAgcHJvbWlzZWRDb21wb25lbnRzKTtcblxuICAgICAgLy8gQnJlYWsgZG93biBjb21wb25lbnRzIGludG8gdG9wLWxldmVsIHdpbmRvdyBVSSAmIGNvbnRleHQgcHJvdmlkZXJzXG4gICAgICBjb25zdCBUb3BXaW5kb3dDb21wb25lbnQgPSBwcm9taXNlZENvbXBvbmVudHNbMF0uZGVmYXVsdDtcbiAgICAgIHZhciBjdHhQcm92aWRlckNvbXBvbmVudHMgPSBwcm9taXNlZENvbXBvbmVudHMuXG4gICAgICAgIHNsaWNlKDEsIHByb21pc2VkQ29tcG9uZW50cy5sZW5ndGgpLlxuICAgICAgICBtYXAoaXRlbSA9PiBpdGVtLmRlZmF1bHQpO1xuXG4gICAgICAvLyBSZW9yZGVyIGNvbnRleHQgcHJvdmlkZXJzIHNvIHRoYXQgdG9wLW1vc3QgaXMgdGhlIG1vc3QgYmFzaWNcbiAgICAgIGN0eFByb3ZpZGVyQ29tcG9uZW50cy5yZXZlcnNlKCk7XG4gICAgICBjdHhQcm92aWRlclByb3BzLnJldmVyc2UoKTtcblxuICAgICAgLy8gV3JpdGUgb3V0IHRvcC1sZXZlbCB3aW5kb3cgY29tcG9uZW50IEpTWFxuICAgICAgdmFyIGFwcE1hcmt1cCA9IDxUb3BXaW5kb3dDb21wb25lbnQgcXVlcnk9e3NlYXJjaFBhcmFtc30gLz47XG5cbiAgICAgIGxvZy5kZWJ1ZyhcbiAgICAgICAgYEMvcmVuZGVyQXBwOiBHb3QgY29udGV4dCBwcm92aWRlciBjb21wb25lbnRzYCxcbiAgICAgICAgY3R4UHJvdmlkZXJDb21wb25lbnRzKTtcblxuICAgICAgLy8gV3JhcCB0aGUgSlNYIGludG8gY29udGV4dCBwcm92aWRlciBjb21wb25lbnRzXG4gICAgICBmb3IgKGNvbnN0IFtpZHgsIENvbnRleHRQcm92aWRlcl0gb2YgY3R4UHJvdmlkZXJDb21wb25lbnRzLmVudHJpZXMoKSkge1xuICAgICAgICBsb2cudmVyYm9zZSggIFxuICAgICAgICAgIGBDL3JlbmRlckFwcDogSW5pdGlhbGl6aW5nIGNvbnRleHQgcHJvdmlkZXIgIyR7aWR4fWAsXG4gICAgICAgICAgY3R4UHJvdmlkZXJDb21wb25lbnRzW2lkeF0sXG4gICAgICAgICAgY3R4UHJvdmlkZXJQcm9wc1tpZHhdKTtcblxuICAgICAgICBhcHBNYXJrdXAgPSAoXG4gICAgICAgICAgPENvbnRleHRQcm92aWRlciB7Li4uY3R4UHJvdmlkZXJQcm9wc1tpZHhdfT5cbiAgICAgICAgICAgIHthcHBNYXJrdXB9XG4gICAgICAgICAgPC9Db250ZXh0UHJvdmlkZXI+XG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIGxvZy5kZWJ1ZyhcIkMvcmVuZGVyQXBwOiBSZW5kZXJpbmdcIik7XG5cbiAgICAgIC8vIFJlbmRlciB0aGUgSlNYXG4gICAgICBSZWFjdERPTS5yZW5kZXIoYXBwTWFya3VwLCBhcHBSb290KTtcbiAgICB9KSgpO1xuXG4gICAgcmV0dXJuIHtcbiAgICAgIHJvb3Q6IGFwcFJvb3QsXG4gICAgICB1c2VDb3VudCxcbiAgICAgIHVzZUlEcyxcbiAgICAgIHVzZU1hbnksXG4gICAgICB1c2VPbmUsXG4gICAgfTtcblxuICB9IGVsc2Uge1xuICAgIC8vIENvbXBvbmVudCBzcGVjaWZpZWQgaW4gR0VUIHBhcmFtcyBpcyBub3QgcHJlc2VudCBpbiBhcHAgcmVuZGVyZXIgY29uZmlnLlxuICAgIC8vIFRPRE86IEhhbmRsZSBtaXNjb25maWd1cmVkIFJlYWN0IGNvbnRleHQgcHJvdmlkZXJzIGFuZCBmYWlsZWQgaW1wb3J0IGF0IHJ1bnRpbWVcbiAgICBSZWFjdERPTS5yZW5kZXIoPE5vbklkZWFsU3RhdGVcbiAgICAgIGljb249XCJlcnJvclwiXG4gICAgICB0aXRsZT1cIlVua25vd24gY29tcG9uZW50IHJlcXVlc3RlZFwiIC8+LCBhcHBSb290KTtcblxuICAgIGxvZy5lcnJvcihcIlVua25vd24gY29tcG9uZW50IHJlcXVlc3RlZFwiLCBjb21wb25lbnRJZCk7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiVW5rbm93biBjb21wb25lbnQgcmVxdWVzdGVkXCIpO1xuICB9XG5cbn07Il19