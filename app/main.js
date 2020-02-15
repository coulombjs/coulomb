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
        log.verbose(`C/main: Opening window ${String(windowName)}`);
        const defaultParams = config.app.windows[windowName].openerParams;
        const openerParams = Object.assign(Object.assign({}, defaultParams), { componentParams: `${defaultParams.componentParams}&${extraComponentParams}` });
        return openWindow(Object.assign(Object.assign({}, openerParams), { component: windowName }));
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
    const isDevelopment = process.env.NODE_ENV !== 'production';
    const settings = new SettingManager(config.appDataPath, config.settingsFileName);
    settings.setUpIPC();
    // Prepare database backends & request configuration if needed
    log.debug("C/initMain: DB: Reading backend config", config.databases);
    let dbBackendClasses;
    dbBackendClasses = (await Promise.all(Object.entries(config.databases).map(async ([dbName, dbConf]) => {
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
        const ManagerClass = (await managerConf.options.cls()).default;
        const manager = new ManagerClass(db, managerConf.options, modelInfo, async (changedIDs) => { var _a; return await reportModifiedDataToAllWindows(modelName, (_a = changedIDs) === null || _a === void 0 ? void 0 : _a.map(id => `${id}`)); });
        if (manager.setUpIPC) {
            manager.setUpIPC(modelName);
        }
        return { [modelName]: manager };
    })))
        .reduce((val, acc) => (Object.assign(Object.assign({}, acc), val)), {});
    listen('open-predefined-window', async ({ id, params }) => {
        const paramsWithDefaults = Object.assign(Object.assign({}, config.app.windows[id].openerParams), params || {});
        openWindow(paramsWithDefaults);
        return {};
    });
    listen('open-arbitrary-window', async (params) => {
        openWindow(params);
        return {};
    });
    // Initialize window-opening endpoints
    for (const [windowName, window] of Object.entries(config.app.windows)) {
        makeWindowEndpoint(windowName, () => (Object.assign(Object.assign({}, window.openerParams), { component: windowName })));
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
    for (const backend of Object.values(databases)) {
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
async function reportBackendStatusToAllWindows(dbName, payload) {
    return await notifyAllWindows(`db-${dbName}-status`, payload);
}
async function reportModifiedDataToAllWindows(modelName, changedIDs) {
    // TODO: If too many update calls with one ID affect performance,
    // debounce this function, combining shorter ID lists and reporting more of them at once
    console.debug("Reporting modified data", modelName, changedIDs);
    return await notifyAllWindows(`model-${modelName}-objects-changed`, { ids: changedIDs });
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9hcHAvbWFpbi50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSwrREFBK0Q7QUFDL0QsT0FBTyxLQUFLLE1BQU0sWUFBWSxDQUFDO0FBQzlCLE1BQWMsQ0FBQyxLQUFLLEdBQUcsS0FBSyxDQUFDO0FBRTlCLE9BQU8sRUFBRSxHQUFHLEVBQU8sTUFBTSxVQUFVLENBQUM7QUFDcEMsT0FBTyxLQUFLLEdBQUcsTUFBTSxjQUFjLENBQUM7QUFLcEMsT0FBTyxFQUFFLGNBQWMsRUFBRSxNQUFNLGtCQUFrQixDQUFDO0FBQ2xELE9BQU8sRUFBRSxnQkFBZ0IsRUFBc0IsTUFBTSxnQkFBZ0IsQ0FBQztBQUN0RSxPQUFPLEVBQUUsTUFBTSxFQUFFLE1BQU0sYUFBYSxDQUFDO0FBT3JDLE9BQU8sRUFBRSxrQkFBa0IsRUFBRSxNQUFNLGFBQWEsQ0FBQztBQUNqRCxPQUFPLEVBQUUsVUFBVSxFQUFFLFdBQVcsRUFBRSxNQUFNLGdCQUFnQixDQUFDO0FBR3pELE1BQU0sQ0FBQyxJQUFJLElBQXVCLENBQUM7QUFHbkMsTUFBTSxDQUFDLE1BQU0sUUFBUSxHQUFHLEtBQUssRUFBNkIsTUFBUyxFQUE0QixFQUFFO0lBRS9GLHdEQUF3RDtJQUN4RCxHQUFHLENBQUMsRUFBRSxDQUFDLG1CQUFtQixFQUFFLENBQUMsQ0FBTSxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsY0FBYyxFQUFFLENBQUMsQ0FBQztJQUU1RCxHQUFHLENBQUMsV0FBVyxDQUFDLEVBQUUsVUFBVSxFQUFFLElBQUksRUFBRSxDQUFDLENBQUM7SUFFdEMsSUFBSSxNQUFNLENBQUMsR0FBRyxDQUFDLGNBQWMsRUFBRTtRQUM3QixnRkFBZ0Y7UUFDaEYsa0NBQWtDO1FBQ2xDLElBQUksQ0FBQyxHQUFHLENBQUMseUJBQXlCLEVBQUUsRUFBRTtZQUNwQyxHQUFHLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO1NBQ2I7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aGljIEdpdCB3b3JrIHVuZGVyIE5vZGVcbmltcG9ydCBmZXRjaCBmcm9tICdub2RlLWZldGNoJztcbihnbG9iYWwgYXMgYW55KS5mZXRjaCA9IGZldGNoO1xuXG5pbXBvcnQgeyBhcHAsIEFwcCB9IGZyb20gJ2VsZWN0cm9uJztcbmltcG9ydCAqIGFzIGxvZyBmcm9tICdlbGVjdHJvbi1sb2cnO1xuXG5pbXBvcnQgeyBBcHBDb25maWcsIFdpbmRvdyB9IGZyb20gJy4uL2NvbmZpZy9hcHAnO1xuXG5pbXBvcnQgeyBNYWluQ29uZmlnIH0gZnJvbSAnLi4vY29uZmlnL21haW4nO1xuaW1wb3J0IHsgU2V0dGluZ01hbmFnZXIgfSBmcm9tICcuLi9zZXR0aW5ncy9tYWluJztcbmltcG9ydCB7IG5vdGlmeUFsbFdpbmRvd3MsIFdpbmRvd09wZW5lclBhcmFtcyB9IGZyb20gJy4uL21haW4vd2luZG93JztcbmltcG9ydCB7IGxpc3RlbiB9IGZyb20gJy4uL2lwYy9tYWluJztcbmltcG9ydCB7XG4gIEJhY2tlbmQsXG4gIE1vZGVsTWFuYWdlcixcbiAgQmFja2VuZENsYXNzIGFzIERhdGFiYXNlQmFja2VuZENsYXNzLFxufSBmcm9tICcuLi9kYi9tYWluL2Jhc2UnO1xuXG5pbXBvcnQgeyBtYWtlV2luZG93RW5kcG9pbnQgfSBmcm9tICcuLi9pcGMvbWFpbic7XG5pbXBvcnQgeyBvcGVuV2luZG93LCBjbG9zZVdpbmRvdyB9IGZyb20gJy4uL21haW4vd2luZG93JztcblxuXG5leHBvcnQgbGV0IG1haW46IE1haW5BcHA8YW55LCBhbnk+O1xuXG5cbmV4cG9ydCBjb25zdCBpbml0TWFpbiA9IGFzeW5jIDxDIGV4dGVuZHMgTWFpbkNvbmZpZzxhbnk+Pihjb25maWc6IEMpOiBQcm9taXNlPE1haW5BcHA8YW55LCBDPj4gPT4ge1xuXG4gIC8vIFByZXZlbnQgd2luZG93cyBmcm9tIGNsb3Npbmcgd2hpbGUgYXBwIGlzIGluaXRpYWxpemVkXG4gIGFwcC5vbignd2luZG93LWFsbC1jbG9zZWQnLCAoZTogYW55KSA9PiBlLnByZXZlbnREZWZhdWx0KCkpO1xuXG4gIGxvZy5jYXRjaEVycm9ycyh7IHNob3dEaWFsb2c6IHRydWUgfSk7XG5cbiAgaWYgKGNvbmZpZy5hcHAuc2luZ2xlSW5zdGFuY2UpIHtcbiAgICAvLyBFbnN1cmUgb25seSBvbmUgaW5zdGFuY2Ugb2YgdGhlIGFwcCBjYW4gcnVuIGF0IGEgdGltZSBvbiBnaXZlbiB1c2Vy4oCZcyBtYWNoaW5lXG4gICAgLy8gYnkgZXhpdGluZyBhbnkgZnV0dXJlIGluc3RhbmNlc1xuICAgIGlmICghYXBwLnJlcXVlc3RTaW5nbGVJbnN0YW5jZUxvY2soKSkge1xuICAgICAgYXBwLmV4aXQoMCk7XG4gICAgfVxuICB9XG5cblxuICAvKiBIZWxwZXIgZnVuY3Rpb25zICovXG5cbiAgZnVuY3Rpb24gX29wZW5XaW5kb3cod2luZG93TmFtZToga2V5b2YgdHlwZW9mIGNvbmZpZy5hcHAud2luZG93cywgZXh0cmFDb21wb25lbnRQYXJhbXM6IHN0cmluZyA9ICcnKSB7XG4gICAgbG9nLnZlcmJvc2UoYEMvbWFpbjogT3BlbmluZyB3aW5kb3cgJHtTdHJpbmcod2luZG93TmFtZSl9YCk7XG5cbiAgICBjb25zdCBkZWZhdWx0UGFyYW1zID0gY29uZmlnLmFwcC53aW5kb3dzW3dpbmRvd05hbWVdLm9wZW5lclBhcmFtcztcblxuICAgIGNvbnN0IG9wZW5lclBhcmFtcyA9IHtcbiAgICAgIC4uLmRlZmF1bHRQYXJhbXMsXG4gICAgICBjb21wb25lbnRQYXJhbXM6IGAke2RlZmF1bHRQYXJhbXMuY29tcG9uZW50UGFyYW1zfSYke2V4dHJhQ29tcG9uZW50UGFyYW1zfWAsXG4gICAgfTtcblxuICAgIHJldHVybiBvcGVuV2luZG93KHtcbiAgICAgIC4uLm9wZW5lclBhcmFtcyxcbiAgICAgIGNvbXBvbmVudDogd2luZG93TmFtZSxcbiAgICB9KTtcbiAgfVxuXG4gIGZ1bmN0aW9uIF9jbG9zZVdpbmRvdyh3aW5kb3dOYW1lOiBrZXlvZiB0eXBlb2YgY29uZmlnLmFwcC53aW5kb3dzKSB7XG4gICAgbG9nLnZlcmJvc2UoYEMvbWFpbjogQ2xvc2luZyB3aW5kb3cgJHtTdHJpbmcod2luZG93TmFtZSl9YCk7XG5cbiAgICBjbG9zZVdpbmRvdyhjb25maWcuYXBwLndpbmRvd3Nbd2luZG93TmFtZV0ub3BlbmVyUGFyYW1zLnRpdGxlKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIF9yZXF1ZXN0U2V0dGluZ3Moc2V0dGluZ0lEczogc3RyaW5nW10pOiBQcm9taXNlPHZvaWQ+IHtcbiAgICAvKiBPcGVuIHNldHRpbmdzIHdpbmRvdywgcHJvbXB0aW5nIHRoZSB1c2VyXG4gICAgICAgdG8gZmlsbCBpbiBwYXJhbWV0ZXJzIHJlcXVpcmVkIGZvciBhcHBsaWNhdGlvblxuICAgICAgIHRvIHBlcmZvcm0gYSBmdW5jdGlvbi5cbiAgICAgICBUaGUgd2luZG93IGlzIGV4cGVjdGVkIHRvIHVzZSBjb21taXRTZXR0aW5nIElQQyBjYWxscyxcbiAgICAgICB3aGljaCBpcyBob3cgZGVmYXVsdCBzZXR0aW5ncyB3aWRnZXRzIHdvcmsuICovXG5cbiAgICBjb25zdCBzZXR0aW5nc1dpbmRvdyA9IGNvbmZpZy5hcHAud2luZG93c1tjb25maWcuYXBwLnNldHRpbmdzV2luZG93SURdO1xuICAgIGlmIChzZXR0aW5nc1dpbmRvdykge1xuICAgICAgcmV0dXJuIG5ldyBQcm9taXNlPHZvaWQ+KGFzeW5jIChyZXNvbHZlLCByZWplY3QpID0+IHtcblxuICAgICAgICBjb25zdCBvcGVuZWRXaW5kb3cgPSBhd2FpdCBfb3BlbldpbmRvdyhcbiAgICAgICAgICBjb25maWcuYXBwLnNldHRpbmdzV2luZG93SUQsXG4gICAgICAgICAgYHJlcXVpcmVkU2V0dGluZ3M9JHtzZXR0aW5nSURzLmpvaW4oJywnKX1gKTtcblxuICAgICAgICBvcGVuZWRXaW5kb3cub24oJ2Nsb3NlZCcsICgpID0+IHtcbiAgICAgICAgICBjb25zdCBtaXNzaW5nUmVxdWlyZWRTZXR0aW5ncyA9IHNldHRpbmdJRHMuXG4gICAgICAgICAgICBtYXAoKHNldHRpbmdJRCkgPT4gIHNldHRpbmdzLmdldFZhbHVlKHNldHRpbmdJRCkpLlxuICAgICAgICAgICAgZmlsdGVyKChzZXR0aW5nVmFsKSA9PiBzZXR0aW5nVmFsID09PSB1bmRlZmluZWQpO1xuICAgICAgICAgIGlmIChtaXNzaW5nUmVxdWlyZWRTZXR0aW5ncy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBsb2cud2FybihcbiAgICAgICAgICAgICAgXCJDL21haW46IFVzZXIgY2xvc2VkIHNldHRpbmdzIHdpbmRvdyB3aXRoIG1pc3Npbmcgc2V0dGluZ3MgbGVmdFwiLFxuICAgICAgICAgICAgICBtaXNzaW5nUmVxdWlyZWRTZXR0aW5ncylcbiAgICAgICAgICAgIHJlamVjdCgpO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBsb2cudmVyYm9zZShcIkMvbWFpbjogVXNlciBwcm92aWRlciBhbGwgbWlzc2luZyBzZXR0aW5nc1wiKVxuICAgICAgICAgICAgcmVzb2x2ZSgpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSlcblxuICAgICAgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIlNldHRpbmdzIHdlcmUgcmVxdWVzdGVkLCBidXQgc2V0dGluZ3Mgd2luZG93IGlzIG5vdCBzcGVjaWZpZWRcIik7XG4gICAgfVxuICB9XG5cbiAgLy8gVE9ETzogVGhpcyB3b3JrYXJvdW5kIG1heSBvciBtYXkgbm90IGJlIG5lY2Vzc2FyeVxuICBpZiAoY29uZmlnLmRpc2FibGVHUFUpIHtcbiAgICBhcHAuZGlzYWJsZUhhcmR3YXJlQWNjZWxlcmF0aW9uKCk7XG4gIH1cblxuICAvLyBDYXRjaCB1bmhhbmRsZWQgZXJyb3JzIGluIGVsZWN0cm9uLWxvZ1xuICBsb2cuY2F0Y2hFcnJvcnMoeyBzaG93RGlhbG9nOiB0cnVlIH0pO1xuXG4gIGF3YWl0IGFwcC53aGVuUmVhZHkoKTtcblxuICAvLyBTaG93IHNwbGFzaCB3aW5kb3csIGlmIGNvbmZpZ3VyZWRcbiAgY29uc3Qgc3BsYXNoV2luZG93ID0gY29uZmlnLmFwcC53aW5kb3dzW2NvbmZpZy5hcHAuc3BsYXNoV2luZG93SURdO1xuICBpZiAoc3BsYXNoV2luZG93KSB7XG4gICAgX29wZW5XaW5kb3coY29uZmlnLmFwcC5zcGxhc2hXaW5kb3dJRCk7XG4gIH1cblxuICBjb25zdCBpc01hY09TID0gcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gJ2Rhcndpbic7XG4gIGNvbnN0IGlzRGV2ZWxvcG1lbnQgPSBwcm9jZXNzLmVudi5OT0RFX0VOViAhPT0gJ3Byb2R1Y3Rpb24nO1xuXG4gIGNvbnN0IHNldHRpbmdzID0gbmV3IFNldHRpbmdNYW5hZ2VyKGNvbmZpZy5hcHBEYXRhUGF0aCwgY29uZmlnLnNldHRpbmdzRmlsZU5hbWUpO1xuICBzZXR0aW5ncy5zZXRVcElQQygpO1xuXG5cbiAgLy8gUHJlcGFyZSBkYXRhYmFzZSBiYWNrZW5kcyAmIHJlcXVlc3QgY29uZmlndXJhdGlvbiBpZiBuZWVkZWRcblxuICBsb2cuZGVidWcoXCJDL2luaXRNYWluOiBEQjogUmVhZGluZyBiYWNrZW5kIGNvbmZpZ1wiLCBjb25maWcuZGF0YWJhc2VzKTtcblxuICB0eXBlIEJhY2tlbmRJbmZvID0ge1xuICAgIGRiTmFtZTogc3RyaW5nXG4gICAgYmFja2VuZENsYXNzOiBEYXRhYmFzZUJhY2tlbmRDbGFzczxhbnksIGFueSwgYW55PlxuICAgIGJhY2tlbmRPcHRpb25zOiBhbnlcbiAgfTtcbiAgbGV0IGRiQmFja2VuZENsYXNzZXM6IEJhY2tlbmRJbmZvW107XG4gIGRiQmFja2VuZENsYXNzZXMgPSAoYXdhaXQgUHJvbWlzZS5hbGwoT2JqZWN0LmVudHJpZXMoY29uZmlnLmRhdGFiYXNlcykubWFwKFxuICAgIGFzeW5jIChbZGJOYW1lLCBkYkNvbmZdKSA9PiB7XG4gICAgICBsb2cuZGVidWcoXCJDL2luaXRNYWluOiBEQjogUmVhZGluZyBiYWNrZW5kIGNvbmZpZ1wiLCBkYk5hbWUsIGRiQ29uZik7XG5cbiAgICAgIGNvbnN0IERCQmFja2VuZENsYXNzID0gKGF3YWl0IGRiQ29uZi5iYWNrZW5kKCkpLmRlZmF1bHQ7XG4gICAgICBpZiAoREJCYWNrZW5kQ2xhc3MucmVnaXN0ZXJTZXR0aW5nc0ZvckNvbmZpZ3VyYWJsZU9wdGlvbnMpIHtcbiAgICAgICAgREJCYWNrZW5kQ2xhc3MucmVnaXN0ZXJTZXR0aW5nc0ZvckNvbmZpZ3VyYWJsZU9wdGlvbnMoc2V0dGluZ3MsIGRiQ29uZi5vcHRpb25zLCBkYk5hbWUpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgZGJOYW1lOiBkYk5hbWUsXG4gICAgICAgIGJhY2tlbmRDbGFzczogREJCYWNrZW5kQ2xhc3MsXG4gICAgICAgIGJhY2tlbmRPcHRpb25zOiBkYkNvbmYub3B0aW9ucyxcbiAgICAgIH07XG4gICAgfVxuICApKSk7XG5cblxuICAvLyBSZXF1ZXN0IHNldHRpbmdzIGZyb20gdXNlciB2aWEgYW4gaW5pdGlhbCBjb25maWd1cmF0aW9uIHdpbmRvdywgaWYgcmVxdWlyZWRcblxuICBjb25zdCBtaXNzaW5nU2V0dGluZ3MgPSBhd2FpdCBzZXR0aW5ncy5saXN0TWlzc2luZ1JlcXVpcmVkU2V0dGluZ3MoKTtcbiAgLy8gTGlzdCBvZiBJRHMgb2Ygc2V0dGluZ3MgdGhhdCBuZWVkIHRvIGJlIGZpbGxlZCBvdXQuXG5cbiAgaWYgKG1pc3NpbmdTZXR0aW5ncy5sZW5ndGggPiAwKSB7XG4gICAgbG9nLnZlcmJvc2UoXCJDL2luaXRNYWluOiBNaXNzaW5nIHNldHRpbmdzIHByZXNlbnQsIHJlcXVlc3RpbmcgZnJvbSB0aGUgdXNlclwiLCBtaXNzaW5nU2V0dGluZ3MpO1xuICAgIGF3YWl0IF9yZXF1ZXN0U2V0dGluZ3MobWlzc2luZ1NldHRpbmdzKTtcbiAgfSBlbHNlIHtcbiAgICBsb2cuZGVidWcoXCJDL2luaXRNYWluOiBObyBtaXNzaW5nIHNldHRpbmdzIGZvdW5kXCIpO1xuICB9XG5cblxuICAvLyBDb25zdHJ1Y3QgZGF0YWJhc2UgYmFja2VuZCBpbnN0YW5jZXNcblxuICB0eXBlIERCcyA9IE1haW5BcHA8YW55LCBDPltcImRhdGFiYXNlc1wiXTtcbiAgbGV0IGRhdGFiYXNlczogREJzXG5cbiAgdHJ5IHtcbiAgICBkYXRhYmFzZXMgPSAoYXdhaXQgUHJvbWlzZS5hbGwoZGJCYWNrZW5kQ2xhc3Nlcy5tYXAoXG4gICAgICBhc3luYyAoeyBkYk5hbWUsIGJhY2tlbmRDbGFzcywgYmFja2VuZE9wdGlvbnMgfSkgPT4ge1xuICAgICAgICBjb25zdCBEQkJhY2tlbmRDbGFzcyA9IGJhY2tlbmRDbGFzcztcblxuICAgICAgICBsb2cudmVyYm9zZShcIkMvaW5pdE1haW46IERCOiBDb21wbGV0aW5nIGJhY2tlbmQgb3B0aW9ucyBmcm9tXCIsIGJhY2tlbmRPcHRpb25zKTtcblxuICAgICAgICBsZXQgb3B0aW9uczogYW55O1xuICAgICAgICBpZiAoREJCYWNrZW5kQ2xhc3MuY29tcGxldGVPcHRpb25zRnJvbVNldHRpbmdzKSB7XG4gICAgICAgICAgb3B0aW9ucyA9IGF3YWl0IERCQmFja2VuZENsYXNzLmNvbXBsZXRlT3B0aW9uc0Zyb21TZXR0aW5ncyhcbiAgICAgICAgICAgIHNldHRpbmdzLFxuICAgICAgICAgICAgYmFja2VuZE9wdGlvbnMsXG4gICAgICAgICAgICBkYk5hbWUpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIG9wdGlvbnMgPSBiYWNrZW5kT3B0aW9ucztcbiAgICAgICAgfVxuXG4gICAgICAgIGxvZy52ZXJib3NlKFwiQy9pbml0TWFpbjogREI6IEluaXRpYWxpemluZyBiYWNrZW5kIHdpdGggb3B0aW9uc1wiLCBiYWNrZW5kT3B0aW9ucyk7XG5cbiAgICAgICAgY29uc3QgYmFja2VuZCA9IG5ldyBEQkJhY2tlbmRDbGFzcyhcbiAgICAgICAgICAgb3B0aW9ucyxcbiAgICAgICAgICAgYXN5bmMgKHBheWxvYWQ6IGFueSkgPT4gYXdhaXQgcmVwb3J0QmFja2VuZFN0YXR1c1RvQWxsV2luZG93cyhkYk5hbWUsIHBheWxvYWQpKTtcblxuICAgICAgICBpZiAoYmFja2VuZC5zZXRVcElQQykge1xuICAgICAgICAgIGJhY2tlbmQuc2V0VXBJUEMoZGJOYW1lKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IFtkYk5hbWVdOiBiYWNrZW5kIH07XG4gICAgICB9XG4gICAgKSkpLnJlZHVjZSgodmFsLCBhY2MpID0+ICh7IC4uLmFjYywgLi4udmFsIH0pLCB7fSBhcyBQYXJ0aWFsPERCcz4pIGFzIERCcztcbiAgfSBjYXRjaCAoZSkge1xuICAgIGxvZy5lcnJvcihcIkMvaW5pdE1haW46IEZhaWxlZCB0byBpbml0aWFsaXplIGRhdGFiYXNlIGJhY2tlbmRzXCIpO1xuICAgIHRocm93IGU7XG4gIH1cblxuXG4gIC8vIEluaXRpYWxpemUgbW9kZWwgbWFuYWdlcnNcblxuICBsb2cuZGVidWcoXCJDL2luaXRNYWluOiBJbml0aWFsaXppbmcgZGF0YSBtb2RlbCBtYW5hZ2Vyc1wiLCBjb25maWcubWFuYWdlcnMpXG5cbiAgdHlwZSBNYW5hZ2VycyA9IE1haW5BcHA8YW55LCBDPltcIm1hbmFnZXJzXCJdO1xuICBsZXQgbWFuYWdlcnM6IE1hbmFnZXJzO1xuXG4gIG1hbmFnZXJzID0gKGF3YWl0IFByb21pc2UuYWxsKE9iamVjdC5lbnRyaWVzKGNvbmZpZy5tYW5hZ2VycykubWFwKFxuICAgIGFzeW5jIChbbW9kZWxOYW1lLCBtYW5hZ2VyQ29uZl0pID0+IHtcbiAgICAgIGNvbnN0IG1vZGVsSW5mbyA9IGNvbmZpZy5hcHAuZGF0YVttb2RlbE5hbWVdO1xuXG4gICAgICBsb2cudmVyYm9zZShcIkMvaW5pdE1haW46IEluaXRpYWxpemluZyBtb2RlbCBtYW5hZ2VyIGZvciBEQlwiLCBtYW5hZ2VyQ29uZi5kYk5hbWUsIGRhdGFiYXNlcyk7XG5cbiAgICAgIGNvbnN0IGRiID0gZGF0YWJhc2VzW21hbmFnZXJDb25mLmRiTmFtZV07XG4gICAgICBjb25zdCBNYW5hZ2VyQ2xhc3MgPSAoYXdhaXQgbWFuYWdlckNvbmYub3B0aW9ucy5jbHMoKSkuZGVmYXVsdDtcbiAgICAgIGNvbnN0IG1hbmFnZXIgPSBuZXcgTWFuYWdlckNsYXNzKFxuICAgICAgICBkYiwgbWFuYWdlckNvbmYub3B0aW9ucywgbW9kZWxJbmZvLFxuICAgICAgICBhc3luYyAoY2hhbmdlZElEcz86IGFueVtdKSA9PiBhd2FpdCByZXBvcnRNb2RpZmllZERhdGFUb0FsbFdpbmRvd3MobW9kZWxOYW1lLCBjaGFuZ2VkSURzPy5tYXAoaWQgPT4gYCR7aWR9YCkpKTtcblxuICAgICAgaWYgKG1hbmFnZXIuc2V0VXBJUEMpIHtcbiAgICAgICAgbWFuYWdlci5zZXRVcElQQyhtb2RlbE5hbWUpO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4geyBbbW9kZWxOYW1lXTogbWFuYWdlciB9O1xuICAgIH1cbiAgKSkpXG4gIC5yZWR1Y2UoKHZhbCwgYWNjKSA9PiAoeyAuLi5hY2MsIC4uLnZhbCB9KSwge30gYXMgUGFydGlhbDxNYW5hZ2Vycz4pIGFzIE1hbmFnZXJzO1xuXG5cbiAgbGlzdGVuPHsgaWQ6IGtleW9mIHR5cGVvZiBjb25maWcuYXBwLndpbmRvd3MsIHBhcmFtcz86IE9taXQ8V2luZG93T3BlbmVyUGFyYW1zLCAnY29tcG9uZW50Jz4gfSwge30+XG4gICgnb3Blbi1wcmVkZWZpbmVkLXdpbmRvdycsIGFzeW5jICh7IGlkLCBwYXJhbXMgfSkgPT4ge1xuICAgIGNvbnN0IHBhcmFtc1dpdGhEZWZhdWx0cyA9IHsgLi4uY29uZmlnLmFwcC53aW5kb3dzW2lkXS5vcGVuZXJQYXJhbXMsIC4uLnBhcmFtcyB8fCB7fX07XG4gICAgb3BlbldpbmRvdyhwYXJhbXNXaXRoRGVmYXVsdHMpO1xuICAgIHJldHVybiB7fTtcbiAgfSk7XG5cblxuICBsaXN0ZW48V2luZG93T3BlbmVyUGFyYW1zLCB7fT5cbiAgKCdvcGVuLWFyYml0cmFyeS13aW5kb3cnLCBhc3luYyAocGFyYW1zKSA9PiB7XG4gICAgb3BlbldpbmRvdyhwYXJhbXMpO1xuICAgIHJldHVybiB7fTtcbiAgfSk7XG5cblxuICAvLyBJbml0aWFsaXplIHdpbmRvdy1vcGVuaW5nIGVuZHBvaW50c1xuICBmb3IgKGNvbnN0IFt3aW5kb3dOYW1lLCB3aW5kb3ddIG9mIE9iamVjdC5lbnRyaWVzKGNvbmZpZy5hcHAud2luZG93cykpIHtcbiAgICBtYWtlV2luZG93RW5kcG9pbnQod2luZG93TmFtZSwgKCkgPT4gKHtcbiAgICAgIC4uLih3aW5kb3cgYXMgV2luZG93KS5vcGVuZXJQYXJhbXMsXG4gICAgICBjb21wb25lbnQ6IHdpbmRvd05hbWUsXG4gICAgfSkpO1xuICB9XG5cbiAgLy8gT3BlbiBtYWluIHdpbmRvd1xuICBhd2FpdCBfb3BlbldpbmRvdygnZGVmYXVsdCcpO1xuXG4gIC8vIERCIGJhY2tlbmQgaW5pdGlhbGl6YXRpb24gaGFwcGVucyBhZnRlciB0aGUgYXBwIGlzIHJlYWR5LFxuICAvLyBzaW5jZSBpdCBtYXkgcmVxdWlyZSB1c2VyIGlucHV0IChhbmQgaGVuY2UgR1VJIGludGVyYWN0aW9uKVxuICAvLyBvZiBzZW5zaXRpdmUgZGF0YSBub3Qgc3VpdGFibGUgZm9yIHNldHRpbmdzLFxuICAvLyBuYW1lbHkgYXV0aGVudGljYXRpb24ga2V5cyBpZiBkYXRhIHNvdXJjZSByZXF1aXJlcyBhdXRoLlxuICAvLyBUT0RPOiBUZWFjaGluZyB0aGUgZnJhbWV3b3JrIHRvIGVuY3J5cHQgc2V0dGluZ3NcbiAgLy8gbWlnaHQgbGV0IHVzIG1ha2UgYXV0aGVudGljYXRpb24gZGF0YSBlbnRyeVxuICAvLyBwYXJ0IG9mIHJlcXVpcmVkIHNldHRpbmdzIGVudHJ5XG4gIC8vIGFuZCBzdGFydCBkYXRhIHNvdXJjZSBpbml0aWFsaXphdGlvbiBlYXJseS5cbiAgZm9yIChjb25zdCBiYWNrZW5kIG9mIE9iamVjdC52YWx1ZXMoZGF0YWJhc2VzKSkge1xuICAgIGF3YWl0IGJhY2tlbmQuaW5pdCgpO1xuICB9XG5cbiAgaWYgKHNwbGFzaFdpbmRvdykge1xuICAgIF9jbG9zZVdpbmRvdyhjb25maWcuYXBwLnNwbGFzaFdpbmRvd0lEKTtcbiAgfVxuXG4gIG1haW4gPSB7XG4gICAgYXBwLFxuICAgIGlzTWFjT1MsXG4gICAgaXNEZXZlbG9wbWVudCxcbiAgICBtYW5hZ2VycyxcbiAgICBkYXRhYmFzZXMsXG4gICAgb3BlbldpbmRvdzogX29wZW5XaW5kb3csXG4gIH0gYXMgTWFpbkFwcDxhbnksIGFueT47XG5cbiAgcmV0dXJuIG1haW4gYXMgTWFpbkFwcDx0eXBlb2YgY29uZmlnLmFwcCwgdHlwZW9mIGNvbmZpZz47XG59O1xuXG5cbmFzeW5jIGZ1bmN0aW9uIHJlcG9ydEJhY2tlbmRTdGF0dXNUb0FsbFdpbmRvd3MoZGJOYW1lOiBzdHJpbmcsIHBheWxvYWQ6IG9iamVjdCkge1xuICByZXR1cm4gYXdhaXQgbm90aWZ5QWxsV2luZG93cyhgZGItJHtkYk5hbWV9LXN0YXR1c2AsIHBheWxvYWQpO1xufVxuXG5cbmFzeW5jIGZ1bmN0aW9uIHJlcG9ydE1vZGlmaWVkRGF0YVRvQWxsV2luZG93cyhtb2RlbE5hbWU6IHN0cmluZywgY2hhbmdlZElEcz86IHN0cmluZ1tdKSB7XG4gIC8vIFRPRE86IElmIHRvbyBtYW55IHVwZGF0ZSBjYWxscyB3aXRoIG9uZSBJRCBhZmZlY3QgcGVyZm9ybWFuY2UsXG4gIC8vIGRlYm91bmNlIHRoaXMgZnVuY3Rpb24sIGNvbWJpbmluZyBzaG9ydGVyIElEIGxpc3RzIGFuZCByZXBvcnRpbmcgbW9yZSBvZiB0aGVtIGF0IG9uY2VcbiAgY29uc29sZS5kZWJ1ZyhcIlJlcG9ydGluZyBtb2RpZmllZCBkYXRhXCIsIG1vZGVsTmFtZSwgY2hhbmdlZElEcylcbiAgcmV0dXJuIGF3YWl0IG5vdGlmeUFsbFdpbmRvd3MoYG1vZGVsLSR7bW9kZWxOYW1lfS1vYmplY3RzLWNoYW5nZWRgLCB7IGlkczogY2hhbmdlZElEcyB9KTtcbn1cblxuXG5leHBvcnQgaW50ZXJmYWNlIE1haW5BcHA8QSBleHRlbmRzIEFwcENvbmZpZywgTSBleHRlbmRzIE1haW5Db25maWc8QT4+IHtcbiAgLyogT2JqZWN0IHJldHVybmVkIGJ5IGluaXRNYWluLiAqL1xuXG4gIGFwcDogQXBwXG4gIGlzTWFjT1M6IGJvb2xlYW5cbiAgaXNEZXZlbG9wbWVudDogYm9vbGVhblxuICBtYW5hZ2VyczogUmVjb3JkPGtleW9mIEFbXCJkYXRhXCJdLCBNb2RlbE1hbmFnZXI8YW55LCBhbnk+PlxuICBkYXRhYmFzZXM6IFJlY29yZDxrZXlvZiBNW1wiZGF0YWJhc2VzXCJdLCBCYWNrZW5kPlxuICBvcGVuV2luZG93OiAod2luZG93TmFtZToga2V5b2YgQVtcIndpbmRvd3NcIl0pID0+IHZvaWRcbn1cbiJdfQ==