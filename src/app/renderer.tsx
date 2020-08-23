import * as log from 'electron-log';
import React from 'react';
import * as ReactDOM from 'react-dom';

import { NonIdealState, Spinner } from '@blueprintjs/core';

import { AppConfig } from '../config/app';
import { RendererConfig } from '../config/renderer';
import { Model, AnyIDType } from '../db/models';
import { Index } from '../db/query';

import '!style-loader!css-loader!@blueprintjs/datetime/lib/css/blueprint-datetime.css';
import '!style-loader!css-loader!@blueprintjs/core/lib/css/blueprint.css';
import '!style-loader!css-loader!./normalize.css';
import '!style-loader!css-loader!./renderer.css';
import { useIPCEvent, useIPCValue, callIPC } from '../ipc/renderer';


interface AppRenderer<C extends RendererConfig<any>> {
  root: HTMLElement
  useCount: UseCountHook<C>
  useIDs: UseIDsHook<C>
  useMany: UseManyHook<C>
  useOne: UseOneHook<C>

  openPredefinedWindow:
    (windowID: keyof C["app"]["windows"], params?: object) => Promise<void>

  openObjectEditor:
    (objectTypeID: keyof C["app"]["data"], objectID: any, params?: string) => Promise<void>
}


// Data operation hook interfaces

interface UseManyHookResult<M extends Model> {
  objects: Index<M>
  isUpdating: boolean
}
type UseManyHook<C extends RendererConfig<any>> =
<M extends Model, Q extends object = {}>
(modelName: keyof C["app"]["data"], query?: Q) => UseManyHookResult<M>

interface UseIDsHookResult<IDType extends AnyIDType> {
  ids: IDType[]
  isUpdating: boolean
}
type UseIDsHook<C extends RendererConfig<any>> =
<IDType extends AnyIDType, Q extends object = {}>
(modelName: keyof C["app"]["data"], query?: Q) => UseIDsHookResult<IDType>

interface UseCountHookResult {
  count: number
  isUpdating: boolean
}
type UseCountHook<C extends RendererConfig<any>> =
<Q extends object>
(modelName: keyof C["app"]["data"], query: Q) => UseCountHookResult

interface UseOneHookResult<M extends Model> {
  object: M | null
  isUpdating: boolean
  refresh: () => void
}
type UseOneHook<C extends RendererConfig<any>> =
<M extends Model, IDType extends AnyIDType>
(modelName: keyof C["app"]["data"], objectID: IDType | null) => UseOneHookResult<M>


