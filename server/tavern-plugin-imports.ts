/** Known native import surface for the pinned plugins. Host adapters only; no upstream source rewrite. */
export const TAVERN_MODULE_IMPORTS: Record<string, readonly string[]> = {
  "/scripts/utils.js": [
    "Stopwatch",
    "copyText",
    "delay",
    "download",
    "ensureImageFormatSupported",
    "getBase64Async",
    "getCharaFilename",
    "getImageSizeFromDataURL",
    "getSanitizedFilename",
    "getStringHash",
    "regexFromString",
    "isDataURL",
    "showFontAwesomePicker",
    "uuidv4"
  ],
  "/scripts/i18n.js": [
    "getCurrentLocale",
    "t"
  ],
  "/script.js": [
    "Generate",
    "MAX_INJECTION_DEPTH",
    "activateSendButtons",
    "addCopyToCodeBlocks",
    "addOneMessage",
    "appendMediaToMessage",
    "baseChatReplace",
    "characters",
    "chat",
    "chat_metadata",
    "cleanUpMessage",
    "clearChat",
    "countOccurrences",
    "deactivateSendButtons",
    "default_avatar",
    "default_user_avatar",
    "deleteCharacter",
    "eventSource",
    "event_types",
    "extension_prompt_roles",
    "extension_prompt_types",
    "extension_prompts",
    "getBiasStrings",
    "getCharacterCardFields",
    "getCharacters",
    "getCurrentChatId",
    "getExtensionPromptRoleByName",
    "getMaxContextSize",
    "getOneCharacter",
    "getPastCharacterChats",
    "getRequestHeaders",
    "getThumbnailUrl",
    "getUserAvatar",
    "isOdd",
    "is_send_press",
    "main_api",
    "messageFormatting",
    "nai_settings",
    "name1",
    "name2",
    "online_status",
    "parseMesExamples",
    "printCharacters",
    "printMessages",
    "reloadCurrentChat",
    "reloadMarkdownProcessor",
    "saveCharacterDebounced",
    "saveChatConditional",
    "saveMetadata",
    "saveSettings",
    "saveSettingsDebounced",
    "scrollChatToBottom",
    "selectCharacterById",
    "setExtensionPrompt",
    "setGenerationProgress",
    "setUserName",
    "showSwipeButtons",
    "stopGeneration",
    "substituteParams",
    "substituteParamsExtended",
    "system_avatar",
    "system_message_types",
    "this_chid",
    "unshallowCharacter",
    "updateMessageBlock",
    "user_avatar"
  ],
  "/scripts/world-info.js": [
    "DEFAULT_DEPTH",
    "DEFAULT_WEIGHT",
    "METADATA_KEY",
    "convertCharacterBook",
    "createNewWorldInfo",
    "deleteWorldInfo",
    "getWorldInfoPrompt",
    "getWorldInfoSettings",
    "loadWorldInfo",
    "newWorldInfoEntryTemplate",
    "parseRegexFromString",
    "saveWorldInfo",
    "selected_world_info",
    "setWorldInfoButtonClass",
    "wi_anchor_position",
    "world_info",
    "world_info_case_sensitive",
    "world_info_include_names",
    "world_info_logic",
    "world_info_match_whole_words",
    "world_info_max_recursion_steps",
    "world_info_position",
    "world_info_use_group_scoring",
    "world_names"
  ],
  "/scripts/extensions/regex/engine.js": [
    "getRegexedString",
    "regex_placement"
  ],
  "/scripts/preset-manager.js": [
    "getPresetManager"
  ],
  "/scripts/extensions.js": [
    "extensionTypes",
    "extension_settings",
    "getContext",
    "renderExtensionTemplateAsync",
    "saveMetadataDebounced"
  ],
  "/scripts/openai.js": [
    "chat_completion_sources",
    "openai_max_stop_strings",
    "ChatCompletion",
    "Message",
    "MessageCollection",
    "getChatCompletionModel",
    "getStreamingReply",
    "isImageInliningSupported",
    "oai_settings",
    "prepareOpenAIMessages",
    "promptManager",
    "proxies",
    "sendOpenAIRequest",
    "setOpenAIMessageExamples",
    "setOpenAIMessages",
    "setupChatCompletionPromptManager",
    "tryParseStreamingError"
  ],
  "/scripts/macros.js": [
    "MacrosParser",
    "getLastMessageId"
  ],
  "/scripts/RossAscends-mods.js": [
    "favsToHotswap",
    "isMobile"
  ],
  "/scripts/power-user.js": [
    "getCustomStoppingStrings",
    "flushEphemeralStoppingStrings",
    "persona_description_positions",
    "power_user"
  ],
  "/scripts/user.js": [
    "isAdmin"
  ],
  "/scripts/authors-note.js": [
    "NOTE_MODULE_NAME",
    "metadata_keys",
    "shouldWIAddPrompt"
  ],
  "/scripts/PromptManager.js": [
    "Prompt",
    "PromptCollection"
  ],
  "/scripts/reasoning.js": [
    "extractReasoningFromData",
    "updateReasoningUI"
  ],
  "/scripts/sse-stream.js": [
    "getEventSourceStream"
  ],
  "/scripts/personas.js": [
    "getUserAvatar",
    "getUserAvatars",
    "setUserAvatar",
    "user_avatar"
  ],
  "/scripts/slash-commands.js": [
    "executeSlashCommandsWithOptions"
  ],
  "/scripts/slash-commands/SlashCommand.js": [
    "SlashCommand"
  ],
  "/scripts/slash-commands/SlashCommandArgument.js": [
    "ARGUMENT_TYPE",
    "SlashCommandArgument",
    "SlashCommandNamedArgument"
  ],
  "/scripts/slash-commands/SlashCommandCommonEnumsProvider.js": [
    "commonEnumProviders",
    "enumIcons"
  ],
  "/scripts/slash-commands/SlashCommandEnumValue.js": [
    "SlashCommandEnumValue",
    "enumTypes"
  ],
  "/scripts/slash-commands/SlashCommandParser.js": [
    "SlashCommandParser"
  ],
  "/scripts/popup.js": [
    "POPUP_TYPE",
    "callGenericPopup"
  ],
  "/scripts/tokenizers.js": [
    "getTokenCountAsync"
  ],
  "/scripts/group-chats.js": [
    "getGroupNames",
    "getGroupMembers",
    "groups",
    "selected_group"
  ],
  "/lib.js": [
    "yaml"
  ],
  "/scripts/events.js": [
    "eventSource",
    "event_types"
  ]
};
