import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import { splitRichContentParts } from "../web/src/richContentParts.ts";
import { prepareDisplayText } from "../src/postprocess.ts";
import { parseImagePrompt, scanImagePromptBlocks } from "../src/image-prompts.ts";

test("解析智慧姬 image### 场景与分角色提示词", () => {
	const p = parseImagePrompt(`【窗边】\nimage###\nScene Composition:1girl, classroom;\nCharacter 1 Prompt:horikita suzune, black hair|centers:0.3,0.5;\nCharacter 1 UC:bad hands;\n###`);
	assert.equal(p.scene, "1girl, classroom;");
	assert.equal(p.characters[0]?.prompt, "horikita suzune, black hair;");
	assert.deepEqual(p.characters[0]?.center, { x: 0.3, y: 0.5 });
	assert.equal(p.characters[0]?.uc, "bad hands;");
});

test("显示层识别历史 image 块，但跳过 markdown 示例", () => {
	const parts = splitRichContentParts("正文\n<image>【窗边】\nimage###1girl###</image>", null);
	assert.equal(parts.some((part) => part.kind === "imagePrompt" && part.title === "窗边"), true);
	const sample = splitRichContentParts("```xml\n<image>image###example###</image>\n```", null);
	assert.equal(sample.some((part) => part.kind === "imagePrompt"), false);
});

test("显示层兼容旧卡 imageTag 别名", () => {
	const parts = splitRichContentParts("正文\n<imageTag>【旧卡图片】\nimage###1girl###</imageTag>", null);
	assert.equal(parts.some((part) => part.kind === "imagePrompt" && part.title === "旧卡图片"), true);
});

test("服务端显示清洗保留 image/imageTag 历史图片提示", () => {
	for (const tag of ["image", "imageTag"]) {
		const source = `<${tag}>【窗边】image###1girl###</${tag}>`;
		const cleaned = prepareDisplayText(source);
		assert.match(cleaned, new RegExp(`<${tag}>`));
		assert.ok(splitRichContentParts(cleaned, null).some((part) => part.kind === "imagePrompt"));
	}
});

test("bare inline Scene Composition protocol uses the existing image slot and isolates NAI fields", () => {
	const protocol = "image###Scene Composition:1girl,1boy, station; Character 1 Prompt:synthetic woman, blue coat|centers:b3; Character 1 UC:bad hands; Character 2 Prompt:$synthetic man-from front-sfw-upperBody-sfw-LowerBody$, brown coat|centers:0.7,0.5; Character 2 UC:blur;###";
	const source = `Before.\n【Synthetic scene】${protocol}\nAfter.`;
	const parts = splitRichContentParts(prepareDisplayText(source), null);
	assert.deepEqual(parts.map(part => part.kind), ["text", "imagePrompt", "text"]);
	const image = parts[1];
	assert.equal(image.kind, "imagePrompt");
	if (image.kind !== "imagePrompt") return;
	assert.equal(image.title, "Synthetic scene");
	assert.equal(image.prompt, `【Synthetic scene】${protocol}`);
	const parsed = parseImagePrompt(image.prompt);
	assert.equal(parsed.scene, "1girl,1boy, station;");
	assert.equal(parsed.characters.length, 2);
	assert.equal(parsed.characters[0].prompt, "synthetic woman, blue coat;");
	assert.equal(parsed.characters[0].uc, "bad hands;");
	assert.deepEqual(parsed.characters[0].center, { x: 0.5, y: 0.5 });
	assert.equal(parsed.characters[1].prompt, "$synthetic man-from front-sfw-upperBody-sfw-LowerBody$, brown coat;");
	assert.deepEqual(parsed.characters[1].center, { x: 0.7, y: 0.5 });
	assert.equal(parsed.characters[1].uc, "blur;");
	assert.equal(parts.filter(part => part.kind === "text").map(part => part.text).join(""), "Before.\n\nAfter.");
});