// Render application screen in a new window
// with given top-level window UI component and (if applicable) any parameters
// wrapped in configured context provider components.
export const renderApp = <A extends AppConfig, C extends RendererConfig<A>>(config: C): AppRenderer<C> => {

  // electron-webpack guarantees presence of #app in index.html it bundles
  const appRoot = document.getElementById('app') as HTMLElement;

  // Add a class allowing platform-specific styling
  document.documentElement.classList.add(`platform--${process.platform}`);

  // Get all params passed to the window via GET query string
  const searchParams = new URLSearchParams(window.location.search);

  // Prepare getter for requested top-level window UI React component
  const componentId = searchParams.get('c');
  const componentImporter = componentId ? config.windowComponents[componentId] : null;

  log.debug(`Requested window component ${componentId}`);


  const openObjectEditor = async (dataTypeID: keyof C["app"]["data"], objectID: any, params?: string) => {
    if (config.objectEditorWindows === undefined) {
      throw new Error("No object editor windows configured");
    }
    const windowID = config.objectEditorWindows[dataTypeID];
    const windowOptions = config.app.windows[windowID as keyof typeof config.app.windows];
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

  const openPredefinedWindow = async (windowID: keyof typeof config["app"]["windows"], params?: object) => {
    await callIPC('open-predefined-window', {
      id: windowID,
      params: params || {},
    });
  };


  // TODO: Refactor out hook initialization

  const useIDs: UseIDsHook<C> =
  <IDType extends AnyIDType, Q extends object = {}>
  (modelName: keyof A["data"], query?: Q) => {
    /* Queries data for specified model, listens for update events and updates the dataset. */

    const trackedIDs = useIPCValue<Q, { ids: IDType[] }>
    (`model-${modelName}-list-ids`, { ids: [] }, query);

    useIPCEvent<{ ids?: string[] }>(`model-${modelName}-objects-changed`, function ({ ids }) {
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
  }

  const useCount: UseCountHook<C> =
  <Q extends object = any>
  (modelName: keyof A["data"], query?: Q) => {
    /* Queries data for specified model, listens for update events and updates the dataset. */

    const count = useIPCValue<Q, { count: number }>
    (`model-${modelName}-count`, { count: 0 }, query);

    useIPCEvent<{ ids?: string[] }>(`model-${modelName}-objects-changed`, function () {
      count.refresh();
    });

    return { count: count.value.count, isUpdating: count.isUpdating };
  }

  const useMany: UseManyHook<C> =
  <M extends Model, Q extends object = {}>
  (modelName: keyof A["data"], query?: Q) => {
    /* Queries data for specified model, listens for update events and updates the dataset. */

    const objects = useIPCValue<Q, Index<M>>
    (`model-${modelName}-read-all`, {}, query);

    useIPCEvent<{ ids?: string[] }>(`model-${modelName}-objects-changed`, function ({ ids }) {
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
  }

  const useOne: UseOneHook<C> =
  <M extends Model, IDType extends AnyIDType>
  (modelName: keyof A["data"], objectID: IDType | null) => {
    /* Queries data for specified model, listens for update events and updates the dataset. */

    const object = useIPCValue<{ objectID: IDType | null }, { object: M | null }>
    (`model-${modelName}-read-one`, { object: null as M | null }, { objectID });

    useIPCEvent<{ ids?: string[] }>(`model-${modelName}-objects-changed`, function ({ ids }) {
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
  }

  // Fetch top-level UI component class and render it.
  if (componentImporter) {
    (async () => {
      // Show loading indicator while components are being resolved
      ReactDOM.render(<Spinner className="initial-spinner" />, appRoot);

      const ctxProviderConfig = config.contextProviders || [];

      // Get props prescribed for each context provider component
      var ctxProviderProps = await Promise.all(ctxProviderConfig.map(item => item.getProps(config)));

      log.silly(
        `C/renderApp: Resolving components`,
        componentImporter, ctxProviderConfig);

      // Resolve (import) components in parallel, first UI and then context providers
      const promisedComponents: { default: React.FC<any> }[] = await Promise.all([
        componentImporter(),
        ...ctxProviderConfig.map(async (ctxp) => await ctxp.cls()),
      ]);

      log.silly(
        `C/renderApp: Resolved components`,
        promisedComponents);

      // Break down components into top-level window UI & context providers
      const TopWindowComponent = promisedComponents[0].default;
      var ctxProviderComponents = promisedComponents.
        slice(1, promisedComponents.length).
        map(item => item.default);

      // Reorder context providers so that top-most is the most basic
      ctxProviderComponents.reverse();
      ctxProviderProps.reverse();

      // Write out top-level window component JSX
      var appMarkup = <TopWindowComponent query={searchParams} />;

      log.debug(
        `C/renderApp: Got context provider components`,
        ctxProviderComponents);

      // Wrap the JSX into context provider components
      for (const [idx, ContextProvider] of ctxProviderComponents.entries()) {
        log.verbose(
          `C/renderApp: Initializing context provider #${idx}`,
          ctxProviderComponents[idx],
          ctxProviderProps[idx]);

        appMarkup = (
          <ContextProvider {...ctxProviderProps[idx]}>
            {appMarkup}
          </ContextProvider>
        );
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

  } else {
    // Component specified in GET params is not present in app renderer config.
    // TODO: Handle misconfigured React context providers and failed import at runtime
    ReactDOM.render(<NonIdealState
      icon="error"
      title="Unknown component requested" />, appRoot);

    log.error("Unknown component requested", componentId);
    throw new Error("Unknown component requested");
  }

};
