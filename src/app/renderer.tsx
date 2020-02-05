import React from 'react';
import * as log from 'electron-log';
import * as ReactDOM from 'react-dom';
import { AppConfig } from '../config/app';
import { RendererConfig } from '../config/renderer';

import { NonIdealState, Spinner } from '@blueprintjs/core';

import '!style-loader!css-loader!@blueprintjs/datetime/lib/css/blueprint-datetime.css';
import '!style-loader!css-loader!@blueprintjs/core/lib/css/blueprint.css';
import '!style-loader!css-loader!./normalize.css';
import '!style-loader!css-loader!./renderer.css';


interface AppRenderer {
  root: HTMLElement,
}


// Render application screen in a new window
// with given top-level window UI component and (if applicable) any parameters
// wrapped in configured context provider components.
export const renderApp = async <A extends AppConfig, C extends RendererConfig<A>>(config: C): Promise<AppRenderer> => {

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

  // Fetch top-level UI component class and render it.
  if (componentImporter) {
    // Show loading indicator while components are being resolved
    ReactDOM.render(<Spinner />, appRoot);

    const RendererConfigContext = React.createContext<C>(config);

    // Get props prescribed for each context provider component
    var ctxProviderOptions = config.contextProviders.map(item => item.opts);

    // Resolve (import) components in parallel, first UI and then context providers
    const promisedComponents: { default: React.FC<any> }[] = await Promise.all([
      componentImporter(),
      ...config.contextProviders.map(async (ctxp) => await ctxp.cls()),
    ]);

    // Break down components into top-level window UI & context providers
    const TopWindowComponent = promisedComponents[0].default;
    var ctxProviderComponents = promisedComponents.
      slice(1, promisedComponents.length).
      map(item => item.default);

    // Reorder context providers so that top-most is the most basic
    ctxProviderComponents.reverse();
    ctxProviderOptions.reverse();

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
        ctxProviderOptions[idx]);

      appMarkup = (
        <ContextProvider {...ctxProviderOptions[idx](config)}>
          {appMarkup}
        </ContextProvider>
      );
    }

    log.debug("C/renderApp: Rendering");

    // Wrap the app into top-level context
    // offering renderer config values
    appMarkup = (
      <RendererConfigContext.Provider value={config}>
        {appMarkup}
      </RendererConfigContext.Provider>
    );

    // Render the JSX
    ReactDOM.render(appMarkup, appRoot);

  } else {
    // Component specified in GET params is not present in app renderer config.
    // TODO: Handle misconfigured React context providers and failed import at runtime
    ReactDOM.render(<NonIdealState
      icon="error"
      title="Unknown component requested" />, appRoot);
  }

  return {
    root: appRoot,
  };

};