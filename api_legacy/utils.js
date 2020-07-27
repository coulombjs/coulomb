import * as moment from 'moment';
export function reviveJsonValue(key, val) {
    const timestamp = moment(val, moment.ISO_8601, true);
    if (timestamp.isValid()) {
        return timestamp.toDate();
    }
    return val;
}
export function getEventNamesForEndpoint(endpointName) {
    return { request: `_api-${endpointName}-request`, response: `_api-${endpointName}-response` };
}
export function getEventNamesForWindowEndpoint(endpointName) {
    return { request: `_open-${endpointName}-request`, response: `_open-${endpointName}-response` };
}
//# sourceMappingURL=utils.js.map