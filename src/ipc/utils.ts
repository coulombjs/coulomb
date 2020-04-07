import * as moment from 'moment';


export function reviveJsonValue(key: string, val: any) {
  if (!val || !val.hasOwnProperty('indexOf') || val.indexOf('-') < 0) {
    return val;
  }
  const timestamp = moment(val, moment.ISO_8601, true);
  if (timestamp.isValid()) {
    return timestamp.toDate();
  }
  return val;
}
