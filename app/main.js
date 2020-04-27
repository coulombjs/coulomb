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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9hcHAvbWFpbi50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSwrREFBK0Q7QUFDL0QsT0FBTyxLQUFLLE1BQU0sWUFBWSxDQUFDO0FBQzlCLE1BQWMsQ0FBQyxLQUFLLEdBQUcsS0FBSyxDQUFDO0FBRTlCLE9BQU8sRUFBRSxHQUFHLEVBQU8sTUFBTSxVQUFVLENBQUM7QUFDcEMsT0FBTyxLQUFLLEdBQUcsTUFBTSxjQUFjLENBQUM7QUFLcEMsT0FBTyxFQUFFLGNBQWMsRUFBRSxNQUFNLGtCQUFrQixDQUFDO0FBQ2xELE9BQU8sRUFBRSxnQkFBZ0IsRUFBc0IsTUFBTSxnQkFBZ0IsQ0FBQztBQUN0RSxPQUFPLEVBQUUsTUFBTSxFQUFFLE1BQU0sYUFBYSxDQUFDO0FBT3JDLE9BQU8sRUFBRSxrQkFBa0IsRUFBRSxNQUFNLGFBQWEsQ0FBQztBQUNqRCxPQUFPLEVBQUUsVUFBVSxFQUFFLFdBQVcsRUFBRSxNQUFNLGdCQUFnQixDQUFDO0FBR3pELE1BQU0sQ0FBQyxJQUFJLElBQXVCLENBQUM7QUFHbkMsTUFBTSxDQUFDLE1BQU0sUUFBUSxHQUFHLEtBQUssRUFBNkIsTUFBUyxFQUE0QixFQUFFO0lBRS9GLHdEQUF3RDtJQUN4RCxHQUFHLENBQUMsRUFBRSxDQUFDLG1CQUFtQixFQUFFLENBQUMsQ0FBTSxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsY0FBYyxFQUFFLENBQUMsQ0FBQztJQUU1RCxHQUFHLENBQUMsV0FBVyxDQUFDLEVBQUUsVUFBVSxFQUFFLElBQUksRUFBRSxDQUFDLENBQUM7SUFFdEMsSUFBSSxNQUFNLENBQUMsR0FBRyxDQUFDLGNBQWMsRUFBRTtRQUM3QixnRkFBZ0Y7UUFDaEYsa0NBQWtDO1FBQ2xDLElBQUksQ0FBQyxHQUFHLENBQUMseUJBQXlCLEVBQUUsRUFBRTtZQUNwQyxHQUFHLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO1NBQ2I7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TSxNQUFNLFNBQVMsRUFBRSxPQUFPLENBQUMsQ0FBQztBQUNoRSxDQUFDLENBQUM7QUFHRixNQUFNLDhCQUE4QixHQUFHLEtBQUssRUFBRSxTQUFpQixFQUFFLFVBQXFCLEVBQUUsRUFBRTtJQUN4RixpRUFBaUU7SUFDakUsd0ZBQXdGO0lBQ3hGLEdBQUcsQ0FBQyxLQUFLLENBQUMsaUNBQWlDLEVBQUUsU0FBUyxFQUFFLFVBQVUsQ0FBQyxDQUFDO0lBQ3BFLE9BQU8sTUFBTSxnQkFBZ0IsQ0FBQyxTQUFTLFNBQVMsa0JBQWtCLEVBQUUsRUFBRSxHQUFHLEVBQUUsVUFBVSxFQUFFLENBQUMsQ0FBQztBQUMzRixDQUFDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvLyBKdXJ5LXJpZyBnbG9iYWwuZmV0Y2ggdG8gbWFrZSBJc29tb3JwaGljIEdpdCB3b3JrIHVuZGVyIE5vZGVcbmltcG9ydCBmZXRjaCBmcm9tICdub2RlLWZldGNoJztcbihnbG9iYWwgYXMgYW55KS5mZXRjaCA9IGZldGNoO1xuXG5pbXBvcnQgeyBhcHAsIEFwcCB9IGZyb20gJ2VsZWN0cm9uJztcbmltcG9ydCAqIGFzIGxvZyBmcm9tICdlbGVjdHJvbi1sb2cnO1xuXG5pbXBvcnQgeyBBcHBDb25maWcsIFdpbmRvdyB9IGZyb20gJy4uL2NvbmZpZy9hcHAnO1xuXG5pbXBvcnQgeyBNYWluQ29uZmlnIH0gZnJvbSAnLi4vY29uZmlnL21haW4nO1xuaW1wb3J0IHsgU2V0dGluZ01hbmFnZXIgfSBmcm9tICcuLi9zZXR0aW5ncy9tYWluJztcbmltcG9ydCB7IG5vdGlmeUFsbFdpbmRvd3MsIFdpbmRvd09wZW5lclBhcmFtcyB9IGZyb20gJy4uL21haW4vd2luZG93JztcbmltcG9ydCB7IGxpc3RlbiB9IGZyb20gJy4uL2lwYy9tYWluJztcbmltcG9ydCB7XG4gIEJhY2tlbmQsXG4gIE1vZGVsTWFuYWdlcixcbiAgQmFja2VuZENsYXNzIGFzIERhdGFiYXNlQmFja2VuZENsYXNzLFxufSBmcm9tICcuLi9kYi9tYWluL2Jhc2UnO1xuXG5pbXBvcnQgeyBtYWtlV2luZG93RW5kcG9pbnQgfSBmcm9tICcuLi9pcGMvbWFpbic7XG5pbXBvcnQgeyBvcGVuV2luZG93LCBjbG9zZVdpbmRvdyB9IGZyb20gJy4uL21haW4vd2luZG93JztcblxuXG5leHBvcnQgbGV0IG1haW46IE1haW5BcHA8YW55LCBhbnk+O1xuXG5cbmV4cG9ydCBjb25zdCBpbml0TWFpbiA9IGFzeW5jIDxDIGV4dGVuZHMgTWFpbkNvbmZpZzxhbnk+Pihjb25maWc6IEMpOiBQcm9taXNlPE1haW5BcHA8YW55LCBDPj4gPT4ge1xuXG4gIC8vIFByZXZlbnQgd2luZG93cyBmcm9tIGNsb3Npbmcgd2hpbGUgYXBwIGlzIGluaXRpYWxpemVkXG4gIGFwcC5vbignd2luZG93LWFsbC1jbG9zZWQnLCAoZTogYW55KSA9PiBlLnByZXZlbnREZWZhdWx0KCkpO1xuXG4gIGxvZy5jYXRjaEVycm9ycyh7IHNob3dEaWFsb2c6IHRydWUgfSk7XG5cbiAgaWYgKGNvbmZpZy5hcHAuc2luZ2xlSW5zdGFuY2UpIHtcbiAgICAvLyBFbnN1cmUgb25seSBvbmUgaW5zdGFuY2Ugb2YgdGhlIGFwcCBjYW4gcnVuIGF0IGEgdGltZSBvbiBnaXZlbiB1c2Vy4oCZcyBtYWNoaW5lXG4gICAgLy8gYnkgZXhpdGluZyBhbnkgZnV0dXJlIGluc3RhbmNlc1xuICAgIGlmICghYXBwLnJlcXVlc3RTaW5nbGVJbnN0YW5jZUxvY2soKSkge1xuICAgICAgYXBwLmV4aXQoMCk7XG4gICAgfVxuICB9XG5cblxuICAvKiBIZWxwZXIgZnVuY3Rpb25zICovXG5cbiAgZnVuY3Rpb24gX29wZW5XaW5kb3cod2luZG93TmFtZToga2V5b2YgdHlwZW9mIGNvbmZpZy5hcHAud2luZG93cywgZXh0cmFDb21wb25lbnRQYXJhbXM6IHN0cmluZyA9ICcnKSB7XG4gICAgbG9nLnZlcmJvc2UoXCJDL21haW46IE9wZW5pbmcgd2luZG93XCIsIHdpbmRvd05hbWUpO1xuXG4gICAgY29uc3QgZGVmYXVsdFBhcmFtcyA9IGNvbmZpZy5hcHAud2luZG93c1t3aW5kb3dOYW1lXS5vcGVuZXJQYXJhbXM7XG5cbiAgICBjb25zdCBvcGVuZXJQYXJhbXMgPSB7XG4gICAgICAuLi5kZWZhdWx0UGFyYW1zLFxuICAgICAgY29tcG9uZW50UGFyYW1zOiBgJHtkZWZhdWx0UGFyYW1zLmNvbXBvbmVudFBhcmFtc30mJHtleHRyYUNvbXBvbmVudFBhcmFtc31gLFxuICAgIH07XG5cbiAgICByZXR1cm4gb3BlbldpbmRvdyh7XG4gICAgICAuLi5vcGVuZXJQYXJhbXMsXG4gICAgICBjb21wb25lbnQ6IHdpbmRvd05hbWUsXG4gICAgICBjb25maWc6IGNvbmZpZy5hcHAsXG4gICAgfSk7XG4gIH1cblxuICBmdW5jdGlvbiBfY2xvc2VXaW5kb3cod2luZG93TmFtZToga2V5b2YgdHlwZW9mIGNvbmZpZy5hcHAud2luZG93cykge1xuICAgIGxvZy52ZXJib3NlKGBDL21haW46IENsb3Npbmcgd2luZG93ICR7U3RyaW5nKHdpbmRvd05hbWUpfWApO1xuXG4gICAgY2xvc2VXaW5kb3coY29uZmlnLmFwcC53aW5kb3dzW3dpbmRvd05hbWVdLm9wZW5lclBhcmFtcy50aXRsZSk7XG4gIH1cblxuICBmdW5jdGlvbiBfcmVxdWVzdFNldHRpbmdzKHNldHRpbmdJRHM6IHN0cmluZ1tdKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgLyogT3BlbiBzZXR0aW5ncyB3aW5kb3csIHByb21wdGluZyB0aGUgdXNlclxuICAgICAgIHRvIGZpbGwgaW4gcGFyYW1ldGVycyByZXF1aXJlZCBmb3IgYXBwbGljYXRpb25cbiAgICAgICB0byBwZXJmb3JtIGEgZnVuY3Rpb24uXG4gICAgICAgVGhlIHdpbmRvdyBpcyBleHBlY3RlZCB0byB1c2UgY29tbWl0U2V0dGluZyBJUEMgY2FsbHMsXG4gICAgICAgd2hpY2ggaXMgaG93IGRlZmF1bHQgc2V0dGluZ3Mgd2lkZ2V0cyB3b3JrLiAqL1xuXG4gICAgY29uc3Qgc2V0dGluZ3NXaW5kb3cgPSBjb25maWcuYXBwLndpbmRvd3NbY29uZmlnLmFwcC5zZXR0aW5nc1dpbmRvd0lEXTtcbiAgICBpZiAoc2V0dGluZ3NXaW5kb3cpIHtcbiAgICAgIHJldHVybiBuZXcgUHJvbWlzZTx2b2lkPihhc3luYyAocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG5cbiAgICAgICAgY29uc3Qgb3BlbmVkV2luZG93ID0gYXdhaXQgX29wZW5XaW5kb3coXG4gICAgICAgICAgY29uZmlnLmFwcC5zZXR0aW5nc1dpbmRvd0lELFxuICAgICAgICAgIGByZXF1aXJlZFNldHRpbmdzPSR7c2V0dGluZ0lEcy5qb2luKCcsJyl9YCk7XG5cbiAgICAgICAgb3BlbmVkV2luZG93Lm9uKCdjbG9zZWQnLCAoKSA9PiB7XG4gICAgICAgICAgY29uc3QgbWlzc2luZ1JlcXVpcmVkU2V0dGluZ3MgPSBzZXR0aW5nSURzLlxuICAgICAgICAgICAgbWFwKChzZXR0aW5nSUQpID0+ICBzZXR0aW5ncy5nZXRWYWx1ZShzZXR0aW5nSUQpKS5cbiAgICAgICAgICAgIGZpbHRlcigoc2V0dGluZ1ZhbCkgPT4gc2V0dGluZ1ZhbCA9PT0gdW5kZWZpbmVkKTtcbiAgICAgICAgICBpZiAobWlzc2luZ1JlcXVpcmVkU2V0dGluZ3MubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgbG9nLndhcm4oXG4gICAgICAgICAgICAgIFwiQy9tYWluOiBVc2VyIGNsb3NlZCBzZXR0aW5ncyB3aW5kb3cgd2l0aCBtaXNzaW5nIHNldHRpbmdzIGxlZnRcIixcbiAgICAgICAgICAgICAgbWlzc2luZ1JlcXVpcmVkU2V0dGluZ3MpXG4gICAgICAgICAgICByZWplY3QoKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbG9nLnZlcmJvc2UoXCJDL21haW46IFVzZXIgcHJvdmlkZXIgYWxsIG1pc3Npbmcgc2V0dGluZ3NcIilcbiAgICAgICAgICAgIHJlc29sdmUoKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pXG5cbiAgICAgIH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJTZXR0aW5ncyB3ZXJlIHJlcXVlc3RlZCwgYnV0IHNldHRpbmdzIHdpbmRvdyBpcyBub3Qgc3BlY2lmaWVkXCIpO1xuICAgIH1cbiAgfVxuXG4gIC8vIFRPRE86IFRoaXMgd29ya2Fyb3VuZCBtYXkgb3IgbWF5IG5vdCBiZSBuZWNlc3NhcnlcbiAgaWYgKGNvbmZpZy5kaXNhYmxlR1BVKSB7XG4gICAgYXBwLmRpc2FibGVIYXJkd2FyZUFjY2VsZXJhdGlvbigpO1xuICB9XG5cbiAgLy8gQ2F0Y2ggdW5oYW5kbGVkIGVycm9ycyBpbiBlbGVjdHJvbi1sb2dcbiAgbG9nLmNhdGNoRXJyb3JzKHsgc2hvd0RpYWxvZzogdHJ1ZSB9KTtcblxuICBhd2FpdCBhcHAud2hlblJlYWR5KCk7XG5cbiAgLy8gU2hvdyBzcGxhc2ggd2luZG93LCBpZiBjb25maWd1cmVkXG4gIGNvbnN0IHNwbGFzaFdpbmRvdyA9IGNvbmZpZy5hcHAud2luZG93c1tjb25maWcuYXBwLnNwbGFzaFdpbmRvd0lEXTtcbiAgaWYgKHNwbGFzaFdpbmRvdykge1xuICAgIF9vcGVuV2luZG93KGNvbmZpZy5hcHAuc3BsYXNoV2luZG93SUQpO1xuICB9XG5cbiAgY29uc3QgaXNNYWNPUyA9IHByb2Nlc3MucGxhdGZvcm0gPT09ICdkYXJ3aW4nO1xuICBjb25zdCBpc0RldmVsb3BtZW50ID0gcHJvY2Vzcy5lbnYuTk9ERV9FTlYgIT09ICdwcm9kdWN0aW9uJyB8fCBjb25maWcuYXBwLmZvcmNlRGV2ZWxvcG1lbnRNb2RlO1xuXG4gIGNvbnN0IHNldHRpbmdzID0gbmV3IFNldHRpbmdNYW5hZ2VyKGNvbmZpZy5hcHBEYXRhUGF0aCwgY29uZmlnLnNldHRpbmdzRmlsZU5hbWUpO1xuICBzZXR0aW5ncy5zZXRVcElQQygpO1xuXG5cbiAgLy8gUHJlcGFyZSBkYXRhYmFzZSBiYWNrZW5kcyAmIHJlcXVlc3QgY29uZmlndXJhdGlvbiBpZiBuZWVkZWRcblxuICBsb2cuZGVidWcoXCJDL2luaXRNYWluOiBEQjogUmVhZGluZyBiYWNrZW5kIGNvbmZpZ1wiLCBjb25maWcuZGF0YWJhc2VzKTtcblxuICB0eXBlIEJhY2tlbmRJbmZvID0ge1xuICAgIGRiTmFtZTogc3RyaW5nXG4gICAgYmFja2VuZENsYXNzOiBEYXRhYmFzZUJhY2tlbmRDbGFzczxhbnksIGFueSwgYW55PlxuICAgIGJhY2tlbmRPcHRpb25zOiBhbnlcbiAgfTtcbiAgbGV0IGRiQmFja2VuZENsYXNzZXM6IEJhY2tlbmRJbmZvW107XG4gIGRiQmFja2VuZENsYXNzZXMgPSAoYXdhaXQgUHJvbWlzZS5hbGwoT2JqZWN0LmVudHJpZXMoY29uZmlnLmRhdGFiYXNlcykubWFwKFxuICAgIGFzeW5jIChbZGJOYW1lLCBkYkNvbmZdKSA9PiB7XG4gICAgICBsb2cuZGVidWcoXCJDL2luaXRNYWluOiBEQjogUmVhZGluZyBiYWNrZW5kIGNvbmZpZ1wiLCBkYk5hbWUsIGRiQ29uZik7XG5cbiAgICAgIGNvbnN0IERCQmFja2VuZENsYXNzID0gZGJDb25mLmJhY2tlbmQ7XG4gICAgICBpZiAoREJCYWNrZW5kQ2xhc3MucmVnaXN0ZXJTZXR0aW5nc0ZvckNvbmZpZ3VyYWJsZU9wdGlvbnMpIHtcbiAgICAgICAgREJCYWNrZW5kQ2xhc3MucmVnaXN0ZXJTZXR0aW5nc0ZvckNvbmZpZ3VyYWJsZU9wdGlvbnMoc2V0dGluZ3MsIGRiQ29uZi5vcHRpb25zLCBkYk5hbWUpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgZGJOYW1lOiBkYk5hbWUsXG4gICAgICAgIGJhY2tlbmRDbGFzczogREJCYWNrZW5kQ2xhc3MsXG4gICAgICAgIGJhY2tlbmRPcHRpb25zOiBkYkNvbmYub3B0aW9ucyxcbiAgICAgIH07XG4gICAgfVxuICApKSk7XG5cblxuICAvLyBSZXF1ZXN0IHNldHRpbmdzIGZyb20gdXNlciB2aWEgYW4gaW5pdGlhbCBjb25maWd1cmF0aW9uIHdpbmRvdywgaWYgcmVxdWlyZWRcblxuICBjb25zdCBtaXNzaW5nU2V0dGluZ3MgPSBhd2FpdCBzZXR0aW5ncy5saXN0TWlzc2luZ1JlcXVpcmVkU2V0dGluZ3MoKTtcbiAgLy8gTGlzdCBvZiBJRHMgb2Ygc2V0dGluZ3MgdGhhdCBuZWVkIHRvIGJlIGZpbGxlZCBvdXQuXG5cbiAgaWYgKG1pc3NpbmdTZXR0aW5ncy5sZW5ndGggPiAwKSB7XG4gICAgbG9nLnZlcmJvc2UoXCJDL2luaXRNYWluOiBNaXNzaW5nIHNldHRpbmdzIHByZXNlbnQsIHJlcXVlc3RpbmcgZnJvbSB0aGUgdXNlclwiLCBtaXNzaW5nU2V0dGluZ3MpO1xuICAgIGF3YWl0IF9yZXF1ZXN0U2V0dGluZ3MobWlzc2luZ1NldHRpbmdzKTtcbiAgfSBlbHNlIHtcbiAgICBsb2cuZGVidWcoXCJDL2luaXRNYWluOiBObyBtaXNzaW5nIHNldHRpbmdzIGZvdW5kXCIpO1xuICB9XG5cblxuICAvLyBDb25zdHJ1Y3QgZGF0YWJhc2UgYmFja2VuZCBpbnN0YW5jZXNcblxuICB0eXBlIERCcyA9IE1haW5BcHA8YW55LCBDPltcImRhdGFiYXNlc1wiXTtcbiAgbGV0IGRhdGFiYXNlczogREJzXG5cbiAgdHJ5IHtcbiAgICBkYXRhYmFzZXMgPSAoYXdhaXQgUHJvbWlzZS5hbGwoZGJCYWNrZW5kQ2xhc3Nlcy5tYXAoXG4gICAgICBhc3luYyAoeyBkYk5hbWUsIGJhY2tlbmRDbGFzcywgYmFja2VuZE9wdGlvbnMgfSkgPT4ge1xuICAgICAgICBjb25zdCBEQkJhY2tlbmRDbGFzcyA9IGJhY2tlbmRDbGFzcztcblxuICAgICAgICBsb2cudmVyYm9zZShcIkMvaW5pdE1haW46IERCOiBDb21wbGV0aW5nIGJhY2tlbmQgb3B0aW9ucyBmcm9tXCIsIGJhY2tlbmRPcHRpb25zKTtcblxuICAgICAgICBsZXQgb3B0aW9uczogYW55O1xuICAgICAgICBpZiAoREJCYWNrZW5kQ2xhc3MuY29tcGxldGVPcHRpb25zRnJvbVNldHRpbmdzKSB7XG4gICAgICAgICAgb3B0aW9ucyA9IGF3YWl0IERCQmFja2VuZENsYXNzLmNvbXBsZXRlT3B0aW9uc0Zyb21TZXR0aW5ncyhcbiAgICAgICAgICAgIHNldHRpbmdzLFxuICAgICAgICAgICAgYmFja2VuZE9wdGlvbnMsXG4gICAgICAgICAgICBkYk5hbWUpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIG9wdGlvbnMgPSBiYWNrZW5kT3B0aW9ucztcbiAgICAgICAgfVxuXG4gICAgICAgIGxvZy52ZXJib3NlKFwiQy9pbml0TWFpbjogREI6IEluaXRpYWxpemluZyBiYWNrZW5kIHdpdGggb3B0aW9uc1wiLCBiYWNrZW5kT3B0aW9ucyk7XG5cbiAgICAgICAgY29uc3QgYmFja2VuZCA9IG5ldyBEQkJhY2tlbmRDbGFzcyhcbiAgICAgICAgICAgb3B0aW9ucyxcbiAgICAgICAgICAgYXN5bmMgKHBheWxvYWQ6IGFueSkgPT4gYXdhaXQgcmVwb3J0QmFja2VuZFN0YXR1c1RvQWxsV2luZG93cyhkYk5hbWUsIHBheWxvYWQpKTtcblxuICAgICAgICBpZiAoYmFja2VuZC5zZXRVcElQQykge1xuICAgICAgICAgIGJhY2tlbmQuc2V0VXBJUEMoZGJOYW1lKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IFtkYk5hbWVdOiBiYWNrZW5kIH07XG4gICAgICB9XG4gICAgKSkpLnJlZHVjZSgodmFsLCBhY2MpID0+ICh7IC4uLmFjYywgLi4udmFsIH0pLCB7fSBhcyBQYXJ0aWFsPERCcz4pIGFzIERCcztcbiAgfSBjYXRjaCAoZSkge1xuICAgIGxvZy5lcnJvcihcIkMvaW5pdE1haW46IEZhaWxlZCB0byBpbml0aWFsaXplIGRhdGFiYXNlIGJhY2tlbmRzXCIpO1xuICAgIHRocm93IGU7XG4gIH1cblxuXG4gIC8vIEluaXRpYWxpemUgbW9kZWwgbWFuYWdlcnNcblxuICBsb2cuZGVidWcoXCJDL2luaXRNYWluOiBJbml0aWFsaXppbmcgZGF0YSBtb2RlbCBtYW5hZ2Vyc1wiLCBjb25maWcubWFuYWdlcnMpXG5cbiAgdHlwZSBNYW5hZ2VycyA9IE1haW5BcHA8YW55LCBDPltcIm1hbmFnZXJzXCJdO1xuICBsZXQgbWFuYWdlcnM6IE1hbmFnZXJzO1xuXG4gIG1hbmFnZXJzID0gKGF3YWl0IFByb21pc2UuYWxsKE9iamVjdC5lbnRyaWVzKGNvbmZpZy5tYW5hZ2VycykubWFwKFxuICAgIGFzeW5jIChbbW9kZWxOYW1lLCBtYW5hZ2VyQ29uZl0pID0+IHtcbiAgICAgIGNvbnN0IG1vZGVsSW5mbyA9IGNvbmZpZy5hcHAuZGF0YVttb2RlbE5hbWVdO1xuXG4gICAgICBsb2cudmVyYm9zZShcIkMvaW5pdE1haW46IEluaXRpYWxpemluZyBtb2RlbCBtYW5hZ2VyIGZvciBEQlwiLCBtYW5hZ2VyQ29uZi5kYk5hbWUsIGRhdGFiYXNlcyk7XG5cbiAgICAgIGNvbnN0IGRiID0gZGF0YWJhc2VzW21hbmFnZXJDb25mLmRiTmFtZV07XG4gICAgICBjb25zdCBNYW5hZ2VyQ2xhc3MgPSBtYW5hZ2VyQ29uZi5vcHRpb25zLmNscztcbiAgICAgIGNvbnN0IG1hbmFnZXIgPSBuZXcgTWFuYWdlckNsYXNzKFxuICAgICAgICBkYiwgbWFuYWdlckNvbmYub3B0aW9ucywgbW9kZWxJbmZvLFxuICAgICAgICBhc3luYyAoY2hhbmdlZElEcz86IGFueVtdKSA9PiBhd2FpdCByZXBvcnRNb2RpZmllZERhdGFUb0FsbFdpbmRvd3MobW9kZWxOYW1lLCBjaGFuZ2VkSURzPy5tYXAoaWQgPT4gYCR7aWR9YCkpKTtcblxuICAgICAgaWYgKG1hbmFnZXIuc2V0VXBJUEMpIHtcbiAgICAgICAgbWFuYWdlci5zZXRVcElQQyhtb2RlbE5hbWUpO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4geyBbbW9kZWxOYW1lXTogbWFuYWdlciB9O1xuICAgIH1cbiAgKSkpXG4gIC5yZWR1Y2UoKHZhbCwgYWNjKSA9PiAoeyAuLi5hY2MsIC4uLnZhbCB9KSwge30gYXMgUGFydGlhbDxNYW5hZ2Vycz4pIGFzIE1hbmFnZXJzO1xuXG5cbiAgbGlzdGVuPHsgaWQ6IGtleW9mIHR5cGVvZiBjb25maWcuYXBwLndpbmRvd3MsIHBhcmFtcz86IE9taXQ8V2luZG93T3BlbmVyUGFyYW1zLCAnY29tcG9uZW50Jz4gfSwge30+XG4gICgnb3Blbi1wcmVkZWZpbmVkLXdpbmRvdycsIGFzeW5jICh7IGlkLCBwYXJhbXMgfSkgPT4ge1xuICAgIGNvbnN0IHBhcmFtc1dpdGhEZWZhdWx0cyA9IHsgLi4uY29uZmlnLmFwcC53aW5kb3dzW2lkXS5vcGVuZXJQYXJhbXMsIC4uLnBhcmFtcyB8fCB7fSwgY29tcG9uZW50OiBpZCwgY29uZmlnOiBjb25maWcuYXBwIH07XG4gICAgb3BlbldpbmRvdyhwYXJhbXNXaXRoRGVmYXVsdHMpO1xuICAgIHJldHVybiB7fTtcbiAgfSk7XG5cblxuICBsaXN0ZW48V2luZG93T3BlbmVyUGFyYW1zLCB7fT5cbiAgKCdvcGVuLWFyYml0cmFyeS13aW5kb3cnLCBhc3luYyAocGFyYW1zKSA9PiB7XG4gICAgb3BlbldpbmRvdyhwYXJhbXMpO1xuICAgIHJldHVybiB7fTtcbiAgfSk7XG5cblxuICAvLyBJbml0aWFsaXplIHdpbmRvdy1vcGVuaW5nIGVuZHBvaW50c1xuICBmb3IgKGNvbnN0IFt3aW5kb3dOYW1lLCB3aW5kb3ddIG9mIE9iamVjdC5lbnRyaWVzKGNvbmZpZy5hcHAud2luZG93cykpIHtcbiAgICBtYWtlV2luZG93RW5kcG9pbnQod2luZG93TmFtZSwgKCkgPT4gKHtcbiAgICAgIC4uLih3aW5kb3cgYXMgV2luZG93KS5vcGVuZXJQYXJhbXMsXG4gICAgICBjb21wb25lbnQ6IHdpbmRvd05hbWUsXG4gICAgICBjb25maWc6IGNvbmZpZy5hcHAsXG4gICAgfSkpO1xuICB9XG5cbiAgLy8gREIgYmFja2VuZCBpbml0aWFsaXphdGlvbiBoYXBwZW5zIGFmdGVyIHRoZSBhcHAgaXMgcmVhZHksXG4gIC8vIHNpbmNlIGl0IG1heSByZXF1aXJlIHVzZXIgaW5wdXQgKGFuZCBoZW5jZSBHVUkgaW50ZXJhY3Rpb24pXG4gIC8vIG9mIHNlbnNpdGl2ZSBkYXRhIG5vdCBzdWl0YWJsZSBmb3Igc2V0dGluZ3MsXG4gIC8vIG5hbWVseSBhdXRoZW50aWNhdGlvbiBrZXlzIGlmIGRhdGEgc291cmNlIHJlcXVpcmVzIGF1dGguXG4gIC8vIFRPRE86IFRlYWNoaW5nIHRoZSBmcmFtZXdvcmsgdG8gZW5jcnlwdCBzZXR0aW5nc1xuICAvLyBtaWdodCBsZXQgdXMgbWFrZSBhdXRoZW50aWNhdGlvbiBkYXRhIGVudHJ5XG4gIC8vIHBhcnQgb2YgcmVxdWlyZWQgc2V0dGluZ3MgZW50cnlcbiAgLy8gYW5kIHN0YXJ0IGRhdGEgc291cmNlIGluaXRpYWxpemF0aW9uIGVhcmx5LlxuICBmb3IgKGNvbnN0IFtiYWNrZW5kSUQsIGJhY2tlbmRdIG9mIE9iamVjdC5lbnRyaWVzKGRhdGFiYXNlcykpIHtcbiAgICBsb2cuZGVidWcoXCJDL2luaXRNYWluOiBJbml0aWFsaXppbmcgREIgYmFja2VuZFwiLCBiYWNrZW5kSUQpO1xuICAgIGF3YWl0IGJhY2tlbmQuaW5pdCgpO1xuICB9XG5cbiAgZm9yIChjb25zdCBbbWFuYWdlcklELCBtYW5hZ2VyXSBvZiBPYmplY3QuZW50cmllcyhtYW5hZ2VycykpIHtcbiAgICBsb2cuZGVidWcoXCJDL2luaXRNYWluOiBJbml0aWFsaXppbmcgbWFuYWdlclwiLCBtYW5hZ2VySUQpO1xuICAgIGF3YWl0IG1hbmFnZXIuaW5pdCgpO1xuICB9XG5cbiAgLy8gT3BlbiBtYWluIHdpbmRvd1xuICBhd2FpdCBfb3BlbldpbmRvdygnZGVmYXVsdCcpO1xuXG4gIGlmIChzcGxhc2hXaW5kb3cpIHtcbiAgICBfY2xvc2VXaW5kb3coY29uZmlnLmFwcC5zcGxhc2hXaW5kb3dJRCk7XG4gIH1cblxuICBtYWluID0ge1xuICAgIGFwcCxcbiAgICBpc01hY09TLFxuICAgIGlzRGV2ZWxvcG1lbnQsXG4gICAgbWFuYWdlcnMsXG4gICAgZGF0YWJhc2VzLFxuICAgIG9wZW5XaW5kb3c6IF9vcGVuV2luZG93LFxuICB9IGFzIE1haW5BcHA8YW55LCBhbnk+O1xuXG4gIHJldHVybiBtYWluIGFzIE1haW5BcHA8dHlwZW9mIGNvbmZpZy5hcHAsIHR5cGVvZiBjb25maWc+O1xufTtcblxuXG5jb25zdCByZXBvcnRCYWNrZW5kU3RhdHVzVG9BbGxXaW5kb3dzID0gYXN5bmMgKGRiTmFtZTogc3RyaW5nLCBwYXlsb2FkOiBvYmplY3QpID0+IHtcbiAgcmV0dXJuIGF3YWl0IG5vdGlmeUFsbFdpbmRvd3MoYGRiLSR7ZGJOYW1lfS1zdGF0dXNgLCBwYXlsb2FkKTtcbn07XG5cblxuY29uc3QgcmVwb3J0TW9kaWZpZWREYXRhVG9BbGxXaW5kb3dzID0gYXN5bmMgKG1vZGVsTmFtZTogc3RyaW5nLCBjaGFuZ2VkSURzPzogc3RyaW5nW10pID0+IHtcbiAgLy8gVE9ETzogSWYgdG9vIG1hbnkgdXBkYXRlIGNhbGxzIHdpdGggb25lIElEIGFmZmVjdCBwZXJmb3JtYW5jZSxcbiAgLy8gZGVib3VuY2UgdGhpcyBmdW5jdGlvbiwgY29tYmluaW5nIHNob3J0ZXIgSUQgbGlzdHMgYW5kIHJlcG9ydGluZyBtb3JlIG9mIHRoZW0gYXQgb25jZVxuICBsb2cuZGVidWcoXCJDL21haW46IFJlcG9ydGluZyBtb2RpZmllZCBkYXRhXCIsIG1vZGVsTmFtZSwgY2hhbmdlZElEcyk7XG4gIHJldHVybiBhd2FpdCBub3RpZnlBbGxXaW5kb3dzKGBtb2RlbC0ke21vZGVsTmFtZX0tb2JqZWN0cy1jaGFuZ2VkYCwgeyBpZHM6IGNoYW5nZWRJRHMgfSk7XG59O1xuXG5cbmV4cG9ydCBpbnRlcmZhY2UgTWFpbkFwcDxBIGV4dGVuZHMgQXBwQ29uZmlnLCBNIGV4dGVuZHMgTWFpbkNvbmZpZzxBPj4ge1xuICAvKiBPYmplY3QgcmV0dXJuZWQgYnkgaW5pdE1haW4uICovXG5cbiAgYXBwOiBBcHBcbiAgaXNNYWNPUzogYm9vbGVhblxuICBpc0RldmVsb3BtZW50OiBib29sZWFuXG4gIG1hbmFnZXJzOiBSZWNvcmQ8a2V5b2YgQVtcImRhdGFcIl0sIE1vZGVsTWFuYWdlcjxhbnksIGFueT4+XG4gIGRhdGFiYXNlczogUmVjb3JkPGtleW9mIE1bXCJkYXRhYmFzZXNcIl0sIEJhY2tlbmQ+XG4gIG9wZW5XaW5kb3c6ICh3aW5kb3dOYW1lOiBrZXlvZiBBW1wid2luZG93c1wiXSkgPT4gdm9pZFxufVxuIl19