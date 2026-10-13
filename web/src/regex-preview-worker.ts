import { previewOriginalRegex, type RegexPreviewInput } from "../../src/regex-preview.ts";
self.addEventListener("message", (event:MessageEvent<RegexPreviewInput>) => {
 try {self.postMessage({ok:true,result:previewOriginalRegex(event.data)});}
 catch (error) {self.postMessage({ok:false,error:error instanceof Error?error.message:String(error)});}
});
