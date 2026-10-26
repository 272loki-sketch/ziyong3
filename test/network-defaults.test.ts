import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { readFileSync } from "node:fs";
import { AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS, configureNetworkDefaults } from "../src/network-defaults.ts";

test("host widens the per-address Happy Eyeballs attempt so a busy event loop cannot fail a reachable IPv4 connect", () => {
	const before = net.getDefaultAutoSelectFamilyAttemptTimeout();
	try {
		net.setDefaultAutoSelectFamilyAttemptTimeout(250);
		configureNetworkDefaults();
		assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout(), AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS);
		// An operator who already chose a longer wait keeps it.
		net.setDefaultAutoSelectFamilyAttemptTimeout(9000);
		configureNetworkDefaults();
		assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout(), 9000);
	} finally { net.setDefaultAutoSelectFamilyAttemptTimeout(before); }
});

test("server entry applies network defaults before any request is constructed", () => {
	const main = readFileSync(new URL("../server/main.ts", import.meta.url), "utf8");
	const call = main.indexOf("configureNetworkDefaults();");
	assert.ok(call > 0 && call < main.indexOf("const cwd = process.cwd();") + 40, "configured at module start");
});
