// Jury-rig globa.fetch to make Isomorphic Git work under Node
import fetch from 'node-fetch';
global.fetch = fetch;
import { app } from 'electron';
import * as log from 'electron-log';
import { SettingManager } from '../settings/main';
import { notifyAllWindows } from '../main/window';
import { listen, unlisten, makeWindowEndpoint } from '../ipc/main';
import { openWindow, closeWindow } from '../main/window';
export let main;
export const initMain = async (config) => {
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
    function _requestSettings(settings) {
        /* Open settings window, prompting the user
           to fill in parameters required for application
           to perform a function.
           The window is expected to use commitSetting IPC calls,
           which is how default settings widgets work. */
        const settingsWindow = config.app.windows[config.app.settingsWindowID];
        if (settingsWindow) {
            return new Promise(async (resolve, reject) => {
                var resolvedSettings = {};
                const handleSetting = async function ({ name, value }) {
                    if (settings.indexOf(name) >= 0) {
                        // If we got a value for one of our requested settings,
                        // check if all requested settings have defined values
                        // (close settings window & resolve promise if they do).
                        resolvedSettings[name] = value;
                        const allSettingsResolved = settings.filter(s => resolvedSettings[s] === undefined).length < 1;
                        if (allSettingsResolved) {
                            unlisten('commitSetting', handleSetting);
                            await closeWindow(settingsWindow.openerParams.title);
                            resolve();
                        }
                        else {
                            log.verbose("C/main: Specified setting value, remaining required settings exist", settings.filter(s => resolvedSettings[s] === undefined));
                        }
                    }
                    return {};
                };
                listen('commitSetting', handleSetting);
                await _openWindow(config.app.settingsWindowID, `requiredSettings=${settings.join(',')}`);
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
            const backend = new DBBackendClass(options, (payload) => reportBackendStatusToAllWindows(`db-${dbName}`, payload));
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
        const modelConf = config.app.data[modelName];
        log.verbose("C/initMain: Initializing model manager for DB", managerConf.dbName, databases);
        const db = databases[managerConf.dbName];
        const ManagerClass = (await managerConf.options.cls()).default;
        const manager = new ManagerClass(db, managerConf.options, modelConf);
        if (manager.setUpIPC) {
            manager.setUpIPC(modelName);
        }
        return { [modelName]: manager };
    })))
        .reduce((val, acc) => (Object.assign(Object.assign({}, acc), val)), {});
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
            makeWindowEndpoint(windowName, () => (Object.assign(Object.assign({}, window.openerParams), { component: windowName })));
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
    return main;
};
async function reportBackendStatusToAllWindows(dbName, payload) {
    return await notifyAllWindows(`db-${dbName}-status`, payload);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9hcHAvbWFpbi50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSw4REFBOEQ7QUFDOUQsT0FBTyxLQUFLLE1BQU0sWUFBWSxDQUFDO0FBQzlCLE1BQWMsQ0FBQyxLQUFLLEdBQUcsS0FBSyxDQUFDO0FBRTlCLE9BQU8sRUFBRSxHQUFHLEVBQU8sTUFBTSxVQUFVLENBQUM7QUFDcEMsT0FBTyxLQUFLLEdBQUcsTUFBTSxjQUFjLENBQUM7QUFJcEMsT0FBTyxFQUFFLGNBQWMsRUFBRSxNQUFNLGtCQUFrQixDQUFDO0FBQ2xELE9BQU8sRUFBRSxnQkFBZ0IsRUFBRSxNQUFNLGdCQUFnQixDQUFDO0FBT2xELE9BQU8sRUFBRSxNQUFNLEVBQUUsUUFBUSxFQUFXLGtCQUFrQixFQUFFLE1BQU0sYUFBYSxDQUFDO0FBQzVFLE9BQU8sRUFBRSxVQUFVLEVBQUUsV0FBVyxFQUFFLE1BQU0sZ0JBQWdCLENBQUM7QUFHekQsTUFBTSxDQUFDLElBQUksSUFBdUIsQ0FBQztBQUduQyxNQUFNLENBQUMsTUFBTSxRQUFRLEdBQUcsS0FBSyxFQUE2QixNQUFTLEVBQTRCLEVBQUU7SUFFL0YsR0FBRyxDQUFDLFdBQVcsQ0FBQyxFQUFFLFVBQVUsRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDO0lBRXRDLElBQUksTUFBTSxDQUFDLEdBQUcsQ0FBQyxjQUFjLEVBQUU7UUFDN0IsZ0ZBQWdGO1FBQ2hGLGtDQUFrQztRQUNsQyxJQUFJLENBQUMsR0FBRyxDQUFDLHlCQUF5QixFQUFFLEVBQUU7WUFDcEMsR0FBRyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztTQUNiO0tBQ0Y7SUFHRCxzQkFBc0I7SUFFdEIsU0FBUyxXQUFXLENBQUMsVUFBMkMsRUFBRSx1QkFBK0IsRUFBRTtRQUNqRyxHQUFHLENBQUMsT0FBTyxDQUFDLDBCQUEwQixNQUFNLENBQUMsVUFBVSxDQUFDLEVBQUUsQ0FBQyxDQUFD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QzNELENBQUMsQ0FBQztBQUdGLEtBQUssVUFBVSwrQkFBK0IsQ0FBQyxNQUFjLEVBQUUsT0FBWTtJQUN6RSxPQUFPLE1BQU0sZ0JBQWdCLENBQUMsTUFBTSxNQUFNLFNBQVMsRUFBRSxPQUFPLENBQUMsQ0FBQztBQUNoRSxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLy8gSnVyeS1yaWcgZ2xvYmEuZmV0Y2ggdG8gbWFrZSBJc29tb3JwaGljIEdpdCB3b3JrIHVuZGVyIE5vZGVcbmltcG9ydCBmZXRjaCBmcm9tICdub2RlLWZldGNoJztcbihnbG9iYWwgYXMgYW55KS5mZXRjaCA9IGZldGNoO1xuXG5pbXBvcnQgeyBhcHAsIEFwcCB9IGZyb20gJ2VsZWN0cm9uJztcbmltcG9ydCAqIGFzIGxvZyBmcm9tICdlbGVjdHJvbi1sb2cnO1xuXG5pbXBvcnQgeyBBcHBDb25maWcsIFdpbmRvdyB9IGZyb20gJy4uL2NvbmZpZy9hcHAnO1xuaW1wb3J0IHsgTWFpbkNvbmZpZyB9IGZyb20gJy4uL2NvbmZpZy9tYWluJztcbmltcG9ydCB7IFNldHRpbmdNYW5hZ2VyIH0gZnJvbSAnLi4vc2V0dGluZ3MvbWFpbic7XG5pbXBvcnQgeyBub3RpZnlBbGxXaW5kb3dzIH0gZnJvbSAnLi4vbWFpbi93aW5kb3cnO1xuaW1wb3J0IHtcbiAgVmVyc2lvbmVkRmlsZXN5c3RlbUJhY2tlbmQsXG4gIFZlcnNpb25lZE1hbmFnZXIsXG4gIEJhY2tlbmRDbGFzcyBhcyBEYXRhYmFzZUJhY2tlbmRDbGFzcyxcbn0gZnJvbSAnLi4vZGIvbWFpbi9iYXNlJztcblxuaW1wb3J0IHsgbGlzdGVuLCB1bmxpc3RlbiwgSGFuZGxlciwgbWFrZVdpbmRvd0VuZHBvaW50IH0gZnJvbSAnLi4vaXBjL21haW4nO1xuaW1wb3J0IHsgb3BlbldpbmRvdywgY2xvc2VXaW5kb3cgfSBmcm9tICcuLi9tYWluL3dpbmRvdyc7XG5cblxuZXhwb3J0IGxldCBtYWluOiBNYWluQXBwPGFueSwgYW55PjtcblxuXG5leHBvcnQgY29uc3QgaW5pdE1haW4gPSBhc3luYyA8QyBleHRlbmRzIE1haW5Db25maWc8YW55Pj4oY29uZmlnOiBDKTogUHJvbWlzZTxNYWluQXBwPGFueSwgQz4+ID0+IHtcblxuICBsb2cuY2F0Y2hFcnJvcnMoeyBzaG93RGlhbG9nOiB0cnVlIH0pO1xuXG4gIGlmIChjb25maWcuYXBwLnNpbmdsZUluc3RhbmNlKSB7XG4gICAgLy8gRW5zdXJlIG9ubHkgb25lIGluc3RhbmNlIG9mIHRoZSBhcHAgY2FuIHJ1biBhdCBhIHRpbWUgb24gZ2l2ZW4gdXNlcuKAmXMgbWFjaGluZVxuICAgIC8vIGJ5IGV4aXRpbmcgYW55IGZ1dHVyZSBpbnN0YW5jZXNcbiAgICBpZiAoIWFwcC5yZXF1ZXN0U2luZ2xlSW5zdGFuY2VMb2NrKCkpIHtcbiAgICAgIGFwcC5leGl0KDApO1xuICAgIH1cbiAgfVxuXG5cbiAgLyogSGVscGVyIGZ1bmN0aW9ucyAqL1xuXG4gIGZ1bmN0aW9uIF9vcGVuV2luZG93KHdpbmRvd05hbWU6IGtleW9mIHR5cGVvZiBjb25maWcuYXBwLndpbmRvd3MsIGV4dHJhQ29tcG9uZW50UGFyYW1zOiBzdHJpbmcgPSAnJykge1xuICAgIGxvZy52ZXJib3NlKGBDL21haW46IE9wZW5pbmcgd2luZG93ICR7U3RyaW5nKHdpbmRvd05hbWUpfWApO1xuXG4gICAgY29uc3QgZGVmYXVsdFBhcmFtcyA9IGNvbmZpZy5hcHAud2luZG93c1t3aW5kb3dOYW1lXS5vcGVuZXJQYXJhbXM7XG5cbiAgICBjb25zdCBvcGVuZXJQYXJhbXMgPSB7XG4gICAgICAuLi5kZWZhdWx0UGFyYW1zLFxuICAgICAgY29tcG9uZW50UGFyYW1zOiBgJHtkZWZhdWx0UGFyYW1zLmNvbXBvbmVudFBhcmFtc30mJHtleHRyYUNvbXBvbmVudFBhcmFtc31gLFxuICAgIH07XG5cbiAgICByZXR1cm4gb3BlbldpbmRvdyh7XG4gICAgICAuLi5vcGVuZXJQYXJhbXMsXG4gICAgICBjb21wb25lbnQ6IHdpbmRvd05hbWUsXG4gICAgfSk7XG4gIH1cblxuICBmdW5jdGlvbiBfcmVxdWVzdFNldHRpbmdzKHNldHRpbmdzOiBzdHJpbmdbXSk6IFByb21pc2U8dm9pZD4ge1xuICAgIC8qIE9wZW4gc2V0dGluZ3Mgd2luZG93LCBwcm9tcHRpbmcgdGhlIHVzZXJcbiAgICAgICB0byBmaWxsIGluIHBhcmFtZXRlcnMgcmVxdWlyZWQgZm9yIGFwcGxpY2F0aW9uXG4gICAgICAgdG8gcGVyZm9ybSBhIGZ1bmN0aW9uLlxuICAgICAgIFRoZSB3aW5kb3cgaXMgZXhwZWN0ZWQgdG8gdXNlIGNvbW1pdFNldHRpbmcgSVBDIGNhbGxzLFxuICAgICAgIHdoaWNoIGlzIGhvdyBkZWZhdWx0IHNldHRpbmdzIHdpZGdldHMgd29yay4gKi9cblxuICAgIGNvbnN0IHNldHRpbmdzV2luZG93ID0gY29uZmlnLmFwcC53aW5kb3dzW2NvbmZpZy5hcHAuc2V0dGluZ3NXaW5kb3dJRF07XG4gICAgaWYgKHNldHRpbmdzV2luZG93KSB7XG4gICAgICByZXR1cm4gbmV3IFByb21pc2U8dm9pZD4oYXN5bmMgKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgICB2YXIgcmVzb2x2ZWRTZXR0aW5nczogeyBba2V5OiBzdHJpbmddOiBhbnkgfSA9IHt9O1xuXG4gICAgICAgIGNvbnN0IGhhbmRsZVNldHRpbmc6IEhhbmRsZXI8eyBuYW1lOiBzdHJpbmcsIHZhbHVlOiBhbnkgfSwge30+ID0gYXN5bmMgZnVuY3Rpb24gKHsgbmFtZSwgdmFsdWUgfSkge1xuICAgICAgICAgIGlmIChzZXR0aW5ncy5pbmRleE9mKG5hbWUpID49IDApIHtcbiAgICAgICAgICAgIC8vIElmIHdlIGdvdCBhIHZhbHVlIGZvciBvbmUgb2Ygb3VyIHJlcXVlc3RlZCBzZXR0aW5ncyxcbiAgICAgICAgICAgIC8vIGNoZWNrIGlmIGFsbCByZXF1ZXN0ZWQgc2V0dGluZ3MgaGF2ZSBkZWZpbmVkIHZhbHVlc1xuICAgICAgICAgICAgLy8gKGNsb3NlIHNldHRpbmdzIHdpbmRvdyAmIHJlc29sdmUgcHJvbWlzZSBpZiB0aGV5IGRvKS5cbiAgICAgICAgICAgIHJlc29sdmVkU2V0dGluZ3NbbmFtZV0gPSB2YWx1ZTtcblxuICAgICAgICAgICAgY29uc3QgYWxsU2V0dGluZ3NSZXNvbHZlZCA9XG4gICAgICAgICAgICAgIHNldHRpbmdzLmZpbHRlcihzID0+IHJlc29sdmVkU2V0dGluZ3Nbc10gPT09IHVuZGVmaW5lZCkubGVuZ3RoIDwgMTtcblxuICAgICAgICAgICAgaWYgKGFsbFNldHRpbmdzUmVzb2x2ZWQpIHtcbiAgICAgICAgICAgICAgdW5saXN0ZW4oJ2NvbW1pdFNldHRpbmcnLCBoYW5kbGVTZXR0aW5nKTtcbiAgICAgICAgICAgICAgYXdhaXQgY2xvc2VXaW5kb3coc2V0dGluZ3NXaW5kb3cub3BlbmVyUGFyYW1zLnRpdGxlKTtcbiAgICAgICAgICAgICAgcmVzb2x2ZSgpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgbG9nLnZlcmJvc2UoXG4gICAgICAgICAgICAgICAgXCJDL21haW46IFNwZWNpZmllZCBzZXR0aW5nIHZhbHVlLCByZW1haW5pbmcgcmVxdWlyZWQgc2V0dGluZ3MgZXhpc3RcIixcbiAgICAgICAgICAgICAgICBzZXR0aW5ncy5maWx0ZXIocyA9PiByZXNvbHZlZFNldHRpbmdzW3NdID09PSB1bmRlZmluZWQpKVxuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4ge307XG4gICAgICAgIH1cbiAgICAgICAgbGlzdGVuKCdjb21taXRTZXR0aW5nJywgaGFuZGxlU2V0dGluZyk7XG4gICAgICAgIGF3YWl0IF9vcGVuV2luZG93KGNvbmZpZy5hcHAuc2V0dGluZ3NXaW5kb3dJRCwgYHJlcXVpcmVkU2V0dGluZ3M9JHtzZXR0aW5ncy5qb2luKCcsJyl9YCk7XG4gICAgICB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiU2V0dGluZ3Mgd2VyZSByZXF1ZXN0ZWQsIGJ1dCBzZXR0aW5ncyB3aW5kb3cgaXMgbm90IHNwZWNpZmllZFwiKTtcbiAgICB9XG4gIH1cblxuICAvLyBUT0RPOiBUaGlzIHdvcmthcm91bmQgbWF5IG9yIG1heSBub3QgYmUgbmVjZXNzYXJ5XG4gIGlmIChjb25maWcuZGlzYWJsZUdQVSkge1xuICAgIGFwcC5kaXNhYmxlSGFyZHdhcmVBY2NlbGVyYXRpb24oKTtcbiAgfVxuXG4gIC8vIENhdGNoIHVuaGFuZGxlZCBlcnJvcnMgaW4gZWxlY3Ryb24tbG9nXG4gIGxvZy5jYXRjaEVycm9ycyh7IHNob3dEaWFsb2c6IHRydWUgfSk7XG5cbiAgLy8gU2hvdyBzcGxhc2ggd2luZG93LCBpZiBjb25maWd1cmVkXG4gIGNvbnN0IHNwbGFzaFdpbmRvdyA9IGNvbmZpZy5hcHAud2luZG93c1tjb25maWcuYXBwLnNwbGFzaFdpbmRvd0lEXTtcbiAgaWYgKHNwbGFzaFdpbmRvdykge1xuICAgIC8vIENhbuKAmXQgZGlzcGxheSBzcGxhc2ggc2NyZWVuIGJlZm9yZSB0aGUgYXBwIGlzIHJlYWR5XG4gICAgYXBwLndoZW5SZWFkeSgpLnRoZW4oKCkgPT4geyBfb3BlbldpbmRvdyhjb25maWcuYXBwLnNwbGFzaFdpbmRvd0lEKTsgfSk7XG4gIH1cblxuICBjb25zdCBpc01hY09TID0gcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gJ2Rhcndpbic7XG4gIGNvbnN0IGlzRGV2ZWxvcG1lbnQgPSBwcm9jZXNzLmVudi5OT0RFX0VOViAhPT0gJ3Byb2R1Y3Rpb24nO1xuXG4gIGNvbnN0IHNldHRpbmdzID0gbmV3IFNldHRpbmdNYW5hZ2VyKGNvbmZpZy5hcHBEYXRhUGF0aCwgY29uZmlnLnNldHRpbmdzRmlsZU5hbWUpO1xuICBzZXR0aW5ncy5zZXRVcElQQygpO1xuXG5cbiAgLy8gUHJlcGFyZSBkYXRhYmFzZSBiYWNrZW5kcyAmIHJlcXVlc3QgY29uZmlndXJhdGlvbiBpZiBuZWVkZWRcblxuICBsb2cuZGVidWcoXCJDL2luaXRNYWluOiBEQjogUmVhZGluZyBiYWNrZW5kIGNvbmZpZ1wiLCBjb25maWcuZGF0YWJhc2VzKTtcblxuICBsZXQgZGJCYWNrZW5kQ2xhc3Nlczoge1xuICAgIGRiTmFtZTogc3RyaW5nXG4gICAgYmFja2VuZENsYXNzOiBEYXRhYmFzZUJhY2tlbmRDbGFzczxhbnksIGFueSwgYW55PlxuICAgIGJhY2tlbmRPcHRpb25zOiBhbnlcbiAgfVtdO1xuXG4gIGRiQmFja2VuZENsYXNzZXMgPSAoYXdhaXQgUHJvbWlzZS5hbGwoT2JqZWN0LmVudHJpZXMoY29uZmlnLmRhdGFiYXNlcykubWFwKFxuICAgIGFzeW5jIChbZGJOYW1lLCBkYkNvbmZdKSA9PiB7XG4gICAgICBsb2cuZGVidWcoXCJDL2luaXRNYWluOiBEQjogUmVhZGluZyBiYWNrZW5kIGNvbmZpZ1wiLCBkYk5hbWUsIGRiQ29uZik7XG5cbiAgICAgIGNvbnN0IERCQmFja2VuZENsYXNzID0gKGF3YWl0IGRiQ29uZi5iYWNrZW5kKCkpLmRlZmF1bHQ7XG4gICAgICBpZiAoREJCYWNrZW5kQ2xhc3MucmVnaXN0ZXJTZXR0aW5nc0ZvckNvbmZpZ3VyYWJsZU9wdGlvbnMpIHtcbiAgICAgICAgREJCYWNrZW5kQ2xhc3MucmVnaXN0ZXJTZXR0aW5nc0ZvckNvbmZpZ3VyYWJsZU9wdGlvbnMoc2V0dGluZ3MsIGRiQ29uZi5vcHRpb25zLCBkYk5hbWUpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgZGJOYW1lOiBkYk5hbWUsXG4gICAgICAgIGJhY2tlbmRDbGFzczogREJCYWNrZW5kQ2xhc3MsXG4gICAgICAgIGJhY2tlbmRPcHRpb25zOiBkYkNvbmYub3B0aW9ucyxcbiAgICAgIH07XG4gICAgfVxuICApKSk7XG5cblxuICAvLyBSZXF1ZXN0IHNldHRpbmdzIGZyb20gdXNlciB2aWEgYW4gaW5pdGlhbCBjb25maWd1cmF0aW9uIHdpbmRvdywgaWYgcmVxdWlyZWRcblxuICBjb25zdCBtaXNzaW5nU2V0dGluZ3MgPSBhd2FpdCBzZXR0aW5ncy5saXN0TWlzc2luZ1JlcXVpcmVkU2V0dGluZ3MoKTtcbiAgLy8gTGlzdCBvZiBJRHMgb2Ygc2V0dGluZ3MgdGhhdCBuZWVkIHRvIGJlIGZpbGxlZCBvdXQuXG5cbiAgaWYgKG1pc3NpbmdTZXR0aW5ncy5sZW5ndGggPiAwKSB7XG4gICAgbG9nLnZlcmJvc2UoXCJDL2luaXRNYWluOiBNaXNzaW5nIHNldHRpbmdzIHByZXNlbnQsIHJlcXVlc3RpbmcgZnJvbSB0aGUgdXNlclwiLCBtaXNzaW5nU2V0dGluZ3MpO1xuICAgIGF3YWl0IF9yZXF1ZXN0U2V0dGluZ3MobWlzc2luZ1NldHRpbmdzKTtcbiAgfSBlbHNlIHtcbiAgICBsb2cuZGVidWcoXCJDL2luaXRNYWluOiBObyBtaXNzaW5nIHNldHRpbmdzIGZvdW5kXCIpO1xuICB9XG5cblxuICAvLyBDb25zdHJ1Y3QgZGF0YWJhc2UgYmFja2VuZCBpbnN0YW5jZXNcblxuICB0eXBlIERCcyA9IE1haW5BcHA8YW55LCBDPltcImRhdGFiYXNlc1wiXTtcbiAgbGV0IGRhdGFiYXNlczogREJzXG5cbiAgdHJ5IHtcbiAgICBkYXRhYmFzZXMgPSAoYXdhaXQgUHJvbWlzZS5hbGwoZGJCYWNrZW5kQ2xhc3Nlcy5tYXAoXG4gICAgICBhc3luYyAoeyBkYk5hbWUsIGJhY2tlbmRDbGFzcywgYmFja2VuZE9wdGlvbnMgfSkgPT4ge1xuICAgICAgICBjb25zdCBEQkJhY2tlbmRDbGFzcyA9IGJhY2tlbmRDbGFzcztcblxuICAgICAgICBsb2cudmVyYm9zZShcIkMvaW5pdE1haW46IERCOiBDb21wbGV0aW5nIGJhY2tlbmQgb3B0aW9ucyBmcm9tXCIsIGJhY2tlbmRPcHRpb25zKTtcblxuICAgICAgICBsZXQgb3B0aW9uczogYW55O1xuICAgICAgICBpZiAoREJCYWNrZW5kQ2xhc3MuY29tcGxldGVPcHRpb25zRnJvbVNldHRpbmdzKSB7XG4gICAgICAgICAgb3B0aW9ucyA9IGF3YWl0IERCQmFja2VuZENsYXNzLmNvbXBsZXRlT3B0aW9uc0Zyb21TZXR0aW5ncyhcbiAgICAgICAgICAgIHNldHRpbmdzLFxuICAgICAgICAgICAgYmFja2VuZE9wdGlvbnMsXG4gICAgICAgICAgICBkYk5hbWUpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIG9wdGlvbnMgPSBiYWNrZW5kT3B0aW9ucztcbiAgICAgICAgfVxuXG4gICAgICAgIGxvZy52ZXJib3NlKFwiQy9pbml0TWFpbjogREI6IEluaXRpYWxpemluZyBiYWNrZW5kIHdpdGggb3B0aW9uc1wiLCBiYWNrZW5kT3B0aW9ucyk7XG5cbiAgICAgICAgY29uc3QgYmFja2VuZCA9IG5ldyBEQkJhY2tlbmRDbGFzcyhcbiAgICAgICAgICAgb3B0aW9ucyxcbiAgICAgICAgICAgKHBheWxvYWQ6IGFueSkgPT4gcmVwb3J0QmFja2VuZFN0YXR1c1RvQWxsV2luZG93cyhgZGItJHtkYk5hbWV9YCwgcGF5bG9hZCkpO1xuXG4gICAgICAgIGlmIChiYWNrZW5kLnNldFVwSVBDKSB7XG4gICAgICAgICAgYmFja2VuZC5zZXRVcElQQyhkYk5hbWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgW2RiTmFtZV06IGJhY2tlbmQgfTtcbiAgICAgIH1cbiAgICApKSkucmVkdWNlKCh2YWwsIGFjYykgPT4gKHsgLi4uYWNjLCAuLi52YWwgfSksIHt9IGFzIFBhcnRpYWw8REJzPikgYXMgREJzO1xuICB9IGNhdGNoIChlKSB7XG4gICAgbG9nLmVycm9yKFwiQy9pbml0TWFpbjogRmFpbGVkIHRvIGluaXRpYWxpemUgZGF0YWJhc2UgYmFja2VuZHNcIik7XG4gICAgdGhyb3cgZTtcbiAgfVxuXG5cbiAgLy8gSW5pdGlhbGl6ZSBtb2RlbCBtYW5hZ2Vyc1xuXG4gIGxvZy5kZWJ1ZyhcIkMvaW5pdE1haW46IEluaXRpYWxpemluZyBkYXRhIG1vZGVsIG1hbmFnZXJzXCIsIGNvbmZpZy5tYW5hZ2VycylcblxuICB0eXBlIE1hbmFnZXJzID0gTWFpbkFwcDxhbnksIEM+W1wibWFuYWdlcnNcIl07XG4gIGxldCBtYW5hZ2VyczogTWFuYWdlcnM7XG5cbiAgbWFuYWdlcnMgPSAoYXdhaXQgUHJvbWlzZS5hbGwoT2JqZWN0LmVudHJpZXMoY29uZmlnLm1hbmFnZXJzKS5tYXAoXG4gICAgYXN5bmMgKFttb2RlbE5hbWUsIG1hbmFnZXJDb25mXSkgPT4ge1xuICAgICAgY29uc3QgbW9kZWxDb25mID0gY29uZmlnLmFwcC5kYXRhW21vZGVsTmFtZV07XG5cbiAgICAgIGxvZy52ZXJib3NlKFwiQy9pbml0TWFpbjogSW5pdGlhbGl6aW5nIG1vZGVsIG1hbmFnZXIgZm9yIERCXCIsIG1hbmFnZXJDb25mLmRiTmFtZSwgZGF0YWJhc2VzKTtcblxuICAgICAgY29uc3QgZGIgPSBkYXRhYmFzZXNbbWFuYWdlckNvbmYuZGJOYW1lXTtcbiAgICAgIGNvbnN0IE1hbmFnZXJDbGFzcyA9IChhd2FpdCBtYW5hZ2VyQ29uZi5vcHRpb25zLmNscygpKS5kZWZhdWx0O1xuICAgICAgY29uc3QgbWFuYWdlciA9IG5ldyBNYW5hZ2VyQ2xhc3MoZGIsIG1hbmFnZXJDb25mLm9wdGlvbnMsIG1vZGVsQ29uZik7XG5cbiAgICAgIGlmIChtYW5hZ2VyLnNldFVwSVBDKSB7XG4gICAgICAgIG1hbmFnZXIuc2V0VXBJUEMobW9kZWxOYW1lKTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHsgW21vZGVsTmFtZV06IG1hbmFnZXIgfTtcbiAgICB9XG4gICkpKVxuICAucmVkdWNlKCh2YWwsIGFjYykgPT4gKHsgLi4uYWNjLCAuLi52YWwgfSksIHt9IGFzIFBhcnRpYWw8TWFuYWdlcnM+KSBhcyBNYW5hZ2VycztcblxuXG4gIGFwcC53aGVuUmVhZHkoKVxuICAudGhlbigoKSA9PiB7XG4gICAgLy8gQ2xvc2Ugc3BsYXNoIHdpbmRvdyBiZWZvcmUgb3BlbmluZyB0aGUgZGVmYXVsdCB3aW5kb3dcbiAgICBjbG9zZVdpbmRvdyhzcGxhc2hXaW5kb3cub3BlbmVyUGFyYW1zLnRpdGxlKTtcblxuICAgIF9vcGVuV2luZG93KCdkZWZhdWx0Jyk7XG5cbiAgICAvLyBEQiBiYWNrZW5kIGluaXRpYWxpemF0aW9uIGhhcHBlbnMgYWZ0ZXIgdGhlIGFwcCBpcyByZWFkeSxcbiAgICAvLyBzaW5jZSBpdCBtYXkgcmVxdWlyZSB1c2VyIGlucHV0IChhbmQgaGVuY2UgR1VJIGludGVyYWN0aW9uKVxuICAgIC8vIG9mIHNlbnNpdGl2ZSBkYXRhIG5vdCBzdWl0YWJsZSBmb3Igc2V0dGluZ3MsXG4gICAgLy8gbmFtZWx5IGF1dGhlbnRpY2F0aW9uIGtleXMgaWYgZGF0YSBzb3VyY2UgcmVxdWlyZXMgYXV0aC5cbiAgICAvLyBUT0RPOiBUZWFjaGluZyB0aGUgZnJhbWV3b3JrIHRvIGVuY3J5cHQgc2V0dGluZ3NcbiAgICAvLyBtaWdodCBsZXQgdXMgbWFrZSBhdXRoZW50aWNhdGlvbiBkYXRhIGVudHJ5XG4gICAgLy8gcGFydCBvZiByZXF1aXJlZCBzZXR0aW5ncyBlbnRyeVxuICAgIC8vIGFuZCBzdGFydCBkYXRhIHNvdXJjZSBpbml0aWFsaXphdGlvbiBlYXJseS5cbiAgICBmb3IgKGNvbnN0IGJhY2tlbmQgb2YgT2JqZWN0LnZhbHVlcyhkYXRhYmFzZXMpKSB7XG4gICAgICBiYWNrZW5kLmluaXQoKTtcbiAgICB9XG5cbiAgICAvLyBJbml0aWFsaXplIHdpbmRvdy1vcGVuaW5nIGVuZHBvaW50c1xuICAgIGZvciAoY29uc3QgW3dpbmRvd05hbWUsIHdpbmRvd10gb2YgT2JqZWN0LmVudHJpZXMoY29uZmlnLmFwcC53aW5kb3dzKSkge1xuICAgICAgbWFrZVdpbmRvd0VuZHBvaW50KHdpbmRvd05hbWUsICgpID0+ICh7XG4gICAgICAgIC4uLih3aW5kb3cgYXMgV2luZG93KS5vcGVuZXJQYXJhbXMsXG4gICAgICAgIGNvbXBvbmVudDogd2luZG93TmFtZSxcbiAgICAgIH0pKTtcbiAgICB9XG4gIH0pO1xuXG4gIG1haW4gPSB7XG4gICAgYXBwLFxuICAgIGlzTWFjT1MsXG4gICAgaXNEZXZlbG9wbWVudCxcbiAgICBtYW5hZ2VycyxcbiAgICBkYXRhYmFzZXMsXG4gICAgb3BlbldpbmRvdzogX29wZW5XaW5kb3csXG4gIH07XG5cbiAgcmV0dXJuIG1haW4gYXMgTWFpbkFwcDx0eXBlb2YgY29uZmlnLmFwcCwgdHlwZW9mIGNvbmZpZz47XG59O1xuXG5cbmFzeW5jIGZ1bmN0aW9uIHJlcG9ydEJhY2tlbmRTdGF0dXNUb0FsbFdpbmRvd3MoZGJOYW1lOiBzdHJpbmcsIHBheWxvYWQ6IGFueSkge1xuICByZXR1cm4gYXdhaXQgbm90aWZ5QWxsV2luZG93cyhgZGItJHtkYk5hbWV9LXN0YXR1c2AsIHBheWxvYWQpO1xufVxuXG5cbmV4cG9ydCBpbnRlcmZhY2UgTWFpbkFwcDxBIGV4dGVuZHMgQXBwQ29uZmlnLCBNIGV4dGVuZHMgTWFpbkNvbmZpZzxBPj4ge1xuICAvKiBPYmplY3QgcmV0dXJuZWQgYnkgaW5pdE1haW4uICovXG5cbiAgYXBwOiBBcHAsXG4gIGlzTWFjT1M6IGJvb2xlYW5cbiAgaXNEZXZlbG9wbWVudDogYm9vbGVhblxuICBtYW5hZ2VyczogUmVjb3JkPGtleW9mIEFbXCJkYXRhXCJdLCBWZXJzaW9uZWRNYW5hZ2VyPGFueSwgYW55Pj5cbiAgZGF0YWJhc2VzOiBSZWNvcmQ8a2V5b2YgTVtcImRhdGFiYXNlc1wiXSwgVmVyc2lvbmVkRmlsZXN5c3RlbUJhY2tlbmQ+XG4gIG9wZW5XaW5kb3c6ICh3aW5kb3dOYW1lOiBrZXlvZiBBW1wid2luZG93c1wiXSkgPT4gdm9pZFxufVxuIl19