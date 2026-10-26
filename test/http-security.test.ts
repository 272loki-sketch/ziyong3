import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AccessAttemptLimiter, isAccessGuardedPath, isSameOriginRequest, isTrustedUnprotectedHost, requestPathname, resolveStaticFile } from "../server/http-security.ts";

function request(headers: Record<string, string>) { return { headers }; }

test("HTTP/WS reject foreign, same-site, null, malformed and forged browser origins", () => {
	for (const origin of ["https://evil.invalid", "null", "https://app.invalid/path", "https://app.invalid#fragment", "https://app.invalid:443", "https://app.invalid/"]) {
		assert.equal(isSameOriginRequest(request({ host: "app.invalid", origin })), false, origin);
	}
	const credentialOrigin = new URL("https://app.invalid"); credentialOrigin.username = "synthetic-user"; credentialOrigin.password = "synthetic-password";
	assert.equal(isSameOriginRequest(request({ host: "app.invalid", origin: credentialOrigin.href })), false);
	assert.equal(isSameOriginRequest(request({ host: "app.invalid", origin: "https://app.invalid" })), true);
	assert.equal(isSameOriginRequest(request({ host: "app.invalid", origin: "http://app.invalid" })), true); // TLS termination is supported without trusting forwarded headers.
	assert.equal(isSameOriginRequest(request({ host: "localhost:7620", origin: "http://localhost:7620", "sec-fetch-site": "same-origin" })), true);
	assert.equal(isSameOriginRequest(request({ host: "[::1]:7620", origin: "http://[::1]:7620" })), true);
	assert.equal(isSameOriginRequest(request({ host: "localhost:7620", origin: "http://localhost:7621" })), false);
	for (const site of ["cross-site", "same-site", "invalid"]) assert.equal(isSameOriginRequest(request({ host: "app.invalid", "sec-fetch-site": site })), false);
	assert.equal(isSameOriginRequest(request({ host: "app.invalid" })), true);
	assert.equal(isSameOriginRequest(request({ host: "app.invalid", "sec-fetch-site": "none" })), true);
});

test("canonical access guard protects original plugin files and normalized aliases", () => {
	for (const path of ["/veridis-rewrite-host.html", "/veridis-rewrite/original/settings.html", "/tavern-plugin-host.html", "/api/config", "/uploads/file.png"]) assert.equal(isAccessGuardedPath(path), true);
	assert.equal(isAccessGuardedPath(requestPathname("/public/../api/config?fixture=1")), true);
	assert.equal(isAccessGuardedPath(requestPathname("/public/%2e%2e/veridis-rewrite/original.js")), true);
	assert.equal(isAccessGuardedPath(requestPathname("/%61pi/config")), true);
	assert.equal(isAccessGuardedPath("/assets/app.js"), false);
	assert.equal(isAccessGuardedPath("/api/access/status"), false);
	for (const value of ["//evil.invalid/path", "http://evil.invalid/api/config", "/bad%zz", "/bad%00", "/bad%5cfile", "/bad\\file"]) assert.throws(() => requestPathname(value));
});

test("static resolver only serves regular contained files, including Unicode filenames", () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-static-security-"));
	try {
		const root = join(cwd, "public"); mkdirSync(join(root, "nested"), { recursive: true });
		writeFileSync(join(root, "nested/合成.txt"), "fixture"); writeFileSync(join(cwd, "secret.txt"), "synthetic-not-real");
		writeFileSync(join(root, ".hidden"), "hidden");
		assert.equal(resolveStaticFile(root, "nested/合成.txt"), join(root, "nested/合成.txt"));
		for (const name of ["../secret.txt", "nested/../../secret.txt", "/secret.txt", "nested/../.hidden", ".hidden", "nested", "nested\\file", "nested//file", "missing"]) assert.equal(resolveStaticFile(root, name), null, name);
		if (process.platform !== "win32") {
			symlinkSync(join(cwd, "secret.txt"), join(root, "linked.txt")); symlinkSync(cwd, join(root, "linked-directory"));
			assert.equal(resolveStaticFile(root, "linked.txt"), null);
			assert.equal(resolveStaticFile(root, "linked-directory/secret.txt"), null);
		}
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("pre-hash login limits are per-socket, globally bounded and expire", () => {
	let now = 10; const limiter = new AccessAttemptLimiter(() => now, 1000, 10);
	for (let i = 0; i < 5; i++) assert.equal(limiter.allow("fixture-a"), true);
	assert.equal(limiter.allow("fixture-a"), false);
	for (const client of ["b", "c", "d"]) for (let i = 0; i < 5; i++) assert.equal(limiter.allow(client), true);
	assert.equal(limiter.allow("other"), false);
	now += 1000; assert.equal(limiter.allow("fixture-a"), true);
	const bounded = new AccessAttemptLimiter(() => now, 1000, 2);
	assert.equal(bounded.allow("a"), true); assert.equal(bounded.allow("b"), true); assert.equal(bounded.allow("c"), false);
	now += 1000; assert.equal(bounded.allow("c"), true);
});

test("unprotected host allowlist rejects arbitrary DNS and userinfo rather than relying on Origin alone", () => {
	const trusted = new Set(["localhost", "127.0.0.1", "[::1]", "192.0.2.10", "explicit-fixture.invalid"]);
	for (const host of ["localhost:7620", "127.0.0.1:7620", "[::1]:7620", "192.0.2.10:7620", "explicit-fixture.invalid"]) assert.equal(isTrustedUnprotectedHost(request({ host }), trusted), true);
	for (const host of ["rebind.invalid", "localhost.evil.invalid", "localhost/extra", "localhost?query=1"]) assert.equal(isTrustedUnprotectedHost(request({ host }), trusted), false);
	assert.equal(isTrustedUnprotectedHost(request({}), trusted), false);
});


test("non-default HTTPS proxy template preserves the original Host authority for HTTP and WebSocket origins",()=>{
 const template=readFileSync(new URL('../deploy/nginx-8788.conf',import.meta.url),'utf8');
 assert.match(template,/proxy_set_header\s+Host\s+\$http_host\s*;/);
 assert.doesNotMatch(template,/proxy_set_header\s+Host\s+\$host\s*;/);
 for(const host of ['app.invalid:8788','127.0.0.1:8788','[::1]:8788']){
  const origin='https://'+host;
  assert.equal(isSameOriginRequest(request({host,origin,'sec-fetch-site':'same-origin'})),true);
  assert.equal(isSameOriginRequest(request({host,origin:origin.replace(':8788',':8789'),'sec-fetch-site':'same-origin'})),false);
  assert.equal(isSameOriginRequest(request({host,origin,'sec-fetch-site':'cross-site'})),false);
 }
 assert.equal(isSameOriginRequest(request({host:'app.invalid',origin:'https://app.invalid:8788','x-forwarded-host':'app.invalid:8788'})),false,'untrusted forwarded headers must not bypass the strict comparison');
});
