import * as moment from 'moment';


export function reviveJsonValue(key: string, val: any) {
  const timestamp = moment(val, moment.ISO_8601, true);
  if (timestamp.isValid()) {
    return timestamp.toDate();
  }
  return val;
}


export type APIResponse<O> = { errors: string[], result: O | undefined };


export function getEventNamesForEndpoint(endpointName: string): { request: string, response: string } {
  return { request: `_api-${endpointName}-request`, response: `_api-${endpointName}-response` };
}


export function getEventNamesForWindowEndpoint(endpointName: string): { request: string, response: string } {
  return { request: `_open-${endpointName}-request`, response: `_open-${endpointName}-response` };
}
