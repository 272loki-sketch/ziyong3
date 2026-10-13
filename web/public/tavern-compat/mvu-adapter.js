/** Parse-only compatibility projection; never changes the saved author/story or calls a model. */
export function mvuParsingProjection(text){
 const source=String(text??'');let changed=false;
 const projected=source.replace(/(<JSONPatch(?:\s[^>]*)?>)([\s\S]*?)(<\/UpdateVariable\s*>)/gi,(whole,open,body,close)=>{
  if(/<\/JSONPatch\s*>/i.test(body))return whole;
  const value=body.trim().replace(/^```(?:json)?\s*|\s*```$/g,'');
  try{if(!Array.isArray(JSON.parse(value)))return whole;}catch{return whole;}
  changed=true;return open+body+'</JSONPatch>\n'+close;
 });
 return {text:projected,repairedPatchClosingTag:changed};
}

/** Native MVU may catch a failed request and return normally. Do not issue a success receipt. */
export function assertMvuCandidatesSettled(candidates){
 if(candidates.some(candidate=>candidate.pending))throw new Error('MVU candidate request is still pending; no completion receipt');
 if(candidates.length&&!candidates.some(candidate=>candidate.ok)){const reason=candidates.map(candidate=>candidate.error).filter(error=>typeof error==='string'&&error).at(-1);throw new Error('MVU candidate requests failed; no completion receipt'+(reason?': '+reason:''));}
}

/** ST envelope metadata is not an SDK sampler or credential. Keep executable fields intact. */
export function mvuManagedCandidatePayload(payload){
 const result={...payload};
 if(result.type!==undefined&&result.type!=='normal')throw new Error('Unsupported native generation type');
 if(result.proxy_password!==undefined&&result.proxy_password!=='')throw new Error('Managed MVU cannot use proxy credentials');
 for(const name of ['user_name','char_name'])if(result[name]!==undefined&&typeof result[name]!=='string')throw new Error('Invalid native name metadata');
 if(result.group_names!==undefined&&(!Array.isArray(result.group_names)||result.group_names.length))throw new Error('Group generation is not supported');
 if(result.include_reasoning!==undefined&&result.include_reasoning!==true)throw new Error('Unsupported native reasoning envelope');
 for(const name of ['type','user_name','char_name','group_names','proxy_password','include_reasoning'])delete result[name];
 // Native chat-message custom_api uses the OpenAI-compatible proxy transport.
 if(result.chat_completion_source==='openai'&&typeof result.reverse_proxy==='string'&&result.reverse_proxy)result.chat_completion_source='custom';
 return result;
}
