import { installWindowApi } from "./compat/window-api";
import { installLegacyFacades } from "./compat/legacy-facades";

declare const __BA_BROWSER_SOURCE_ORDER__: string[];

installLegacyFacades();
installWindowApi(__BA_BROWSER_SOURCE_ORDER__);
