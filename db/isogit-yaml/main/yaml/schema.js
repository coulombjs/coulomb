import * as yaml from 'js-yaml';
import { customTimestampType } from './yaml-custom-ts';
import { customBoolType } from './yaml-custom-bool';
export const Schema = new yaml.Schema({
    include: [yaml.DEFAULT_SAFE_SCHEMA],
    // Trick because js-yaml API appears to not support augmenting implicit tags
    implicit: [
        ...yaml.DEFAULT_SAFE_SCHEMA.implicit,
        ...[customTimestampType, customBoolType],
    ],
});
/* This schema simply adds timestamp parsing to YAML. */
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2NoZW1hLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vLi4vc3JjL2RiL2lzb2dpdC15YW1sL21haW4veWFtbC9zY2hlbWEudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxLQUFLLElBQUksTUFBTSxTQUFTLENBQUM7QUFDaEMsT0FBTyxFQUFFLG1CQUFtQixFQUFFLE1BQU0sa0JBQWtCLENBQUM7QUFDdkQsT0FBTyxFQUFFLGNBQWMsRUFBRSxNQUFNLG9CQUFvQixDQUFDO0FBR3BELE1BQU0sQ0FBQyxNQUFNLE1BQU0sR0FBRyxJQUFJLElBQUksQ0FBQyxNQUFNLENBQUM7SUFDcEMsT0FBTyxFQUFFLENBQUMsSUFBSSxDQUFDLG1CQUFtQixDQUFDO0lBRW5DLDRFQUE0RTtJQUM1RSxRQUFRLEVBQUU7UUFDUixHQUFJLElBQUksQ0FBQyxtQkFBMkIsQ0FBQyxRQUFRO1FBQzdDLEdBQUcsQ0FBQyxtQkFBbUIsRUFBRSxjQUFjLENBQUM7S0FDekM7Q0FDRixDQUFDLENBQUM7QUFDSCx3REFBd0QiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyB5YW1sIGZyb20gJ2pzLXlhbWwnO1xuaW1wb3J0IHsgY3VzdG9tVGltZXN0YW1wVHlwZSB9IGZyb20gJy4veWFtbC1jdXN0b20tdHMnO1xuaW1wb3J0IHsgY3VzdG9tQm9vbFR5cGUgfSBmcm9tICcuL3lhbWwtY3VzdG9tLWJvb2wnO1xuXG5cbmV4cG9ydCBjb25zdCBTY2hlbWEgPSBuZXcgeWFtbC5TY2hlbWEoe1xuICBpbmNsdWRlOiBbeWFtbC5ERUZBVUxUX1NBRkVfU0NIRU1BXSxcblxuICAvLyBUcmljayBiZWNhdXNlIGpzLXlhbWwgQVBJIGFwcGVhcnMgdG8gbm90IHN1cHBvcnQgYXVnbWVudGluZyBpbXBsaWNpdCB0YWdzXG4gIGltcGxpY2l0OiBbXG4gICAgLi4uKHlhbWwuREVGQVVMVF9TQUZFX1NDSEVNQSBhcyBhbnkpLmltcGxpY2l0LFxuICAgIC4uLltjdXN0b21UaW1lc3RhbXBUeXBlLCBjdXN0b21Cb29sVHlwZV0sXG4gIF0sXG59KTtcbi8qIFRoaXMgc2NoZW1hIHNpbXBseSBhZGRzIHRpbWVzdGFtcCBwYXJzaW5nIHRvIFlBTUwuICovXG4iXX0=