/* Compatibility worker retained only to replace previously installed workers.
 * Verified original resources are now routed by the owning iframe's
 * native-resources.js with its exact workspace lease. A worker-global mapping
 * or an unscoped /asset-map fetch cannot safely represent concurrent windows.
 * Unknown decorative resources retain the browser's normal network behavior.
 */
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
