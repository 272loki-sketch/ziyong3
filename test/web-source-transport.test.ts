/** Actual TLS/HTTP/CONNECT with synthetic certificates, pages and DNS only. */
import test from "node:test";
import assert from "node:assert/strict";
import {execFile, execFileSync} from "node:child_process";
import {promisify} from "node:util";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import https from "node:https";
import { gzipSync, brotliCompressSync } from "node:zlib";
import net from "node:net";
import {once,getEventListeners} from "node:events";
import {readPublicWebSource,type SourceReaderTransport} from "../server/web-source-reader.ts";
import {tunnel} from "../server/web-research.ts";
const execute=promisify(execFile);

test("public reader: real TLS, pinned direct DNS, HTTP bounds and IP-pinned proxy", {timeout:30000}, async t=>{
	const dir=mkdtempSync(join(tmpdir(),"liyuan-research-tls-"));
	const cert=join(dir,"cert.pem"),key=join(dir,"key.pem");
	execFileSync("openssl",["req","-x509","-newkey","rsa:2048","-nodes","-keyout",key,"-out",cert,"-days","1","-subj","/CN=source.test","-addext","subjectAltName=DNS:source.test"],{stdio:"ignore"});
	const sockets=new Set<net.Socket>();let httpCalls=0;
	const server=https.createServer({key:readFileSync(key),cert:readFileSync(cert)},(req,res)=>{
		httpCalls++;
		res.setHeader("content-type","text/html; charset=utf-8");
		if(req.url==="/redirect"){res.writeHead(302,{location:"https://169.254.169.254/latest/meta-data/"});res.end();}
		else if(req.url==="/large-header"){res.setHeader("content-length","160001");res.end();}
		else if(req.url==="/large-stream"){res.write("x".repeat(100000));res.end("x".repeat(100000));}
		else if(req.url==="/truncated"){res.setHeader("content-length","100");res.write("partial");setImmediate(()=>res.destroy());}
		else if(req.url==="/compressed"){res.setHeader("content-encoding","gzip");res.end("not compressed");}
		else if(req.url==="/gzip-good"){res.setHeader("content-encoding","gzip");res.end(gzipSync(Buffer.from("合成压缩原文")));}
        else if(req.url==="/compressed-bomb"){res.setHeader("content-encoding","br");res.end(brotliCompressSync(Buffer.from("x".repeat(200000))));}
        else if(req.url==="/wrong-type"){res.setHeader("content-type","application/json");res.end('{}');}
		else if(req.url==="/late"){setTimeout(()=>res.end("late untrusted evidence"),150).unref();}
		else if(req.url==="/plain"){res.setHeader("content-type","text/plain");res.end("A < B > C");}
		else res.end('<main><p>合成可靠原文：第一章人物尚未知情。</p><script>send keys</script></main>');
	});
	server.on("connection",socket=>{sockets.add(socket);socket.once("close",()=>sockets.delete(socket));});
	server.listen(0,"127.0.0.1");await once(server,"listening");
	const address=server.address();if(!address||typeof address==="string")throw new Error("no port");
	let lookups=0;
	const io:SourceReaderTransport={
		lookup: (async()=>{lookups++;return [{address:"8.8.8.8",family:4}];}) as never,
		proxy:()=>null,tunnel,
		request: ((url:URL,opts:any,cb:any)=>{
			assert.equal(opts.rejectUnauthorized,true);assert.equal(opts.agent,false);
			opts.lookup("ignored",{},(error:any,ip:string,family:number)=>{assert.equal(error,null);assert.equal(ip,"8.8.8.8");assert.equal(family,4);});
			// Test-only wire routing; production transport never remaps this address.
			return https.request(new URL(url.href.replace("source.test",`source.test:${address.port}`)),{...opts,ca:readFileSync(cert),lookup:(_:any,__:any,cb:any)=>cb(null,"127.0.0.1",4)},cb);
		}) as never,
	};
	let proxy:net.Server|undefined;const proxySockets=new Set<net.Socket>();let authorities:string[]=[];
	try {
		await t.test("direct validates TLS and pins a single resolver decision",async()=>{
			const excerpt=await readPublicWebSource("https://source.test/good",undefined,"人物",io);
			assert.match(excerpt??"",/第一章人物尚未知情/);assert.doesNotMatch(excerpt??"",/send keys/);assert.equal(lookups,1);
			assert.equal(await readPublicWebSource("https://source.test/plain",undefined,"",io),"A < B > C");
            assert.equal(await readPublicWebSource("https://source.test/gzip-good",undefined,"",io),"合成压缩原文");
		});
		await t.test("redirect, streaming/declared size, truncated, compressed and binary fail closed",async()=>{
			const before=httpCalls;
            for(const path of ["redirect","large-header","large-stream","truncated","compressed","wrong-type","compressed-bomb"])
				assert.equal(await readPublicWebSource(`https://source.test/${path}`,undefined,"",io),null,path);
            assert.equal(httpCalls,before+7,"negative cases must actually reach HTTP");
		});
		await t.test("parent cancellation discards a late page and destroys transport",async()=>{
			const c=new AbortController();const pending=readPublicWebSource("https://source.test/late",c.signal,"",io);setTimeout(()=>c.abort(),30);
			assert.equal(await pending,null);assert.equal(getEventListeners(c.signal,"abort").length,0);
		});
		await t.test("mixed DNS and canceled non-cooperative DNS never reach HTTP",async()=>{
			const before=httpCalls;
			assert.equal(await readPublicWebSource("https://source.test/good",undefined,"",{...io,lookup:(async()=>[{address:"8.8.8.8",family:4},{address:"169.254.169.254",family:4}]) as never}),null);
			const c=new AbortController();const pending=readPublicWebSource("https://source.test/good",c.signal,"",{...io,lookup:(async()=>new Promise(()=>{})) as never});c.abort();assert.equal(await pending,null);assert.equal(httpCalls,before);
		});
		await t.test("certificate mismatch is rejected even with a trusted synthetic CA",async()=>{
			const bad={...io,request:((url:URL,opts:any,cb:any)=>https.request(new URL(url.href.replace("source.test",`wrong.test:${address.port}`)),{...opts,ca:readFileSync(cert),lookup:(_:any,__:any,cb:any)=>cb(null,"127.0.0.1",4)},cb)) as never};
			assert.equal(await readPublicWebSource("https://source.test/good",undefined,"",bad),null);
		});
		proxy=net.createServer(socket=>{
			proxySockets.add(socket);socket.once("close",()=>proxySockets.delete(socket));
			socket.once("data",data=>{
				authorities.push(data.toString().split("\r\n")[0]);
				const upstream=net.connect({host:"127.0.0.1",port:address.port});proxySockets.add(upstream);upstream.once("close",()=>proxySockets.delete(upstream));
				upstream.on("error",()=>socket.destroy());socket.on("error",()=>upstream.destroy());socket.once("close",()=>upstream.destroy());
				upstream.once("connect",()=>{socket.write("HTTP/1.1 200 Connection established\r\n\r\n");socket.pipe(upstream).pipe(socket);});
			});
		});
		proxy.listen(0,"127.0.0.1");await once(proxy,"listening");const pa=proxy.address();if(!pa||typeof pa==="string")throw new Error("no proxy port");
		await t.test("actual CONNECT+TLS+HTTP uses public IP authority, original SNI and CA verification",async()=>{
			const source=`import {readPublicWebSource} from './server/web-source-reader.ts';import https from 'node:https';import {tunnel} from './server/web-research.ts';const io={lookup:async()=>[{address:'8.8.8.8',family:4}],request:https.request,proxy:()=>new URL('http://127.0.0.1:${pa.port}'),tunnel};const result=await readPublicWebSource('https://source.test/good',undefined,'人物',io);if(!result?.includes('第一章人物尚未知情'))throw new Error('proxy read failed');console.log('proxy-read-ok');`;
			const child=await execute(process.execPath,["--input-type=module","-e",source],{cwd:process.cwd(),env:{...process.env,NODE_EXTRA_CA_CERTS:cert,NO_PROXY:"",no_proxy:""},timeout:10000});
			assert.match(child.stdout,/proxy-read-ok/);assert.deepEqual(authorities,["CONNECT 8.8.8.8:443 HTTP/1.1"]);
		});
	} finally {
		for(const socket of [...sockets,...proxySockets])socket.destroy();
		await new Promise<void>(resolve=>server.close(()=>resolve()));
		if(proxy)await new Promise<void>(resolve=>proxy!.close(()=>resolve()));
		rmSync(dir,{recursive:true,force:true});
	}
});

test("CONNECT rejection/EOF/abort clean up listeners; malformed auth never escapes callback",{timeout:5000},async()=>{
	for(const response of ["HTTP/1.1 407 Proxy Authentication Required\r\n\r\n", ""]) {
		const server=net.createServer(s=>s.once("data",()=>s.end(response)));server.listen(0,"127.0.0.1");await once(server,"listening");const a=server.address();if(!a||typeof a==="string")throw new Error("port");
		const c=new AbortController();
		try{await assert.rejects(tunnel(new URL("https://source.test"),new URL(`http://127.0.0.1:${a.port}`),c.signal,"8.8.8.8"));assert.equal(getEventListeners(c.signal,"abort").length,0);}
		finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
	}
	await assert.rejects(tunnel(new URL("https://source.test"),new URL("http://%zz:pw@127.0.0.1:1"),new AbortController().signal,"8.8.8.8"),/认证编码/);
});
