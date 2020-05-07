import { Type } from 'js-yaml';


function resolveYamlBoolean(data) {
  if (data === null) return false;

  var max = data.length;

  return (max === 3 && (data === 'yes' || data === 'Yes' || data === 'YES')) ||
         (max === 2 && (data === 'no' || data === 'No' || data === 'NO'));
}

function constructYamlBoolean(data) {
  return data === 'yes' ||
         data === 'Yes' ||
         data === 'YES';
}

function isBoolean(object) {
  return Object.prototype.toString.call(object) === '[object Boolean]';
}

const customBoolType = new Type('tag:yaml.org,2002:bool', {
  kind: 'scalar',
  resolve: resolveYamlBoolean,
  construct: constructYamlBoolean,
  predicate: isBoolean,
  represent: {
    lowercase: function (object) { return object ? 'true' : 'false'; },
    uppercase: function (object) { return object ? 'TRUE' : 'FALSE'; },
    camelcase: function (object) { return object ? 'True' : 'False'; }
  },
  defaultStyle: 'lowercase'
});


export { customBoolType };