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
    log.debug("C/main: Reporting modified data", modelName, changedIDs);
    return await notifyAllWindows(`model-${modelName}-objects-changed`, { ids: changedIDs });
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9hcHAvbWFpbi50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSwrREFBK0Q7QUFDL0QsT0FBTyxLQUFLLE1BQU0sWUFBWSxDQUFDO0FBQzlCLE1BQWMsQ0FBQyxLQUFLLEdBQUcsS0FBSyxDQUFDO0FBRTlCLE9BQU8sRUFBRSxHQUFHLEVBQU8sTUFBTSxVQUFVLENBQUM7QUFDcEMsT0FBTyxLQUFLLEdBQUcsTUFBTSxjQUFjLENBQUM7QUFLcEMsT0FBTyxFQUFFLGNBQWMsRUFBRSxNQUFNLGtCQUFrQixDQUFDO0FBQ2xELE9BQU8sRUFBRSxnQkFBZ0IsRUFBc0IsTUFBTSxnQkFBZ0IsQ0FBQztBQUN0RSxPQUFPLEVBQUUsTUFBTSxFQUFFLE1BQU0sYUFBYSxDQUFDO0FBT3JDLE9BQU8sRUFBRSxrQkFBa0IsRUFBRSxNQUFNLGFBQWEsQ0FBQztBQUNqRCxPQUFPLEVBQUUsVUFBVSxFQUFFLFdBQVcsRUFBRSxNQUFNLGdCQUFnQixDQUFDO0FBZ0J6RCxNQUFNLENBQUMsTUFBTSxRQUFRLEdBQUcsS0FBSyxFQUE2QixNQUFTLEVBQTRCLEVBQUU7SUFFL0Ysd0RBQXdEO0lBQ3hELEdBQUcsQ0FBQyxFQUFFLENBQUMsbUJBQW1CLEVBQUUsQ0FBQyxDQUFNLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxjQUFjLEVBQUUsQ0FBQyxDQUFDO0lBRTVELEdBQUcsQ0FBQyxXQUFXLENBQUMsRUFBRSxVQUFVLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQztJQUV0QyxJQUFJLE1BQU0sQ0FBQyxHQUFHLENBQUMsY0FBYyxFQUFFO1FBQzdCLGdGQUFnRjtRQUNoRixrQ0FBa0M7UUFDbEMsSUFBSSxDQUFDLEdBQUcsQ0FBQyx5QkFBeUIsRUFBRSxFQUFFO1lBQ3BDLEdBQUcsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7U0FDYjtLQUNGO0lBR0Qsc0JBQXNCO0lBRXRCLFNBQVMsV0FB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ZUFBZSxDQUFDO0FBQ3pCLENBQUMsQ0FBQztBQUdGLE1BQU0sK0JBQStCLEdBQUcsS0FBSyxFQUFFLE1BQWMsRUFBRSxPQUFlLEVBQUUsRUFBRTtJQUNoRixPQUFPLE1BQU0sZ0JBQWdCLENBQUMsTUFBTSxNQUFNLFNBQVMsRUFBRSxPQUFPLENBQUMsQ0FBQztBQUNoRSxDQUFDLENBQUM7QUFHRixNQUFNLDhCQUE4QixHQUFHLEtBQUssRUFBRSxTQUFpQixFQUFFLFVBQXFCLEVBQUUsRUFBRTtJQUN4RixpRUFBaUU7SUFDakUsd0ZBQXdGO0lBQ3hGLEdBQUcsQ0FBQyxLQUFLLENBQUMsaUNBQWlDLEVBQUUsU0FBUyxFQUFFLFVBQVUsQ0FBQyxDQUFDO0lBQ3BFLE9BQU8sTUFBTSxnQkFBZ0IsQ0FBQyxTQUFTLFNBQVMsa0JBQWtCLEVBQUUsRUFBRSxHQUFHLEVBQUUsVUFBVSxFQUFFLENBQUMsQ0FBQztBQUMzRixDQUFDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvLyBKdXJ5LXJpZyBnbG9iYWwuZmV0Y2ggdG8gbWFrZSBJc29tb3JwaGljIEdpdCB3b3JrIHVuZGVyIE5vZGVcbmltcG9ydCBmZXRjaCBmcm9tICdub2RlLWZldGNoJztcbihnbG9iYWwgYXMgYW55KS5mZXRjaCA9IGZldGNoO1xuXG5pbXBvcnQgeyBhcHAsIEFwcCB9IGZyb20gJ2VsZWN0cm9uJztcbmltcG9ydCAqIGFzIGxvZyBmcm9tICdlbGVjdHJvbi1sb2cnO1xuXG5pbXBvcnQgeyBBcHBDb25maWcsIFdpbmRvdyB9IGZyb20gJy4uL2NvbmZpZy9hcHAnO1xuXG5pbXBvcnQgeyBNYWluQ29uZmlnIH0gZnJvbSAnLi4vY29uZmlnL21haW4nO1xuaW1wb3J0IHsgU2V0dGluZ01hbmFnZXIgfSBmcm9tICcuLi9zZXR0aW5ncy9tYWluJztcbmltcG9ydCB7IG5vdGlmeUFsbFdpbmRvd3MsIFdpbmRvd09wZW5lclBhcmFtcyB9IGZyb20gJy4uL21haW4vd2luZG93JztcbmltcG9ydCB7IGxpc3RlbiB9IGZyb20gJy4uL2lwYy9tYWluJztcbmltcG9ydCB7XG4gIEJhY2tlbmQsXG4gIE1vZGVsTWFuYWdlcixcbiAgQmFja2VuZENsYXNzIGFzIERhdGFiYXNlQmFja2VuZENsYXNzLFxufSBmcm9tICcuLi9kYi9tYWluL2Jhc2UnO1xuXG5pbXBvcnQgeyBtYWtlV2luZG93RW5kcG9pbnQgfSBmcm9tICcuLi9pcGMvbWFpbic7XG5pbXBvcnQgeyBvcGVuV2luZG93LCBjbG9zZVdpbmRvdyB9IGZyb20gJy4uL21haW4vd2luZG93JztcblxuXG5leHBvcnQgaW50ZXJmYWNlIE1haW5BcHA8QSBleHRlbmRzIEFwcENvbmZpZywgTSBleHRlbmRzIE1haW5Db25maWc8QT4+IHtcbiAgLyogT2JqZWN0IHJldHVybmVkIGJ5IGluaXRNYWluLiAqL1xuXG4gIGFwcDogQXBwXG4gIGlzTWFjT1M6IGJvb2xlYW5cbiAgaXNEZXZlbG9wbWVudDogYm9vbGVhblxuICBtYW5hZ2VyczogUmVjb3JkPGtleW9mIEFbXCJkYXRhXCJdLCBNb2RlbE1hbmFnZXI8YW55LCBhbnk+PlxuICBkYXRhYmFzZXM6IFJlY29yZDxrZXlvZiBNW1wiZGF0YWJhc2VzXCJdLCBCYWNrZW5kPlxuICBvcGVuV2luZG93OiAod2luZG93TmFtZToga2V5b2YgQVtcIndpbmRvd3NcIl0pID0+IHZvaWRcbiAgc2V0dGluZ3M6IFNldHRpbmdNYW5hZ2VyXG59XG5cblxuZXhwb3J0IGNvbnN0IGluaXRNYWluID0gYXN5bmMgPEMgZXh0ZW5kcyBNYWluQ29uZmlnPGFueT4+KGNvbmZpZzogQyk6IFByb21pc2U8TWFpbkFwcDxhbnksIEM+PiA9PiB7XG5cbiAgLy8gUHJldmVudCB3aW5kb3dzIGZyb20gY2xvc2luZyB3aGlsZSBhcHAgaXMgaW5pdGlhbGl6ZWRcbiAgYXBwLm9uKCd3aW5kb3ctYWxsLWNsb3NlZCcsIChlOiBhbnkpID0+IGUucHJldmVudERlZmF1bHQoKSk7XG5cbiAgbG9nLmNhdGNoRXJyb3JzKHsgc2hvd0RpYWxvZzogdHJ1ZSB9KTtcblxuICBpZiAoY29uZmlnLmFwcC5zaW5nbGVJbnN0YW5jZSkge1xuICAgIC8vIEVuc3VyZSBvbmx5IG9uZSBpbnN0YW5jZSBvZiB0aGUgYXBwIGNhbiBydW4gYXQgYSB0aW1lIG9uIGdpdmVuIHVzZXLigJlzIG1hY2hpbmVcbiAgICAvLyBieSBleGl0aW5nIGFueSBmdXR1cmUgaW5zdGFuY2VzXG4gICAgaWYgKCFhcHAucmVxdWVzdFNpbmdsZUluc3RhbmNlTG9jaygpKSB7XG4gICAgICBhcHAuZXhpdCgwKTtcbiAgICB9XG4gIH1cblxuXG4gIC8qIEhlbHBlciBmdW5jdGlvbnMgKi9cblxuICBmdW5jdGlvbiBfb3BlbldpbmRvdyh3aW5kb3dOYW1lOiBrZXlvZiB0eXBlb2YgY29uZmlnLmFwcC53aW5kb3dzLCBleHRyYUNvbXBvbmVudFBhcmFtczogc3RyaW5nID0gJycpIHtcbiAgICBsb2cudmVyYm9zZShcIkMvbWFpbjogT3BlbmluZyB3aW5kb3dcIiwgd2luZG93TmFtZSk7XG5cbiAgICBjb25zdCBkZWZhdWx0UGFyYW1zID0gY29uZmlnLmFwcC53aW5kb3dzW3dpbmRvd05hbWVdLm9wZW5lclBhcmFtcztcblxuICAgIGNvbnN0IG9wZW5lclBhcmFtcyA9IHtcbiAgICAgIC4uLmRlZmF1bHRQYXJhbXMsXG4gICAgICBjb21wb25lbnRQYXJhbXM6IGAke2RlZmF1bHRQYXJhbXMuY29tcG9uZW50UGFyYW1zfSYke2V4dHJhQ29tcG9uZW50UGFyYW1zfWAsXG4gICAgfTtcblxuICAgIHJldHVybiBvcGVuV2luZG93KHtcbiAgICAgIC4uLm9wZW5lclBhcmFtcyxcbiAgICAgIGNvbXBvbmVudDogd2luZG93TmFtZSxcbiAgICAgIGNvbmZpZzogY29uZmlnLmFwcCxcbiAgICB9KTtcbiAgfVxuXG4gIGZ1bmN0aW9uIF9jbG9zZVdpbmRvdyh3aW5kb3dOYW1lOiBrZXlvZiB0eXBlb2YgY29uZmlnLmFwcC53aW5kb3dzKSB7XG4gICAgbG9nLnZlcmJvc2UoYEMvbWFpbjogQ2xvc2luZyB3aW5kb3cgJHtTdHJpbmcod2luZG93TmFtZSl9YCk7XG5cbiAgICBjbG9zZVdpbmRvdyhjb25maWcuYXBwLndpbmRvd3Nbd2luZG93TmFtZV0ub3BlbmVyUGFyYW1zLnRpdGxlKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIF9yZXF1ZXN0U2V0dGluZ3Moc2V0dGluZ0lEczogc3RyaW5nW10pOiBQcm9taXNlPHZvaWQ+IHtcbiAgICAvKiBPcGVuIHNldHRpbmdzIHdpbmRvdywgcHJvbXB0aW5nIHRoZSB1c2VyXG4gICAgICAgdG8gZmlsbCBpbiBwYXJhbWV0ZXJzIHJlcXVpcmVkIGZvciBhcHBsaWNhdGlvblxuICAgICAgIHRvIHBlcmZvcm0gYSBmdW5jdGlvbi5cbiAgICAgICBUaGUgd2luZG93IGlzIGV4cGVjdGVkIHRvIHVzZSBjb21taXRTZXR0aW5nIElQQyBjYWxscyxcbiAgICAgICB3aGljaCBpcyBob3cgZGVmYXVsdCBzZXR0aW5ncyB3aWRnZXRzIHdvcmsuICovXG5cbiAgICBjb25zdCBzZXR0aW5nc1dpbmRvdyA9IGNvbmZpZy5hcHAud2luZG93c1tjb25maWcuYXBwLnNldHRpbmdzV2luZG93SURdO1xuICAgIGlmIChzZXR0aW5nc1dpbmRvdykge1xuICAgICAgcmV0dXJuIG5ldyBQcm9taXNlPHZvaWQ+KGFzeW5jIChyZXNvbHZlLCByZWplY3QpID0+IHtcblxuICAgICAgICBjb25zdCBvcGVuZWRXaW5kb3cgPSBhd2FpdCBfb3BlbldpbmRvdyhcbiAgICAgICAgICBjb25maWcuYXBwLnNldHRpbmdzV2luZG93SUQsXG4gICAgICAgICAgYHJlcXVpcmVkU2V0dGluZ3M9JHtzZXR0aW5nSURzLmpvaW4oJywnKX1gKTtcblxuICAgICAgICBvcGVuZWRXaW5kb3cub24oJ2Nsb3NlZCcsICgpID0+IHtcbiAgICAgICAgICBjb25zdCBtaXNzaW5nUmVxdWlyZWRTZXR0aW5ncyA9IHNldHRpbmdJRHMuXG4gICAgICAgICAgICBtYXAoKHNldHRpbmdJRCkgPT4gIHNldHRpbmdzLmdldFZhbHVlKHNldHRpbmdJRCkpLlxuICAgICAgICAgICAgZmlsdGVyKChzZXR0aW5nVmFsKSA9PiBzZXR0aW5nVmFsID09PSB1bmRlZmluZWQpO1xuICAgICAgICAgIGlmIChtaXNzaW5nUmVxdWlyZWRTZXR0aW5ncy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBsb2cud2FybihcbiAgICAgICAgICAgICAgXCJDL21haW46IFVzZXIgY2xvc2VkIHNldHRpbmdzIHdpbmRvdyB3aXRoIG1pc3Npbmcgc2V0dGluZ3MgbGVmdFwiLFxuICAgICAgICAgICAgICBtaXNzaW5nUmVxdWlyZWRTZXR0aW5ncylcbiAgICAgICAgICAgIHJlamVjdCgpO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBsb2cudmVyYm9zZShcIkMvbWFpbjogVXNlciBwcm92aWRlciBhbGwgbWlzc2luZyBzZXR0aW5nc1wiKVxuICAgICAgICAgICAgcmVzb2x2ZSgpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSlcblxuICAgICAgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIlNldHRpbmdzIHdlcmUgcmVxdWVzdGVkLCBidXQgc2V0dGluZ3Mgd2luZG93IGlzIG5vdCBzcGVjaWZpZWRcIik7XG4gICAgfVxuICB9XG5cbiAgLy8gVE9ETzogVGhpcyB3b3JrYXJvdW5kIG1heSBvciBtYXkgbm90IGJlIG5lY2Vzc2FyeVxuICBpZiAoY29uZmlnLmRpc2FibGVHUFUpIHtcbiAgICBhcHAuZGlzYWJsZUhhcmR3YXJlQWNjZWxlcmF0aW9uKCk7XG4gIH1cblxuICAvLyBDYXRjaCB1bmhhbmRsZWQgZXJyb3JzIGluIGVsZWN0cm9uLWxvZ1xuICBsb2cuY2F0Y2hFcnJvcnMoeyBzaG93RGlhbG9nOiB0cnVlIH0pO1xuXG4gIGF3YWl0IGFwcC53aGVuUmVhZHkoKTtcblxuICAvLyBTaG93IHNwbGFzaCB3aW5kb3csIGlmIGNvbmZpZ3VyZWRcbiAgY29uc3Qgc3BsYXNoV2luZG93ID0gY29uZmlnLmFwcC53aW5kb3dzW2NvbmZpZy5hcHAuc3BsYXNoV2luZG93SURdO1xuICBpZiAoc3BsYXNoV2luZG93KSB7XG4gICAgX29wZW5XaW5kb3coY29uZmlnLmFwcC5zcGxhc2hXaW5kb3dJRCk7XG4gIH1cblxuICBjb25zdCBpc01hY09TID0gcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gJ2Rhcndpbic7XG4gIGNvbnN0IGlzRGV2ZWxvcG1lbnQgPSBwcm9jZXNzLmVudi5OT0RFX0VOViAhPT0gJ3Byb2R1Y3Rpb24nIHx8IGNvbmZpZy5hcHAuZm9yY2VEZXZlbG9wbWVudE1vZGU7XG5cbiAgY29uc3Qgc2V0dGluZ3MgPSBuZXcgU2V0dGluZ01hbmFnZXIoY29uZmlnLmFwcERhdGFQYXRoLCBjb25maWcuc2V0dGluZ3NGaWxlTmFtZSk7XG4gIHNldHRpbmdzLnNldFVwSVBDKCk7XG5cblxuICAvLyBQcmVwYXJlIGRhdGFiYXNlIGJhY2tlbmRzICYgcmVxdWVzdCBjb25maWd1cmF0aW9uIGlmIG5lZWRlZFxuXG4gIGxvZy5kZWJ1ZyhcIkMvaW5pdE1haW46IERCOiBSZWFkaW5nIGJhY2tlbmQgY29uZmlnXCIsIGNvbmZpZy5kYXRhYmFzZXMpO1xuXG4gIHR5cGUgQmFja2VuZEluZm8gPSB7XG4gICAgZGJOYW1lOiBzdHJpbmdcbiAgICBiYWNrZW5kQ2xhc3M6IERhdGFiYXNlQmFja2VuZENsYXNzPGFueSwgYW55LCBhbnk+XG4gICAgYmFja2VuZE9wdGlvbnM6IGFueVxuICB9O1xuICBsZXQgZGJCYWNrZW5kQ2xhc3NlczogQmFja2VuZEluZm9bXTtcbiAgZGJCYWNrZW5kQ2xhc3NlcyA9IChhd2FpdCBQcm9taXNlLmFsbChPYmplY3QuZW50cmllcyhjb25maWcuZGF0YWJhc2VzKS5tYXAoXG4gICAgYXN5bmMgKFtkYk5hbWUsIGRiQ29uZl0pID0+IHtcbiAgICAgIGxvZy5kZWJ1ZyhcIkMvaW5pdE1haW46IERCOiBSZWFkaW5nIGJhY2tlbmQgY29uZmlnXCIsIGRiTmFtZSwgZGJDb25mKTtcblxuICAgICAgY29uc3QgREJCYWNrZW5kQ2xhc3MgPSBkYkNvbmYuYmFja2VuZDtcbiAgICAgIGlmIChEQkJhY2tlbmRDbGFzcy5yZWdpc3RlclNldHRpbmdzRm9yQ29uZmlndXJhYmxlT3B0aW9ucykge1xuICAgICAgICBEQkJhY2tlbmRDbGFzcy5yZWdpc3RlclNldHRpbmdzRm9yQ29uZmlndXJhYmxlT3B0aW9ucyhzZXR0aW5ncywgZGJDb25mLm9wdGlvbnMsIGRiTmFtZSk7XG4gICAgICB9XG4gICAgICByZXR1cm4ge1xuICAgICAgICBkYk5hbWU6IGRiTmFtZSxcbiAgICAgICAgYmFja2VuZENsYXNzOiBEQkJhY2tlbmRDbGFzcyxcbiAgICAgICAgYmFja2VuZE9wdGlvbnM6IGRiQ29uZi5vcHRpb25zLFxuICAgICAgfTtcbiAgICB9XG4gICkpKTtcblxuXG4gIC8vIFJlcXVlc3Qgc2V0dGluZ3MgZnJvbSB1c2VyIHZpYSBhbiBpbml0aWFsIGNvbmZpZ3VyYXRpb24gd2luZG93LCBpZiByZXF1aXJlZFxuXG4gIGNvbnN0IG1pc3NpbmdTZXR0aW5ncyA9IGF3YWl0IHNldHRpbmdzLmxpc3RNaXNzaW5nUmVxdWlyZWRTZXR0aW5ncygpO1xuICAvLyBMaXN0IG9mIElEcyBvZiBzZXR0aW5ncyB0aGF0IG5lZWQgdG8gYmUgZmlsbGVkIG91dC5cblxuICBpZiAobWlzc2luZ1NldHRpbmdzLmxlbmd0aCA+IDApIHtcbiAgICBsb2cudmVyYm9zZShcIkMvaW5pdE1haW46IE1pc3Npbmcgc2V0dGluZ3MgcHJlc2VudCwgcmVxdWVzdGluZyBmcm9tIHRoZSB1c2VyXCIsIG1pc3NpbmdTZXR0aW5ncyk7XG4gICAgYXdhaXQgX3JlcXVlc3RTZXR0aW5ncyhtaXNzaW5nU2V0dGluZ3MpO1xuICB9IGVsc2Uge1xuICAgIGxvZy5kZWJ1ZyhcIkMvaW5pdE1haW46IE5vIG1pc3Npbmcgc2V0dGluZ3MgZm91bmRcIik7XG4gIH1cblxuXG4gIC8vIENvbnN0cnVjdCBkYXRhYmFzZSBiYWNrZW5kIGluc3RhbmNlc1xuXG4gIHR5cGUgREJzID0gTWFpbkFwcDxhbnksIEM+W1wiZGF0YWJhc2VzXCJdO1xuICBsZXQgZGF0YWJhc2VzOiBEQnNcblxuICB0cnkge1xuICAgIGRhdGFiYXNlcyA9IChhd2FpdCBQcm9taXNlLmFsbChkYkJhY2tlbmRDbGFzc2VzLm1hcChcbiAgICAgIGFzeW5jICh7IGRiTmFtZSwgYmFja2VuZENsYXNzLCBiYWNrZW5kT3B0aW9ucyB9KSA9PiB7XG4gICAgICAgIGNvbnN0IERCQmFja2VuZENsYXNzID0gYmFja2VuZENsYXNzO1xuXG4gICAgICAgIGxvZy52ZXJib3NlKFwiQy9pbml0TWFpbjogREI6IENvbXBsZXRpbmcgYmFja2VuZCBvcHRpb25zIGZyb21cIiwgYmFja2VuZE9wdGlvbnMpO1xuXG4gICAgICAgIGxldCBvcHRpb25zOiBhbnk7XG4gICAgICAgIGlmIChEQkJhY2tlbmRDbGFzcy5jb21wbGV0ZU9wdGlvbnNGcm9tU2V0dGluZ3MpIHtcbiAgICAgICAgICBvcHRpb25zID0gYXdhaXQgREJCYWNrZW5kQ2xhc3MuY29tcGxldGVPcHRpb25zRnJvbVNldHRpbmdzKFxuICAgICAgICAgICAgc2V0dGluZ3MsXG4gICAgICAgICAgICBiYWNrZW5kT3B0aW9ucyxcbiAgICAgICAgICAgIGRiTmFtZSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgb3B0aW9ucyA9IGJhY2tlbmRPcHRpb25zO1xuICAgICAgICB9XG5cbiAgICAgICAgbG9nLnZlcmJvc2UoXCJDL2luaXRNYWluOiBEQjogSW5pdGlhbGl6aW5nIGJhY2tlbmQgd2l0aCBvcHRpb25zXCIsIGJhY2tlbmRPcHRpb25zKTtcblxuICAgICAgICBjb25zdCBiYWNrZW5kID0gbmV3IERCQmFja2VuZENsYXNzKFxuICAgICAgICAgICBvcHRpb25zLFxuICAgICAgICAgICBhc3luYyAocGF5bG9hZDogYW55KSA9PiBhd2FpdCByZXBvcnRCYWNrZW5kU3RhdHVzVG9BbGxXaW5kb3dzKGRiTmFtZSwgcGF5bG9hZCkpO1xuXG4gICAgICAgIGlmIChiYWNrZW5kLnNldFVwSVBDKSB7XG4gICAgICAgICAgYmFja2VuZC5zZXRVcElQQyhkYk5hbWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgW2RiTmFtZV06IGJhY2tlbmQgfTtcbiAgICAgIH1cbiAgICApKSkucmVkdWNlKCh2YWwsIGFjYykgPT4gKHsgLi4uYWNjLCAuLi52YWwgfSksIHt9IGFzIFBhcnRpYWw8REJzPikgYXMgREJzO1xuICB9IGNhdGNoIChlKSB7XG4gICAgbG9nLmVycm9yKFwiQy9pbml0TWFpbjogRmFpbGVkIHRvIGluaXRpYWxpemUgZGF0YWJhc2UgYmFja2VuZHNcIik7XG4gICAgdGhyb3cgZTtcbiAgfVxuXG5cbiAgLy8gSW5pdGlhbGl6ZSBtb2RlbCBtYW5hZ2Vyc1xuXG4gIGxvZy5kZWJ1ZyhcIkMvaW5pdE1haW46IEluaXRpYWxpemluZyBkYXRhIG1vZGVsIG1hbmFnZXJzXCIsIGNvbmZpZy5tYW5hZ2VycylcblxuICB0eXBlIE1hbmFnZXJzID0gTWFpbkFwcDxhbnksIEM+W1wibWFuYWdlcnNcIl07XG4gIGxldCBtYW5hZ2VyczogTWFuYWdlcnM7XG5cbiAgbWFuYWdlcnMgPSAoYXdhaXQgUHJvbWlzZS5hbGwoT2JqZWN0LmVudHJpZXMoY29uZmlnLm1hbmFnZXJzKS5tYXAoXG4gICAgYXN5bmMgKFttb2RlbE5hbWUsIG1hbmFnZXJDb25mXSkgPT4ge1xuICAgICAgY29uc3QgbW9kZWxJbmZvID0gY29uZmlnLmFwcC5kYXRhW21vZGVsTmFtZV07XG5cbiAgICAgIGxvZy52ZXJib3NlKFwiQy9pbml0TWFpbjogSW5pdGlhbGl6aW5nIG1vZGVsIG1hbmFnZXIgZm9yIERCXCIsIG1hbmFnZXJDb25mLmRiTmFtZSwgZGF0YWJhc2VzKTtcblxuICAgICAgY29uc3QgZGIgPSBkYXRhYmFzZXNbbWFuYWdlckNvbmYuZGJOYW1lXTtcbiAgICAgIGNvbnN0IE1hbmFnZXJDbGFzcyA9IG1hbmFnZXJDb25mLm9wdGlvbnMuY2xzO1xuICAgICAgY29uc3QgbWFuYWdlciA9IG5ldyBNYW5hZ2VyQ2xhc3MoXG4gICAgICAgIGRiLCBtYW5hZ2VyQ29uZi5vcHRpb25zLCBtb2RlbEluZm8sXG4gICAgICAgIGFzeW5jIChjaGFuZ2VkSURzPzogYW55W10pID0+IGF3YWl0IHJlcG9ydE1vZGlmaWVkRGF0YVRvQWxsV2luZG93cyhtb2RlbE5hbWUsIGNoYW5nZWRJRHM/Lm1hcChpZCA9PiBgJHtpZH1gKSkpO1xuXG4gICAgICBpZiAobWFuYWdlci5zZXRVcElQQykge1xuICAgICAgICBtYW5hZ2VyLnNldFVwSVBDKG1vZGVsTmFtZSk7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiB7IFttb2RlbE5hbWVdOiBtYW5hZ2VyIH07XG4gICAgfVxuICApKSlcbiAgLnJlZHVjZSgodmFsLCBhY2MpID0+ICh7IC4uLmFjYywgLi4udmFsIH0pLCB7fSBhcyBQYXJ0aWFsPE1hbmFnZXJzPikgYXMgTWFuYWdlcnM7XG5cblxuICBsaXN0ZW48e30sIHsgZGF0YWJhc2VzOiAoa2V5b2YgTWFpbkFwcDxhbnksIEM+W1wiZGF0YWJhc2VzXCJdKVtdIH0+XG4gICgnbGlzdC1kYXRhYmFzZXMnLCBhc3luYyAoKSA9PiB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGRhdGFiYXNlczogT2JqZWN0LmtleXMoZGF0YWJhc2VzKSxcbiAgICB9O1xuICB9KTtcblxuXG4gIGxpc3Rlbjx7IGlkOiBrZXlvZiB0eXBlb2YgY29uZmlnLmFwcC53aW5kb3dzLCBwYXJhbXM/OiBPbWl0PFdpbmRvd09wZW5lclBhcmFtcywgJ2NvbXBvbmVudCc+IH0sIHt9PlxuICAoJ29wZW4tcHJlZGVmaW5lZC13aW5kb3cnLCBhc3luYyAoeyBpZCwgcGFyYW1zIH0pID0+IHtcbiAgICBjb25zdCBwYXJhbXNXaXRoRGVmYXVsdHMgPSB7IC4uLmNvbmZpZy5hcHAud2luZG93c1tpZF0ub3BlbmVyUGFyYW1zLCAuLi5wYXJhbXMgfHwge30sIGNvbXBvbmVudDogaWQsIGNvbmZpZzogY29uZmlnLmFwcCB9O1xuICAgIG9wZW5XaW5kb3cocGFyYW1zV2l0aERlZmF1bHRzKTtcbiAgICByZXR1cm4ge307XG4gIH0pO1xuXG5cbiAgbGlzdGVuPFdpbmRvd09wZW5lclBhcmFtcywge30+XG4gICgnb3Blbi1hcmJpdHJhcnktd2luZG93JywgYXN5bmMgKHBhcmFtcykgPT4ge1xuICAgIG9wZW5XaW5kb3cocGFyYW1zKTtcbiAgICByZXR1cm4ge307XG4gIH0pO1xuXG5cbiAgLy8gSW5pdGlhbGl6ZSB3aW5kb3ctb3BlbmluZyBlbmRwb2ludHNcbiAgZm9yIChjb25zdCBbd2luZG93TmFtZSwgd2luZG93XSBvZiBPYmplY3QuZW50cmllcyhjb25maWcuYXBwLndpbmRvd3MpKSB7XG4gICAgbWFrZVdpbmRvd0VuZHBvaW50KHdpbmRvd05hbWUsICgpID0+ICh7XG4gICAgICAuLi4od2luZG93IGFzIFdpbmRvdykub3BlbmVyUGFyYW1zLFxuICAgICAgY29tcG9uZW50OiB3aW5kb3dOYW1lLFxuICAgICAgY29uZmlnOiBjb25maWcuYXBwLFxuICAgIH0pKTtcbiAgfVxuXG5cbiAgLy8gT3BlbiBtYWluIHdpbmRvd1xuICBhd2FpdCBfb3BlbldpbmRvdygnZGVmYXVsdCcpO1xuXG4gIGlmIChzcGxhc2hXaW5kb3cpIHtcbiAgICBfY2xvc2VXaW5kb3coY29uZmlnLmFwcC5zcGxhc2hXaW5kb3dJRCk7XG4gIH1cblxuICAvLyBEQiBiYWNrZW5kIGluaXRpYWxpemF0aW9uIGhhcHBlbnMgYWZ0ZXIgdGhlIGFwcCBpcyByZWFkeSxcbiAgLy8gc2luY2UgaXQgbWF5IHJlcXVpcmUgdXNlciBpbnB1dCAoYW5kIGhlbmNlIEdVSSBpbnRlcmFjdGlvbilcbiAgLy8gb2Ygc2Vuc2l0aXZlIGRhdGEgbm90IHN1aXRhYmxlIGZvciBzZXR0aW5ncyxcbiAgLy8gbmFtZWx5IGF1dGhlbnRpY2F0aW9uIGtleXMgaWYgZGF0YSBzb3VyY2UgcmVxdWlyZXMgYXV0aC5cbiAgLy8gVE9ETzogVGVhY2hpbmcgdGhlIGZyYW1ld29yayB0byBlbmNyeXB0IHNldHRpbmdzXG4gIC8vIG1pZ2h0IGxldCB1cyBtYWtlIGF1dGhlbnRpY2F0aW9uIGRhdGEgZW50cnlcbiAgLy8gcGFydCBvZiByZXF1aXJlZCBzZXR0aW5ncyBlbnRyeVxuICAvLyBhbmQgc3RhcnQgZGF0YSBzb3VyY2UgaW5pdGlhbGl6YXRpb24gZWFybHkuXG4gIGZvciAoY29uc3QgW2JhY2tlbmRJRCwgYmFja2VuZF0gb2YgT2JqZWN0LmVudHJpZXMoZGF0YWJhc2VzKSkge1xuICAgIGxvZy5kZWJ1ZyhcIkMvaW5pdE1haW46IEluaXRpYWxpemluZyBEQiBiYWNrZW5kXCIsIGJhY2tlbmRJRCk7XG4gICAgYXdhaXQgYmFja2VuZC5pbml0KCk7XG4gIH1cblxuICBmb3IgKGNvbnN0IFttYW5hZ2VySUQsIG1hbmFnZXJdIG9mIE9iamVjdC5lbnRyaWVzKG1hbmFnZXJzKSkge1xuICAgIGxvZy5kZWJ1ZyhcIkMvaW5pdE1haW46IEluaXRpYWxpemluZyBtYW5hZ2VyXCIsIG1hbmFnZXJJRCk7XG4gICAgYXdhaXQgbWFuYWdlci5pbml0KCk7XG4gIH1cblxuICBjb25zdCBpbml0aWFsaXplZE1haW46IE1haW5BcHA8dHlwZW9mIGNvbmZpZy5hcHAsIHR5cGVvZiBjb25maWc+ID0ge1xuICAgIGFwcCxcbiAgICBpc01hY09TLFxuICAgIGlzRGV2ZWxvcG1lbnQsXG4gICAgbWFuYWdlcnMsXG4gICAgZGF0YWJhc2VzLFxuICAgIHNldHRpbmdzLFxuICAgIG9wZW5XaW5kb3c6IF9vcGVuV2luZG93LFxuICB9O1xuXG4gIHJldHVybiBpbml0aWFsaXplZE1haW47XG59O1xuXG5cbmNvbnN0IHJlcG9ydEJhY2tlbmRTdGF0dXNUb0FsbFdpbmRvd3MgPSBhc3luYyAoZGJOYW1lOiBzdHJpbmcsIHBheWxvYWQ6IG9iamVjdCkgPT4ge1xuICByZXR1cm4gYXdhaXQgbm90aWZ5QWxsV2luZG93cyhgZGItJHtkYk5hbWV9LXN0YXR1c2AsIHBheWxvYWQpO1xufTtcblxuXG5jb25zdCByZXBvcnRNb2RpZmllZERhdGFUb0FsbFdpbmRvd3MgPSBhc3luYyAobW9kZWxOYW1lOiBzdHJpbmcsIGNoYW5nZWRJRHM/OiBzdHJpbmdbXSkgPT4ge1xuICAvLyBUT0RPOiBJZiB0b28gbWFueSB1cGRhdGUgY2FsbHMgd2l0aCBvbmUgSUQgYWZmZWN0IHBlcmZvcm1hbmNlLFxuICAvLyBkZWJvdW5jZSB0aGlzIGZ1bmN0aW9uLCBjb21iaW5pbmcgc2hvcnRlciBJRCBsaXN0cyBhbmQgcmVwb3J0aW5nIG1vcmUgb2YgdGhlbSBhdCBvbmNlXG4gIGxvZy5kZWJ1ZyhcIkMvbWFpbjogUmVwb3J0aW5nIG1vZGlmaWVkIGRhdGFcIiwgbW9kZWxOYW1lLCBjaGFuZ2VkSURzKTtcbiAgcmV0dXJuIGF3YWl0IG5vdGlmeUFsbFdpbmRvd3MoYG1vZGVsLSR7bW9kZWxOYW1lfS1vYmplY3RzLWNoYW5nZWRgLCB7IGlkczogY2hhbmdlZElEcyB9KTtcbn07XG4iXX0=