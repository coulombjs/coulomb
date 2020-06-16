// Jury-rig global.fetch to make Isomorphic Git work under Node
import fetch from 'node-fetch';
global.fetch = fetch;
import { app } from 'electron';
import * as log from 'electron-log';
import { SettingManager } from '../settings/main';
import { notifyAllWindows } from '../main/window';
import { listen } from '../ipc/main';
import { makeWindowEndpoint } from '../ipc/main';
import { openWindow, closeWindow } from '../main/window';
export const initMain = async (config) => {
    // Prevent windows from closing while app is initialized
    app.on('window-all-closed', (e) => e.preventDefault());
    log.catchErrors({ showDialog: true });
    if (config.app.singleInstance) {
        // Ensure only one instance of the app can run at a time on given user’s machine
        // by exiting any future instances
        if (!app.requestSingleInstanceLock()) {
            app.exit(0);
        }
    }
    /* Helper functions */
    function _openWindow(windowName, extraComponentParams = '') {
        log.verbose("C/main: Opening window", windowName);
        const defaultParams = config.app.windows[windowName].openerParams;
        const openerParams = Object.assign(Object.assign({}, defaultParams), { componentParams: `${defaultParams.componentParams}&${extraComponentParams}` });
        return openWindow(Object.assign(Object.assign({}, openerParams), { component: windowName, config: config.app }));
    }
    function _closeWindow(windowName) {
        log.verbose(`C/main: Closing window ${String(windowName)}`);
        closeWindow(config.app.windows[windowName].openerParams.title);
    }
    function _requestSettings(settingIDs) {
        /* Open settings window, prompting the user
           to fill in parameters required for application
           to perform a function.
           The window is expected to use commitSetting IPC calls,
           which is how default settings widgets work. */
        const settingsWindow = config.app.windows[config.app.settingsWindowID];
        if (settingsWindow) {
            return new Promise(async (resolve, reject) => {
                const openedWindow = await _openWindow(config.app.settingsWindowID, `requiredSettings=${settingIDs.join(',')}`);
                openedWindow.on('closed', () => {
                    const missingRequiredSettings = settingIDs.
                        map((settingID) => settings.getValue(settingID)).
                        filter((settingVal) => settingVal === undefined);
                    if (missingRequiredSettings.length > 0) {
                        log.warn("C/main: User closed settings window with missing settings left", missingRequiredSettings);
                        reject();
                    }
                    else {
                        log.verbose("C/main: User provider all missing settings");
                        resolve();
                    }
                });
            });
        }
        else {
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
    let dbBackendClasses;
    dbBackendClasses = (await Promise.all(Object.entries(config.databases).map(async ([dbName, dbConf]) => {
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
    })));
    // Request settings from user via an initial configuration window, if required
    const missingSettings = await settings.listMissingRequiredSettings();
    // List of IDs of settings that need to be filled out.
    if (missingSettings.length > 0) {
        log.verbose("C/initMain: Missing settings present, requesting from the user", missingSettings);
        await _requestSettings(missingSettings);
    }
    else {
        log.debug("C/initMain: No missing settings found");
    }
    let databases;
    try {
        databases = (await Promise.all(dbBackendClasses.map(async ({ dbName, backendClass, backendOptions }) => {
            const DBBackendClass = backendClass;
            log.verbose("C/initMain: DB: Completing backend options from", backendOptions);
            let options;
            if (DBBackendClass.completeOptionsFromSettings) {
                options = await DBBackendClass.completeOptionsFromSettings(settings, backendOptions, dbName);
            }
            else {
                options = backendOptions;
            }
            log.verbose("C/initMain: DB: Initializing backend with options", backendOptions);
            const backend = new DBBackendClass(options, async (payload) => await reportBackendStatusToAllWindows(dbName, payload));
            if (backend.setUpIPC) {
                backend.setUpIPC(dbName);
            }
            return { [dbName]: backend };
        }))).reduce((val, acc) => (Object.assign(Object.assign({}, acc), val)), {});
    }
    catch (e) {
        log.error("C/initMain: Failed to initialize database backends");
        throw e;
    }
    // Initialize model managers
    log.debug("C/initMain: Initializing data model managers", config.managers);
    let managers;
    managers = (await Promise.all(Object.entries(config.managers).map(async ([modelName, managerConf]) => {
        const modelInfo = config.app.data[modelName];
        log.verbose("C/initMain: Initializing model manager for DB", managerConf.dbName, databases);
        const db = databases[managerConf.dbName];
        const ManagerClass = managerConf.options.cls;
        const manager = new ManagerClass(db, managerConf.options, modelInfo, async (changedIDs) => { var _a; return await reportModifiedDataToAllWindows(modelName, (_a = changedIDs) === null || _a === void 0 ? void 0 : _a.map(id => `${id}`)); });
        if (manager.setUpIPC) {
            manager.setUpIPC(modelName);
        }
        return { [modelName]: manager };
    })))
        .reduce((val, acc) => (Object.assign(Object.assign({}, acc), val)), {});
    listen('list-databases', async () => {
        return {
            databases: Object.keys(databases),
        };
    });
    listen('open-predefined-window', async ({ id, params }) => {
        const paramsWithDefaults = Object.assign(Object.assign(Object.assign({}, config.app.windows[id].openerParams), params || {}), { component: id, config: config.app });
        openWindow(paramsWithDefaults);
        return {};
    });
    listen('open-arbitrary-window', async (params) => {
        openWindow(params);
        return {};
    });
    // Initialize window-opening endpoints
    for (const [windowName, window] of Object.entries(config.app.windows)) {
        makeWindowEndpoint(windowName, () => (Object.assign(Object.assign({}, window.openerParams), { component: windowName, config: config.app })));
    }
    // Open main window
    await _openWindow('default');
    if (splashWindow) {
        _closeWindow(config.app.splashWindowID);
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
    const initializedMain = {
        app,
        isMacOS,
        isDevelopment,
        managers,
        databases,
        settings,
        openWindow: _openWindow,
    };
    return initializedMain;
};
const reportBackendStatusToAllWindows = async (dbName, payload) => {
    return await notifyAllWindows(`db-${dbName}-status`, payload);
};
const reportModifiedDataToAllWindows = async (modelName, changedIDs) => {
    // TODO: If too many update calls with one ID affect performance,
    // debounce this function, combining shorter ID lists and reporting more of them at once
    //log.debug("C/main: Reporting modified data", modelName, changedIDs);
    return await notifyAllWindows(`model-${modelName}-objects-changed`, { ids: changedIDs });
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9hcHAvbWFpbi50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSwrREFBK0Q7QUFDL0QsT0FBTyxLQUFLLE1BQU0sWUFBWSxDQUFDO0FBQzlCLE1BQWMsQ0FBQyxLQUFLLEdBQUcsS0FBSyxDQUFDO0FBRTlCLE9BQU8sRUFBRSxHQUFHLEVBQU8sTUFBTSxVQUFVLENBQUM7QUFDcEMsT0FBTyxLQUFLLEdBQUcsTUFBTSxjQUFjLENBQUM7QUFLcEMsT0FBTyxFQUFFLGNBQWMsRUFBRSxNQUFNLGtCQUFrQixDQUFDO0FBQ2xELE9BQU8sRUFBRSxnQkFBZ0IsRUFBc0IsTUFBTSxnQkFBZ0IsQ0FBQztBQUN0RSxPQUFPLEVBQUUsTUFBTSxFQUFFLE1BQU0sYUFBYSxDQUFDO0FBT3JDLE9BQU8sRUFBRSxrQkFBa0IsRUFBRSxNQUFNLGFBQWEsQ0FBQztBQUNqRCxPQUFPLEVBQUUsVUFBVSxFQUFFLFdBQVcsRUFBRSxNQUFNLGdCQUFnQixDQUFDO0FBZ0J6RCxNQUFNLENBQUMsTUFBTSxRQUFRLEdBQUcsS0FBSyxFQUE2QixNQUFTLEVBQTRCLEVBQUU7SUFFL0Ysd0RBQXdEO0lBQ3hELEdBQUcsQ0FBQyxFQUFFLENBQUMsbUJBQW1CLEVBQUUsQ0FBQyxDQUFNLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxjQUFjLEVBQUUsQ0FBQyxDQUFDO0lBRTVELEdBQUcsQ0FBQyxXQUFXLENBQUMsRUFBRSxVQUFVLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQztJQUV0QyxJQUFJLE1BQU0sQ0FBQyxHQUFHLENBQUMsY0FBYyxFQUFFO1FBQzdCLGdGQUFnRjtRQUNoRixrQ0FBa0M7UUFDbEMsSUFBSSxDQUFDLEdBQUcsQ0FBQyx5QkFBeUIsRUFBRSxFQUFFO1lBQ3BDLEdBQUcsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7U0FDYjtLQUNGO0lBR0Qsc0JBQXNCO0lBRXRCLFNBQVMsV0FBVyxDQUFDLFVBQTJDLEVBQUUsdUJBQStCLEVBQUU7UUFDakcsR0FBRyxDQUFDLE9BQU8sQ0FBQyx3QkFBd0IsRUFBRSxVQUFVLENBQUMsQ0FBQztRQUVsRCxNQUFNLGFBQWEsR0FBRyxNQUFNLENBQUMsR0FBRyxDQUFDLE9BQU8sQ0FBQyxVQUFVLENBQUMsQ0FBQyxZQUFZLENBQUM7UUFFbEUsTUFBTSxZQUFZLG1DQUNiLGFBQWEsS0FDaEIsZUFBZSxFQUFFLEdBQUcsYUFBYSxDQUFDLGVBQWUsSUFBSSxvQkFBb0IsRUFBRSxHQUM1RSxDQUFDO1FBRUYsT0FBTyxVQUFVLGlDQUNaLFlBQVksS0FDZixTQUFTLEVBQUUsVUFBVSxFQUNyQixNQUFNLEVBQUUsTUFBTSxDQUFDLEdBQUcsSUFDbEIsQ0FBQztJQUNMLENBQUM7SUFFRCxTQUFTLFlBQVksQ0FBQyxVQUEyQztRQUMvRCxHQUFHLENBQUMsT0FBTyxDQUFDLDBCQUEwQixNQUFNLENBQUMsVUFBVSxDQUFDLEVBQUUsQ0FBQyxDQUFDO1FBRTVELFdBQVcsQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDLE9BQU8sQ0FBQyxVQUFVLENBQUMsQ0FBQyxZQUFZLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDakUsQ0FBQztJQUVELFNBQVMsZ0JBQWdCLENBQUMsVUFBb0I7UUFDNUM7Ozs7eURBSWlEO1FBRWpELE1BQU0sY0FBYyxHQUFHLE1BQU0sQ0FBQyxHQUFHLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsZ0JBQWdCLENBQUMsQ0FBQztRQUN2RSxJQUFJLGNBQWMsRUFBRTtZQUNsQixPQUFPLElBQUksT0FBTyxDQUFPLEtBQUssRUFBRSxPQUFPLEVBQUUsTUFBTSxFQUFFLEVBQUU7Z0JBRWpELE1BQU0sWUFBWSxHQUFHLE1BQU0sV0FBVyxDQUNwQyxNQUFNLENBQUMsR0FBRyxDQUFDLGdCQUFnQixFQUMzQixvQkFBb0IsVUFBVSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLENBQUM7Z0JBRTlDLFlBQVksQ0FBQyxFQUFFLENBQUMsUUFBUSxFQUFFLEdBQUcsRUFBRTtvQkFDN0IsTUFBTSx1QkFBdUIsR0FBRyxVQUFVO3dCQUN4QyxHQUFHLENBQUMsQ0FBQyxTQUFTLEVBQUUsRUFBRSxDQUFFLFFBQVEsQ0FBQyxRQUFRLENBQUMsU0FBUyxDQUFDLENBQUM7d0JBQ2pELE1BQU0sQ0FBQyxDQUFDLFVBQVUsRUFBRSxFQUFFLENBQUMsVUFBVSxLQUFLLFNBQVMsQ0FBQyxDQUFDO29CQUNuRCxJQUFJLHVCQUF1QixDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUU7d0JBQ3RDLEdBQUcsQ0FBQyxJQUFJLENBQ04sZ0VBQWdFLEVBQ2hFLHVCQUF1QixDQUFDLENBQUE7d0JBQzFCLE1BQU0sRUFBRSxDQUFDO3FCQUNWO3lCQUFNO3dCQUNMLEdBQUcsQ0FBQyxPQUFPLENBQUMsNENBQTRDLENBQUMsQ0FBQTt3QkFDekQsT0FBTyxFQUFFLENBQUM7cUJBQ1g7Z0JBQ0gsQ0FBQyxDQUFDLENBQUE7WUFFSixDQUFDLENBQUMsQ0FBQztTQUNKO2FBQU07WUFDTCxNQUFNLElBQUksS0FBSyxDQUFDLCtEQUErRCxDQUFDLENBQUM7U0FDbEY7SUFDSCxDQUFDO0lBRUQsb0RBQW9EO0lBQ3BELElBQUksTUFBTSxDQUFDLFVBQVUsRUFBRTtRQUNyQixHQUFHLENBQUMsMkJBQTJCLEVBQUUsQ0FBQztLQUNuQztJQUVELHlDQUF5QztJQUN6QyxHQUFHLENBQUMsV0FBVyxDQUFDLEVBQUUsVUFBVSxFQUFFLElBQUksRUFBRSxDQUFDLENBQUM7SUFFdEMsTUFBTSxHQUFHLENBQUMsU0FBUyxFQUFFLENBQUM7SUFFdEIsb0NBQW9DO0lBQ3BDLE1BQU0sWUFBWSxHQUFHLE1BQU0sQ0FBQyxHQUFHLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsY0FBYyxDQUFDLENBQUM7SUFDbkUsSUFBSSxZQUFZLEVBQUU7UUFDaEIsV0FBVyxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsY0FBYyxDQUFDLENBQUM7S0FDeEM7SUFFRCxNQUFNLE9BQU8sR0FBRyxPQUFPLENBQUMsUUFBUSxLQUFLLFFBQVEsQ0FBQztJQUM5QyxNQUFNLGFBQWEsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLFFBQVEsS0FBSyxZQUFZLElBQUksTUFBTSxDQUFDLEdBQUcsQ0FBQyxvQkFBb0IsQ0FBQztJQUUvRixNQUFNLFFBQVEsR0FBRyxJQUFJLGNBQWMsQ0FBQyxNQUFNLENBQUMsV0FBVyxFQUFFLE1BQU0sQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDO0lBQ2pGLFFBQVEsQ0FBQyxRQUFRLEVBQUUsQ0FBQztJQUdwQiw4REFBOEQ7SUFFOUQsR0FBRyxDQUFDLEtBQUssQ0FBQyx3Q0FBd0MsRUFBRSxNQUFNLENBQUMsU0FBUyxDQUFDLENBQUM7SUFPdEUsSUFBSSxnQkFBK0IsQ0FBQztJQUNwQyxnQkFBZ0IsR0FBRyxDQUFDLE1BQU0sT0FBTyxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxTQUFTLENBQUMsQ0FBQyxHQUFHLENBQ3hFLEtBQUssRUFBRSxDQUFDLE1BQU0sRUFBRSxNQUFNLENBQUMsRUFBRSxFQUFFO1FBQ3pCLEdBQUcsQ0FBQyxLQUFLLENBQUMsd0NBQXdDLEVBQUUsTUFBTSxFQUFFLE1BQU0sQ0FBQyxDQUFDO1FBRXBFLE1BQU0sY0FBYyxHQUFHLE1BQU0sQ0FBQyxPQUFPLENBQUM7UUFDdEMsSUFBSSxjQUFjLENBQUMsc0NBQXNDLEVBQUU7WUFDekQsY0FBYyxDQUFDLHNDQUFzQyxDQUFDLFFBQVEsRUFBRSxNQUFNLENBQUMsT0FBTyxFQUFFLE1BQU0sQ0FBQyxDQUFDO1NBQ3pGO1FBQ0QsT0FBTztZQUNMLE1BQU0sRUFBRSxNQUFNO1lBQ2QsWUFBWSxFQUFFLGNBQWM7WUFDNUIsY0FBYyxFQUFFLE1BQU0sQ0FBQyxPQUFPO1NBQy9CLENBQUM7SUFDSixDQUFDLENBQ0YsQ0FBQyxDQUFDLENBQUM7SUFHSiw4RUFBOEU7SUFFOUUsTUFBTSxlQUFlLEdBQUcsTUFBTSxRQUFRLENBQUMsMkJBQTJCLEVBQUUsQ0FBQztJQUNyRSxzREFBc0Q7SUFFdEQsSUFBSSxlQUFlLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRTtRQUM5QixHQUFHLENBQUMsT0FBTyxDQUFDLGdFQUFnRSxFQUFFLGVBQWUsQ0FBQyxDQUFDO1FBQy9GLE1BQU0sZ0JBQWdCLENBQUMsZUFBZSxDQUFDLENBQUM7S0FDekM7U0FBTTtRQUNMLEdBQUcsQ0FBQyxLQUFLLENBQUMsdUNBQXVDLENBQUMsQ0FBQztLQUNwRDtJQU1ELElBQUksU0FBYyxDQUFBO0lBRWxCLElBQUk7UUFDRixTQUFTLEdBQUcsQ0FBQyxNQUFNLE9BQU8sQ0FBQyxHQUFHLENBQUMsZ0JBQWdCLENBQUMsR0FBRyxDQUNqRCxLQUFLLEVBQUUsRUFBRSxNQUFNLEVBQUUsWUFBWSxFQUFFLGNBQWMsRUFBRSxFQUFFLEVBQUU7WUFDakQsTUFBTSxjQUFjLEdBQUcsWUFBWSxDQUFDO1lBRXBDLEdBQUcsQ0FBQyxPQUFPLENBQUMsaURBQWlELEVBQUUsY0FBYyxDQUFDLENBQUM7WUFFL0UsSUFBSSxPQUFZLENBQUM7WUFDakIsSUFBSSxjQUFjLENBQUMsMkJBQTJCLEVBQUU7Z0JBQzlDLE9BQU8sR0FBRyxNQUFNLGNBQWMsQ0FBQywyQkFBMkIsQ0FDeEQsUUFBUSxFQUNSLGNBQWMsRUFDZCxNQUFNLENBQUMsQ0FBQzthQUNYO2lCQUFNO2dCQUNMLE9BQU8sR0FBRyxjQUFjLENBQUM7YUFDMUI7WUFFRCxHQUFHLENBQUMsT0FBTyxDQUFDLG1EQUFtRCxFQUFFLGNBQWMsQ0FBQyxDQUFDO1lBRWpGLE1BQU0sT0FBTyxHQUFHLElBQUksY0FBYyxDQUMvQixPQUFPLEVBQ1AsS0FBSyxFQUFFLE9BQVksRUFBRSxFQUFFLENBQUMsTUFBTSwrQkFBK0IsQ0FBQyxNQUFNLEVBQUUsT0FBTyxDQUFDLENBQUMsQ0FBQztZQUVuRixJQUFJLE9BQU8sQ0FBQyxRQUFRLEVBQUU7Z0JBQ3BCLE9BQU8sQ0FBQyxRQUFRLENBQUMsTUFBTSxDQUFDLENBQUM7YUFDMUI7WUFFRCxPQUFPLEVBQUUsQ0FBQyxNQUFNLENBQUMsRUFBRSxPQUFPLEVBQUUsQ0FBQztRQUMvQixDQUFDLENBQ0YsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsR0FBRyxFQUFFLEdBQUcsRUFBRSxFQUFFLENBQUMsaUNBQU0sR0FBRyxHQUFLLEdBQUcsRUFBRyxFQUFFLEVBQWtCLENBQVEsQ0FBQztLQUMzRTtJQUFDLE9BQU8sQ0FBQyxFQUFFO1FBQ1YsR0FBRyxDQUFDLEtBQUssQ0FBQyxvREFBb0QsQ0FBQyxDQUFDO1FBQ2hFLE1BQU0sQ0FBQyxDQUFDO0tBQ1Q7SUFHRCw0QkFBNEI7SUFFNUIsR0FBRyxDQUFDLEtBQUssQ0FBQyw4Q0FBOEMsRUFBRSxNQUFNLENBQUMsUUFBUSxDQUFDLENBQUE7SUFHMUUsSUFBSSxRQUFrQixDQUFDO0lBRXZCLFFBQVEsR0FBRyxDQUFDLE1BQU0sT0FBTyxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsQ0FBQyxHQUFHLENBQy9ELEtBQUssRUFBRSxDQUFDLFNBQVMsRUFBRSxXQUFXLENBQUMsRUFBRSxFQUFFO1FBQ2pDLE1BQU0sU0FBUyxHQUFHLE1BQU0sQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDO1FBRTdDLEdBQUcsQ0FBQyxPQUFPLENBQUMsK0NBQStDLEVBQUUsV0FBVyxDQUFDLE1BQU0sRUFBRSxTQUFTLENBQUMsQ0FBQztRQUU1RixNQUFNLEVBQUUsR0FBRyxTQUFTLENBQUMsV0FBVyxDQUFDLE1BQU0sQ0FBQyxDQUFDO1FBQ3pDLE1BQU0sWUFBWSxHQUFHLFdBQVcsQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDO1FBQzdDLE1BQU0sT0FBTyxHQUFHLElBQUksWUFBWSxDQUM5QixFQUFFLEVBQUUsV0FBVyxDQUFDLE9BQU8sRUFBRSxTQUFTLEVBQ2xDLEtBQUssRUFBRSxVQUFrQixFQUFFLEVBQUUsV0FBQyxPQUFBLE1BQU0sOEJBQThCLENBQUMsU0FBUyxRQUFFLFVBQVUsMENBQUUsR0FBRyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsR0FBRyxFQUFFLEVBQUUsRUFBRSxDQUFBLEVBQUEsQ0FBQyxDQUFDO1FBRWpILElBQUksT0FBTyxDQUFDLFFBQVEsRUFBRTtZQUNwQixPQUFPLENBQUMsUUFBUSxDQUFDLFNBQVMsQ0FBQyxDQUFDO1NBQzdCO1FBRUQsT0FBTyxFQUFFLENBQUMsU0FBUyxDQUFDLEVBQUUsT0FBTyxFQUFFLENBQUM7SUFDbEMsQ0FBQyxDQUNGLENBQUMsQ0FBQztTQUNGLE1BQU0sQ0FBQyxDQUFDLEdBQUcsRUFBRSxHQUFHLEVBQUUsRUFBRSxDQUFDLGlDQUFNLEdBQUcsR0FBSyxHQUFHLEVBQUcsRUFBRSxFQUF1QixDQUFhLENBQUM7SUFHakYsTUFBTSxDQUNMLGdCQUFnQixFQUFFLEtBQUssSUFBSSxFQUFFO1FBQzVCLE9BQU87WUFDTCxTQUFTLEVBQUUsTUFBTSxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUM7U0FDbEMsQ0FBQztJQUNKLENBQUMsQ0FBQyxDQUFDO0lBR0gsTUFBTSxDQUNMLHdCQUF3QixFQUFFLEtBQUssRUFBRSxFQUFFLEVBQUUsRUFBRSxNQUFNLEVBQUUsRUFBRSxFQUFFO1FBQ2xELE1BQU0sa0JBQWtCLGlEQUFRLE1BQU0sQ0FBQyxHQUFHLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQyxDQUFDLFlBQVksR0FBSyxNQUFNLElBQUksRUFBRSxLQUFFLFNBQVMsRUFBRSxFQUFFLEVBQUUsTUFBTSxFQUFFLE1BQU0sQ0FBQyxHQUFHLEdBQUUsQ0FBQztRQUMxSCxVQUFVLENBQUMsa0JBQWtCLENBQUMsQ0FBQztRQUMvQixPQUFPLEVBQUUsQ0FBQztJQUNaLENBQUMsQ0FBQyxDQUFDO0lBR0gsTUFBTSxDQUNMLHVCQUF1QixFQUFFLEtBQUssRUFBRSxNQUFNLEVBQUUsRUFBRTtRQUN6QyxVQUFVLENBQUMsTUFBTSxDQUFDLENBQUM7UUFDbkIsT0FBTyxFQUFFLENBQUM7SUFDWixDQUFDLENBQUMsQ0FBQztJQUdILHNDQUFzQztJQUN0QyxLQUFLLE1BQU0sQ0FBQyxVQUFVLEVBQUUsTUFBTSxDQUFDLElBQUksTUFBTSxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDLE9BQU8sQ0FBQyxFQUFFO1FBQ3JFLGtCQUFrQixDQUFDLFVBQVUsRUFBRSxHQUFHLEVBQUUsQ0FBQyxpQ0FDL0IsTUFBaUIsQ0FBQyxZQUFZLEtBQ2xDLFNBQVMsRUFBRSxVQUFVLEVBQ3JCLE1BQU0sRUFBRSxNQUFNLENBQUMsR0FBRyxJQUNsQixDQUFDLENBQUM7S0FDTDtJQUdELG1CQUFtQjtJQUNuQixNQUFNLFdBQVcsQ0FBQyxTQUFTLENBQUMsQ0FBQztJQUU3QixJQUFJLFlBQVksRUFBRTtRQUNoQixZQUFZLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxjQUFjLENBQUMsQ0FBQztLQUN6QztJQUVELDREQUE0RDtJQUM1RCw4REFBOEQ7SUFDOUQsK0NBQStDO0lBQy9DLDJEQUEyRDtJQUMzRCxtREFBbUQ7SUFDbkQsOENBQThDO0lBQzlDLGtDQUFrQztJQUNsQyw4Q0FBOEM7SUFDOUMsS0FBSyxNQUFNLENBQUMsU0FBUyxFQUFFLE9BQU8sQ0FBQyxJQUFJLE1BQU0sQ0FBQyxPQUFPLENBQUMsU0FBUyxDQUFDLEVBQUU7UUFDNUQsR0FBRyxDQUFDLEtBQUssQ0FBQyxxQ0FBcUMsRUFBRSxTQUFTLENBQUMsQ0FBQztRQUM1RCxNQUFNLE9BQU8sQ0FBQyxJQUFJLEVBQUUsQ0FBQztLQUN0QjtJQUVELEtBQUssTUFBTSxDQUFDLFNBQVMsRUFBRSxPQUFPLENBQUMsSUFBSSxNQUFNLENBQUMsT0FBTyxDQUFDLFFBQVEsQ0FBQyxFQUFFO1FBQzNELEdBQUcsQ0FBQyxLQUFLLENBQUMsa0NBQWtDLEVBQUUsU0FBUyxDQUFDLENBQUM7UUFDekQsTUFBTSxPQUFPLENBQUMsSUFBSSxFQUFFLENBQUM7S0FDdEI7SUFFRCxNQUFNLGVBQWUsR0FBOEM7UUFDakUsR0FBRztRQUNILE9BQU87UUFDUCxhQUFhO1FBQ2IsUUFBUTtRQUNSLFNBQVM7UUFDVCxRQUFRO1FBQ1IsVUFBVSxFQUFFLFdBQVc7S0FDeEIsQ0FBQztJQUVGLE9BQU8sZUFBZSxDQUFDO0FBQ3pCLENBQUMsQ0FBQztBQUdGLE1BQU0sK0JBQStCLEdBQUcsS0FBSyxFQUFFLE1BQWMsRUFBRSxPQUFlLEVBQUUsRUFBRTtJQUNoRixPQUFPLE1BQU0sZ0JBQWdCLENBQUMsTUFBTSxNQUFNLFNBQVMsRUFBRSxPQUFPLENBQUMsQ0FBQztBQUNoRSxDQUFDLENBQUM7QUFHRixNQUFNLDhCQUE4QixHQUFHLEtBQUssRUFBRSxTQUFpQixFQUFFLFVBQXFCLEVBQUUsRUFBRTtJQUN4RixpRUFBaUU7SUFDakUsd0ZBQXdGO0lBQ3hGLHNFQUFzRTtJQUN0RSxPQUFPLE1BQU0sZ0JBQWdCLENBQUMsU0FBUyxTQUFTLGtCQUFrQixFQUFFLEVBQUUsR0FBRyxFQUFFLFVBQVUsRUFBRSxDQUFDLENBQUM7QUFDM0YsQ0FBQyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLy8gSnVyeS1yaWcgZ2xvYmFsLmZldGNoIHRvIG1ha2UgSXNvbW9ycGhpYyBHaXQgd29yayB1bmRlciBOb2RlXG5pbXBvcnQgZmV0Y2ggZnJvbSAnbm9kZS1mZXRjaCc7XG4oZ2xvYmFsIGFzIGFueSkuZmV0Y2ggPSBmZXRjaDtcblxuaW1wb3J0IHsgYXBwLCBBcHAgfSBmcm9tICdlbGVjdHJvbic7XG5pbXBvcnQgKiBhcyBsb2cgZnJvbSAnZWxlY3Ryb24tbG9nJztcblxuaW1wb3J0IHsgQXBwQ29uZmlnLCBXaW5kb3cgfSBmcm9tICcuLi9jb25maWcvYXBwJztcblxuaW1wb3J0IHsgTWFpbkNvbmZpZyB9IGZyb20gJy4uL2NvbmZpZy9tYWluJztcbmltcG9ydCB7IFNldHRpbmdNYW5hZ2VyIH0gZnJvbSAnLi4vc2V0dGluZ3MvbWFpbic7XG5pbXBvcnQgeyBub3RpZnlBbGxXaW5kb3dzLCBXaW5kb3dPcGVuZXJQYXJhbXMgfSBmcm9tICcuLi9tYWluL3dpbmRvdyc7XG5pbXBvcnQgeyBsaXN0ZW4gfSBmcm9tICcuLi9pcGMvbWFpbic7XG5pbXBvcnQge1xuICBCYWNrZW5kLFxuICBNb2RlbE1hbmFnZXIsXG4gIEJhY2tlbmRDbGFzcyBhcyBEYXRhYmFzZUJhY2tlbmRDbGFzcyxcbn0gZnJvbSAnLi4vZGIvbWFpbi9iYXNlJztcblxuaW1wb3J0IHsgbWFrZVdpbmRvd0VuZHBvaW50IH0gZnJvbSAnLi4vaXBjL21haW4nO1xuaW1wb3J0IHsgb3BlbldpbmRvdywgY2xvc2VXaW5kb3cgfSBmcm9tICcuLi9tYWluL3dpbmRvdyc7XG5cblxuZXhwb3J0IGludGVyZmFjZSBNYWluQXBwPEEgZXh0ZW5kcyBBcHBDb25maWcsIE0gZXh0ZW5kcyBNYWluQ29uZmlnPEE+PiB7XG4gIC8qIE9iamVjdCByZXR1cm5lZCBieSBpbml0TWFpbi4gKi9cblxuICBhcHA6IEFwcFxuICBpc01hY09TOiBib29sZWFuXG4gIGlzRGV2ZWxvcG1lbnQ6IGJvb2xlYW5cbiAgbWFuYWdlcnM6IFJlY29yZDxrZXlvZiBBW1wiZGF0YVwiXSwgTW9kZWxNYW5hZ2VyPGFueSwgYW55Pj5cbiAgZGF0YWJhc2VzOiBSZWNvcmQ8a2V5b2YgTVtcImRhdGFiYXNlc1wiXSwgQmFja2VuZD5cbiAgb3BlbldpbmRvdzogKHdpbmRvd05hbWU6IGtleW9mIEFbXCJ3aW5kb3dzXCJdKSA9PiB2b2lkXG4gIHNldHRpbmdzOiBTZXR0aW5nTWFuYWdlclxufVxuXG5cbmV4cG9ydCBjb25zdCBpbml0TWFpbiA9IGFzeW5jIDxDIGV4dGVuZHMgTWFpbkNvbmZpZzxhbnk+Pihjb25maWc6IEMpOiBQcm9taXNlPE1haW5BcHA8YW55LCBDPj4gPT4ge1xuXG4gIC8vIFByZXZlbnQgd2luZG93cyBmcm9tIGNsb3Npbmcgd2hpbGUgYXBwIGlzIGluaXRpYWxpemVkXG4gIGFwcC5vbignd2luZG93LWFsbC1jbG9zZWQnLCAoZTogYW55KSA9PiBlLnByZXZlbnREZWZhdWx0KCkpO1xuXG4gIGxvZy5jYXRjaEVycm9ycyh7IHNob3dEaWFsb2c6IHRydWUgfSk7XG5cbiAgaWYgKGNvbmZpZy5hcHAuc2luZ2xlSW5zdGFuY2UpIHtcbiAgICAvLyBFbnN1cmUgb25seSBvbmUgaW5zdGFuY2Ugb2YgdGhlIGFwcCBjYW4gcnVuIGF0IGEgdGltZSBvbiBnaXZlbiB1c2Vy4oCZcyBtYWNoaW5lXG4gICAgLy8gYnkgZXhpdGluZyBhbnkgZnV0dXJlIGluc3RhbmNlc1xuICAgIGlmICghYXBwLnJlcXVlc3RTaW5nbGVJbnN0YW5jZUxvY2soKSkge1xuICAgICAgYXBwLmV4aXQoMCk7XG4gICAgfVxuICB9XG5cblxuICAvKiBIZWxwZXIgZnVuY3Rpb25zICovXG5cbiAgZnVuY3Rpb24gX29wZW5XaW5kb3cod2luZG93TmFtZToga2V5b2YgdHlwZW9mIGNvbmZpZy5hcHAud2luZG93cywgZXh0cmFDb21wb25lbnRQYXJhbXM6IHN0cmluZyA9ICcnKSB7XG4gICAgbG9nLnZlcmJvc2UoXCJDL21haW46IE9wZW5pbmcgd2luZG93XCIsIHdpbmRvd05hbWUpO1xuXG4gICAgY29uc3QgZGVmYXVsdFBhcmFtcyA9IGNvbmZpZy5hcHAud2luZG93c1t3aW5kb3dOYW1lXS5vcGVuZXJQYXJhbXM7XG5cbiAgICBjb25zdCBvcGVuZXJQYXJhbXMgPSB7XG4gICAgICAuLi5kZWZhdWx0UGFyYW1zLFxuICAgICAgY29tcG9uZW50UGFyYW1zOiBgJHtkZWZhdWx0UGFyYW1zLmNvbXBvbmVudFBhcmFtc30mJHtleHRyYUNvbXBvbmVudFBhcmFtc31gLFxuICAgIH07XG5cbiAgICByZXR1cm4gb3BlbldpbmRvdyh7XG4gICAgICAuLi5vcGVuZXJQYXJhbXMsXG4gICAgICBjb21wb25lbnQ6IHdpbmRvd05hbWUsXG4gICAgICBjb25maWc6IGNvbmZpZy5hcHAsXG4gICAgfSk7XG4gIH1cblxuICBmdW5jdGlvbiBfY2xvc2VXaW5kb3cod2luZG93TmFtZToga2V5b2YgdHlwZW9mIGNvbmZpZy5hcHAud2luZG93cykge1xuICAgIGxvZy52ZXJib3NlKGBDL21haW46IENsb3Npbmcgd2luZG93ICR7U3RyaW5nKHdpbmRvd05hbWUpfWApO1xuXG4gICAgY2xvc2VXaW5kb3coY29uZmlnLmFwcC53aW5kb3dzW3dpbmRvd05hbWVdLm9wZW5lclBhcmFtcy50aXRsZSk7XG4gIH1cblxuICBmdW5jdGlvbiBfcmVxdWVzdFNldHRpbmdzKHNldHRpbmdJRHM6IHN0cmluZ1tdKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgLyogT3BlbiBzZXR0aW5ncyB3aW5kb3csIHByb21wdGluZyB0aGUgdXNlclxuICAgICAgIHRvIGZpbGwgaW4gcGFyYW1ldGVycyByZXF1aXJlZCBmb3IgYXBwbGljYXRpb25cbiAgICAgICB0byBwZXJmb3JtIGEgZnVuY3Rpb24uXG4gICAgICAgVGhlIHdpbmRvdyBpcyBleHBlY3RlZCB0byB1c2UgY29tbWl0U2V0dGluZyBJUEMgY2FsbHMsXG4gICAgICAgd2hpY2ggaXMgaG93IGRlZmF1bHQgc2V0dGluZ3Mgd2lkZ2V0cyB3b3JrLiAqL1xuXG4gICAgY29uc3Qgc2V0dGluZ3NXaW5kb3cgPSBjb25maWcuYXBwLndpbmRvd3NbY29uZmlnLmFwcC5zZXR0aW5nc1dpbmRvd0lEXTtcbiAgICBpZiAoc2V0dGluZ3NXaW5kb3cpIHtcbiAgICAgIHJldHVybiBuZXcgUHJvbWlzZTx2b2lkPihhc3luYyAocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG5cbiAgICAgICAgY29uc3Qgb3BlbmVkV2luZG93ID0gYXdhaXQgX29wZW5XaW5kb3coXG4gICAgICAgICAgY29uZmlnLmFwcC5zZXR0aW5nc1dpbmRvd0lELFxuICAgICAgICAgIGByZXF1aXJlZFNldHRpbmdzPSR7c2V0dGluZ0lEcy5qb2luKCcsJyl9YCk7XG5cbiAgICAgICAgb3BlbmVkV2luZG93Lm9uKCdjbG9zZWQnLCAoKSA9PiB7XG4gICAgICAgICAgY29uc3QgbWlzc2luZ1JlcXVpcmVkU2V0dGluZ3MgPSBzZXR0aW5nSURzLlxuICAgICAgICAgICAgbWFwKChzZXR0aW5nSUQpID0+ICBzZXR0aW5ncy5nZXRWYWx1ZShzZXR0aW5nSUQpKS5cbiAgICAgICAgICAgIGZpbHRlcigoc2V0dGluZ1ZhbCkgPT4gc2V0dGluZ1ZhbCA9PT0gdW5kZWZpbmVkKTtcbiAgICAgICAgICBpZiAobWlzc2luZ1JlcXVpcmVkU2V0dGluZ3MubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgbG9nLndhcm4oXG4gICAgICAgICAgICAgIFwiQy9tYWluOiBVc2VyIGNsb3NlZCBzZXR0aW5ncyB3aW5kb3cgd2l0aCBtaXNzaW5nIHNldHRpbmdzIGxlZnRcIixcbiAgICAgICAgICAgICAgbWlzc2luZ1JlcXVpcmVkU2V0dGluZ3MpXG4gICAgICAgICAgICByZWplY3QoKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbG9nLnZlcmJvc2UoXCJDL21haW46IFVzZXIgcHJvdmlkZXIgYWxsIG1pc3Npbmcgc2V0dGluZ3NcIilcbiAgICAgICAgICAgIHJlc29sdmUoKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pXG5cbiAgICAgIH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJTZXR0aW5ncyB3ZXJlIHJlcXVlc3RlZCwgYnV0IHNldHRpbmdzIHdpbmRvdyBpcyBub3Qgc3BlY2lmaWVkXCIpO1xuICAgIH1cbiAgfVxuXG4gIC8vIFRPRE86IFRoaXMgd29ya2Fyb3VuZCBtYXkgb3IgbWF5IG5vdCBiZSBuZWNlc3NhcnlcbiAgaWYgKGNvbmZpZy5kaXNhYmxlR1BVKSB7XG4gICAgYXBwLmRpc2FibGVIYXJkd2FyZUFjY2VsZXJhdGlvbigpO1xuICB9XG5cbiAgLy8gQ2F0Y2ggdW5oYW5kbGVkIGVycm9ycyBpbiBlbGVjdHJvbi1sb2dcbiAgbG9nLmNhdGNoRXJyb3JzKHsgc2hvd0RpYWxvZzogdHJ1ZSB9KTtcblxuICBhd2FpdCBhcHAud2hlblJlYWR5KCk7XG5cbiAgLy8gU2hvdyBzcGxhc2ggd2luZG93LCBpZiBjb25maWd1cmVkXG4gIGNvbnN0IHNwbGFzaFdpbmRvdyA9IGNvbmZpZy5hcHAud2luZG93c1tjb25maWcuYXBwLnNwbGFzaFdpbmRvd0lEXTtcbiAgaWYgKHNwbGFzaFdpbmRvdykge1xuICAgIF9vcGVuV2luZG93KGNvbmZpZy5hcHAuc3BsYXNoV2luZG93SUQpO1xuICB9XG5cbiAgY29uc3QgaXNNYWNPUyA9IHByb2Nlc3MucGxhdGZvcm0gPT09ICdkYXJ3aW4nO1xuICBjb25zdCBpc0RldmVsb3BtZW50ID0gcHJvY2Vzcy5lbnYuTk9ERV9FTlYgIT09ICdwcm9kdWN0aW9uJyB8fCBjb25maWcuYXBwLmZvcmNlRGV2ZWxvcG1lbnRNb2RlO1xuXG4gIGNvbnN0IHNldHRpbmdzID0gbmV3IFNldHRpbmdNYW5hZ2VyKGNvbmZpZy5hcHBEYXRhUGF0aCwgY29uZmlnLnNldHRpbmdzRmlsZU5hbWUpO1xuICBzZXR0aW5ncy5zZXRVcElQQygpO1xuXG5cbiAgLy8gUHJlcGFyZSBkYXRhYmFzZSBiYWNrZW5kcyAmIHJlcXVlc3QgY29uZmlndXJhdGlvbiBpZiBuZWVkZWRcblxuICBsb2cuZGVidWcoXCJDL2luaXRNYWluOiBEQjogUmVhZGluZyBiYWNrZW5kIGNvbmZpZ1wiLCBjb25maWcuZGF0YWJhc2VzKTtcblxuICB0eXBlIEJhY2tlbmRJbmZvID0ge1xuICAgIGRiTmFtZTogc3RyaW5nXG4gICAgYmFja2VuZENsYXNzOiBEYXRhYmFzZUJhY2tlbmRDbGFzczxhbnksIGFueSwgYW55PlxuICAgIGJhY2tlbmRPcHRpb25zOiBhbnlcbiAgfTtcbiAgbGV0IGRiQmFja2VuZENsYXNzZXM6IEJhY2tlbmRJbmZvW107XG4gIGRiQmFja2VuZENsYXNzZXMgPSAoYXdhaXQgUHJvbWlzZS5hbGwoT2JqZWN0LmVudHJpZXMoY29uZmlnLmRhdGFiYXNlcykubWFwKFxuICAgIGFzeW5jIChbZGJOYW1lLCBkYkNvbmZdKSA9PiB7XG4gICAgICBsb2cuZGVidWcoXCJDL2luaXRNYWluOiBEQjogUmVhZGluZyBiYWNrZW5kIGNvbmZpZ1wiLCBkYk5hbWUsIGRiQ29uZik7XG5cbiAgICAgIGNvbnN0IERCQmFja2VuZENsYXNzID0gZGJDb25mLmJhY2tlbmQ7XG4gICAgICBpZiAoREJCYWNrZW5kQ2xhc3MucmVnaXN0ZXJTZXR0aW5nc0ZvckNvbmZpZ3VyYWJsZU9wdGlvbnMpIHtcbiAgICAgICAgREJCYWNrZW5kQ2xhc3MucmVnaXN0ZXJTZXR0aW5nc0ZvckNvbmZpZ3VyYWJsZU9wdGlvbnMoc2V0dGluZ3MsIGRiQ29uZi5vcHRpb25zLCBkYk5hbWUpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgZGJOYW1lOiBkYk5hbWUsXG4gICAgICAgIGJhY2tlbmRDbGFzczogREJCYWNrZW5kQ2xhc3MsXG4gICAgICAgIGJhY2tlbmRPcHRpb25zOiBkYkNvbmYub3B0aW9ucyxcbiAgICAgIH07XG4gICAgfVxuICApKSk7XG5cblxuICAvLyBSZXF1ZXN0IHNldHRpbmdzIGZyb20gdXNlciB2aWEgYW4gaW5pdGlhbCBjb25maWd1cmF0aW9uIHdpbmRvdywgaWYgcmVxdWlyZWRcblxuICBjb25zdCBtaXNzaW5nU2V0dGluZ3MgPSBhd2FpdCBzZXR0aW5ncy5saXN0TWlzc2luZ1JlcXVpcmVkU2V0dGluZ3MoKTtcbiAgLy8gTGlzdCBvZiBJRHMgb2Ygc2V0dGluZ3MgdGhhdCBuZWVkIHRvIGJlIGZpbGxlZCBvdXQuXG5cbiAgaWYgKG1pc3NpbmdTZXR0aW5ncy5sZW5ndGggPiAwKSB7XG4gICAgbG9nLnZlcmJvc2UoXCJDL2luaXRNYWluOiBNaXNzaW5nIHNldHRpbmdzIHByZXNlbnQsIHJlcXVlc3RpbmcgZnJvbSB0aGUgdXNlclwiLCBtaXNzaW5nU2V0dGluZ3MpO1xuICAgIGF3YWl0IF9yZXF1ZXN0U2V0dGluZ3MobWlzc2luZ1NldHRpbmdzKTtcbiAgfSBlbHNlIHtcbiAgICBsb2cuZGVidWcoXCJDL2luaXRNYWluOiBObyBtaXNzaW5nIHNldHRpbmdzIGZvdW5kXCIpO1xuICB9XG5cblxuICAvLyBDb25zdHJ1Y3QgZGF0YWJhc2UgYmFja2VuZCBpbnN0YW5jZXNcblxuICB0eXBlIERCcyA9IE1haW5BcHA8YW55LCBDPltcImRhdGFiYXNlc1wiXTtcbiAgbGV0IGRhdGFiYXNlczogREJzXG5cbiAgdHJ5IHtcbiAgICBkYXRhYmFzZXMgPSAoYXdhaXQgUHJvbWlzZS5hbGwoZGJCYWNrZW5kQ2xhc3Nlcy5tYXAoXG4gICAgICBhc3luYyAoeyBkYk5hbWUsIGJhY2tlbmRDbGFzcywgYmFja2VuZE9wdGlvbnMgfSkgPT4ge1xuICAgICAgICBjb25zdCBEQkJhY2tlbmRDbGFzcyA9IGJhY2tlbmRDbGFzcztcblxuICAgICAgICBsb2cudmVyYm9zZShcIkMvaW5pdE1haW46IERCOiBDb21wbGV0aW5nIGJhY2tlbmQgb3B0aW9ucyBmcm9tXCIsIGJhY2tlbmRPcHRpb25zKTtcblxuICAgICAgICBsZXQgb3B0aW9uczogYW55O1xuICAgICAgICBpZiAoREJCYWNrZW5kQ2xhc3MuY29tcGxldGVPcHRpb25zRnJvbVNldHRpbmdzKSB7XG4gICAgICAgICAgb3B0aW9ucyA9IGF3YWl0IERCQmFja2VuZENsYXNzLmNvbXBsZXRlT3B0aW9uc0Zyb21TZXR0aW5ncyhcbiAgICAgICAgICAgIHNldHRpbmdzLFxuICAgICAgICAgICAgYmFja2VuZE9wdGlvbnMsXG4gICAgICAgICAgICBkYk5hbWUpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIG9wdGlvbnMgPSBiYWNrZW5kT3B0aW9ucztcbiAgICAgICAgfVxuXG4gICAgICAgIGxvZy52ZXJib3NlKFwiQy9pbml0TWFpbjogREI6IEluaXRpYWxpemluZyBiYWNrZW5kIHdpdGggb3B0aW9uc1wiLCBiYWNrZW5kT3B0aW9ucyk7XG5cbiAgICAgICAgY29uc3QgYmFja2VuZCA9IG5ldyBEQkJhY2tlbmRDbGFzcyhcbiAgICAgICAgICAgb3B0aW9ucyxcbiAgICAgICAgICAgYXN5bmMgKHBheWxvYWQ6IGFueSkgPT4gYXdhaXQgcmVwb3J0QmFja2VuZFN0YXR1c1RvQWxsV2luZG93cyhkYk5hbWUsIHBheWxvYWQpKTtcblxuICAgICAgICBpZiAoYmFja2VuZC5zZXRVcElQQykge1xuICAgICAgICAgIGJhY2tlbmQuc2V0VXBJUEMoZGJOYW1lKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IFtkYk5hbWVdOiBiYWNrZW5kIH07XG4gICAgICB9XG4gICAgKSkpLnJlZHVjZSgodmFsLCBhY2MpID0+ICh7IC4uLmFjYywgLi4udmFsIH0pLCB7fSBhcyBQYXJ0aWFsPERCcz4pIGFzIERCcztcbiAgfSBjYXRjaCAoZSkge1xuICAgIGxvZy5lcnJvcihcIkMvaW5pdE1haW46IEZhaWxlZCB0byBpbml0aWFsaXplIGRhdGFiYXNlIGJhY2tlbmRzXCIpO1xuICAgIHRocm93IGU7XG4gIH1cblxuXG4gIC8vIEluaXRpYWxpemUgbW9kZWwgbWFuYWdlcnNcblxuICBsb2cuZGVidWcoXCJDL2luaXRNYWluOiBJbml0aWFsaXppbmcgZGF0YSBtb2RlbCBtYW5hZ2Vyc1wiLCBjb25maWcubWFuYWdlcnMpXG5cbiAgdHlwZSBNYW5hZ2VycyA9IE1haW5BcHA8YW55LCBDPltcIm1hbmFnZXJzXCJdO1xuICBsZXQgbWFuYWdlcnM6IE1hbmFnZXJzO1xuXG4gIG1hbmFnZXJzID0gKGF3YWl0IFByb21pc2UuYWxsKE9iamVjdC5lbnRyaWVzKGNvbmZpZy5tYW5hZ2VycykubWFwKFxuICAgIGFzeW5jIChbbW9kZWxOYW1lLCBtYW5hZ2VyQ29uZl0pID0+IHtcbiAgICAgIGNvbnN0IG1vZGVsSW5mbyA9IGNvbmZpZy5hcHAuZGF0YVttb2RlbE5hbWVdO1xuXG4gICAgICBsb2cudmVyYm9zZShcIkMvaW5pdE1haW46IEluaXRpYWxpemluZyBtb2RlbCBtYW5hZ2VyIGZvciBEQlwiLCBtYW5hZ2VyQ29uZi5kYk5hbWUsIGRhdGFiYXNlcyk7XG5cbiAgICAgIGNvbnN0IGRiID0gZGF0YWJhc2VzW21hbmFnZXJDb25mLmRiTmFtZV07XG4gICAgICBjb25zdCBNYW5hZ2VyQ2xhc3MgPSBtYW5hZ2VyQ29uZi5vcHRpb25zLmNscztcbiAgICAgIGNvbnN0IG1hbmFnZXIgPSBuZXcgTWFuYWdlckNsYXNzKFxuICAgICAgICBkYiwgbWFuYWdlckNvbmYub3B0aW9ucywgbW9kZWxJbmZvLFxuICAgICAgICBhc3luYyAoY2hhbmdlZElEcz86IGFueVtdKSA9PiBhd2FpdCByZXBvcnRNb2RpZmllZERhdGFUb0FsbFdpbmRvd3MobW9kZWxOYW1lLCBjaGFuZ2VkSURzPy5tYXAoaWQgPT4gYCR7aWR9YCkpKTtcblxuICAgICAgaWYgKG1hbmFnZXIuc2V0VXBJUEMpIHtcbiAgICAgICAgbWFuYWdlci5zZXRVcElQQyhtb2RlbE5hbWUpO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4geyBbbW9kZWxOYW1lXTogbWFuYWdlciB9O1xuICAgIH1cbiAgKSkpXG4gIC5yZWR1Y2UoKHZhbCwgYWNjKSA9PiAoeyAuLi5hY2MsIC4uLnZhbCB9KSwge30gYXMgUGFydGlhbDxNYW5hZ2Vycz4pIGFzIE1hbmFnZXJzO1xuXG5cbiAgbGlzdGVuPHt9LCB7IGRhdGFiYXNlczogKGtleW9mIE1haW5BcHA8YW55LCBDPltcImRhdGFiYXNlc1wiXSlbXSB9PlxuICAoJ2xpc3QtZGF0YWJhc2VzJywgYXN5bmMgKCkgPT4ge1xuICAgIHJldHVybiB7XG4gICAgICBkYXRhYmFzZXM6IE9iamVjdC5rZXlzKGRhdGFiYXNlcyksXG4gICAgfTtcbiAgfSk7XG5cblxuICBsaXN0ZW48eyBpZDoga2V5b2YgdHlwZW9mIGNvbmZpZy5hcHAud2luZG93cywgcGFyYW1zPzogT21pdDxXaW5kb3dPcGVuZXJQYXJhbXMsICdjb21wb25lbnQnPiB9LCB7fT5cbiAgKCdvcGVuLXByZWRlZmluZWQtd2luZG93JywgYXN5bmMgKHsgaWQsIHBhcmFtcyB9KSA9PiB7XG4gICAgY29uc3QgcGFyYW1zV2l0aERlZmF1bHRzID0geyAuLi5jb25maWcuYXBwLndpbmRvd3NbaWRdLm9wZW5lclBhcmFtcywgLi4ucGFyYW1zIHx8IHt9LCBjb21wb25lbnQ6IGlkLCBjb25maWc6IGNvbmZpZy5hcHAgfTtcbiAgICBvcGVuV2luZG93KHBhcmFtc1dpdGhEZWZhdWx0cyk7XG4gICAgcmV0dXJuIHt9O1xuICB9KTtcblxuXG4gIGxpc3RlbjxXaW5kb3dPcGVuZXJQYXJhbXMsIHt9PlxuICAoJ29wZW4tYXJiaXRyYXJ5LXdpbmRvdycsIGFzeW5jIChwYXJhbXMpID0+IHtcbiAgICBvcGVuV2luZG93KHBhcmFtcyk7XG4gICAgcmV0dXJuIHt9O1xuICB9KTtcblxuXG4gIC8vIEluaXRpYWxpemUgd2luZG93LW9wZW5pbmcgZW5kcG9pbnRzXG4gIGZvciAoY29uc3QgW3dpbmRvd05hbWUsIHdpbmRvd10gb2YgT2JqZWN0LmVudHJpZXMoY29uZmlnLmFwcC53aW5kb3dzKSkge1xuICAgIG1ha2VXaW5kb3dFbmRwb2ludCh3aW5kb3dOYW1lLCAoKSA9PiAoe1xuICAgICAgLi4uKHdpbmRvdyBhcyBXaW5kb3cpLm9wZW5lclBhcmFtcyxcbiAgICAgIGNvbXBvbmVudDogd2luZG93TmFtZSxcbiAgICAgIGNvbmZpZzogY29uZmlnLmFwcCxcbiAgICB9KSk7XG4gIH1cblxuXG4gIC8vIE9wZW4gbWFpbiB3aW5kb3dcbiAgYXdhaXQgX29wZW5XaW5kb3coJ2RlZmF1bHQnKTtcblxuICBpZiAoc3BsYXNoV2luZG93KSB7XG4gICAgX2Nsb3NlV2luZG93KGNvbmZpZy5hcHAuc3BsYXNoV2luZG93SUQpO1xuICB9XG5cbiAgLy8gREIgYmFja2VuZCBpbml0aWFsaXphdGlvbiBoYXBwZW5zIGFmdGVyIHRoZSBhcHAgaXMgcmVhZHksXG4gIC8vIHNpbmNlIGl0IG1heSByZXF1aXJlIHVzZXIgaW5wdXQgKGFuZCBoZW5jZSBHVUkgaW50ZXJhY3Rpb24pXG4gIC8vIG9mIHNlbnNpdGl2ZSBkYXRhIG5vdCBzdWl0YWJsZSBmb3Igc2V0dGluZ3MsXG4gIC8vIG5hbWVseSBhdXRoZW50aWNhdGlvbiBrZXlzIGlmIGRhdGEgc291cmNlIHJlcXVpcmVzIGF1dGguXG4gIC8vIFRPRE86IFRlYWNoaW5nIHRoZSBmcmFtZXdvcmsgdG8gZW5jcnlwdCBzZXR0aW5nc1xuICAvLyBtaWdodCBsZXQgdXMgbWFrZSBhdXRoZW50aWNhdGlvbiBkYXRhIGVudHJ5XG4gIC8vIHBhcnQgb2YgcmVxdWlyZWQgc2V0dGluZ3MgZW50cnlcbiAgLy8gYW5kIHN0YXJ0IGRhdGEgc291cmNlIGluaXRpYWxpemF0aW9uIGVhcmx5LlxuICBmb3IgKGNvbnN0IFtiYWNrZW5kSUQsIGJhY2tlbmRdIG9mIE9iamVjdC5lbnRyaWVzKGRhdGFiYXNlcykpIHtcbiAgICBsb2cuZGVidWcoXCJDL2luaXRNYWluOiBJbml0aWFsaXppbmcgREIgYmFja2VuZFwiLCBiYWNrZW5kSUQpO1xuICAgIGF3YWl0IGJhY2tlbmQuaW5pdCgpO1xuICB9XG5cbiAgZm9yIChjb25zdCBbbWFuYWdlcklELCBtYW5hZ2VyXSBvZiBPYmplY3QuZW50cmllcyhtYW5hZ2VycykpIHtcbiAgICBsb2cuZGVidWcoXCJDL2luaXRNYWluOiBJbml0aWFsaXppbmcgbWFuYWdlclwiLCBtYW5hZ2VySUQpO1xuICAgIGF3YWl0IG1hbmFnZXIuaW5pdCgpO1xuICB9XG5cbiAgY29uc3QgaW5pdGlhbGl6ZWRNYWluOiBNYWluQXBwPHR5cGVvZiBjb25maWcuYXBwLCB0eXBlb2YgY29uZmlnPiA9IHtcbiAgICBhcHAsXG4gICAgaXNNYWNPUyxcbiAgICBpc0RldmVsb3BtZW50LFxuICAgIG1hbmFnZXJzLFxuICAgIGRhdGFiYXNlcyxcbiAgICBzZXR0aW5ncyxcbiAgICBvcGVuV2luZG93OiBfb3BlbldpbmRvdyxcbiAgfTtcblxuICByZXR1cm4gaW5pdGlhbGl6ZWRNYWluO1xufTtcblxuXG5jb25zdCByZXBvcnRCYWNrZW5kU3RhdHVzVG9BbGxXaW5kb3dzID0gYXN5bmMgKGRiTmFtZTogc3RyaW5nLCBwYXlsb2FkOiBvYmplY3QpID0+IHtcbiAgcmV0dXJuIGF3YWl0IG5vdGlmeUFsbFdpbmRvd3MoYGRiLSR7ZGJOYW1lfS1zdGF0dXNgLCBwYXlsb2FkKTtcbn07XG5cblxuY29uc3QgcmVwb3J0TW9kaWZpZWREYXRhVG9BbGxXaW5kb3dzID0gYXN5bmMgKG1vZGVsTmFtZTogc3RyaW5nLCBjaGFuZ2VkSURzPzogc3RyaW5nW10pID0+IHtcbiAgLy8gVE9ETzogSWYgdG9vIG1hbnkgdXBkYXRlIGNhbGxzIHdpdGggb25lIElEIGFmZmVjdCBwZXJmb3JtYW5jZSxcbiAgLy8gZGVib3VuY2UgdGhpcyBmdW5jdGlvbiwgY29tYmluaW5nIHNob3J0ZXIgSUQgbGlzdHMgYW5kIHJlcG9ydGluZyBtb3JlIG9mIHRoZW0gYXQgb25jZVxuICAvL2xvZy5kZWJ1ZyhcIkMvbWFpbjogUmVwb3J0aW5nIG1vZGlmaWVkIGRhdGFcIiwgbW9kZWxOYW1lLCBjaGFuZ2VkSURzKTtcbiAgcmV0dXJuIGF3YWl0IG5vdGlmeUFsbFdpbmRvd3MoYG1vZGVsLSR7bW9kZWxOYW1lfS1vYmplY3RzLWNoYW5nZWRgLCB7IGlkczogY2hhbmdlZElEcyB9KTtcbn07XG4iXX0=