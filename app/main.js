// Jury-rig global.fetch to make Isomorphic Git work under Node
import fetch from 'node-fetch';
global.fetch = fetch;
import { debounce } from 'throttle-debounce';
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
const reportBackendStatusToAllWindows = debounce(300, async (dbName, payload) => {
    return await notifyAllWindows(`db-${dbName}-status`, payload);
});
const reportModifiedDataToAllWindows = debounce(400, async (modelName, changedIDs) => {
    // TODO: If too many update calls with one ID affect performance,
    // debounce this function, combining shorter ID lists and reporting more of them at once
    console.debug("Reporting modified data", modelName, changedIDs);
    return await notifyAllWindows(`model-${modelName}-objects-changed`, { ids: changedIDs });
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9hcHAvbWFpbi50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSwrREFBK0Q7QUFDL0QsT0FBTyxLQUFLLE1BQU0sWUFBWSxDQUFDO0FBQzlCLE1BQWMsQ0FBQyxLQUFLLEdBQUcsS0FBSyxDQUFDO0FBQzlCLE9BQU8sRUFBRSxRQUFRLEVBQUUsTUFBTSxtQkFBbUIsQ0FBQztBQUU3QyxPQUFPLEVBQUUsR0FBRyxFQUFPLE1BQU0sVUFBVSxDQUFDO0FBQ3BDLE9BQU8sS0FBSyxHQUFHLE1BQU0sY0FBYyxDQUFDO0FBS3BDLE9BQU8sRUFBRSxjQUFjLEVBQUUsTUFBTSxrQkFBa0IsQ0FBQztBQUNsRCxPQUFPLEVBQUUsZ0JBQWdCLEVBQXNCLE1BQU0sZ0JBQWdCLENBQUM7QUFDdEUsT0FBTyxFQUFFLE1BQU0sRUFBRSxNQUFNLGFBQWEsQ0FBQztBQU9yQyxPQUFPLEVBQUUsa0JBQWtCLEVBQUUsTUFBTSxhQUFhLENBQUM7QUFDakQsT0FBTyxFQUFFLFVBQVUsRUFBRSxXQUFXLEVBQUUsTUFBTSxnQkFBZ0IsQ0FBQztBQUd6RCxNQUFNLENBQUMsSUFBSSxJQUF1QixDQUFDO0FBR25DLE1BQU0sQ0FBQyxNQUFNLFFBQVEsR0FBRyxLQUFLLEVBQTZCLE1BQVMsRUFBNEIsRUFBRTtJQUUvRix3REFBd0Q7SUFDeEQsR0FBRyxDQUFDLEVBQUUsQ0FBQyxtQkFBbUIsRUFBRSxDQUFDLENBQU0sRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLGNBQWMsRUFBRSxDQUFDLENBQUM7SUFFNUQsR0FBRyxDQUFDLFdBQVcsQ0FBQyxFQUFFLFVBQVUsRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDO0lBRXRDLElBQUksTUFBTSxDQUFDLEdBQUcsQ0FBQyxjQUFjLEVBQUU7UUFDN0IsZ0ZBQWdGO1FBQ2hGLGtDQUFrQztRQUNsQyxJQUFJLENBQUMsR0FBRyxDQUFDLHlCQUF5QixFQUFFLEVBQUU7WUFD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Q2pFLHdGQUF3RjtJQUN4RixPQUFPLENBQUMsS0FBSyxDQUFDLHlCQUF5QixFQUFFLFNBQVMsRUFBRSxVQUFVLENBQUMsQ0FBQTtJQUMvRCxPQUFPLE1BQU0sZ0JBQWdCLENBQUMsU0FBUyxTQUFTLGtCQUFrQixFQUFFLEVBQUUsR0FBRyxFQUFFLFVBQVUsRUFBRSxDQUFDLENBQUM7QUFDM0YsQ0FBQyxDQUFDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvLyBKdXJ5LXJpZyBnbG9iYWwuZmV0Y2ggdG8gbWFrZSBJc29tb3JwaGljIEdpdCB3b3JrIHVuZGVyIE5vZGVcbmltcG9ydCBmZXRjaCBmcm9tICdub2RlLWZldGNoJztcbihnbG9iYWwgYXMgYW55KS5mZXRjaCA9IGZldGNoO1xuaW1wb3J0IHsgZGVib3VuY2UgfSBmcm9tICd0aHJvdHRsZS1kZWJvdW5jZSc7XG5cbmltcG9ydCB7IGFwcCwgQXBwIH0gZnJvbSAnZWxlY3Ryb24nO1xuaW1wb3J0ICogYXMgbG9nIGZyb20gJ2VsZWN0cm9uLWxvZyc7XG5cbmltcG9ydCB7IEFwcENvbmZpZywgV2luZG93IH0gZnJvbSAnLi4vY29uZmlnL2FwcCc7XG5cbmltcG9ydCB7IE1haW5Db25maWcgfSBmcm9tICcuLi9jb25maWcvbWFpbic7XG5pbXBvcnQgeyBTZXR0aW5nTWFuYWdlciB9IGZyb20gJy4uL3NldHRpbmdzL21haW4nO1xuaW1wb3J0IHsgbm90aWZ5QWxsV2luZG93cywgV2luZG93T3BlbmVyUGFyYW1zIH0gZnJvbSAnLi4vbWFpbi93aW5kb3cnO1xuaW1wb3J0IHsgbGlzdGVuIH0gZnJvbSAnLi4vaXBjL21haW4nO1xuaW1wb3J0IHtcbiAgQmFja2VuZCxcbiAgTW9kZWxNYW5hZ2VyLFxuICBCYWNrZW5kQ2xhc3MgYXMgRGF0YWJhc2VCYWNrZW5kQ2xhc3MsXG59IGZyb20gJy4uL2RiL21haW4vYmFzZSc7XG5cbmltcG9ydCB7IG1ha2VXaW5kb3dFbmRwb2ludCB9IGZyb20gJy4uL2lwYy9tYWluJztcbmltcG9ydCB7IG9wZW5XaW5kb3csIGNsb3NlV2luZG93IH0gZnJvbSAnLi4vbWFpbi93aW5kb3cnO1xuXG5cbmV4cG9ydCBsZXQgbWFpbjogTWFpbkFwcDxhbnksIGFueT47XG5cblxuZXhwb3J0IGNvbnN0IGluaXRNYWluID0gYXN5bmMgPEMgZXh0ZW5kcyBNYWluQ29uZmlnPGFueT4+KGNvbmZpZzogQyk6IFByb21pc2U8TWFpbkFwcDxhbnksIEM+PiA9PiB7XG5cbiAgLy8gUHJldmVudCB3aW5kb3dzIGZyb20gY2xvc2luZyB3aGlsZSBhcHAgaXMgaW5pdGlhbGl6ZWRcbiAgYXBwLm9uKCd3aW5kb3ctYWxsLWNsb3NlZCcsIChlOiBhbnkpID0+IGUucHJldmVudERlZmF1bHQoKSk7XG5cbiAgbG9nLmNhdGNoRXJyb3JzKHsgc2hvd0RpYWxvZzogdHJ1ZSB9KTtcblxuICBpZiAoY29uZmlnLmFwcC5zaW5nbGVJbnN0YW5jZSkge1xuICAgIC8vIEVuc3VyZSBvbmx5IG9uZSBpbnN0YW5jZSBvZiB0aGUgYXBwIGNhbiBydW4gYXQgYSB0aW1lIG9uIGdpdmVuIHVzZXLigJlzIG1hY2hpbmVcbiAgICAvLyBieSBleGl0aW5nIGFueSBmdXR1cmUgaW5zdGFuY2VzXG4gICAgaWYgKCFhcHAucmVxdWVzdFNpbmdsZUluc3RhbmNlTG9jaygpKSB7XG4gICAgICBhcHAuZXhpdCgwKTtcbiAgICB9XG4gIH1cblxuXG4gIC8qIEhlbHBlciBmdW5jdGlvbnMgKi9cblxuICBmdW5jdGlvbiBfb3BlbldpbmRvdyh3aW5kb3dOYW1lOiBrZXlvZiB0eXBlb2YgY29uZmlnLmFwcC53aW5kb3dzLCBleHRyYUNvbXBvbmVudFBhcmFtczogc3RyaW5nID0gJycpIHtcbiAgICBsb2cudmVyYm9zZShgQy9tYWluOiBPcGVuaW5nIHdpbmRvdyAke1N0cmluZyh3aW5kb3dOYW1lKX1gKTtcblxuICAgIGNvbnN0IGRlZmF1bHRQYXJhbXMgPSBjb25maWcuYXBwLndpbmRvd3Nbd2luZG93TmFtZV0ub3BlbmVyUGFyYW1zO1xuXG4gICAgY29uc3Qgb3BlbmVyUGFyYW1zID0ge1xuICAgICAgLi4uZGVmYXVsdFBhcmFtcyxcbiAgICAgIGNvbXBvbmVudFBhcmFtczogYCR7ZGVmYXVsdFBhcmFtcy5jb21wb25lbnRQYXJhbXN9JiR7ZXh0cmFDb21wb25lbnRQYXJhbXN9YCxcbiAgICB9O1xuXG4gICAgcmV0dXJuIG9wZW5XaW5kb3coe1xuICAgICAgLi4ub3BlbmVyUGFyYW1zLFxuICAgICAgY29tcG9uZW50OiB3aW5kb3dOYW1lLFxuICAgICAgY29uZmlnOiBjb25maWcuYXBwLFxuICAgIH0pO1xuICB9XG5cbiAgZnVuY3Rpb24gX2Nsb3NlV2luZG93KHdpbmRvd05hbWU6IGtleW9mIHR5cGVvZiBjb25maWcuYXBwLndpbmRvd3MpIHtcbiAgICBsb2cudmVyYm9zZShgQy9tYWluOiBDbG9zaW5nIHdpbmRvdyAke1N0cmluZyh3aW5kb3dOYW1lKX1gKTtcblxuICAgIGNsb3NlV2luZG93KGNvbmZpZy5hcHAud2luZG93c1t3aW5kb3dOYW1lXS5vcGVuZXJQYXJhbXMudGl0bGUpO1xuICB9XG5cbiAgZnVuY3Rpb24gX3JlcXVlc3RTZXR0aW5ncyhzZXR0aW5nSURzOiBzdHJpbmdbXSk6IFByb21pc2U8dm9pZD4ge1xuICAgIC8qIE9wZW4gc2V0dGluZ3Mgd2luZG93LCBwcm9tcHRpbmcgdGhlIHVzZXJcbiAgICAgICB0byBmaWxsIGluIHBhcmFtZXRlcnMgcmVxdWlyZWQgZm9yIGFwcGxpY2F0aW9uXG4gICAgICAgdG8gcGVyZm9ybSBhIGZ1bmN0aW9uLlxuICAgICAgIFRoZSB3aW5kb3cgaXMgZXhwZWN0ZWQgdG8gdXNlIGNvbW1pdFNldHRpbmcgSVBDIGNhbGxzLFxuICAgICAgIHdoaWNoIGlzIGhvdyBkZWZhdWx0IHNldHRpbmdzIHdpZGdldHMgd29yay4gKi9cblxuICAgIGNvbnN0IHNldHRpbmdzV2luZG93ID0gY29uZmlnLmFwcC53aW5kb3dzW2NvbmZpZy5hcHAuc2V0dGluZ3NXaW5kb3dJRF07XG4gICAgaWYgKHNldHRpbmdzV2luZG93KSB7XG4gICAgICByZXR1cm4gbmV3IFByb21pc2U8dm9pZD4oYXN5bmMgKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuXG4gICAgICAgIGNvbnN0IG9wZW5lZFdpbmRvdyA9IGF3YWl0IF9vcGVuV2luZG93KFxuICAgICAgICAgIGNvbmZpZy5hcHAuc2V0dGluZ3NXaW5kb3dJRCxcbiAgICAgICAgICBgcmVxdWlyZWRTZXR0aW5ncz0ke3NldHRpbmdJRHMuam9pbignLCcpfWApO1xuXG4gICAgICAgIG9wZW5lZFdpbmRvdy5vbignY2xvc2VkJywgKCkgPT4ge1xuICAgICAgICAgIGNvbnN0IG1pc3NpbmdSZXF1aXJlZFNldHRpbmdzID0gc2V0dGluZ0lEcy5cbiAgICAgICAgICAgIG1hcCgoc2V0dGluZ0lEKSA9PiAgc2V0dGluZ3MuZ2V0VmFsdWUoc2V0dGluZ0lEKSkuXG4gICAgICAgICAgICBmaWx0ZXIoKHNldHRpbmdWYWwpID0+IHNldHRpbmdWYWwgPT09IHVuZGVmaW5lZCk7XG4gICAgICAgICAgaWYgKG1pc3NpbmdSZXF1aXJlZFNldHRpbmdzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIGxvZy53YXJuKFxuICAgICAgICAgICAgICBcIkMvbWFpbjogVXNlciBjbG9zZWQgc2V0dGluZ3Mgd2luZG93IHdpdGggbWlzc2luZyBzZXR0aW5ncyBsZWZ0XCIsXG4gICAgICAgICAgICAgIG1pc3NpbmdSZXF1aXJlZFNldHRpbmdzKVxuICAgICAgICAgICAgcmVqZWN0KCk7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGxvZy52ZXJib3NlKFwiQy9tYWluOiBVc2VyIHByb3ZpZGVyIGFsbCBtaXNzaW5nIHNldHRpbmdzXCIpXG4gICAgICAgICAgICByZXNvbHZlKCk7XG4gICAgICAgICAgfVxuICAgICAgICB9KVxuXG4gICAgICB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiU2V0dGluZ3Mgd2VyZSByZXF1ZXN0ZWQsIGJ1dCBzZXR0aW5ncyB3aW5kb3cgaXMgbm90IHNwZWNpZmllZFwiKTtcbiAgICB9XG4gIH1cblxuICAvLyBUT0RPOiBUaGlzIHdvcmthcm91bmQgbWF5IG9yIG1heSBub3QgYmUgbmVjZXNzYXJ5XG4gIGlmIChjb25maWcuZGlzYWJsZUdQVSkge1xuICAgIGFwcC5kaXNhYmxlSGFyZHdhcmVBY2NlbGVyYXRpb24oKTtcbiAgfVxuXG4gIC8vIENhdGNoIHVuaGFuZGxlZCBlcnJvcnMgaW4gZWxlY3Ryb24tbG9nXG4gIGxvZy5jYXRjaEVycm9ycyh7IHNob3dEaWFsb2c6IHRydWUgfSk7XG5cbiAgYXdhaXQgYXBwLndoZW5SZWFkeSgpO1xuXG4gIC8vIFNob3cgc3BsYXNoIHdpbmRvdywgaWYgY29uZmlndXJlZFxuICBjb25zdCBzcGxhc2hXaW5kb3cgPSBjb25maWcuYXBwLndpbmRvd3NbY29uZmlnLmFwcC5zcGxhc2hXaW5kb3dJRF07XG4gIGlmIChzcGxhc2hXaW5kb3cpIHtcbiAgICBfb3BlbldpbmRvdyhjb25maWcuYXBwLnNwbGFzaFdpbmRvd0lEKTtcbiAgfVxuXG4gIGNvbnN0IGlzTWFjT1MgPSBwcm9jZXNzLnBsYXRmb3JtID09PSAnZGFyd2luJztcbiAgY29uc3QgaXNEZXZlbG9wbWVudCA9IHByb2Nlc3MuZW52Lk5PREVfRU5WICE9PSAncHJvZHVjdGlvbicgfHwgY29uZmlnLmFwcC5mb3JjZURldmVsb3BtZW50TW9kZTtcblxuICBjb25zdCBzZXR0aW5ncyA9IG5ldyBTZXR0aW5nTWFuYWdlcihjb25maWcuYXBwRGF0YVBhdGgsIGNvbmZpZy5zZXR0aW5nc0ZpbGVOYW1lKTtcbiAgc2V0dGluZ3Muc2V0VXBJUEMoKTtcblxuXG4gIC8vIFByZXBhcmUgZGF0YWJhc2UgYmFja2VuZHMgJiByZXF1ZXN0IGNvbmZpZ3VyYXRpb24gaWYgbmVlZGVkXG5cbiAgbG9nLmRlYnVnKFwiQy9pbml0TWFpbjogREI6IFJlYWRpbmcgYmFja2VuZCBjb25maWdcIiwgY29uZmlnLmRhdGFiYXNlcyk7XG5cbiAgdHlwZSBCYWNrZW5kSW5mbyA9IHtcbiAgICBkYk5hbWU6IHN0cmluZ1xuICAgIGJhY2tlbmRDbGFzczogRGF0YWJhc2VCYWNrZW5kQ2xhc3M8YW55LCBhbnksIGFueT5cbiAgICBiYWNrZW5kT3B0aW9uczogYW55XG4gIH07XG4gIGxldCBkYkJhY2tlbmRDbGFzc2VzOiBCYWNrZW5kSW5mb1tdO1xuICBkYkJhY2tlbmRDbGFzc2VzID0gKGF3YWl0IFByb21pc2UuYWxsKE9iamVjdC5lbnRyaWVzKGNvbmZpZy5kYXRhYmFzZXMpLm1hcChcbiAgICBhc3luYyAoW2RiTmFtZSwgZGJDb25mXSkgPT4ge1xuICAgICAgbG9nLmRlYnVnKFwiQy9pbml0TWFpbjogREI6IFJlYWRpbmcgYmFja2VuZCBjb25maWdcIiwgZGJOYW1lLCBkYkNvbmYpO1xuXG4gICAgICBjb25zdCBEQkJhY2tlbmRDbGFzcyA9IGRiQ29uZi5iYWNrZW5kO1xuICAgICAgaWYgKERCQmFja2VuZENsYXNzLnJlZ2lzdGVyU2V0dGluZ3NGb3JDb25maWd1cmFibGVPcHRpb25zKSB7XG4gICAgICAgIERCQmFja2VuZENsYXNzLnJlZ2lzdGVyU2V0dGluZ3NGb3JDb25maWd1cmFibGVPcHRpb25zKHNldHRpbmdzLCBkYkNvbmYub3B0aW9ucywgZGJOYW1lKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiB7XG4gICAgICAgIGRiTmFtZTogZGJOYW1lLFxuICAgICAgICBiYWNrZW5kQ2xhc3M6IERCQmFja2VuZENsYXNzLFxuICAgICAgICBiYWNrZW5kT3B0aW9uczogZGJDb25mLm9wdGlvbnMsXG4gICAgICB9O1xuICAgIH1cbiAgKSkpO1xuXG5cbiAgLy8gUmVxdWVzdCBzZXR0aW5ncyBmcm9tIHVzZXIgdmlhIGFuIGluaXRpYWwgY29uZmlndXJhdGlvbiB3aW5kb3csIGlmIHJlcXVpcmVkXG5cbiAgY29uc3QgbWlzc2luZ1NldHRpbmdzID0gYXdhaXQgc2V0dGluZ3MubGlzdE1pc3NpbmdSZXF1aXJlZFNldHRpbmdzKCk7XG4gIC8vIExpc3Qgb2YgSURzIG9mIHNldHRpbmdzIHRoYXQgbmVlZCB0byBiZSBmaWxsZWQgb3V0LlxuXG4gIGlmIChtaXNzaW5nU2V0dGluZ3MubGVuZ3RoID4gMCkge1xuICAgIGxvZy52ZXJib3NlKFwiQy9pbml0TWFpbjogTWlzc2luZyBzZXR0aW5ncyBwcmVzZW50LCByZXF1ZXN0aW5nIGZyb20gdGhlIHVzZXJcIiwgbWlzc2luZ1NldHRpbmdzKTtcbiAgICBhd2FpdCBfcmVxdWVzdFNldHRpbmdzKG1pc3NpbmdTZXR0aW5ncyk7XG4gIH0gZWxzZSB7XG4gICAgbG9nLmRlYnVnKFwiQy9pbml0TWFpbjogTm8gbWlzc2luZyBzZXR0aW5ncyBmb3VuZFwiKTtcbiAgfVxuXG5cbiAgLy8gQ29uc3RydWN0IGRhdGFiYXNlIGJhY2tlbmQgaW5zdGFuY2VzXG5cbiAgdHlwZSBEQnMgPSBNYWluQXBwPGFueSwgQz5bXCJkYXRhYmFzZXNcIl07XG4gIGxldCBkYXRhYmFzZXM6IERCc1xuXG4gIHRyeSB7XG4gICAgZGF0YWJhc2VzID0gKGF3YWl0IFByb21pc2UuYWxsKGRiQmFja2VuZENsYXNzZXMubWFwKFxuICAgICAgYXN5bmMgKHsgZGJOYW1lLCBiYWNrZW5kQ2xhc3MsIGJhY2tlbmRPcHRpb25zIH0pID0+IHtcbiAgICAgICAgY29uc3QgREJCYWNrZW5kQ2xhc3MgPSBiYWNrZW5kQ2xhc3M7XG5cbiAgICAgICAgbG9nLnZlcmJvc2UoXCJDL2luaXRNYWluOiBEQjogQ29tcGxldGluZyBiYWNrZW5kIG9wdGlvbnMgZnJvbVwiLCBiYWNrZW5kT3B0aW9ucyk7XG5cbiAgICAgICAgbGV0IG9wdGlvbnM6IGFueTtcbiAgICAgICAgaWYgKERCQmFja2VuZENsYXNzLmNvbXBsZXRlT3B0aW9uc0Zyb21TZXR0aW5ncykge1xuICAgICAgICAgIG9wdGlvbnMgPSBhd2FpdCBEQkJhY2tlbmRDbGFzcy5jb21wbGV0ZU9wdGlvbnNGcm9tU2V0dGluZ3MoXG4gICAgICAgICAgICBzZXR0aW5ncyxcbiAgICAgICAgICAgIGJhY2tlbmRPcHRpb25zLFxuICAgICAgICAgICAgZGJOYW1lKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBvcHRpb25zID0gYmFja2VuZE9wdGlvbnM7XG4gICAgICAgIH1cblxuICAgICAgICBsb2cudmVyYm9zZShcIkMvaW5pdE1haW46IERCOiBJbml0aWFsaXppbmcgYmFja2VuZCB3aXRoIG9wdGlvbnNcIiwgYmFja2VuZE9wdGlvbnMpO1xuXG4gICAgICAgIGNvbnN0IGJhY2tlbmQgPSBuZXcgREJCYWNrZW5kQ2xhc3MoXG4gICAgICAgICAgIG9wdGlvbnMsXG4gICAgICAgICAgIGFzeW5jIChwYXlsb2FkOiBhbnkpID0+IGF3YWl0IHJlcG9ydEJhY2tlbmRTdGF0dXNUb0FsbFdpbmRvd3MoZGJOYW1lLCBwYXlsb2FkKSk7XG5cbiAgICAgICAgaWYgKGJhY2tlbmQuc2V0VXBJUEMpIHtcbiAgICAgICAgICBiYWNrZW5kLnNldFVwSVBDKGRiTmFtZSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBbZGJOYW1lXTogYmFja2VuZCB9O1xuICAgICAgfVxuICAgICkpKS5yZWR1Y2UoKHZhbCwgYWNjKSA9PiAoeyAuLi5hY2MsIC4uLnZhbCB9KSwge30gYXMgUGFydGlhbDxEQnM+KSBhcyBEQnM7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBsb2cuZXJyb3IoXCJDL2luaXRNYWluOiBGYWlsZWQgdG8gaW5pdGlhbGl6ZSBkYXRhYmFzZSBiYWNrZW5kc1wiKTtcbiAgICB0aHJvdyBlO1xuICB9XG5cblxuICAvLyBJbml0aWFsaXplIG1vZGVsIG1hbmFnZXJzXG5cbiAgbG9nLmRlYnVnKFwiQy9pbml0TWFpbjogSW5pdGlhbGl6aW5nIGRhdGEgbW9kZWwgbWFuYWdlcnNcIiwgY29uZmlnLm1hbmFnZXJzKVxuXG4gIHR5cGUgTWFuYWdlcnMgPSBNYWluQXBwPGFueSwgQz5bXCJtYW5hZ2Vyc1wiXTtcbiAgbGV0IG1hbmFnZXJzOiBNYW5hZ2VycztcblxuICBtYW5hZ2VycyA9IChhd2FpdCBQcm9taXNlLmFsbChPYmplY3QuZW50cmllcyhjb25maWcubWFuYWdlcnMpLm1hcChcbiAgICBhc3luYyAoW21vZGVsTmFtZSwgbWFuYWdlckNvbmZdKSA9PiB7XG4gICAgICBjb25zdCBtb2RlbEluZm8gPSBjb25maWcuYXBwLmRhdGFbbW9kZWxOYW1lXTtcblxuICAgICAgbG9nLnZlcmJvc2UoXCJDL2luaXRNYWluOiBJbml0aWFsaXppbmcgbW9kZWwgbWFuYWdlciBmb3IgREJcIiwgbWFuYWdlckNvbmYuZGJOYW1lLCBkYXRhYmFzZXMpO1xuXG4gICAgICBjb25zdCBkYiA9IGRhdGFiYXNlc1ttYW5hZ2VyQ29uZi5kYk5hbWVdO1xuICAgICAgY29uc3QgTWFuYWdlckNsYXNzID0gbWFuYWdlckNvbmYub3B0aW9ucy5jbHM7XG4gICAgICBjb25zdCBtYW5hZ2VyID0gbmV3IE1hbmFnZXJDbGFzcyhcbiAgICAgICAgZGIsIG1hbmFnZXJDb25mLm9wdGlvbnMsIG1vZGVsSW5mbyxcbiAgICAgICAgYXN5bmMgKGNoYW5nZWRJRHM/OiBhbnlbXSkgPT4gYXdhaXQgcmVwb3J0TW9kaWZpZWREYXRhVG9BbGxXaW5kb3dzKG1vZGVsTmFtZSwgY2hhbmdlZElEcz8ubWFwKGlkID0+IGAke2lkfWApKSk7XG5cbiAgICAgIGlmIChtYW5hZ2VyLnNldFVwSVBDKSB7XG4gICAgICAgIG1hbmFnZXIuc2V0VXBJUEMobW9kZWxOYW1lKTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHsgW21vZGVsTmFtZV06IG1hbmFnZXIgfTtcbiAgICB9XG4gICkpKVxuICAucmVkdWNlKCh2YWwsIGFjYykgPT4gKHsgLi4uYWNjLCAuLi52YWwgfSksIHt9IGFzIFBhcnRpYWw8TWFuYWdlcnM+KSBhcyBNYW5hZ2VycztcblxuXG4gIGxpc3Rlbjx7IGlkOiBrZXlvZiB0eXBlb2YgY29uZmlnLmFwcC53aW5kb3dzLCBwYXJhbXM/OiBPbWl0PFdpbmRvd09wZW5lclBhcmFtcywgJ2NvbXBvbmVudCc+IH0sIHt9PlxuICAoJ29wZW4tcHJlZGVmaW5lZC13aW5kb3cnLCBhc3luYyAoeyBpZCwgcGFyYW1zIH0pID0+IHtcbiAgICBjb25zdCBwYXJhbXNXaXRoRGVmYXVsdHMgPSB7IC4uLmNvbmZpZy5hcHAud2luZG93c1tpZF0ub3BlbmVyUGFyYW1zLCAuLi5wYXJhbXMgfHwge319O1xuICAgIG9wZW5XaW5kb3cocGFyYW1zV2l0aERlZmF1bHRzKTtcbiAgICByZXR1cm4ge307XG4gIH0pO1xuXG5cbiAgbGlzdGVuPFdpbmRvd09wZW5lclBhcmFtcywge30+XG4gICgnb3Blbi1hcmJpdHJhcnktd2luZG93JywgYXN5bmMgKHBhcmFtcykgPT4ge1xuICAgIG9wZW5XaW5kb3cocGFyYW1zKTtcbiAgICByZXR1cm4ge307XG4gIH0pO1xuXG5cbiAgLy8gSW5pdGlhbGl6ZSB3aW5kb3ctb3BlbmluZyBlbmRwb2ludHNcbiAgZm9yIChjb25zdCBbd2luZG93TmFtZSwgd2luZG93XSBvZiBPYmplY3QuZW50cmllcyhjb25maWcuYXBwLndpbmRvd3MpKSB7XG4gICAgbWFrZVdpbmRvd0VuZHBvaW50KHdpbmRvd05hbWUsICgpID0+ICh7XG4gICAgICAuLi4od2luZG93IGFzIFdpbmRvdykub3BlbmVyUGFyYW1zLFxuICAgICAgY29tcG9uZW50OiB3aW5kb3dOYW1lLFxuICAgICAgY29uZmlnOiBjb25maWcuYXBwLFxuICAgIH0pKTtcbiAgfVxuXG4gIC8vIE9wZW4gbWFpbiB3aW5kb3dcbiAgYXdhaXQgX29wZW5XaW5kb3coJ2RlZmF1bHQnKTtcblxuICAvLyBEQiBiYWNrZW5kIGluaXRpYWxpemF0aW9uIGhhcHBlbnMgYWZ0ZXIgdGhlIGFwcCBpcyByZWFkeSxcbiAgLy8gc2luY2UgaXQgbWF5IHJlcXVpcmUgdXNlciBpbnB1dCAoYW5kIGhlbmNlIEdVSSBpbnRlcmFjdGlvbilcbiAgLy8gb2Ygc2Vuc2l0aXZlIGRhdGEgbm90IHN1aXRhYmxlIGZvciBzZXR0aW5ncyxcbiAgLy8gbmFtZWx5IGF1dGhlbnRpY2F0aW9uIGtleXMgaWYgZGF0YSBzb3VyY2UgcmVxdWlyZXMgYXV0aC5cbiAgLy8gVE9ETzogVGVhY2hpbmcgdGhlIGZyYW1ld29yayB0byBlbmNyeXB0IHNldHRpbmdzXG4gIC8vIG1pZ2h0IGxldCB1cyBtYWtlIGF1dGhlbnRpY2F0aW9uIGRhdGEgZW50cnlcbiAgLy8gcGFydCBvZiByZXF1aXJlZCBzZXR0aW5ncyBlbnRyeVxuICAvLyBhbmQgc3RhcnQgZGF0YSBzb3VyY2UgaW5pdGlhbGl6YXRpb24gZWFybHkuXG4gIGZvciAoY29uc3QgW2JhY2tlbmRJRCwgYmFja2VuZF0gb2YgT2JqZWN0LmVudHJpZXMoZGF0YWJhc2VzKSkge1xuICAgIGxvZy5kZWJ1ZyhcIkMvaW5pdE1haW46IEluaXRpYWxpemluZyBEQiBiYWNrZW5kXCIsIGJhY2tlbmRJRCk7XG4gICAgYXdhaXQgYmFja2VuZC5pbml0KCk7XG4gIH1cblxuICBpZiAoc3BsYXNoV2luZG93KSB7XG4gICAgX2Nsb3NlV2luZG93KGNvbmZpZy5hcHAuc3BsYXNoV2luZG93SUQpO1xuICB9XG5cbiAgbWFpbiA9IHtcbiAgICBhcHAsXG4gICAgaXNNYWNPUyxcbiAgICBpc0RldmVsb3BtZW50LFxuICAgIG1hbmFnZXJzLFxuICAgIGRhdGFiYXNlcyxcbiAgICBvcGVuV2luZG93OiBfb3BlbldpbmRvdyxcbiAgfSBhcyBNYWluQXBwPGFueSwgYW55PjtcblxuICByZXR1cm4gbWFpbiBhcyBNYWluQXBwPHR5cGVvZiBjb25maWcuYXBwLCB0eXBlb2YgY29uZmlnPjtcbn07XG5cblxuY29uc3QgcmVwb3J0QmFja2VuZFN0YXR1c1RvQWxsV2luZG93cyA9IGRlYm91bmNlKDMwMCwgYXN5bmMgKGRiTmFtZTogc3RyaW5nLCBwYXlsb2FkOiBvYmplY3QpID0+IHtcbiAgcmV0dXJuIGF3YWl0IG5vdGlmeUFsbFdpbmRvd3MoYGRiLSR7ZGJOYW1lfS1zdGF0dXNgLCBwYXlsb2FkKTtcbn0pO1xuXG5cbmNvbnN0IHJlcG9ydE1vZGlmaWVkRGF0YVRvQWxsV2luZG93cyA9IGRlYm91bmNlKDQwMCwgYXN5bmMgKG1vZGVsTmFtZTogc3RyaW5nLCBjaGFuZ2VkSURzPzogc3RyaW5nW10pID0+IHtcbiAgLy8gVE9ETzogSWYgdG9vIG1hbnkgdXBkYXRlIGNhbGxzIHdpdGggb25lIElEIGFmZmVjdCBwZXJmb3JtYW5jZSxcbiAgLy8gZGVib3VuY2UgdGhpcyBmdW5jdGlvbiwgY29tYmluaW5nIHNob3J0ZXIgSUQgbGlzdHMgYW5kIHJlcG9ydGluZyBtb3JlIG9mIHRoZW0gYXQgb25jZVxuICBjb25zb2xlLmRlYnVnKFwiUmVwb3J0aW5nIG1vZGlmaWVkIGRhdGFcIiwgbW9kZWxOYW1lLCBjaGFuZ2VkSURzKVxuICByZXR1cm4gYXdhaXQgbm90aWZ5QWxsV2luZG93cyhgbW9kZWwtJHttb2RlbE5hbWV9LW9iamVjdHMtY2hhbmdlZGAsIHsgaWRzOiBjaGFuZ2VkSURzIH0pO1xufSk7XG5cblxuZXhwb3J0IGludGVyZmFjZSBNYWluQXBwPEEgZXh0ZW5kcyBBcHBDb25maWcsIE0gZXh0ZW5kcyBNYWluQ29uZmlnPEE+PiB7XG4gIC8qIE9iamVjdCByZXR1cm5lZCBieSBpbml0TWFpbi4gKi9cblxuICBhcHA6IEFwcFxuICBpc01hY09TOiBib29sZWFuXG4gIGlzRGV2ZWxvcG1lbnQ6IGJvb2xlYW5cbiAgbWFuYWdlcnM6IFJlY29yZDxrZXlvZiBBW1wiZGF0YVwiXSwgTW9kZWxNYW5hZ2VyPGFueSwgYW55Pj5cbiAgZGF0YWJhc2VzOiBSZWNvcmQ8a2V5b2YgTVtcImRhdGFiYXNlc1wiXSwgQmFja2VuZD5cbiAgb3BlbldpbmRvdzogKHdpbmRvd05hbWU6IGtleW9mIEFbXCJ3aW5kb3dzXCJdKSA9PiB2b2lkXG59XG4iXX0=