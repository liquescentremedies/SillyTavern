import { chat, chat_metadata, main_api, getMaxContextSize, getCurrentChatId, substituteParams } from '../script.js';
import { timestampToMoment, isDigitsOnly, getStringHash } from './utils.js';
import { textgenerationwebui_banned_in_macros } from './textgen-settings.js';
import { replaceInstructMacros } from './instruct-mode.js';
import { replaceVariableMacros } from './variables.js';

// Register any macro that you want to leave in the compiled story string
Handlebars.registerHelper('trim', () => '{{trim}}');
// Catch-all helper for any macro that is not defined for story strings
Handlebars.registerHelper('helperMissing', function () {
    const options = arguments[arguments.length - 1];
    const macroName = options.name;
    return substituteParams(`{{${macroName}}}`);
});

/**
 * Gets a hashed id of the current chat from the metadata.
 * If no metadata exists, creates a new hash and saves it.
 * @returns {number} The hashed chat id
 */
function getChatIdHash() {
    const cachedIdHash = chat_metadata['chat_id_hash'];

    // If chat_id_hash is not already set, calculate it
    if (!cachedIdHash) {
        // Use the main_chat if it's available, otherwise get the current chat ID
        const chatId = chat_metadata['main_chat'] ?? getCurrentChatId();
        const chatIdHash = getStringHash(chatId);
        chat_metadata['chat_id_hash'] = chatIdHash;
        return chatIdHash;
    }

    return cachedIdHash;
}

/**
 * Returns the ID of the last message in the chat
 *
 * Optionally can only choose specific messages, if a filter is provided.
 *
 * @param {object} param0 - Optional arguments
 * @param {boolean} [param0.exclude_swipe_in_propress=true] - Whether a message that is currently being swiped should be ignored
 * @param {function(object):boolean} [param0.filter] - A filter applied to the search, ignoring all messages that don't match the criteria. For example to only find user messages, etc.
 * @returns {number|null} The message id, or null if none was found
 */
export function getLastMessageId({ exclude_swipe_in_propress = true, filter = null } = {}) {
    for (let i = chat?.length - 1; i >= 0; i--) {
        let message = chat[i];

        // If ignoring swipes and the message is being swiped, continue
        // We can check if a message is being swiped by checking whether the current swipe id is not in the list of finished swipes yet
        if (exclude_swipe_in_propress && message.swipes && message.swipe_id >= message.swipes.length) {
            continue;
        }

        // Check if no filter is provided, or if the message passes the filter
        if (!filter || filter(message)) {
            return i;
        }
    }

    return null;
}

/**
 * Returns the ID of the first message included in the context
 *
 * @returns {number|null} The ID of the first message in the context
 */
function getFirstIncludedMessageId() {
    const index = Number(document.querySelector('.lastInContext')?.getAttribute('mesid'));

    if (!isNaN(index) && index >= 0) {
        return index;
    }

    return null;
}

/**
 * Returns the last message in the chat
 *
 * @returns {string} The last message in the chat
 */
function getLastMessage() {
    const mid = getLastMessageId();
    return chat[mid]?.mes ?? '';
}

/**
 * Returns the last message from the user
 *
 * @returns {string} The last message from the user
 */
function getLastUserMessage() {
    const mid = getLastMessageId({ filter: m => m.is_user && !m.is_system });
    return chat[mid]?.mes ?? '';
}

/**
 * Returns the last message from the bot
 *
 * @returns {string} The last message from the bot
 */
function getLastCharMessage() {
    const mid = getLastMessageId({ filter: m => !m.is_user && !m.is_system });
    return chat[mid]?.mes ?? '';
}

/**
 * Returns the 1-based ID (number) of the last swipe
 *
 * @returns {number|null} The 1-based ID of the last swipe
 */
function getLastSwipeId() {
    // For swipe macro, we are accepting using the message that is currently being swiped
    const mid = getLastMessageId({ exclude_swipe_in_propress: false });
    const swipes = chat[mid]?.swipes;
    return swipes?.length;
}

