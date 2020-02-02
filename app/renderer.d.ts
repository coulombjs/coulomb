import { AppConfig } from '../config/app';
import { RendererConfig } from '../config/renderer';
import '!style-loader!css-loader!@blueprintjs/datetime/lib/css/blueprint-datetime.css';
import '!style-loader!css-loader!@blueprintjs/core/lib/css/blueprint.css';
import '!style-loader!css-loader!./normalize.css';
import '!style-loader!css-loader!./renderer.css';
interface AppRenderer {
    root: HTMLElement;
}
export declare const renderApp: <A extends AppConfig, C extends RendererConfig<A>>(config: C) => Promise<AppRenderer>;
export {};
