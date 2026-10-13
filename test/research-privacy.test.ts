import test from "node:test";import assert from "node:assert/strict";
import {privateQueryReason} from "../src/tools/research-privacy.ts";
import {webResearchBatch} from "../server/web-research.ts";
test("egress rejects normalized private names and copied world/persona text without a classifier",()=>{
	const context={privateTerms:["SyntheticSecretName"],privateTexts:["The entirely synthetic private identity is a lighthouse keeper"]};
	for(const query of ["SyntheticSecretName history", "ＳｙｎｔｈｅｔｉｃＳｅｃｒｅｔＮａｍｅ history","Synthetic\u200bSecretName history","entirely synthetic private identity"])assert.ok(privateQueryReason(query,context),query);
	assert.equal(privateQueryReason("lighthouse engineering history",context),undefined);
});
test("a franchise tag is not egress permission for a private card name or user identity",async()=>{
	const card={name:"PrivateSyntheticAlias",tags:["source:PublicSyntheticWork"]} as never;
	for(const query of ["PrivateSyntheticAlias chapter", "TestPrivatePlayer history", "sk-proj-1234567890abcdef"]) {
		const rows=await webResearchBatch([query],3,{card,userName:"TestPrivatePlayer"});assert.ok(rows[0].rejected);
	}
});
test("only explicit user-approved public identifiers can exempt a protected name",()=>{
	const base={privateTerms:["PublicCanonicalName","PrivateAlias"],privateTexts:["PublicCanonicalName is a character in a synthetic story"]};
	assert.ok(privateQueryReason("PublicCanonicalName first chapter",base));
	assert.equal(privateQueryReason("PublicCanonicalName first chapter",{...base,publicTerms:["PublicCanonicalName"]}),undefined);
	assert.ok(privateQueryReason("PrivateAlias first chapter",{...base,publicTerms:["PublicCanonicalName"]}));
});
test("private material past the former 200k cap and a short exact canon quote is still protected",()=>{
	assert.ok(privateQueryReason("synthetic unpublished paragraph",{privateTexts:["x".repeat(200001),"synthetic unpublished paragraph"]}));
	assert.ok(privateQueryReason("雨桥相遇她尚不知道真相 details",{privateTerms:["雨桥相遇。她尚不知道真相。"]}));
});
test("literal phone numbers or short opaque secrets from private context cannot become a bare query",()=>{
	const context={privateTexts:["Synthetic private profile phone 2125550100 and access secret abcd1234"]};
	assert.ok(privateQueryReason("2125550100",context));assert.ok(privateQueryReason("abcd1234",context));
});
test("a private source fingerprint or branch locator is not a public research topic",()=>{
	const fingerprint="abc123def4567890";assert.ok(privateQueryReason(fingerprint,{privateTexts:[JSON.stringify({sourceFingerprint:fingerprint,branchConflictSourceIds:["synthetic-private-leaf-id"]})]}));
});


test("shared egress guard rejects fresh phone/contact/credentials without needing a prior private snapshot",()=>{
 for (const query of ["2125550100","+1 (212) 555-0100", "电话号码１３８００１３８０００", "sk-\u200bproj-1234567890ABCDEF", "Bearer abcdefghijklmnopqrst"])
  assert.ok(privateQueryReason(query,{}),query);
 for (const query of ["IANA example domains", "RFC 2606 Section 3", "history 2026-10-12", "Mars Phobos Deimos NASA"])
  assert.equal(privateQueryReason(query,{}),undefined,query);
});


test("normalization reuse follows actual text values and public authorization, not stale array positions",()=>{
 const context={privateTexts:["SyntheticSecretName canon"],publicTerms:[] as string[]};
 assert.ok(privateQueryReason("SyntheticSecretName canon",context));
 context.publicTerms.push("SyntheticSecretName");
 assert.equal(privateQueryReason("SyntheticSecretName canon",context),undefined);
 context.publicTerms.splice(0);assert.ok(privateQueryReason("SyntheticSecretName canon",context));
 context.privateTexts[0]="DifferentPrivatePhrase secret archive";
 assert.ok(privateQueryReason("DifferentPrivatePhrase secret archive",context));
 assert.equal(privateQueryReason("SyntheticSecretName canon",context),undefined);
});