/**
 * Returns the 1-based ID (number) of the current swipe
 *
 * @returns {number|null} The 1-based ID of the current swipe
 */
function getCurrentSwipeId() {
    // For swipe macro, we are accepting using the message that is currently being swiped
    const mid = getLastMessageId({ exclude_swipe_in_propress: false });
    const swipeId = chat[mid]?.swipe_id;
    return swipeId ? swipeId + 1 : null;
}

/**
 * Replaces banned words in macros with an empty string.
 * Adds them to textgenerationwebui ban list.
 * @param {string} inText Text to replace banned words in
 * @returns {string} Text without the "banned" macro
 */
function bannedWordsReplace(inText) {
    if (!inText) {
        return '';
    }

    const banPattern = /{{banned "(.*)"}}/gi;

    if (main_api == 'textgenerationwebui') {
        const bans = inText.matchAll(banPattern);
        if (bans) {
            for (const banCase of bans) {
                console.log('Found banned words in macros: ' + banCase[1]);
                textgenerationwebui_banned_in_macros.push(banCase[1]);
            }
        }
    }

    inText = inText.replaceAll(banPattern, '');
    return inText;
}

function getTimeSinceLastMessage() {
    const now = moment();

    if (Array.isArray(chat) && chat.length > 0) {
        let lastMessage;
        let takeNext = false;

        for (let i = chat.length - 1; i >= 0; i--) {
            const message = chat[i];

            if (message.is_system) {
                continue;
            }

            if (message.is_user && takeNext) {
                lastMessage = message;
                break;
            }

            takeNext = true;
        }

        if (lastMessage?.send_date) {
            const lastMessageDate = timestampToMoment(lastMessage.send_date);
            const duration = moment.duration(now.diff(lastMessageDate));
            return duration.humanize();
        }
    }

    return 'just now';
}

function randomReplace(input, emptyListPlaceholder = '') {
    const randomPattern = /{{random\s?::?([^}]+)}}/gi;

    input = input.replace(randomPattern, (match, listString) => {
        // Split on either double colons or comma. If comma is the separator, we are also trimming all items.
        const list = listString.includes('::')
            ? listString.split('::')
            : listString.split(',').map(item => item.trim());

        if (list.length === 0) {
            return emptyListPlaceholder;
        }
        const rng = new Math.seedrandom('added entropy.', { entropy: true });
        const randomIndex = Math.floor(rng() * list.length);
        return list[randomIndex];
    });
    return input;
}

function pickReplace(input, rawContent, emptyListPlaceholder = '') {
    const pickPattern = /{{pick\s?::?([^}]+)}}/gi;

    // We need to have a consistent chat hash, otherwise we'll lose rolls on chat file rename or branch switches
    // No need to save metadata here - branching and renaming will implicitly do the save for us, and until then loading it like this is consistent
    const chatIdHash = getChatIdHash();
    const rawContentHash = getStringHash(rawContent);

    return input.replace(pickPattern, (match, listString, offset) => {
        // Split on either double colons or comma. If comma is the separator, we are also trimming all items.
        const list = listString.includes('::')
            ? listString.split('::')
            : listString.split(',').map(item => item.trim());

        if (list.length === 0) {
            return emptyListPlaceholder;
        }

        // We build a hash seed based on: unique chat file, raw content, and the placement inside this content
        // This allows us to get unique but repeatable picks in nearly all cases
        const combinedSeedString = `${chatIdHash}-${rawContentHash}-${offset}`;
        const finalSeed = getStringHash(combinedSeedString);
        const rng = new Math.seedrandom(finalSeed);
        const randomIndex = Math.floor(rng() * list.length);
        return list[randomIndex];
    });
}

