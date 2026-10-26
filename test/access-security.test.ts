import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, lstatSync, readFileSync, writeFileSync, rmSync, symlinkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { accessCookie, clearPassword, issueToken, loadAccess, parseCookies, revokeToken, setPassword, verifyPassword, verifyToken } from "../src/access.ts";

function fixture(run: (cwd: string) => void): void {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-access-security-"));
	try { run(cwd); } finally { rmSync(cwd, { recursive: true, force: true }); }
}

test("missing password is open, corrupt existing credentials fail closed without overwriting", () => fixture(cwd => {
	assert.equal(loadAccess(cwd), null); mkdirSync(join(cwd, ".liyuan"));
	const path = join(cwd, ".liyuan/access.json");
	for (const bytes of ["{invalid", "null", "{}", '{"salt":"x","hash":"y","tokens":[]}', "x".repeat(65537)]) {
		writeFileSync(path, bytes);
		assert.throws(() => loadAccess(cwd), /拒绝开放服务/);
		assert.equal(readFileSync(path, "utf8"), bytes);
	}
}));

test("password persistence is private and atomic; tokens and old credentials revoke correctly", () => fixture(cwd => {
	const { data, token } = setPassword(cwd, "synthetic-password");
	assert.equal(verifyPassword(data, "synthetic-password"), true);
	assert.equal(verifyPassword(data, "wrong"), false);
	assert.equal(verifyPassword(data, "x".repeat(1025)), false);
	assert.equal(verifyToken(data, token), true); assert.equal(verifyToken(data, "__proto__"), false);
	assert.deepEqual(loadAccess(cwd), data);
	if (process.platform !== "win32") {
		assert.equal(lstatSync(join(cwd, ".liyuan")).mode & 0o777, 0o700);
		assert.equal(lstatSync(join(cwd, ".liyuan/access.json")).mode & 0o777, 0o600);
	}
	const next = issueToken(cwd, data); assert.equal(verifyToken(data, next), true);
	revokeToken(cwd, data, next); assert.equal(verifyToken(data, next), false);
	assert.deepEqual(loadAccess(cwd), data);
	const updated = setPassword(cwd, "different-synthetic-password");
	assert.equal(verifyToken(updated.data, token), false);
	clearPassword(cwd); assert.equal(loadAccess(cwd), null); clearPassword(cwd);
	assert.throws(() => setPassword(cwd, "x".repeat(1025)), /长度/);
}));

test("failed token persistence does not publish an in-memory successful login or logout", () => fixture(cwd => {
	const { data, token } = setPassword(cwd, "synthetic-password");
	const path = join(cwd, ".liyuan/access.json");
	renameSync(path, `${path}.fixture`); mkdirSync(path);
	const before = structuredClone(data);
	assert.throws(() => issueToken(cwd, data)); assert.deepEqual(data, before);
	assert.throws(() => revokeToken(cwd, data, token)); assert.deepEqual(data, before);
	assert.throws(() => clearPassword(cwd));
}));

test("symlinks and malformed token records cannot disable the access guard", () => fixture(cwd => {
	const { data } = setPassword(cwd, "synthetic-password");
	const path = join(cwd, ".liyuan/access.json");
	writeFileSync(path, JSON.stringify({ ...data, tokens: [{ id: "bad", createdAt: 0 }] }));
	assert.throws(() => loadAccess(cwd));
	if (process.platform !== "win32") {
		rmSync(path); const other = join(cwd, "synthetic-credentials.json"); writeFileSync(other, JSON.stringify(data)); symlinkSync(other, path);
		assert.throws(() => loadAccess(cwd)); assert.throws(() => setPassword(cwd, "synthetic-password"));
		assert.equal(readFileSync(other, "utf8"), JSON.stringify(data));
	}
}));

test("cookie parsing has no inherited properties or prototype-pollution side effects", () => {
	const cookies = parseCookies("__proto__=poison; constructor=fixture; liyuan_access=abc; malformed=%zz");
	assert.equal(Object.getPrototypeOf(cookies), null); assert.equal(cookies.__proto__, "poison");
	assert.equal(cookies.liyuan_access, "abc"); assert.equal(cookies.malformed, undefined);
	assert.equal(parseCookies(undefined).liyuan_access, undefined);
});

test("HTTPS cookies are Secure while explicit HTTP compatibility never removes HttpOnly or SameSite", () => {
	const token = "a".repeat(64);
	assert.match(accessCookie(token, true), /HttpOnly; SameSite=Strict; Secure;/);
	assert.equal(accessCookie(token).includes("Secure"), false);
	assert.match(accessCookie(null, true), /Max-Age=0$/);
	assert.throws(() => accessCookie("unsafe; injected=1"));
});

test("server-side tokens expire with the one-year cookie and reject future-dated credentials", () => fixture(cwd => {
	const { data, token } = setPassword(cwd, "synthetic-password");
	const issued = data.tokens[0].createdAt;
	assert.equal(verifyToken(data, token, issued + 1000), true);
	assert.equal(verifyToken(data, token, issued + 365 * 24 * 60 * 60 * 1000), false);
	assert.equal(verifyToken(data, token, issued - 60_001), false);
}));
