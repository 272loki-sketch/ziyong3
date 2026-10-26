import assert from "node:assert/strict";
import test from "node:test";
import { greetingBranchLeaf } from "../src/greeting.ts";

test("opening source ignores only model/thinking metadata, not actual branch changes or story entries", () => {
 const greeting={id:"greeting-a",type:"custom_message"};
 assert.equal(greetingBranchLeaf([greeting]),"greeting-a");
 assert.equal(greetingBranchLeaf([greeting,{id:"model",type:"model_change"},{id:"thinking",type:"thinking_level_change"}]),"greeting-a");
 assert.equal(greetingBranchLeaf([{id:"model",type:"model_change"}]),null);
 assert.equal(greetingBranchLeaf([]),null);
 assert.equal(greetingBranchLeaf([greeting,{id:"greeting-b",type:"custom_message"},{id:"model",type:"model_change"}]),"greeting-b");
 assert.equal(greetingBranchLeaf([greeting,{id:"user",type:"message"}]),"user");
 assert.equal(greetingBranchLeaf([greeting,{id:"other-source",type:"custom"}]),"other-source");
});