function diceRollReplace(input, invalidRollPlaceholder = '') {
    const rollPattern = /{{roll[ : ]([^}]+)}}/gi;

    return input.replace(rollPattern, (match, matchValue) => {
        let formula = matchValue.trim();

        if (isDigitsOnly(formula)) {
            formula = `1d${formula}`;
        }

        const isValid = droll.validate(formula);

        if (!isValid) {
            console.debug(`Invalid roll formula: ${formula}`);
            return invalidRollPlaceholder;
        }

        const result = droll.roll(formula);
        return new String(result.total);
    });
}

/**
 * Substitutes {{macro}} parameters in a string.
 * @param {string} content - The string to substitute parameters in.
 * @param {Object<string, *>} env - Map of macro names to the values they'll be substituted with. If the param
 * values are functions, those functions will be called and their return values are used.
 * @returns {string} The string with substituted parameters.
 */
export function evaluateMacros(content, env) {
    if (!content) {
        return '';
    }

    const rawContent = content;

    // Legacy non-macro substitutions
    content = content.replace(/<USER>/gi, typeof env.user === 'function' ? env.user() : env.user);
    content = content.replace(/<BOT>/gi, typeof env.char === 'function' ? env.char() : env.char);
    content = content.replace(/<CHARIFNOTGROUP>/gi, typeof env.group === 'function' ? env.group() : env.group);
    content = content.replace(/<GROUP>/gi, typeof env.group === 'function' ? env.group() : env.group);

    // Short circuit if there are no macros
    if (!content.includes('{{')) {
        return content;
    }

    content = diceRollReplace(content);
    content = replaceInstructMacros(content, env);
    content = replaceVariableMacros(content);
    content = content.replace(/{{newline}}/gi, '\n');
    content = content.replace(/\n*{{trim}}\n*/gi, '');
    content = content.replace(/{{noop}}/gi, '');
    content = content.replace(/{{input}}/gi, () => String($('#send_textarea').val()));

    // Substitute passed-in variables
    for (const varName in env) {
        if (!Object.hasOwn(env, varName)) continue;

        const param = env[varName];
        content = content.replace(new RegExp(`{{${varName}}}`, 'gi'), param);
    }

    content = content.replace(/{{maxPrompt}}/gi, () => String(getMaxContextSize()));
    content = content.replace(/{{lastMessage}}/gi, () => getLastMessage());
    content = content.replace(/{{lastMessageId}}/gi, () => String(getLastMessageId() ?? ''));
    content = content.replace(/{{lastUserMessage}}/gi, () => getLastUserMessage());
    content = content.replace(/{{lastCharMessage}}/gi, () => getLastCharMessage());
    content = content.replace(/{{firstIncludedMessageId}}/gi, () => String(getFirstIncludedMessageId() ?? ''));
    content = content.replace(/{{lastSwipeId}}/gi, () => String(getLastSwipeId() ?? ''));
    content = content.replace(/{{currentSwipeId}}/gi, () => String(getCurrentSwipeId() ?? ''));

    content = content.replace(/\{\{\/\/([\s\S]*?)\}\}/gm, '');

    content = content.replace(/{{time}}/gi, () => moment().format('LT'));
    content = content.replace(/{{date}}/gi, () => moment().format('LL'));
    content = content.replace(/{{weekday}}/gi, () => moment().format('dddd'));
    content = content.replace(/{{isotime}}/gi, () => moment().format('HH:mm'));
    content = content.replace(/{{isodate}}/gi, () => moment().format('YYYY-MM-DD'));

    content = content.replace(/{{datetimeformat +([^}]*)}}/gi, (_, format) => {
        const formattedTime = moment().format(format);
        return formattedTime;
    });
    content = content.replace(/{{idle_duration}}/gi, () => getTimeSinceLastMessage());
    content = content.replace(/{{time_UTC([-+]\d+)}}/gi, (_, offset) => {
        const utcOffset = parseInt(offset, 10);
        const utcTime = moment().utc().utcOffset(utcOffset).format('LT');
        return utcTime;
    });
    content = bannedWordsReplace(content);
    content = randomReplace(content);
    content = pickReplace(content, rawContent);
    return content;
}
