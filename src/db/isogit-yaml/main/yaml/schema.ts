import * as yaml from 'js-yaml';
import { customTimestampType } from './yaml-custom-ts';


export const Schema = new yaml.Schema({
  include: [yaml.DEFAULT_SAFE_SCHEMA],

  // Trick because js-yaml API appears to not support augmenting implicit tags
  implicit: [
    ...(yaml.DEFAULT_SAFE_SCHEMA as any).implicit,
    ...[customTimestampType],
  ],
});
/* This schema simply adds timestamp parsing to YAML. */
