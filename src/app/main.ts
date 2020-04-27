// Jury-rig global.fetch to make Isomorphic Git work under Node
import fetch from 'node-fetch';
(global as any).fetch = fetch;

import { app, App } from 'electron';
import * as log from 'electron-log';

import { AppConfig, Window } from '../config/app';

import { MainConfig } from '../config/main';
import { SettingManager } from '../settings/main';
import { notifyAllWindows, WindowOpenerParams } from '../main/window';
import { listen } from '../ipc/main';
import {
  Backend,
  ModelManager,
  BackendClass as DatabaseBackendClass,
} from '../db/main/base';

import { makeWindowEndpoint } from '../ipc/main';
import { openWindow, closeWindow } from '../main/window';


export let main: MainApp<any, any>;


export const initMain = async <C extends MainConfig<any>>(config: C): Promise<MainApp<any, C>> => {

  // Prevent windows from closing while app is initialized
  app.on('window-all-closed', (e: any) => e.preventDefault());

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
    log.verbose("C/main: Opening window", windowName);

    const defaultParams = config.app.windows[windowName].openerParams;

    const openerParams = {
      ...defaultParams,
      componentParams: `${defaultParams.componentParams}&${extraComponentParams}`,
    };

    return openWindow({
      ...openerParams,
      component: windowName,
      config: config.app,
    });
  }

  function _closeWindow(windowName: keyof typeof config.app.windows) {
    log.verbose(`C/main: Closing window ${String(windowName)}`);

    closeWindow(config.app.windows[windowName].openerParams.title);
  }

  function _requestSettings(settingIDs: string[]): Promise<void> {
    /* Open settings window, prompting the user
       to fill in parameters required for application
       to perform a function.
       The window is expected to use commitSetting IPC calls,
       which is how default settings widgets work. */

    const settingsWindow = config.app.windows[config.app.settingsWindowID];
    if (settingsWindow) {
      return new Promise<void>(async (resolve, reject) => {

        const openedWindow = await _openWindow(
          config.app.settingsWindowID,
          `requiredSettings=${settingIDs.join(',')}`);

        openedWindow.on('closed', () => {
          const missingRequiredSettings = settingIDs.
            map((settingID) =>  settings.getValue(settingID)).
            filter((settingVal) => settingVal === undefined);
          if (missingRequiredSettings.length > 0) {
            log.warn(
              "C/main: User closed settings window with missing settings left",
              missingRequiredSettings)
            reject();
          } else {
            log.verbose("C/main: User provider all missing settings")
            resolve();
          }
        })

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

  await app.whenReady();

  // Show splash window, if configured
  const splashWindow = config.app.windows[config.app.splashWindowID];
  if (splashWindow) {
    _openWindow(config.app.splashWindowID);
  }

  const isMacOS = process.platform === 'darwin';
  const isDevelopment = process.env.NODE_ENV !== 'production' || config.app.forceDevelopmentMode;

  const settings = new SettingManager(config.appDataPath, config.settingsFileName);
  settings.setUpIPC();


  // Prepare database backends & request configuration if needed

  log.debug("C/initMain: DB: Reading backend config", config.databases);

  type BackendInfo = {
    dbName: string
    backendClass: DatabaseBackendClass<any, any, any>
    backendOptions: any
  };
  let dbBackendClasses: BackendInfo[];
  dbBackendClasses = (await Promise.all(Object.entries(config.databases).map(
    async ([dbName, dbConf]) => {
      log.debug("C/initMain: DB: Reading backend config", dbName, dbConf);

      const DBBackendClass = dbConf.backend;
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
           async (payload: any) => await reportBackendStatusToAllWindows(dbName, payload));

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
      const modelInfo = config.app.data[modelName];

      log.verbose("C/initMain: Initializing model manager for DB", managerConf.dbName, databases);

      const db = databases[managerConf.dbName];
      const ManagerClass = managerConf.options.cls;
      const manager = new ManagerClass(
        db, managerConf.options, modelInfo,
        async (changedIDs?: any[]) => await reportModifiedDataToAllWindows(modelName, changedIDs?.map(id => `${id}`)));

      if (manager.setUpIPC) {
        manager.setUpIPC(modelName);
      }

      return { [modelName]: manager };
    }
  )))
  .reduce((val, acc) => ({ ...acc, ...val }), {} as Partial<Managers>) as Managers;


  listen<{ id: keyof typeof config.app.windows, params?: Omit<WindowOpenerParams, 'component'> }, {}>
  ('open-predefined-window', async ({ id, params }) => {
    const paramsWithDefaults = { ...config.app.windows[id].openerParams, ...params || {}, component: id, config: config.app };
    openWindow(paramsWithDefaults);
    return {};
  });


  listen<WindowOpenerParams, {}>
  ('open-arbitrary-window', async (params) => {
    openWindow(params);
    return {};
  });


  // Initialize window-opening endpoints
  for (const [windowName, window] of Object.entries(config.app.windows)) {
    makeWindowEndpoint(windowName, () => ({
      ...(window as Window).openerParams,
      component: windowName,
      config: config.app,
    }));
  }

  // DB backend initialization happens after the app is ready,
  // since it may require user input (and hence GUI interaction)
  // of sensitive data not suitable for settings,
  // namely authentication keys if data source requires auth.
  // TODO: Teaching the framework to encrypt settings
  // might let us make authentication data entry
  // part of required settings entry
  // and start data source initialization early.
  for (const [backendID, backend] of Object.entries(databases)) {
    log.debug("C/initMain: Initializing DB backend", backendID);
    await backend.init();
  }

  for (const [managerID, manager] of Object.entries(managers)) {
    log.debug("C/initMain: Initializing manager", managerID);
    await manager.init();
  }

  // Open main window
  await _openWindow('default');

  if (splashWindow) {
    _closeWindow(config.app.splashWindowID);
  }

  main = {
    app,
    isMacOS,
    isDevelopment,
    managers,
    databases,
    openWindow: _openWindow,
  } as MainApp<any, any>;

  return main as MainApp<typeof config.app, typeof config>;
};


const reportBackendStatusToAllWindows = async (dbName: string, payload: object) => {
  return await notifyAllWindows(`db-${dbName}-status`, payload);
};


const reportModifiedDataToAllWindows = async (modelName: string, changedIDs?: string[]) => {
  // TODO: If too many update calls with one ID affect performance,
  // debounce this function, combining shorter ID lists and reporting more of them at once
  log.debug("C/main: Reporting modified data", modelName, changedIDs);
  return await notifyAllWindows(`model-${modelName}-objects-changed`, { ids: changedIDs });
};


export interface MainApp<A extends AppConfig, M extends MainConfig<A>> {
  /* Object returned by initMain. */

  app: App
  isMacOS: boolean
  isDevelopment: boolean
  managers: Record<keyof A["data"], ModelManager<any, any>>
  databases: Record<keyof M["databases"], Backend>
  openWindow: (windowName: keyof A["windows"]) => void
}
