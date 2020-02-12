import React from 'react';
import * as log from 'electron-log';
import * as ReactDOM from 'react-dom';

import { AppConfig } from '../config/app';
import { RendererConfig } from '../config/renderer';

import { Model } from '../db/models';
import { Index } from '../db/query';

import { NonIdealState, Spinner } from '@blueprintjs/core';

import '!style-loader!css-loader!@blueprintjs/datetime/lib/css/blueprint-datetime.css';
import '!style-loader!css-loader!@blueprintjs/core/lib/css/blueprint.css';
import '!style-loader!css-loader!./normalize.css';
import '!style-loader!css-loader!./renderer.css';
import { useIPCEvent, useIPCValue } from '../ipc/renderer';


interface UseDataHookResult<M extends Model> {
  objects: Index<M>
}

type UseDataHook<C extends RendererConfig<any>> =
<M extends Model, Q extends object>(modelName: keyof C["app"]["data"], query: Q) => UseDataHookResult<M>

interface AppRenderer<C extends RendererConfig<any>> {
  root: HTMLElement
  useData: UseDataHook<C>
}


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

  const useData: UseDataHook<C> =
  <M extends Model, Q extends object = any>
  (modelName: keyof A["data"], query?: Q) => {
    /* Queries data for specified model, listens for update events and updates the dataset. */

    const objects = useIPCValue<Q, Index<M>>(`model-${modelName}-read-all`, {}, query);

    useIPCEvent<{ ids?: string[] }>(`model-${modelName}-objects-changed`, function ({ ids }) {
      const trackedObjectIDs = Object.keys(objects);
      const shouldRefresh = ids !== undefined
        ? ids.filter(id => trackedObjectIDs.includes(id)).length > 0
        : false;
      if (shouldRefresh) {
        objects.refresh();
      }
    });

    return { objects: objects.value };
  }

  // Fetch top-level UI component class and render it.
  if (componentImporter) {
    (async () => {
      // Show loading indicator while components are being resolved
      ReactDOM.render(<Spinner />, appRoot);

      // Get props prescribed for each context provider component
      var ctxProviderProps = config.contextProviders.map(item => item.getProps(config));

      log.silly(
        `C/renderApp: Resolving components`,
        componentImporter, config.contextProviders);

      // Resolve (import) components in parallel, first UI and then context providers
      const promisedComponents: { default: React.FC<any> }[] = await Promise.all([
        componentImporter(),
        ...config.contextProviders.map(async (ctxp) => await ctxp.cls()),
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
      useData,
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