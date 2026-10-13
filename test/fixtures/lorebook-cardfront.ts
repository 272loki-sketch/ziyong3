// Deterministic synthetic renderer/material IDs; no original user card/worldbook content.
export const lorebookRegexScripts = [
	{
		scriptName: "贴吧前端2",
		findRegex: "/<Small_theater>\\s*([\\s\\S]*?)<\\/Small_theater>/g",
		replaceString: "```html\n<!DOCTYPE html>\n<html><body><div class=\"thread\">$1</div><script>const floorElement = document.createElement('div'); floorElement.className = 'floor';</script></body></html>\n```",
		placement: [2],
		disabled: false,
		markdownOnly: true,
		promptOnly: false,
	},
	{
		scriptName: "替换表情",
		findRegex: "/\\[表情(\\d+)\\]/g",
		replaceString: "<img src=\"https://tb2.bdstatic.com/tb/editor/images/client/image_emoticon$1.png\">",
		placement: [2],
		disabled: false,
		markdownOnly: true,
		promptOnly: false,
	},
	{
		scriptName: "小剧场",
		findRegex: "/<legacy_theater>([\\s\\S]*?)<\\/legacy_theater>/g",
		replaceString: "$1",
		placement: [2],
		disabled: false,
		markdownOnly: true,
		promptOnly: false,
	},
	{
		scriptName: "日期（大小固定优化适配）",
		findRegex: "/<calendar>([\\s\\S]*?)<\\/calendar>/g",
		replaceString: "<time>$1</time>",
		placement: [2],
		disabled: false,
		markdownOnly: true,
		promptOnly: false,
	},
] as const;

export const lorebookEntries = Object.fromEntries([
	...[1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014, 1015, 1016, 1017, 1018, 1019, 1020].map((uid) => [String(uid), { uid, enabled: false, disable: true }]),
	["1200", { uid: 1200, enabled: true, disable: false }],
	["1201", { uid: 1201, enabled: true, disable: false }],
	["1202", { uid: 1202, enabled: true, disable: false }],
]);
