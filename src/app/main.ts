// Jury-rig globa.fetch to make Isomorphic Git work under Node
import fetch from 'node-fetch';
(global as any).fetch = fetch;

import { app, App, ipcMain } from 'electron';
import * as log from 'electron-log';

import { AppConfig, Window } from '../config/app';
import { MainConfig } from '../config/main';
import { SettingManager } from '../settings/main';
import { notifyAllWindows } from '../main/window';
import {
  VersionedFilesystemBackend,
  VersionedManager,
  BackendClass as DatabaseBackendClass,
} from '../db/main/base';

import { listen, unlisten, Handler, makeWindowEndpoint } from '../ipc/main';
import { openWindow, closeWindow } from '../main/window';


export let main: MainApp<any, any>;


export const initMain = async <C extends MainConfig<any>>(config: C): Promise<MainApp<any, C>> => {

  log.catchErrors({ showDialog: true });

  if (config.app.singleInstance) {
    // Ensure only one instance of the app can run at a time on given user’s machine
    // by exiting any future instances
    if (!app.requestSingleInstanceLock()) {
      app.exit(0);
    }
  }


  /* Helper functions */

  function _openWindow(windowName: keyof typeof config.app.windows, extraComponentParams: string = '') {
    log.verbose(`C/main: Opening window ${String(windowName)}`);

    const defaultParams = config.app.windows[windowName].openerParams;

    const openerParams = {
      ...defaultParams,
      componentParams: `${defaultParams.componentParams}&${extraComponentParams}`,
    };

    return openWindow({
      ...openerParams,
      component: windowName,
    });
  }

  function _requestSettings(settings: string[]): Promise<void> {
    /* Open settings window, prompting the user
       to fill in parameters required for application
       to perform a function.
       The window is expected to use commitSetting IPC calls,
       which is how default settings widgets work. */

    const settingsWindow = config.app.windows[config.app.settingsWindowID];
    if (settingsWindow) {
      return new Promise<void>(async (resolve, reject) => {
        var resolvedSettings: { [key: string]: any } = {};

        const handleSetting: Handler<{ name: string, value: any }, {}> = async function ({ name, value }) {
          if (settings.indexOf(name) >= 0) {
            // If we got a value for one of our requested settings,
            // check if all requested settings have defined values
            // (close settings window & resolve promise if they do).
            resolvedSettings[name] = value;

            const allSettingsResolved =
              settings.filter(s => resolvedSettings[s] === undefined).length < 1;

            if (allSettingsResolved) {
              unlisten('commitSetting', handleSetting);
              await closeWindow(settingsWindow.openerParams.title);
              resolve();
            } else {
              log.verbose(
                "C/main: Specified setting value, remaining required settings exist",
                settings.filter(s => resolvedSettings[s] === undefined))
            }
          }
          return {};
        }
        listen('commitSetting', handleSetting);
        await _openWindow(config.app.settingsWindowID, `requiredSettings=${settings.join(',')}`);
      });
    } else {
      throw new Error("Settings were requested, but settings window is not specified");
    }
  }

  // TODO: This workaround may or may not be necessary
  if (config.disableGPU) {
    app.disableHardwareAcceleration();
  }

  // Catch unhandled errors in electron-log
  log.catchErrors({ showDialog: true });

  // Show splash window, if configured
  const splashWindow = config.app.windows[config.app.splashWindowID];
  if (splashWindow) {
    // Can’t display splash screen before the app is ready
    app.whenReady().then(() => { _openWindow(config.app.splashWindowID); });
  }

  const isMacOS = process.platform === 'darwin';
  const isDevelopment = process.env.NODE_ENV !== 'production';

  const settings = new SettingManager(config.appDataPath, config.settingsFileName);
  settings.setUpIPC();


  // Prepare database backends & request configuration if needed

  log.debug("C/initMain: DB: Reading backend config", config.databases);

  let dbBackendClasses: {
    dbName: string
    backendClass: DatabaseBackendClass<any, any, any>
    backendOptions: any
  }[];

  dbBackendClasses = (await Promise.all(Object.entries(config.databases).map(
    async ([dbName, dbConf]) => {
      log.debug("C/initMain: DB: Reading backend config", dbName, dbConf);

      const DBBackendClass = (await dbConf.backend()).default;
      if (DBBackendClass.registerSettingsForConfigurableOptions) {
        DBBackendClass.registerSettingsForConfigurableOptions(settings, dbConf.options, dbName);
      }
      return {
        dbName: dbName,
        backendClass: DBBackendClass,
        backendOptions: dbConf.options,
      };
    }
  )));


  // Request settings from user via an initial configuration window, if required

  const missingSettings = await settings.listMissingRequiredSettings();
  // List of IDs of settings that need to be filled out.

  if (missingSettings.length > 0) {
    log.verbose("C/initMain: Missing settings present, requesting from the user", missingSettings);
    await _requestSettings(missingSettings);
  } else {
    log.debug("C/initMain: No missing settings found");
  }


  // Construct database backend instances

  type DBs = MainApp<any, C>["databases"];
  let databases: DBs

  try {
    databases = (await Promise.all(dbBackendClasses.map(
      async ({ dbName, backendClass, backendOptions }) => {
        const DBBackendClass = backendClass;

        log.verbose("C/initMain: DB: Completing backend options from", backendOptions);

        let options: any;
        if (DBBackendClass.completeOptionsFromSettings) {
          options = await DBBackendClass.completeOptionsFromSettings(
            settings,
            backendOptions,
            dbName);
        } else {
          options = backendOptions;
        }

        log.verbose("C/initMain: DB: Initializing backend with options", backendOptions);

        const backend = new DBBackendClass(
           options,
           (payload: any) => reportBackendStatusToAllWindows(`db-${dbName}`, payload));

        if (backend.setUpIPC) {
          backend.setUpIPC(dbName);
        }

        return { [dbName]: backend };
      }
    ))).reduce((val, acc) => ({ ...acc, ...val }), {} as Partial<DBs>) as DBs;
  } catch (e) {
    log.error("C/initMain: Failed to initialize database backends");
    throw e;
  }


  // Initialize model managers

  log.debug("C/initMain: Initializing data model managers", config.managers)

  type Managers = MainApp<any, C>["managers"];
  let managers: Managers;

  managers = (await Promise.all(Object.entries(config.managers).map(
    async ([modelName, managerConf]) => {
      const modelConf = config.app.data[modelName];

      log.verbose("C/initMain: Initializing model manager for DB", managerConf.dbName, databases);

      const db = databases[managerConf.dbName];
      const ManagerClass = (await managerConf.options.cls()).default;
      const manager = new ManagerClass(db, managerConf.options, modelConf);

      if (manager.setUpIPC) {
        manager.setUpIPC(modelName);
      }

      return { [modelName]: manager };
    }
  )))
  .reduce((val, acc) => ({ ...acc, ...val }), {} as Partial<Managers>) as Managers;


  app.whenReady()
  .then(() => {
    // Close splash window before opening the default window
    closeWindow(splashWindow.openerParams.title);

    _openWindow('default');

    // DB backend initialization happens after the app is ready,
    // since it may require user input (and hence GUI interaction)
    // of sensitive data not suitable for settings,
    // namely authentication keys if data source requires auth.
    // TODO: Teaching the framework to encrypt settings
    // might let us make authentication data entry
    // part of required settings entry
    // and start data source initialization early.
    for (const backend of Object.values(databases)) {
      backend.init();
    }

    // Initialize window-opening endpoints
    for (const [windowName, window] of Object.entries(config.app.windows)) {
      makeWindowEndpoint(windowName, () => ({
        ...(window as Window).openerParams,
        component: windowName,
      }));
    }
  });

  main = {
    app,
    isMacOS,
    isDevelopment,
    managers,
    databases,
    openWindow: _openWindow,
  };

  return main as MainApp<typeof config.app, typeof config>;
};


async function reportBackendStatusToAllWindows(dbName: string, payload: any) {
  return await notifyAllWindows(`db-${dbName}-status`, payload);
}


export interface MainApp<A extends AppConfig, M extends MainConfig<A>> {
  /* Object returned by initMain. */

  app: App,
  isMacOS: boolean
  isDevelopment: boolean
  managers: Record<keyof A["data"], VersionedManager<any, any>>
  databases: Record<keyof M["databases"], VersionedFilesystemBackend>
  openWindow: (windowName: keyof A["windows"]) => void
}
