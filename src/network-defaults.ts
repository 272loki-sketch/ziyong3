import net from "node:net";

/**
 * Node 的 Happy Eyeballs 默认每个地址只等 250ms。这个计时器跑在事件循环上：
 * 后台结算开工时主线程常有几百毫秒的同步工作，计时器到点时可用的 IPv4 握手还没被处理，
 * 就被判超时、转去尝试（本机不通的）IPv6，最后整次请求报 UND_ERR_CONNECT_TIMEOUT。
 * 放宽单地址等待只影响"第一个地址确实不通"时的回退时机，不改变地址顺序或总超时。
 */
export const AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2500;

export function configureNetworkDefaults(): void {
	if (net.getDefaultAutoSelectFamilyAttemptTimeout() < AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS) {
		net.setDefaultAutoSelectFamilyAttemptTimeout(AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS);
	}
}
