import * as moment from 'moment';
export function reviveJsonValue(key, val) {
    if (!val || val.indexOf === undefined || val.indexOf('-') < 0) {
        return val;
    }
    const timestamp = moment(val, moment.ISO_8601, true);
    if (timestamp.isValid()) {
        return timestamp.toDate();
    }
    return val;
}
//# sourceMappingURL=utils.js.map