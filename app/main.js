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
export let main;
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
    };
    return main;
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9hcHAvbWFpbi50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSwrREFBK0Q7QUFDL0QsT0FBTyxLQUFLLE1BQU0sWUFBWSxDQUFDO0FBQzlCLE1BQWMsQ0FBQyxLQUFLLEdBQUcsS0FBSyxDQUFDO0FBRTlCLE9BQU8sRUFBRSxHQUFHLEVBQU8sTUFBTSxVQUFVLENBQUM7QUFDcEMsT0FBTyxLQUFLLEdBQUcsTUFBTSxjQUFjLENBQUM7QUFLcEMsT0FBTyxFQUFFLGNBQWMsRUFBRSxNQUFNLGtCQUFrQixDQUFDO0FBQ2xELE9BQU8sRUFBRSxnQkFBZ0IsRUFBc0IsTUFBTSxnQkFBZ0IsQ0FBQztBQUN0RSxPQUFPLEVBQUUsTUFBTSxFQUFFLE1BQU0sYUFBYSxDQUFDO0FBT3JDLE9BQU8sRUFBRSxrQkFBa0IsRUFBRSxNQUFNLGFBQWEsQ0FBQztBQUNqRCxPQUFPLEVBQUUsVUFBVSxFQUFFLFdBQVcsRUFBRSxNQUFNLGdCQUFnQixDQUFDO0FBR3pELE1BQU0sQ0FBQyxJQUFJLElBQXVCLENBQUM7QUFHbkMsTUFBTSxDQUFDLE1BQU0sUUFBUSxHQUFHLEtBQUssRUFBNkIsTUFBUyxFQUE0QixFQUFFO0lBRS9GLHdEQUF3RDtJQUN4RCxHQUFHLENBQUMsRUFBRSxDQUFDLG1CQUFtQixFQUFFLENBQUMsQ0FBTSxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsY0FBYyxFQUFFLENBQUMsQ0FBQztJQUU1RCxHQUFHLENBQUMsV0FBVyxDQUFDLEVBQUUsVUFBVSxFQUFFLElBQUksRUFBRSxDQUFDLENBQUM7SUFFdEMsSUFBSSxNQUFNLENBQUMsR0FBRyxDQUFDLGNBQWMsRUFBRTtRQUM3QixnRkFBZ0Y7UUFDaEYsa0NBQWtDO1FBQ2xDLElBQUksQ0FBQyxHQUFHLENBQUMseUJBQXlCLEVBQUUsRUFBRTtZQUNwQyxHQUFHLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO1NBQ2I7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LEVBQUUsVUFBVSxDQUFDLENBQUM7SUFDcEUsT0FBTyxNQUFNLGdCQUFnQixDQUFDLFNBQVMsU0FBUyxrQkFBa0IsRUFBRSxFQUFFLEdBQUcsRUFBRSxVQUFVLEVBQUUsQ0FBQyxDQUFDO0FBQzNGLENBQUMsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8vIEp1cnktcmlnIGdsb2JhbC5mZXRjaCB0byBtYWtlIElzb21vcnBoaWMgR2l0IHdvcmsgdW5kZXIgTm9kZVxuaW1wb3J0IGZldGNoIGZyb20gJ25vZGUtZmV0Y2gnO1xuKGdsb2JhbCBhcyBhbnkpLmZldGNoID0gZmV0Y2g7XG5cbmltcG9ydCB7IGFwcCwgQXBwIH0gZnJvbSAnZWxlY3Ryb24nO1xuaW1wb3J0ICogYXMgbG9nIGZyb20gJ2VsZWN0cm9uLWxvZyc7XG5cbmltcG9ydCB7IEFwcENvbmZpZywgV2luZG93IH0gZnJvbSAnLi4vY29uZmlnL2FwcCc7XG5cbmltcG9ydCB7IE1haW5Db25maWcgfSBmcm9tICcuLi9jb25maWcvbWFpbic7XG5pbXBvcnQgeyBTZXR0aW5nTWFuYWdlciB9IGZyb20gJy4uL3NldHRpbmdzL21haW4nO1xuaW1wb3J0IHsgbm90aWZ5QWxsV2luZG93cywgV2luZG93T3BlbmVyUGFyYW1zIH0gZnJvbSAnLi4vbWFpbi93aW5kb3cnO1xuaW1wb3J0IHsgbGlzdGVuIH0gZnJvbSAnLi4vaXBjL21haW4nO1xuaW1wb3J0IHtcbiAgQmFja2VuZCxcbiAgTW9kZWxNYW5hZ2VyLFxuICBCYWNrZW5kQ2xhc3MgYXMgRGF0YWJhc2VCYWNrZW5kQ2xhc3MsXG59IGZyb20gJy4uL2RiL21haW4vYmFzZSc7XG5cbmltcG9ydCB7IG1ha2VXaW5kb3dFbmRwb2ludCB9IGZyb20gJy4uL2lwYy9tYWluJztcbmltcG9ydCB7IG9wZW5XaW5kb3csIGNsb3NlV2luZG93IH0gZnJvbSAnLi4vbWFpbi93aW5kb3cnO1xuXG5cbmV4cG9ydCBsZXQgbWFpbjogTWFpbkFwcDxhbnksIGFueT47XG5cblxuZXhwb3J0IGNvbnN0IGluaXRNYWluID0gYXN5bmMgPEMgZXh0ZW5kcyBNYWluQ29uZmlnPGFueT4+KGNvbmZpZzogQyk6IFByb21pc2U8TWFpbkFwcDxhbnksIEM+PiA9PiB7XG5cbiAgLy8gUHJldmVudCB3aW5kb3dzIGZyb20gY2xvc2luZyB3aGlsZSBhcHAgaXMgaW5pdGlhbGl6ZWRcbiAgYXBwLm9uKCd3aW5kb3ctYWxsLWNsb3NlZCcsIChlOiBhbnkpID0+IGUucHJldmVudERlZmF1bHQoKSk7XG5cbiAgbG9nLmNhdGNoRXJyb3JzKHsgc2hvd0RpYWxvZzogdHJ1ZSB9KTtcblxuICBpZiAoY29uZmlnLmFwcC5zaW5nbGVJbnN0YW5jZSkge1xuICAgIC8vIEVuc3VyZSBvbmx5IG9uZSBpbnN0YW5jZSBvZiB0aGUgYXBwIGNhbiBydW4gYXQgYSB0aW1lIG9uIGdpdmVuIHVzZXLigJlzIG1hY2hpbmVcbiAgICAvLyBieSBleGl0aW5nIGFueSBmdXR1cmUgaW5zdGFuY2VzXG4gICAgaWYgKCFhcHAucmVxdWVzdFNpbmdsZUluc3RhbmNlTG9jaygpKSB7XG4gICAgICBhcHAuZXhpdCgwKTtcbiAgICB9XG4gIH1cblxuXG4gIC8qIEhlbHBlciBmdW5jdGlvbnMgKi9cblxuICBmdW5jdGlvbiBfb3BlbldpbmRvdyh3aW5kb3dOYW1lOiBrZXlvZiB0eXBlb2YgY29uZmlnLmFwcC53aW5kb3dzLCBleHRyYUNvbXBvbmVudFBhcmFtczogc3RyaW5nID0gJycpIHtcbiAgICBsb2cudmVyYm9zZShcIkMvbWFpbjogT3BlbmluZyB3aW5kb3dcIiwgd2luZG93TmFtZSk7XG5cbiAgICBjb25zdCBkZWZhdWx0UGFyYW1zID0gY29uZmlnLmFwcC53aW5kb3dzW3dpbmRvd05hbWVdLm9wZW5lclBhcmFtcztcblxuICAgIGNvbnN0IG9wZW5lclBhcmFtcyA9IHtcbiAgICAgIC4uLmRlZmF1bHRQYXJhbXMsXG4gICAgICBjb21wb25lbnRQYXJhbXM6IGAke2RlZmF1bHRQYXJhbXMuY29tcG9uZW50UGFyYW1zfSYke2V4dHJhQ29tcG9uZW50UGFyYW1zfWAsXG4gICAgfTtcblxuICAgIHJldHVybiBvcGVuV2luZG93KHtcbiAgICAgIC4uLm9wZW5lclBhcmFtcyxcbiAgICAgIGNvbXBvbmVudDogd2luZG93TmFtZSxcbiAgICAgIGNvbmZpZzogY29uZmlnLmFwcCxcbiAgICB9KTtcbiAgfVxuXG4gIGZ1bmN0aW9uIF9jbG9zZVdpbmRvdyh3aW5kb3dOYW1lOiBrZXlvZiB0eXBlb2YgY29uZmlnLmFwcC53aW5kb3dzKSB7XG4gICAgbG9nLnZlcmJvc2UoYEMvbWFpbjogQ2xvc2luZyB3aW5kb3cgJHtTdHJpbmcod2luZG93TmFtZSl9YCk7XG5cbiAgICBjbG9zZVdpbmRvdyhjb25maWcuYXBwLndpbmRvd3Nbd2luZG93TmFtZV0ub3BlbmVyUGFyYW1zLnRpdGxlKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIF9yZXF1ZXN0U2V0dGluZ3Moc2V0dGluZ0lEczogc3RyaW5nW10pOiBQcm9taXNlPHZvaWQ+IHtcbiAgICAvKiBPcGVuIHNldHRpbmdzIHdpbmRvdywgcHJvbXB0aW5nIHRoZSB1c2VyXG4gICAgICAgdG8gZmlsbCBpbiBwYXJhbWV0ZXJzIHJlcXVpcmVkIGZvciBhcHBsaWNhdGlvblxuICAgICAgIHRvIHBlcmZvcm0gYSBmdW5jdGlvbi5cbiAgICAgICBUaGUgd2luZG93IGlzIGV4cGVjdGVkIHRvIHVzZSBjb21taXRTZXR0aW5nIElQQyBjYWxscyxcbiAgICAgICB3aGljaCBpcyBob3cgZGVmYXVsdCBzZXR0aW5ncyB3aWRnZXRzIHdvcmsuICovXG5cbiAgICBjb25zdCBzZXR0aW5nc1dpbmRvdyA9IGNvbmZpZy5hcHAud2luZG93c1tjb25maWcuYXBwLnNldHRpbmdzV2luZG93SURdO1xuICAgIGlmIChzZXR0aW5nc1dpbmRvdykge1xuICAgICAgcmV0dXJuIG5ldyBQcm9taXNlPHZvaWQ+KGFzeW5jIChyZXNvbHZlLCByZWplY3QpID0+IHtcblxuICAgICAgICBjb25zdCBvcGVuZWRXaW5kb3cgPSBhd2FpdCBfb3BlbldpbmRvdyhcbiAgICAgICAgICBjb25maWcuYXBwLnNldHRpbmdzV2luZG93SUQsXG4gICAgICAgICAgYHJlcXVpcmVkU2V0dGluZ3M9JHtzZXR0aW5nSURzLmpvaW4oJywnKX1gKTtcblxuICAgICAgICBvcGVuZWRXaW5kb3cub24oJ2Nsb3NlZCcsICgpID0+IHtcbiAgICAgICAgICBjb25zdCBtaXNzaW5nUmVxdWlyZWRTZXR0aW5ncyA9IHNldHRpbmdJRHMuXG4gICAgICAgICAgICBtYXAoKHNldHRpbmdJRCkgPT4gIHNldHRpbmdzLmdldFZhbHVlKHNldHRpbmdJRCkpLlxuICAgICAgICAgICAgZmlsdGVyKChzZXR0aW5nVmFsKSA9PiBzZXR0aW5nVmFsID09PSB1bmRlZmluZWQpO1xuICAgICAgICAgIGlmIChtaXNzaW5nUmVxdWlyZWRTZXR0aW5ncy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBsb2cud2FybihcbiAgICAgICAgICAgICAgXCJDL21haW46IFVzZXIgY2xvc2VkIHNldHRpbmdzIHdpbmRvdyB3aXRoIG1pc3Npbmcgc2V0dGluZ3MgbGVmdFwiLFxuICAgICAgICAgICAgICBtaXNzaW5nUmVxdWlyZWRTZXR0aW5ncylcbiAgICAgICAgICAgIHJlamVjdCgpO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBsb2cudmVyYm9zZShcIkMvbWFpbjogVXNlciBwcm92aWRlciBhbGwgbWlzc2luZyBzZXR0aW5nc1wiKVxuICAgICAgICAgICAgcmVzb2x2ZSgpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSlcblxuICAgICAgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIlNldHRpbmdzIHdlcmUgcmVxdWVzdGVkLCBidXQgc2V0dGluZ3Mgd2luZG93IGlzIG5vdCBzcGVjaWZpZWRcIik7XG4gICAgfVxuICB9XG5cbiAgLy8gVE9ETzogVGhpcyB3b3JrYXJvdW5kIG1heSBvciBtYXkgbm90IGJlIG5lY2Vzc2FyeVxuICBpZiAoY29uZmlnLmRpc2FibGVHUFUpIHtcbiAgICBhcHAuZGlzYWJsZUhhcmR3YXJlQWNjZWxlcmF0aW9uKCk7XG4gIH1cblxuICAvLyBDYXRjaCB1bmhhbmRsZWQgZXJyb3JzIGluIGVsZWN0cm9uLWxvZ1xuICBsb2cuY2F0Y2hFcnJvcnMoeyBzaG93RGlhbG9nOiB0cnVlIH0pO1xuXG4gIGF3YWl0IGFwcC53aGVuUmVhZHkoKTtcblxuICAvLyBTaG93IHNwbGFzaCB3aW5kb3csIGlmIGNvbmZpZ3VyZWRcbiAgY29uc3Qgc3BsYXNoV2luZG93ID0gY29uZmlnLmFwcC53aW5kb3dzW2NvbmZpZy5hcHAuc3BsYXNoV2luZG93SURdO1xuICBpZiAoc3BsYXNoV2luZG93KSB7XG4gICAgX29wZW5XaW5kb3coY29uZmlnLmFwcC5zcGxhc2hXaW5kb3dJRCk7XG4gIH1cblxuICBjb25zdCBpc01hY09TID0gcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gJ2Rhcndpbic7XG4gIGNvbnN0IGlzRGV2ZWxvcG1lbnQgPSBwcm9jZXNzLmVudi5OT0RFX0VOViAhPT0gJ3Byb2R1Y3Rpb24nIHx8IGNvbmZpZy5hcHAuZm9yY2VEZXZlbG9wbWVudE1vZGU7XG5cbiAgY29uc3Qgc2V0dGluZ3MgPSBuZXcgU2V0dGluZ01hbmFnZXIoY29uZmlnLmFwcERhdGFQYXRoLCBjb25maWcuc2V0dGluZ3NGaWxlTmFtZSk7XG4gIHNldHRpbmdzLnNldFVwSVBDKCk7XG5cblxuICAvLyBQcmVwYXJlIGRhdGFiYXNlIGJhY2tlbmRzICYgcmVxdWVzdCBjb25maWd1cmF0aW9uIGlmIG5lZWRlZFxuXG4gIGxvZy5kZWJ1ZyhcIkMvaW5pdE1haW46IERCOiBSZWFkaW5nIGJhY2tlbmQgY29uZmlnXCIsIGNvbmZpZy5kYXRhYmFzZXMpO1xuXG4gIHR5cGUgQmFja2VuZEluZm8gPSB7XG4gICAgZGJOYW1lOiBzdHJpbmdcbiAgICBiYWNrZW5kQ2xhc3M6IERhdGFiYXNlQmFja2VuZENsYXNzPGFueSwgYW55LCBhbnk+XG4gICAgYmFja2VuZE9wdGlvbnM6IGFueVxuICB9O1xuICBsZXQgZGJCYWNrZW5kQ2xhc3NlczogQmFja2VuZEluZm9bXTtcbiAgZGJCYWNrZW5kQ2xhc3NlcyA9IChhd2FpdCBQcm9taXNlLmFsbChPYmplY3QuZW50cmllcyhjb25maWcuZGF0YWJhc2VzKS5tYXAoXG4gICAgYXN5bmMgKFtkYk5hbWUsIGRiQ29uZl0pID0+IHtcbiAgICAgIGxvZy5kZWJ1ZyhcIkMvaW5pdE1haW46IERCOiBSZWFkaW5nIGJhY2tlbmQgY29uZmlnXCIsIGRiTmFtZSwgZGJDb25mKTtcblxuICAgICAgY29uc3QgREJCYWNrZW5kQ2xhc3MgPSBkYkNvbmYuYmFja2VuZDtcbiAgICAgIGlmIChEQkJhY2tlbmRDbGFzcy5yZWdpc3RlclNldHRpbmdzRm9yQ29uZmlndXJhYmxlT3B0aW9ucykge1xuICAgICAgICBEQkJhY2tlbmRDbGFzcy5yZWdpc3RlclNldHRpbmdzRm9yQ29uZmlndXJhYmxlT3B0aW9ucyhzZXR0aW5ncywgZGJDb25mLm9wdGlvbnMsIGRiTmFtZSk7XG4gICAgICB9XG4gICAgICByZXR1cm4ge1xuICAgICAgICBkYk5hbWU6IGRiTmFtZSxcbiAgICAgICAgYmFja2VuZENsYXNzOiBEQkJhY2tlbmRDbGFzcyxcbiAgICAgICAgYmFja2VuZE9wdGlvbnM6IGRiQ29uZi5vcHRpb25zLFxuICAgICAgfTtcbiAgICB9XG4gICkpKTtcblxuXG4gIC8vIFJlcXVlc3Qgc2V0dGluZ3MgZnJvbSB1c2VyIHZpYSBhbiBpbml0aWFsIGNvbmZpZ3VyYXRpb24gd2luZG93LCBpZiByZXF1aXJlZFxuXG4gIGNvbnN0IG1pc3NpbmdTZXR0aW5ncyA9IGF3YWl0IHNldHRpbmdzLmxpc3RNaXNzaW5nUmVxdWlyZWRTZXR0aW5ncygpO1xuICAvLyBMaXN0IG9mIElEcyBvZiBzZXR0aW5ncyB0aGF0IG5lZWQgdG8gYmUgZmlsbGVkIG91dC5cblxuICBpZiAobWlzc2luZ1NldHRpbmdzLmxlbmd0aCA+IDApIHtcbiAgICBsb2cudmVyYm9zZShcIkMvaW5pdE1haW46IE1pc3Npbmcgc2V0dGluZ3MgcHJlc2VudCwgcmVxdWVzdGluZyBmcm9tIHRoZSB1c2VyXCIsIG1pc3NpbmdTZXR0aW5ncyk7XG4gICAgYXdhaXQgX3JlcXVlc3RTZXR0aW5ncyhtaXNzaW5nU2V0dGluZ3MpO1xuICB9IGVsc2Uge1xuICAgIGxvZy5kZWJ1ZyhcIkMvaW5pdE1haW46IE5vIG1pc3Npbmcgc2V0dGluZ3MgZm91bmRcIik7XG4gIH1cblxuXG4gIC8vIENvbnN0cnVjdCBkYXRhYmFzZSBiYWNrZW5kIGluc3RhbmNlc1xuXG4gIHR5cGUgREJzID0gTWFpbkFwcDxhbnksIEM+W1wiZGF0YWJhc2VzXCJdO1xuICBsZXQgZGF0YWJhc2VzOiBEQnNcblxuICB0cnkge1xuICAgIGRhdGFiYXNlcyA9IChhd2FpdCBQcm9taXNlLmFsbChkYkJhY2tlbmRDbGFzc2VzLm1hcChcbiAgICAgIGFzeW5jICh7IGRiTmFtZSwgYmFja2VuZENsYXNzLCBiYWNrZW5kT3B0aW9ucyB9KSA9PiB7XG4gICAgICAgIGNvbnN0IERCQmFja2VuZENsYXNzID0gYmFja2VuZENsYXNzO1xuXG4gICAgICAgIGxvZy52ZXJib3NlKFwiQy9pbml0TWFpbjogREI6IENvbXBsZXRpbmcgYmFja2VuZCBvcHRpb25zIGZyb21cIiwgYmFja2VuZE9wdGlvbnMpO1xuXG4gICAgICAgIGxldCBvcHRpb25zOiBhbnk7XG4gICAgICAgIGlmIChEQkJhY2tlbmRDbGFzcy5jb21wbGV0ZU9wdGlvbnNGcm9tU2V0dGluZ3MpIHtcbiAgICAgICAgICBvcHRpb25zID0gYXdhaXQgREJCYWNrZW5kQ2xhc3MuY29tcGxldGVPcHRpb25zRnJvbVNldHRpbmdzKFxuICAgICAgICAgICAgc2V0dGluZ3MsXG4gICAgICAgICAgICBiYWNrZW5kT3B0aW9ucyxcbiAgICAgICAgICAgIGRiTmFtZSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgb3B0aW9ucyA9IGJhY2tlbmRPcHRpb25zO1xuICAgICAgICB9XG5cbiAgICAgICAgbG9nLnZlcmJvc2UoXCJDL2luaXRNYWluOiBEQjogSW5pdGlhbGl6aW5nIGJhY2tlbmQgd2l0aCBvcHRpb25zXCIsIGJhY2tlbmRPcHRpb25zKTtcblxuICAgICAgICBjb25zdCBiYWNrZW5kID0gbmV3IERCQmFja2VuZENsYXNzKFxuICAgICAgICAgICBvcHRpb25zLFxuICAgICAgICAgICBhc3luYyAocGF5bG9hZDogYW55KSA9PiBhd2FpdCByZXBvcnRCYWNrZW5kU3RhdHVzVG9BbGxXaW5kb3dzKGRiTmFtZSwgcGF5bG9hZCkpO1xuXG4gICAgICAgIGlmIChiYWNrZW5kLnNldFVwSVBDKSB7XG4gICAgICAgICAgYmFja2VuZC5zZXRVcElQQyhkYk5hbWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgW2RiTmFtZV06IGJhY2tlbmQgfTtcbiAgICAgIH1cbiAgICApKSkucmVkdWNlKCh2YWwsIGFjYykgPT4gKHsgLi4uYWNjLCAuLi52YWwgfSksIHt9IGFzIFBhcnRpYWw8REJzPikgYXMgREJzO1xuICB9IGNhdGNoIChlKSB7XG4gICAgbG9nLmVycm9yKFwiQy9pbml0TWFpbjogRmFpbGVkIHRvIGluaXRpYWxpemUgZGF0YWJhc2UgYmFja2VuZHNcIik7XG4gICAgdGhyb3cgZTtcbiAgfVxuXG5cbiAgLy8gSW5pdGlhbGl6ZSBtb2RlbCBtYW5hZ2Vyc1xuXG4gIGxvZy5kZWJ1ZyhcIkMvaW5pdE1haW46IEluaXRpYWxpemluZyBkYXRhIG1vZGVsIG1hbmFnZXJzXCIsIGNvbmZpZy5tYW5hZ2VycylcblxuICB0eXBlIE1hbmFnZXJzID0gTWFpbkFwcDxhbnksIEM+W1wibWFuYWdlcnNcIl07XG4gIGxldCBtYW5hZ2VyczogTWFuYWdlcnM7XG5cbiAgbWFuYWdlcnMgPSAoYXdhaXQgUHJvbWlzZS5hbGwoT2JqZWN0LmVudHJpZXMoY29uZmlnLm1hbmFnZXJzKS5tYXAoXG4gICAgYXN5bmMgKFttb2RlbE5hbWUsIG1hbmFnZXJDb25mXSkgPT4ge1xuICAgICAgY29uc3QgbW9kZWxJbmZvID0gY29uZmlnLmFwcC5kYXRhW21vZGVsTmFtZV07XG5cbiAgICAgIGxvZy52ZXJib3NlKFwiQy9pbml0TWFpbjogSW5pdGlhbGl6aW5nIG1vZGVsIG1hbmFnZXIgZm9yIERCXCIsIG1hbmFnZXJDb25mLmRiTmFtZSwgZGF0YWJhc2VzKTtcblxuICAgICAgY29uc3QgZGIgPSBkYXRhYmFzZXNbbWFuYWdlckNvbmYuZGJOYW1lXTtcbiAgICAgIGNvbnN0IE1hbmFnZXJDbGFzcyA9IG1hbmFnZXJDb25mLm9wdGlvbnMuY2xzO1xuICAgICAgY29uc3QgbWFuYWdlciA9IG5ldyBNYW5hZ2VyQ2xhc3MoXG4gICAgICAgIGRiLCBtYW5hZ2VyQ29uZi5vcHRpb25zLCBtb2RlbEluZm8sXG4gICAgICAgIGFzeW5jIChjaGFuZ2VkSURzPzogYW55W10pID0+IGF3YWl0IHJlcG9ydE1vZGlmaWVkRGF0YVRvQWxsV2luZG93cyhtb2RlbE5hbWUsIGNoYW5nZWRJRHM/Lm1hcChpZCA9PiBgJHtpZH1gKSkpO1xuXG4gICAgICBpZiAobWFuYWdlci5zZXRVcElQQykge1xuICAgICAgICBtYW5hZ2VyLnNldFVwSVBDKG1vZGVsTmFtZSk7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiB7IFttb2RlbE5hbWVdOiBtYW5hZ2VyIH07XG4gICAgfVxuICApKSlcbiAgLnJlZHVjZSgodmFsLCBhY2MpID0+ICh7IC4uLmFjYywgLi4udmFsIH0pLCB7fSBhcyBQYXJ0aWFsPE1hbmFnZXJzPikgYXMgTWFuYWdlcnM7XG5cblxuICBsaXN0ZW48eyBpZDoga2V5b2YgdHlwZW9mIGNvbmZpZy5hcHAud2luZG93cywgcGFyYW1zPzogT21pdDxXaW5kb3dPcGVuZXJQYXJhbXMsICdjb21wb25lbnQnPiB9LCB7fT5cbiAgKCdvcGVuLXByZWRlZmluZWQtd2luZG93JywgYXN5bmMgKHsgaWQsIHBhcmFtcyB9KSA9PiB7XG4gICAgY29uc3QgcGFyYW1zV2l0aERlZmF1bHRzID0geyAuLi5jb25maWcuYXBwLndpbmRvd3NbaWRdLm9wZW5lclBhcmFtcywgLi4ucGFyYW1zIHx8IHt9LCBjb21wb25lbnQ6IGlkLCBjb25maWc6IGNvbmZpZy5hcHAgfTtcbiAgICBvcGVuV2luZG93KHBhcmFtc1dpdGhEZWZhdWx0cyk7XG4gICAgcmV0dXJuIHt9O1xuICB9KTtcblxuXG4gIGxpc3RlbjxXaW5kb3dPcGVuZXJQYXJhbXMsIHt9PlxuICAoJ29wZW4tYXJiaXRyYXJ5LXdpbmRvdycsIGFzeW5jIChwYXJhbXMpID0+IHtcbiAgICBvcGVuV2luZG93KHBhcmFtcyk7XG4gICAgcmV0dXJuIHt9O1xuICB9KTtcblxuXG4gIC8vIEluaXRpYWxpemUgd2luZG93LW9wZW5pbmcgZW5kcG9pbnRzXG4gIGZvciAoY29uc3QgW3dpbmRvd05hbWUsIHdpbmRvd10gb2YgT2JqZWN0LmVudHJpZXMoY29uZmlnLmFwcC53aW5kb3dzKSkge1xuICAgIG1ha2VXaW5kb3dFbmRwb2ludCh3aW5kb3dOYW1lLCAoKSA9PiAoe1xuICAgICAgLi4uKHdpbmRvdyBhcyBXaW5kb3cpLm9wZW5lclBhcmFtcyxcbiAgICAgIGNvbXBvbmVudDogd2luZG93TmFtZSxcbiAgICAgIGNvbmZpZzogY29uZmlnLmFwcCxcbiAgICB9KSk7XG4gIH1cblxuICAvLyBPcGVuIG1haW4gd2luZG93XG4gIGF3YWl0IF9vcGVuV2luZG93KCdkZWZhdWx0Jyk7XG5cbiAgLy8gREIgYmFja2VuZCBpbml0aWFsaXphdGlvbiBoYXBwZW5zIGFmdGVyIHRoZSBhcHAgaXMgcmVhZHksXG4gIC8vIHNpbmNlIGl0IG1heSByZXF1aXJlIHVzZXIgaW5wdXQgKGFuZCBoZW5jZSBHVUkgaW50ZXJhY3Rpb24pXG4gIC8vIG9mIHNlbnNpdGl2ZSBkYXRhIG5vdCBzdWl0YWJsZSBmb3Igc2V0dGluZ3MsXG4gIC8vIG5hbWVseSBhdXRoZW50aWNhdGlvbiBrZXlzIGlmIGRhdGEgc291cmNlIHJlcXVpcmVzIGF1dGguXG4gIC8vIFRPRE86IFRlYWNoaW5nIHRoZSBmcmFtZXdvcmsgdG8gZW5jcnlwdCBzZXR0aW5nc1xuICAvLyBtaWdodCBsZXQgdXMgbWFrZSBhdXRoZW50aWNhdGlvbiBkYXRhIGVudHJ5XG4gIC8vIHBhcnQgb2YgcmVxdWlyZWQgc2V0dGluZ3MgZW50cnlcbiAgLy8gYW5kIHN0YXJ0IGRhdGEgc291cmNlIGluaXRpYWxpemF0aW9uIGVhcmx5LlxuICBmb3IgKGNvbnN0IFtiYWNrZW5kSUQsIGJhY2tlbmRdIG9mIE9iamVjdC5lbnRyaWVzKGRhdGFiYXNlcykpIHtcbiAgICBsb2cuZGVidWcoXCJDL2luaXRNYWluOiBJbml0aWFsaXppbmcgREIgYmFja2VuZFwiLCBiYWNrZW5kSUQpO1xuICAgIGF3YWl0IGJhY2tlbmQuaW5pdCgpO1xuICB9XG5cbiAgaWYgKHNwbGFzaFdpbmRvdykge1xuICAgIF9jbG9zZVdpbmRvdyhjb25maWcuYXBwLnNwbGFzaFdpbmRvd0lEKTtcbiAgfVxuXG4gIG1haW4gPSB7XG4gICAgYXBwLFxuICAgIGlzTWFjT1MsXG4gICAgaXNEZXZlbG9wbWVudCxcbiAgICBtYW5hZ2VycyxcbiAgICBkYXRhYmFzZXMsXG4gICAgb3BlbldpbmRvdzogX29wZW5XaW5kb3csXG4gIH0gYXMgTWFpbkFwcDxhbnksIGFueT47XG5cbiAgcmV0dXJuIG1haW4gYXMgTWFpbkFwcDx0eXBlb2YgY29uZmlnLmFwcCwgdHlwZW9mIGNvbmZpZz47XG59O1xuXG5cbmNvbnN0IHJlcG9ydEJhY2tlbmRTdGF0dXNUb0FsbFdpbmRvd3MgPSBhc3luYyAoZGJOYW1lOiBzdHJpbmcsIHBheWxvYWQ6IG9iamVjdCkgPT4ge1xuICByZXR1cm4gYXdhaXQgbm90aWZ5QWxsV2luZG93cyhgZGItJHtkYk5hbWV9LXN0YXR1c2AsIHBheWxvYWQpO1xufTtcblxuXG5jb25zdCByZXBvcnRNb2RpZmllZERhdGFUb0FsbFdpbmRvd3MgPSBhc3luYyAobW9kZWxOYW1lOiBzdHJpbmcsIGNoYW5nZWRJRHM/OiBzdHJpbmdbXSkgPT4ge1xuICAvLyBUT0RPOiBJZiB0b28gbWFueSB1cGRhdGUgY2FsbHMgd2l0aCBvbmUgSUQgYWZmZWN0IHBlcmZvcm1hbmNlLFxuICAvLyBkZWJvdW5jZSB0aGlzIGZ1bmN0aW9uLCBjb21iaW5pbmcgc2hvcnRlciBJRCBsaXN0cyBhbmQgcmVwb3J0aW5nIG1vcmUgb2YgdGhlbSBhdCBvbmNlXG4gIGxvZy5kZWJ1ZyhcIkMvbWFpbjogUmVwb3J0aW5nIG1vZGlmaWVkIGRhdGFcIiwgbW9kZWxOYW1lLCBjaGFuZ2VkSURzKTtcbiAgcmV0dXJuIGF3YWl0IG5vdGlmeUFsbFdpbmRvd3MoYG1vZGVsLSR7bW9kZWxOYW1lfS1vYmplY3RzLWNoYW5nZWRgLCB7IGlkczogY2hhbmdlZElEcyB9KTtcbn07XG5cblxuZXhwb3J0IGludGVyZmFjZSBNYWluQXBwPEEgZXh0ZW5kcyBBcHBDb25maWcsIE0gZXh0ZW5kcyBNYWluQ29uZmlnPEE+PiB7XG4gIC8qIE9iamVjdCByZXR1cm5lZCBieSBpbml0TWFpbi4gKi9cblxuICBhcHA6IEFwcFxuICBpc01hY09TOiBib29sZWFuXG4gIGlzRGV2ZWxvcG1lbnQ6IGJvb2xlYW5cbiAgbWFuYWdlcnM6IFJlY29yZDxrZXlvZiBBW1wiZGF0YVwiXSwgTW9kZWxNYW5hZ2VyPGFueSwgYW55Pj5cbiAgZGF0YWJhc2VzOiBSZWNvcmQ8a2V5b2YgTVtcImRhdGFiYXNlc1wiXSwgQmFja2VuZD5cbiAgb3BlbldpbmRvdzogKHdpbmRvd05hbWU6IGtleW9mIEFbXCJ3aW5kb3dzXCJdKSA9PiB2b2lkXG59XG4iXX0=