test("multiple wrapped and bare image protocols preserve prose and unknown formats", () => {
	const source = "Before.\n<image data-id=\"synthetic\">【One】image###tree###</image>\nBetween.\n<unknown-format>Keep this unknown format.</unknown-format>\n【Two】image###cloud###\nAfter.";
	const parts = splitRichContentParts(prepareDisplayText(source), null);
	assert.equal(parts.filter(part => part.kind === "imagePrompt").length, 2);
	const prose = parts.filter(part => part.kind === "text").map(part => part.text).join("");
	for (const sentence of ["Before.", "Between.", "Keep this unknown format.", "After."]) assert.ok(prose.includes(sentence));
	assert.doesNotMatch(prose, /image###|tree|cloud/);
	assert.deepEqual(splitRichContentParts("image%%%unknown%%%", null), [{ kind: "text", text: "image%%%unknown%%%" }]);
});

test("unclosed protocols and code examples do not consume prose or create image slots", () => {
	for (const source of ["image###unfinished\nAfter.", "`image###example###`", "```xml\nimage###example###\n```", "```xml\nimage###example###"]) {
		assert.deepEqual(splitRichContentParts(source, null), [{ kind: "text", text: source }]);
	}
	const source = "image###unfinished\nKeep this.\nimage###tree###\nAfter.";
	const parts = splitRichContentParts(source, null);
	assert.deepEqual(parts.map(part => part.kind), ["text", "imagePrompt", "text"]);
	assert.deepEqual(parts[0], { kind: "text", text: "image###unfinished\nKeep this.\n" });
	assert.deepEqual(parts[2], { kind: "text", text: "\nAfter." });
});

test("image protocols inside HTML remain owned by their frame", () => {
	const parts = splitRichContentParts('<div>image###tree###</div>\nAfter.', null);
	assert.deepEqual(parts.map(part => part.kind), ["html", "text"]);
});

test("complete first image and truncated second image retain source and hide protocol from paragraphs", () => {
	const unfinished = '<image>【Two】\nCharacter descriptions\nimage###Scene Composition:1girl,1boy; Character 1 Prompt:blue coat|centers:b3; Character 1 UC:blur; Character 2 Prompt:$synthetic-from front-sfw-upperBody$, brown coat';
	const source = `Story before.\n<image>【One】image###tree###</image>\nStory between.\n${unfinished}`;
	const original = source;
	const display = prepareDisplayText(source);
	assert.ok(display.endsWith(unfinished));
	assert.equal(source, original);
	const parts = splitRichContentParts(display, null);
	const images = parts.filter(part => part.kind === "imagePrompt");
	assert.equal(images.length, 2);
	assert.equal(images[0].incomplete, undefined);
	assert.equal(images[1].incomplete, true);
	assert.equal(images[1].prompt, unfinished);
	const prose = parts.filter(part => part.kind === "text").map(part => part.text).join("");
	assert.match(prose, /Story before/);
	assert.match(prose, /Story between/);
	assert.doesNotMatch(prose, /Scene Composition|Character|centers|image###/);
});

test("incomplete wrappers stop at structure; bare protocols also stop at prose", () => {
	for (const start of ['<image>【Two】\nimage###Scene Composition:1girl;\n', 'image###Scene Composition:1girl;\n']) {
		for (const tail of ['Story continues.', '<unknown-format>Keep me.</unknown-format>', '<div>Keep me.</div>', '```xml\nKeep me.\n```', '<image>image###tree###</image>']) {
			if (start.startsWith('<image>') && tail === 'Story continues.') continue;
			const parts = splitRichContentParts(prepareDisplayText(start + tail), null);
			assert.equal(parts[0].kind, "imagePrompt");
			if (parts[0].kind !== "imagePrompt") continue;
			assert.equal(parts[0].incomplete, true);
			assert.doesNotMatch(parts[0].prompt, /Keep me|Story continues|tree/);
			assert.ok(parts.length > 1);
		}
	}
});

test("complete and incomplete rendering share the read-only historical component", () => {
	const messages = readFileSync(new URL('../web/src/components/Messages.tsx', import.meta.url), 'utf8');
	assert.match(messages, /if \(p\.kind === "imagePrompt"\) return <HistoricalImage[^\n]*incomplete=\{p\.incomplete\}/);
	assert.match(messages, /if \(incomplete\) return;/);
	for (const source of ['```xml\n<image>image###Scene Composition:example', 'image###not a known field\nStory.']) {
		assert.deepEqual(splitRichContentParts(source, null), [{ kind: "text", text: source }]);
	}
	const parts = splitRichContentParts(prepareDisplayText('<image>\nStory continues without a protocol.'), null);
	assert.equal(parts[0].kind, 'imagePrompt');
	assert.equal(parts.length, 1);
	assert.equal(parts[0].prompt, '<image>\nStory continues without a protocol.');
});

test("explicit truncated image keeps description and Character1 metadata in one tail slot", () => {
	for (const description of ['描述:合成中文说明', 'Description:synthetic description', '中文角色:合成角色说明']) {
		const tail = `<image>【标题】\n${description}\n  合成说明的缩进续行\nCharacter1中文角色\n角色2:合成中文角色\nimage###Scene Composition:1girl,1boy;\nCharacter 1 Prompt:blue coat|centers:b3;\nCharacter 1 UC:blur;\nCharacter 2 Prompt:$synthetic-from front-sfw-upperBody$, brown coat`;
		const source = `<image>【完整】image###tree###</image>\n合成正文。\n${tail}`;
		const blocks = scanImagePromptBlocks(source);
		assert.equal(blocks.length, 2);
		assert.equal(blocks[0].incomplete, undefined);
		assert.equal(blocks[1].incomplete, true);
		assert.equal(source.slice(blocks[1].start, blocks[1].end), tail);
		const display = prepareDisplayText(source);
		assert.equal(display, source);
		const parts = splitRichContentParts(display, null);
		const images = parts.filter(part => part.kind === 'imagePrompt');
		assert.equal(images.length, 2);
		assert.equal(images[1].prompt, tail);
		assert.equal(images[1].incomplete, true);
		assert.equal(parts.filter(part => part.kind === 'text').map(part => part.text).join(''), '\n合成正文。\n');
	}
	const tail = '<image>【标题】\n描述:合成说明\n后续普通正文。';
	const parts = splitRichContentParts(prepareDisplayText(tail), null);
	assert.equal(parts.length, 1);
	assert.equal(parts[0].prompt, tail);
});

test("unknown metadata and multiline semicolons remain owned by one hanging wrapper", () => {
	const tail = '<image>【未知元数据】\n布局备注=合成说明\n没有名单标记的中文说明\n另一行自由文字\nimage###Scene Composition:1girl,1boy;\n中文补充说明;\nCharacter 1 Prompt:blue coat;\n续行;\nCharacter 2 Prompt:brown coat;';
	const source = '<image>【完整】image###tree###</image>\n正文。\n' + tail;
	const blocks = scanImagePromptBlocks(source);
	assert.equal(blocks.length, 2);
	assert.equal(blocks[0].incomplete, undefined);
	assert.equal(blocks[1].incomplete, true);
	assert.ok(blocks[0].end <= blocks[1].start);
	assert.equal(blocks[1].end, source.length);
	assert.equal(blocks[1].prompt, tail);
	assert.equal(prepareDisplayText(source), source);
	const images = splitRichContentParts(prepareDisplayText(source), null).filter(p => p.kind === 'imagePrompt');
	assert.equal(images.length, 2);
	assert.equal(images[1].prompt, tail);
});

test("paired generic pre-protocol children stay in one incomplete image, never HTML frames", () => {
	for (const child of ['<imgthink>synthetic meta</imgthink>', '<unknown-meta>合成说明</unknown-meta>', '<div><div>nested</div><script>window.__metadataExecuted=true</script></div>', '<meta-one>one</meta-one><meta-two>two</meta-two>']) {
		const tail = `<image>【题】\n${child}\nimage###Scene Composition:1girl; Character 1 Prompt:synthetic coat;`;
		for (const previous of ['', '<image>【完整】image###tree###</image>\n正文。\n']) {
			const source = previous + tail;
			const blocks = scanImagePromptBlocks(source);
			assert.equal(blocks.length, previous ? 2 : 1);
			assert.equal(blocks.at(-1)?.prompt, tail);
			assert.equal(blocks.at(-1)?.end, source.length);
			if (previous) assert.ok(blocks[0].end <= blocks[1].start);
			assert.equal(prepareDisplayText(source), source);
			const parts = splitRichContentParts(prepareDisplayText(source), null);
			assert.equal(parts.filter(p => p.kind === 'imagePrompt').length, previous ? 2 : 1);
			assert.equal(parts.filter(p => p.kind === 'html').length, 0);
			assert.equal(parts.at(-1)?.incomplete, true);
			assert.equal(parts.at(-1)?.prompt, tail);
			assert.doesNotMatch(parts.filter(p => p.kind === 'text').map(p => p.text).join(''), /synthetic|Scene Composition|meta|nested/);
		}
	}
	for (const tail of ['<options>Outside.</options>', '<unknown-meta>unclosed\nimage###Scene Composition:tree', '<unknown-meta>paired</unknown-meta>\nOutside.\nimage###Scene Composition:tree']) {
		const source = '<image>【题】' + tail;
		assert.equal(scanImagePromptBlocks(source)[0].prompt, '<image>【题】');
	}
	const source = '<image>【题】<unknown-meta>paired</unknown-meta>image###Scene Composition:tree\n<options>Outside.</options>';
	assert.ok(scanImagePromptBlocks(source)[0].prompt.endsWith('tree\n'));
});
