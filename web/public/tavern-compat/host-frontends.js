/** Install only host-side UI adapters before importing the unchanged native-plugin host. */
import { host } from './bridge.js';
import { installFrontendApi, installFrontendDomContext } from './frontend-api.js';
installFrontendApi(host);
await import('./host-base.js');
installFrontendDomContext(host);
