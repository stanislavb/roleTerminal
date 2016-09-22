const labels = require('./labels');
const textTools = require('./textTools');
const mapTools = require('./mapTools');
const storage = require('./storage');
const layoutChanger = require('./layoutChanger');
const socketHandler = require('./socketHandler');
const messenger = require('./messenger');
const commandHandler = require('./commandHandler');
const domManipulator = require('./domManipulator');
const clickHandler = require('./clickHandler');
const videoPlayer = require('./videoPlayer');

/**
 * Queue of all the commands used by the user that will be handled and printed
 * @type {Object[]}
 */
const commandQueue = [];
/**
 * Check every * amount of milliseconds to see if Javascript is still responding
 * It will trigger a function if the response is delayed
 * @type {Number}
 */
const screenOffTimeoutTime = 1000;
/**
 * Get GPS coordinates for * amount of milliseconds
 * @type {Number}
 */
const watchPositionTime = 15000;
/**
 * Get GPS coordinates every * milliseconds
 * @type {Number}
 */
const pausePositionTime = 20000;
/**
 * Queue of all sounds to be consumed and played
 * @type {Object[]}
 */
const soundQueue = [];
/**
 * Timeout between each command to be run
 * @type {Number}
 */
const commandTime = 1000;
const dot = '.';
const dash = '-';
const triggerKeysPressed = [];
/**
 * Symbolizes space between words in morse string
 * @type {string}
 */
const morseSeparator = '#';
const teams = {};
const stations = {};
let audioCtx;
let oscillator;
let gainNode;
let soundTimeout = 0;
let previousCommandPointer;
let watchId = null;
// Is geolocation tracking on?
let isTracking = false;
let firstConnection = true;
let positions = [];
/**
 * Used by isScreenOff() to force reconnect when phone screen is off
 * for a longer period of time
 */
let lastScreenOff = (new Date()).getTime();
let commmandUsed = false;
/**
 * Used to block repeat of key presses
 */
let keyPressed;
let trackingTimeout;
let isScreenOffTimeout;
let serverDownTimeout;

/**
 * Push command to queue
 * @static
 * @param {string} command - Name of the command
 * @param {string[]} data - Values, options to be used with the command
 * @param {string} [commandMsg] - String to be printed after command usage
 */
function queueCommand(command, data, commandMsg) {
  commandQueue.push({
    command,
    data,
    commandMsg,
  });
}

/**
 * Push used command to history
 * @param {string} command - Command with options
 */
function pushCommandHistory(command) {
  const commandHistory = storage.getCommandHistory();

  commandHistory.push(command);
  storage.setCommandHistory(commandHistory);
}

/**
 * Sets room as the new default room
 * @param {string} roomName - Name of the new room
 */
function enterRoom(roomName) {
  storage.setRoom(roomName);

  if (!storage.getStaticInputStart()) {
    domManipulator.setInputStart(roomName);
  }

  messenger.queueMessage({
    text: [`Entered ${roomName}`],
    text_se: [`Gick in i ${roomName}`],
  });
}

/**
 *
 */
function resetPreviousCommandPointer() {
  const commandHistory = storage.getCommandHistory();

  previousCommandPointer = commandHistory ? commandHistory.length : 0;
}

/**
 * Set new gain value
 * @param {number} value - New gain value
 */
function setGain(value) {
  gainNode.gain.value = value;
}

/**
 * Play and print morse code
 * @param {string} morseCode - Morse code to be played and printed
 * @param {boolean} silent - Should the morse code text be surpressed?
 */
function playMorse(morseCode, silent) {
  /**
   * Finish sound queue by clearing it and send morse code as text
   * @param {number} timeouts - Morse code array length
   */
  function finishSoundQueue(timeouts) {
    const cleanMorse = morseCode.replace(/#/g, '');

    soundQueue.splice(0, timeouts);

    if (!silent) {
      messenger.queueMessage({
        text: [`Morse code message received: ${cleanMorse}`],
        text_se: [`Morse mottaget: ${cleanMorse}`],
      });
    }
  }

  let duration;
  let shouldPlay;

  if (soundQueue.length === 0) {
    soundTimeout = 0;
  }

  for (let i = 0; i < morseCode.length; i++) {
    const code = morseCode[i];

    shouldPlay = false;
    duration = 0;

    if (dot === code) {
      duration = 50;
      shouldPlay = true;
    } else if (dash === code) {
      duration = 150;
      shouldPlay = true;
    } else if (morseSeparator === code) {
      duration = 200;
    } else {
      duration = 75;
    }

    if (shouldPlay) {
      soundQueue.push(setTimeout(setGain, soundTimeout, 1));
      soundQueue.push(setTimeout(setGain, soundTimeout + duration, 0));
    }

    soundTimeout += duration;
  }

  setTimeout(finishSoundQueue, soundTimeout, (2 * morseCode.length), morseCode);
}

/**
 * Geolocation object is empty when sent through Socket.IO
 * This is a fix for that
 * @param {object} position - Position
 * @returns {object} Position
 */
function preparePosition(position) {
  const preparedPosition = {};
  preparedPosition.latitude = position.coords.latitude;
  preparedPosition.longitude = position.coords.longitude;
  preparedPosition.speed = position.coords.speed;
  preparedPosition.accuracy = position.coords.accuracy;
  preparedPosition.heading = position.coords.heading;
  preparedPosition.timestamp = position.timestamp;

  return preparedPosition; // geolocation
}

/**
 * Checks client position, stores them and later sends the best one to the server
 */
function retrievePosition() {
  const clearingWatch = () => {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
    trackingTimeout = setTimeout(sendLocation, pausePositionTime); // eslint-disable-line no-use-before-define
  };

  const staticPosition = storage.getStaticPosition();

  if (staticPosition && staticPosition.latitude && staticPosition.longitude) {
    isTracking = true;

    positions.push({
      coords: {
        latitude: staticPosition.latitude,
        longitude: staticPosition.longitude,
        accuracy: 100,
      },
      timestamp: new Date(),
    });
    mapTools.setUserPosition({
      latitude: staticPosition.latitude,
      longitude: staticPosition.longitude,
    });
  } else {
    watchId = navigator.geolocation.watchPosition((position) => {
      if (position !== undefined) {
        isTracking = true;
        positions.push(position);

        mapTools.setUserPosition({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        });
      }
    }, (err) => {
      console.log(err);
    }, { enableHighAccuracy: true });
  }

  if (isTracking) {
    trackingTimeout = setTimeout(clearingWatch, watchPositionTime);
  }
}

/**
 * Send client position to server
 */
function sendLocation() {
  let mostAccuratePos;

  if (storage.getUser() !== null && positions.length > 0) {
    mostAccuratePos = positions[positions.length - 1];

    for (let i = positions.length - 2; i >= 0; i--) {
      const position = positions[i];
      const accuracy = positions[i].coords.accuracy;

      if (mostAccuratePos.coords.accuracy > accuracy) {
        mostAccuratePos = position;
      }
    }

    positions = [];

    socketHandler.emit('updateLocation', {
      type: 'user',
      position: preparePosition(mostAccuratePos),
    });
  }

  retrievePosition();
}

/**
 * Checks if the screen has been unresponsive for some time.
 * Some devices disable Javascript when screen is off (iOS)
 * They also fail to notice that they have been disconnected
 * We check the time between heartbeats and if the time i
 * over 10 seconds (example: when screen is turned off and then on)
 * we force them to reconnect
 */
function isScreenOff() {
  const now = (new Date()).getTime();
  const diff = now - lastScreenOff;
  // FIXME Hard coded
  const offBy = diff - 1000;
  lastScreenOff = now;

  // FIXME Hard coded
  if (offBy > 10000) {
    socketHandler.reconnect();
  }

  isScreenOffTimeout = setTimeout(isScreenOff, screenOffTimeoutTime);
}

/**
 * Sets timeouts.
 * NOTE! NOTE! Intervals are unreliable in Chrome. Don't use them
 */
function setTimeouts() {
  if (trackingTimeout !== null) {
    clearTimeout(trackingTimeout);
  }

  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
  }

  if (storage.getGpsTracking() && navigator.geolocation) {
    // Gets new geolocation data
    sendLocation();
  }

  // Should not be recreated on focus
  if (isScreenOffTimeout === null) {
    /**
     * Checks time between when JS stopped and started working again
     * This will be most frequently triggered when a user turns off the
     * screen on their phone and turns it back on
     */
    isScreenOffTimeout = setTimeout(isScreenOff, screenOffTimeoutTime);
  }
}

/**
 * Resets intervals and keyPressed (to not have it true after a user tabbed out and into the site)
 */
function refocus() {
  keyPressed = false;
  triggerKeysPressed.ctrl = false;
  triggerKeysPressed.alt = false;
  setTimeouts();
}

/**
 * Create AudioContext needed for morse
 */
function buildMorsePlayer() {
  // Not supported in Spartan nor IE11 or lower
  if (window.AudioContext || window.webkitAudioContext) {
    if (window.AudioContext) {
      audioCtx = new window.AudioContext();
    } else if (window.webkitAudioContext) {
      audioCtx = new window.webkitAudioContext(); // eslint-disable-line
    }

    oscillator = audioCtx.createOscillator();
    gainNode = audioCtx.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    gainNode.gain.value = 0;
    oscillator.type = 'sine';
    oscillator.frequency.value = '440';
    // oscillator.type = 'square';
    // oscillator.frequency.value = '300';

    oscillator.start(0);
  }
}

/**
 * Does the user agent contain Android?
 * @returns {boolean} Does the user agent contain Android?
 */
function isAndroid() {
  return navigator.userAgent.match(/Android/i) !== null;
}

/**
 * Is the site visited in standalone mode? (iOS, site started from home screen)
 * @returns {boolean} Is the site visited in standalone mode?
 */
function isStandalone() {
  return window.navigator.standalone;
}

/**
 * Does the user agent contain iPhone, iPad or iPad?
 * @returns {boolean} Does the user agent contain iPhone, iPad or iPad?
 */
function isIos() {
  return navigator.userAgent.match(/iP(hone|ad|od)/i) !== null;
}

/**
 * Adds padding to top, if iOS and in stand alone mode
 * Needed due to top menu row in iOS
 */
function padMenu() {
  if (isIos() && isStandalone()) {
    domManipulator.getMenu().classList.add('iosMenuPadding');
  }
}

/**
 * Should auto-completion trigger?
 * @param {string} text - Previous text in input
 * @param {string} textChar - Latest text char
 * @returns {boolean} Should auto-completion trigger?
 */
function triggerAutoComplete(text, textChar) {
  /**
   * Older versions of Android bugs on keypress/down, thus this check
   */
  if ((isAndroid() && text.match(/\s\s$/)) || (!isAndroid() && text.match(/\s$/) && textChar.match(/^\s$/))) {
    domManipulator.setCommandInput(text.slice(0, -1));

    return true;
  }

  return false;
}

/**
 * Set command used
 * @param {boolean} used - Has command been used?
 */
function setCommandUsed(used) {
  commmandUsed = used;
}

/**
 * Consume command queue. Runs the commands stored until empty
 */
function consumeCommandQueue() {
  if (commandQueue.length > 0) {
    const storedCommand = commandQueue.shift();
    const command = storedCommand.command;
    const commandMessage = storedCommand.commandMsg;

    if (commandMessage) {
      messenger.queueMessage(commandMessage);
    }

    setCommandUsed(true);
    commandHandler.triggerCommand({ cmd: command, cmdParams: storedCommand.data });
    setTimeout(consumeCommandQueue, commandTime);
  } else {
    setCommandUsed(false);
  }
}

/**
 * Start consumption of command queue
 */
function startCommandQueue() {
  if (!commmandUsed) {
    consumeCommandQueue();
  }
}

/**
 * @param {string} commandName - Command name
 * @param {string[]} phrases - Command input
 * @returns {string[]} Combined input
 */
function combineSequences(commandName, phrases) {
  const aliases = storage.getAliases();

  return aliases[commandName] ? aliases[commandName].concat(phrases.slice(1)) : phrases.slice(1);
}

/**
 * Expands sent partial string to a matched command, if any
 * @param {string[]} matchedCommands - Matched command names
 * @param {string} partialMatch - Partial string
 * @param {string} sign - Command character
 * @returns {string} Expanded match
 */
function expandPartialMatch(matchedCommands, partialMatch, sign) {
  const firstCommand = matchedCommands[0];
  let expanded = '';
  let matched = true;

  for (let i = partialMatch.length; i < firstCommand.length; i++) {
    const commandChar = firstCommand.charAt(i);

    for (let j = 0; j < matchedCommands.length; j++) {
      if (matchedCommands[j].charAt(i) !== commandChar) {
        matched = false;

        break;
      }
    }

    if (matched) {
      expanded += commandChar;
    } else {
      return commandHandler.isCommandChar(sign) ? sign + partialMatch + expanded : partialMatch + expanded;
    }
  }

  return '';
}

// TODO autoCompleteCommand should use this
/**
 * Match partial string against one to many strings and return matches
 * @param {string} partial - Partial string to match
 * @param {string[]} items - All matchable items
 * @returns {string[]} - Matched strings
 */
function match(partial, items) {
  const matched = [];
  let matches = false;

  for (let i = 0; i < items.length; i++) {
    const name = items[i];

    for (let j = 0; j < partial.length; j++) {
      if (partial.charAt(j) === name.charAt(j)) {
        matches = true;
      } else {
        matches = false;

        break;
      }
    }

    if (matches) {
      matched.push(name);
    }
  }

  return matched;
}

/**
 * Matches partial string against available options for a command.
 * Appends input with matched option or sends message with multiple matches
 * @param {string[]} phrases - Input from user
 * @param {Object} options - Options from command
 */
function autoCompleteOption(phrases = [], options = {}) {
  const option = options[phrases[1]];
  const partial = phrases[phrases.length - 1];
  /**
   * @type {string[]}
   */
  let matched = [];

  if (option && option.next) {
    const nextKeys = Object.keys(option.next);
    matched = match(partial, nextKeys);

    if (matched.length === 1) {
      domManipulator.replaceLastInputPhrase(`${matched[0]} `);
    } else if (matched.length > 0) {
      messenger.queueMessage({ text: [matched.join(' - ')] });
    } else if (nextKeys.length > 0) {
      messenger.queueMessage({ text: [nextKeys.join(' - ')] });
    }
  } else if (phrases.length <= 2) {
    const firstLevelOptions = Object.keys(options);
    matched = match(partial, firstLevelOptions);

    if (matched.length === 1) {
      domManipulator.replaceLastInputPhrase(`${matched[0]} `);
    } else if (matched.length > 0) {
      domManipulator.setCommandInput(textTools.trimSpace(domManipulator.getInputText()));
      messenger.queueMessage({ text: [matched.join(' - ')] });
    } else if (partial === '') {
      messenger.queueMessage({ text: [firstLevelOptions.join(' - ')] });
    }
  }
}

/**
 * Auto-completes command
 * @param {string[]} phrases - Full input
 */
function autoCompleteCommand(phrases) {
  const allCommands = commandHandler.getCommands({ aliases: true, filtered: true });
  const matched = [];
  const sign = phrases[0].charAt(0);
  let matches;
  let partialCommand = phrases[0];

  /**
   * Auto-complete should only trigger when one phrase is in the input
   * It will not auto-complete flags
   * If chat mode and the command is prepended or normal mode
   */
  if (phrases.length === 1 && partialCommand.length > 0 && (commandHandler.isCommandChar(sign) || (storage.getMode() === 'cmd') || storage.getUser() === null)) {
    // Removes prepend sign
    if (commandHandler.isCommandChar(sign)) {
      partialCommand = partialCommand.slice(1);
    }

    for (let i = 0; i < allCommands.length; i++) {
      const command = allCommands[i];
      matches = false;

      for (let j = 0; j < partialCommand.length; j++) {
        const commandAccesssLevel = commandHandler.getCommandAccessLevel(command);
        const commandVisibility = commandHandler.getCommandVisibility(command);

        if ((isNaN(commandAccesssLevel) || storage.getAccessLevel() >= commandAccesssLevel) && storage.getAccessLevel() >= commandVisibility && partialCommand.charAt(j) === command.charAt(j)) {
          matches = true;
        } else {
          matches = false;

          break;
        }
      }

      if (matches) {
        matched.push(command);
      }
    }

    if (matched.length === 1) {
      const commandChars = commandHandler.getCommandChars();
      const commandIndex = commandChars.indexOf(sign);
      let newText = '';

      if (commandIndex >= 0) {
        newText += commandChars[commandIndex];
      }

      newText += `${matched[0]} `;

      domManipulator.clearInput();
      domManipulator.setCommandInput(newText);
    } else if (matched.length > 0) {
      domManipulator.setCommandInput(textTools.trimSpace(`${expandPartialMatch(matched, partialCommand, sign)}`));
      messenger.queueMessage({ text: [matched.join(' - ')] });
    }
  }
}

/**
 * Prints the command input used, unless clearAfterUse is true
 * @param {boolean} clearAfterUse - Should command usage be cleared after usage?
 * @param {string} inputText - The command input that will be printed
 * @returns {{text: string[]}} Full command row, with added visuals
 */
function printUsedCommand(clearAfterUse, inputText) {
  if (clearAfterUse) {
    return null;
  }

  /**
   * Print input if the command shouldn't clear
   * after use
   */
  return {
    text: [`${domManipulator.getInputStart()}${domManipulator.getModeText()}$ ${inputText}`],
  };
}

/**
 * Is the view in full screen?
 * @returns {boolean} Is the view in full screen?
 */
function isFullscreen() {
  return (!window.screenTop && !window.screenY);
}

/**
 * Goes into full screen with sent element
 * This is not supported in iOS Safari
 * @param {object} element - The element which should be maximized to full screen
 * @returns {undefined} Returns nothing
 */
function goFullScreen(element) {
  if (element.requestFullscreen) {
    element.requestFullscreen(Element.ALLOW_KEYBOARD_INPUT);
  } else if (element.webkitRequestFullscreen) {
    element.webkitRequestFullscreen(Element.ALLOW_KEYBOARD_INPUT);
  } else if (element.mozRequestFullScreen) {
    element.mozRequestFullScreen(Element.ALLOW_KEYBOARD_INPUT);
  }
}

/**
 * Fix for Android.
 * Expands the spacer so that the virtual keyboard doesn't block the rest of the site
 * @param {boolean} [keyboardShown] - Is the virtual keyboard visible?
 */
function fullscreenResize(keyboardShown) {
  /**
   * Used for Android when it shows/hides the keyboard
   * The soft keyboard will block part of the site without this fix
   */
  if (isFullscreen() && isAndroid()) {
    const spacer = domManipulator.getSpacer();

    domManipulator.getMainView().classList.add('fullscreen');

    if (keyboardShown) {
      spacer.classList.add('keyboardFix');
      spacer.classList.remove('fullFix');
    } else {
      spacer.classList.remove('keyboardFix');
      spacer.classList.add('fullFix');
    }

    domManipulator.scrollView();
  }
}

/**
 * Triggers on enter press. Runs command based on input
 */
function enterKeyHandler() {
  const commandHelper = commandHandler.commandHelper;
  const user = storage.getUser();
  const inputText = domManipulator.getInputText();
  let phrases;
  keyPressed = true;

  if (!commandHelper.keysBlocked) {
    if (commandHelper.command !== null) {
      phrases = textTools.trimSpace(inputText).split(' ');

      // TODO Hard coded
      if (phrases[0] === 'exit' || phrases[0] === 'abort') {
        commandHandler.abortCommand(commandHelper.command);
        commandHandler.resetCommand(true);
      } else {
        if (!commandHelper.hideInput) {
          messenger.queueMessage({ text: [inputText] });
        }

        commandHandler.triggerCommandStep(phrases);
      }
    } else {
      phrases = textTools.trimSpace(inputText).split(' ');

      if (phrases[0].length > 0) {
        const command = commandHandler.getCommand(phrases[0].toLowerCase());

        if (!storage.getDisableCommands() && (command && (isNaN(command.accessLevel) || storage.getAccessLevel() >= command.accessLevel))) {
          // Store the command for usage with up/down arrows
          pushCommandHistory(phrases.join(' '));

          if (command.clearBeforeUse) {
            commandHandler.triggerCommand({ cmd: 'clear' });
          }

          queueCommand(command.commandName, combineSequences(command.commandName, phrases), printUsedCommand(command.clearAfterUse, inputText));
          startCommandQueue();
          /**
           * User is logged in and in chat mode
           */
        } else if (user !== null && storage.getMode() === 'chat' && phrases[0].length > 0) {
          if (commandHandler.getCommandChars().indexOf(phrases[0].charAt(0)) < 0) {
            queueCommand(commandHandler.getCommand('msg').func, phrases);
            startCommandQueue();

            /**
             * User input commandChar but didn't type
             * a proper command
             */
          } else {
            messenger.queueMessage({
              text: [`${phrases[0]}: ${labels.getText('errors', 'commandFail')}`],
            });
          }
        } else if (user === null) {
          messenger.queueMessage({ text: [phrases.toString()] });
          messenger.queueMessage({ text: labels.getText('info', 'mustRegister') });

          /**
           * Sent command was not found.
           * Print the failed input
           */
        } else {
          pushCommandHistory(phrases.join(' '));
          messenger.queueMessage({
            text: [`- ${phrases[0]}: ${labels.getText('errors', 'commandFail')}`],
          });
        }
      } else {
        messenger.queueMessage(printUsedCommand(false, ' '));
      }
    }
  }

  domManipulator.removeSubMenu();
  resetPreviousCommandPointer();
  domManipulator.clearInput();
  domManipulator.clearModeText();
}

/**
 * Scrolls the view (with rows) a specific amount of pixels
 * Used to scroll the view with page up/down keys
 * @param {number} amount - Amount of pixels to scroll the view with
 */
function scrollText(amount) {
  domManipulator.getMainView().scrollTop += amount;
}

/**
 * Auto-completes depending on current input
 */
function autoComplete() {
  const commandHelper = commandHandler.commandHelper;
  const phrases = textTools.trimSpace(domManipulator.getInputText().toLowerCase()).split(' ');
  const command = commandHandler.getCommand((commandHelper.command || phrases[0]).toLowerCase());

  if (command && phrases.length === 1) {
    phrases.push('');
  }

  if (phrases.length === 1 && phrases[0].length === 0) {
    commandHandler.triggerCommand({ cmd: 'help' });
  } else if (!command && !commandHelper.keysBlocked && commandHelper.command === null) {
    autoCompleteCommand(phrases);
    domManipulator.changeModeText();
  } else if (command) {
    if (command.autocomplete && phrases.length < 3) {
      const partial = phrases[1];

      switch (command.autocomplete.type) {
        case 'users': {
          socketHandler.emit('matchPartialUser', { partialName: partial });

          break;
        }
        case 'rooms': {
          socketHandler.emit('matchPartialRoom', { partialName: partial });

          break;
        }
        case 'myRooms': {
          socketHandler.emit('matchPartialMyRoom', { partialName: partial });

          break;
        }
        default: {
          break;
        }
      }
    } else if (command.options) {
      autoCompleteOption(phrases, command.options);
    }
  }
}

/**
 * All key presses that weren't caught in specialKeypress
 * @param {string} textChar - Character pressed on the keyboard
 */
function defaultKeyPress(textChar) {
  if (triggerAutoComplete(domManipulator.getInputText(), textChar) && commandHandler.commandHelper.command === null) {
    autoComplete();

    // Prevent new whitespace to be printed
    event.preventDefault();
  }
}

/**
 * Checks key event against a list of keys
 * @param {Object} event - Key event
 */
function specialKeyPress(event) {
  const keyCode = typeof event.which === 'number' ? event.which : event.keyCode;
  const textChar = String.fromCharCode(keyCode);
  const commandHistory = storage.getCommandHistory();
  const commandHelper = commandHandler.commandHelper;

  domManipulator.focusInput();
  domManipulator.removeSubMenu();

  if (!keyPressed) {
    switch (keyCode) {
      case 9: { // Tab
        keyPressed = true;

        autoComplete();

        event.preventDefault();

        break;
      }
      case 13: { // Enter
        enterKeyHandler();

        event.preventDefault();

        break;
      }
      case 17: { // Ctrl
        triggerKeysPressed.ctrl = true;

        break;
      }
      case 18: { // Alt
        triggerKeysPressed.alt = true;

        break;
      }
      case 91: { // Left Command key in OS X
        triggerKeysPressed.ctrl = true;

        break;
      }
      case 93: { // Right Command key in OS X
        triggerKeysPressed.ctrl = true;

        break;
      }
      case 224: { // Command key in OS X (Firefox)
        triggerKeysPressed.ctrl = true;

        break;
      }
      case 33: { // Page up
        scrollText(-window.innerHeight * 0.5);

        event.preventDefault();

        break;
      }
      case 34: { // Page down
        scrollText(window.innerHeight * 0.5);

        event.preventDefault();

        break;
      }
      case 38: { // Up arrow
        keyPressed = true;

        if (triggerKeysPressed.ctrl) {
          scrollText(-window.innerHeight);
        } else if (!commandHelper.keysBlocked && commandHelper.command === null && previousCommandPointer > 0) {
          domManipulator.clearInput();
          previousCommandPointer--;
          domManipulator.setCommandInput(commandHistory[previousCommandPointer]);
        }

        event.preventDefault();

        break;
      }
      case 40: { // Down arrow
        keyPressed = true;

        if (triggerKeysPressed.ctrl) {
          scrollText(window.innerHeight);
        } else {
          if (!commandHelper.keysBlocked && commandHelper.command === null) {
            if (previousCommandPointer < commandHistory.length - 1) {
              domManipulator.clearInput();
              previousCommandPointer++;
              domManipulator.setCommandInput(commandHistory[previousCommandPointer]);
            } else if (previousCommandPointer === commandHistory.length - 1) {
              domManipulator.clearInput();
              previousCommandPointer++;
            } else {
              domManipulator.clearInput();
            }
          }
        }

        event.preventDefault();

        break;
      }
      case 68: { // d
        if (triggerKeysPressed.ctrl) {
          commandHandler.triggerCommand({ cmd: 'logout' });
          event.preventDefault();
        } else {
          defaultKeyPress(textChar);
        }

        break;
      }
      case 85: { // u
        if (triggerKeysPressed.ctrl) {
          goFullScreen(document.documentElement);
          fullscreenResize(false);
          event.preventDefault();
          domManipulator.scrollView();
        } else {
          defaultKeyPress(textChar);
        }

        break;
      }
      default: {
        defaultKeyPress(textChar);

        break;
      }
    }
  } else {
    event.preventDefault();
  }
}

/**
 * Indicates that a key has been released and sets the corresponding flag
 * @param {KeyboardEvent} event - Keyboard event
 */
function keyReleased(event) {
  const keyCode = typeof event.which === 'number' ? event.which : event.keyCode;

  /**
   * Older versions of Android bugs on keydown/press and sends incorrect keycodes,
   * thus defaultKeyPress has to be triggered on keyup
   */
  if (isAndroid()) {
    const textChar = domManipulator.getInputText().charAt(domManipulator.getInputText().length - 1);

    defaultKeyPress(textChar);
  }

  switch (keyCode) {
    case 9: // Tab
    case 16: // Shift
    case 20: // Caps lock
    case 33: // Page up
    case 34: // Page down
    case 37: // Left arrow
    case 39: { // Down arrow
      keyPressed = false;

      break;
    }
    case 91: // Left Command key in OS X
    case 93: // Right Command key in OS X
    case 224: // Command key in OS X (Firefox)
    case 17: { // Ctrl
      triggerKeysPressed.ctrl = false;

      break;
    }
    case 18: { // Alt
      triggerKeysPressed.alt = false;

      break;
    }
    default: {
      keyPressed = false;
      domManipulator.resizeInput();

      break;
    }
  }

  if (domManipulator.getInputText().length === 0) {
    domManipulator.clearModeText();
  } else {
    domManipulator.changeModeText();
  }

  domManipulator.updateThisCommandItem();
}

/**
 * Attach click listener to menu item
 * @param {Element} menuItem - Menu item that will get a click handler
 * @param {Function} func - Function on click
 * @param {string} funcParam - Function parameters
 */
function attachMenuListener(menuItem, func, funcParam) {
  if (func) {
    menuItem.addEventListener('click', (event) => {
      fullscreenResize();
      domManipulator.removeAllSubMenus();
      func([funcParam]);
      clickHandler.setClicked(true);
      event.stopPropagation();
    });
  }
}

/**
 * Create menu item
 * @param {Object} menuItem - Menu item to be added
 * @returns {Element} List item
 */
function createMenuItem(menuItem) {
  const listItem = document.createElement('li');
  const span = document.createElement('span');

  if (menuItem.extraClass) {
    span.classList.add(menuItem.extraClass);
  }

  listItem.setAttribute('id', menuItem.elementId);
  listItem.classList.add('link');
  span.appendChild(document.createTextNode(menuItem.itemName));
  listItem.appendChild(span);

  return listItem;
}

/**
 * Creates sub-menu list
 * @param {string[]} subItems - Items that will be added to the list
 * @param {boolean} replaceInput - Should a click on the item replace current input?
 * @returns {Element} List item
 */
function createSubMenuItem(subItems, replaceInput) {
  const ulElem = document.createElement('ul');

  for (let i = 0; i < subItems.length; i++) {
    const item = subItems[i];
    const liElem = document.createElement('li');
    const span = document.createElement('span');

    liElem.classList.add('link');
    span.appendChild(document.createTextNode(item.toUpperCase()));
    liElem.appendChild(span);
    ulElem.classList.add('subMenu');
    ulElem.appendChild(liElem);

    liElem.addEventListener('click', () => {
      if (replaceInput) {
        domManipulator.setCommandInput(`${span.textContent.toLowerCase()} `);
      } else {
        domManipulator.appendInputText(span.textContent.toLowerCase());
      }

      domManipulator.removeAllSubMenus();
    });
  }

  return ulElem;
}

/**
 * Shows available options for command in sub-menu
 */
function thisCommandOptions() {
  const command = commandHandler.getCommand(domManipulator.getThisCommandItem().children[0].textContent.toLowerCase());
  const options = command.options;

  if (options) {
    const input = textTools.trimSpace(domManipulator.getInputText()).split(' ');

    if (input.length > 1) {
      const currentOption = options[input[input.length - 1]];

      if (currentOption && currentOption.next) {
        domManipulator.addSubMenuItem('thisCommand', createSubMenuItem(Object.keys(currentOption.next)));
      }
    } else {
      const firstLevelOptions = Object.keys(options);

      domManipulator.addSubMenuItem('thisCommand', createSubMenuItem(firstLevelOptions));
    }
  }
}

/**
 * Shows available commands in sub-menu
 */
function showCommands() {
  const commands = commandHandler.getCommands({ aliases: true, filtered: true });

  domManipulator.addSubMenuItem('commands', createSubMenuItem(commands, true));
}

/**
 * Populate top menu with items
 */
function populateMenu() {
  const menuItems = {
    runCommand: {
      itemName: 'EXEC',
      extraClass: 'menuButton',
      func: enterKeyHandler,
      elementId: 'runCommand',
    },
    commands: {
      itemName: 'CMDS',
      func: showCommands,
      elementId: 'commands',
    },
    thisCommand: {
      itemName: '',
      func: thisCommandOptions,
      elementId: 'thisCommand',
    },
    lantern: {
      itemName: 'LANTERN',
      func: domManipulator.toggleLantern,
      elementId: 'lantern',
    },
  };
  const menuKeys = Object.keys(menuItems);

  for (let i = 0; i < menuKeys.length; i++) {
    const menuItem = menuItems[menuKeys[i]];
    const listItem = createMenuItem(menuItem);

    if (listItem.id === 'thisCommand') {
      domManipulator.setThisCommandItem(listItem);
    }

    attachMenuListener(listItem, menuItem.func, menuItem.funcParam);
    domManipulator.addMenuItem(listItem);
  }
}

/**
 * Print welcome messages
 */
function printWelcomeMessage() {
  if (!storage.getFastMode()) {
    const mainLogo = labels.getMessage('logos', 'mainLogo');
    const razorLogo = labels.getMessage('logos', 'razor');

    messenger.queueMessage(mainLogo);
    messenger.queueMessage({ text: labels.getText('info', 'welcomeLoggedIn') });
    messenger.queueMessage({ text: labels.getText('info', 'razorHacked') });
    messenger.queueMessage(razorLogo);
  }
}

/**
 * Print starting messages
 */
function printStartMessage() {
  if (!storage.getFastMode()) {
    const mainLogo = labels.getMessage('logos', 'mainLogo');

    messenger.queueMessage(mainLogo);
    messenger.queueMessage({
      text: labels.getText('info', 'establishConnection'),
      extraClass: 'upperCase',
    });
    messenger.queueMessage({ text: labels.getText('info', 'welcome') });
  }
}

/**
 * Add listener that sets view to full screen on click
 */
function attachFullscreenListener() {
  domManipulator.getMainView().addEventListener('click', (event) => {
    clickHandler.toggleClicked();

    if (clickHandler.isClicked()) {
      domManipulator.focusInput();
    } else {
      domManipulator.blurInput();
    }

    if (storage.getForceFullscreen() === true) {
      // Set whole document to full screen
      goFullScreen(document.documentElement);
      fullscreenResize(clickHandler.isClicked());
    }

    domManipulator.removeAllSubMenus();

    event.preventDefault();
  });
}

/**
 * Resets local storage
 */
function resetAllLocalVals() {
  storage.removeCommandHistory();
  storage.removeRoom();
  storage.removeUser();
  storage.setAccessLevel(0);
  domManipulator.setInputStart(storage.getDefaultInputStart());
  previousCommandPointer = 0;
}

/**
 * Modifies message following special rules depending on what the message contains
 * @param {Object} message - Message to be modified
 * @returns {Object} Returns modified message
 */
function hideMessageProperties(message = {}) {
  const modifiedMessage = message;
  const roomName = message.roomName;

  // TODO Change blank user and room to booleans instead of string removal
  if (message.extraClass === 'importantMsg') {
    modifiedMessage.roomName = '';
    modifiedMessage.userName = '';
    modifiedMessage.skipTime = true;
  } else if (message.extraClass === 'broadcastMsg') {
    modifiedMessage.roomName = '';
    modifiedMessage.userName = '';
  }

  if (roomName && roomName !== null) {
    const whisperIndex = roomName.indexOf('-whisper');

    if (whisperIndex >= 0) {
      if (message.userName === storage.getUser()) {
        modifiedMessage.roomName = roomName.substring(0, whisperIndex);
      } else {
        modifiedMessage.roomName = 'whisper';
      }
    } else if (roomName.indexOf('-device') >= 0) {
      modifiedMessage.roomName = 'device';
    } else if (roomName.indexOf('team') >= 0) {
      modifiedMessage.roomName = 'team';
    }
  }

  return modifiedMessage;
}

// TODO Not all Android devices have touch screens
/**
 * Checks if device is iOS or Android
 * @returns {boolean} Returns true if userAgent contains iPhone, iPad, iPod or Android
 */
function isTouchDevice() {
  return ((isIos() || isAndroid()));
}

/**
 * Called on message emit. Prints text
 * @param {Object} params - Parameters
 * @param {Object} params.message - Message
 */
function onMessage(params = { message: {} }) {
  const message = textTools.addMessageSpecialProperties(hideMessageProperties(params.message));

  messenger.queueMessage(message);

  if (layoutChanger.isViewExpanded()) {
    domManipulator.flashMenu();
  }
}

/**
 * Called on messages emit. Prints multiple texts
 * @param {Object} params - Parameters
 * @param {Object[]} params.messages - Messages
 */
function onMessages(params = { messages: [] }) {
  const messages = params.messages;

  for (let i = 0; i < messages.length; i++) {
    const message = textTools.addMessageSpecialProperties(hideMessageProperties(messages[i]));

    messenger.queueMessage(message);
  }

  if (layoutChanger.isViewExpanded()) {
    domManipulator.flashMenu();
  }
}

/**
 * Called on importantMsg emit. Prints text
 * @param {Object} params - Parameters
 * @param {Object} params.message - Message
 */
function onImportantMsg(params = {}) {
  const message = params.message;

  if (message) {
    message.extraClass = 'importantMsg';
    message.skipTime = true;

    messenger.queueMessage(message);

    if (message.morse) {
      commandHandler.triggerCommand({ cmd: 'morse', cmdParams: message.text.slice(0, 1) });
    }
  }

  if (layoutChanger.isViewExpanded()) {
    domManipulator.flashMenu();
  }
}

/**
 * Called on reconnect emit. Triggers when the connection is lost and then re-established
 */
function onReconnect() {
  clearTimeout(serverDownTimeout);
  socketHandler.reconnect();
  domManipulator.setStatus(labels.getString('status', 'online'));
}

/**
 * Called on disconnect emit
 */
function onDisconnect() {
  const serverDown = () => {
    if (storage.getUser()) {
      printWelcomeMessage();
    } else {
      printStartMessage();
    }
  };

  domManipulator.setStatus(labels.getString('status', 'offline'));
  messenger.queueMessage({
    text: labels.getText('info', 'lostConnection'),
  });
  serverDownTimeout = setTimeout(serverDown, 300000);
}

/**
 * Called on follow emit
 * @param {Object} params - Parameters
 * @param {Object} params.room - Room
 */
function onFollow(params = { room: {} }) {
  const room = params.room;

  if (room.entered) {
    enterRoom(room.roomName);
  } else {
    messenger.queueMessage({
      text: [`Following ${room.roomName}`],
      text_se: [`Följer ${room.roomName}`],
    });
  }
}

/**
 * Called on unfollow emit
 * @param {Object} params - Parameters
 * @param {Object} params.room - Room
 * @param {string} params.room.roomName - Name of the room that was unfollowed
 */
function onUnfollow(params = { room: { roomName: '' } }) {
  const room = params.room;

  if (!params.silent) {
    messenger.queueMessage({
      text: [`Stopped following ${room.roomName}`],
      text_se: [`Slutade följa ${room.roomName}`],
    });
  }

  if (room.roomName === storage.getRoom()) {
    socketHandler.emit('follow', {
      room: {
        roomName: 'public',
        entered: true,
      },
    });
  }
}

/**
 * Called on login emit. Sets users info and starts map
 * @param {Object} params - Parameters
 * @param {Object} params.user - User information
 */
function onLogin(params = {}) {
  const user = params.user;
  const mode = user.mode || 'cmd';

  commandHandler.triggerCommand({ cmd: 'clear' });
  storage.setUser(user.userName);
  storage.setAccessLevel(user.accessLevel);
  messenger.queueMessage({
    text: [`Successfully logged in as ${user.userName}`],
    text_se: [`Lyckades logga in som ${user.userName}`],
  });
  printWelcomeMessage();
  commandHandler.triggerCommand({ cmd: 'mode', cmdParams: [mode] });

  socketHandler.emit('updateDeviceSocketId', {
    device: {
      deviceId: storage.getDeviceId(),
    },
    user: {
      userName: storage.getUser(),
    },
  });
  socketHandler.emit('follow', {
    room: {
      roomName: 'public',
      entered: true,
    },
  });
  mapTools.startMap();
}

/**
 * @param {Object} params - Parameters
 * @param {boolean} params.noStepCall - Should next step function be skipped?
 * @param {boolean} params.freezeStep - Should the step stay the same after being called?
 * @param {*} params.newData - New data to be used by next command step
 */
function onCommandSuccess(params = {}) {
  const commandHelper = commandHandler.commandHelper;

  if (!params.noStepCall) {
    if (!params.freezeStep) {
      commandHelper.onStep++;
    }

    commandHandler.triggerCommandStep(params.newData);
  } else {
    commandHandler.resetCommand(false);
  }
}

/**
 * Called on commandFail emit
 */
function onCommandFail() {
  const commandHelper = commandHandler.commandHelper;

  if (commandHelper.command !== null) {
    commandHandler.abortCommand(commandHelper.command);
    commandHandler.resetCommand(true);
  }
}

/**
 * Calls a specific command step which has been designated as the fallback step
 * Example usage: failed login leads back to start of user name input
 * @param {string[]} cmdParams - Parameters for the command step
 */
function onCommandStep(cmdParams) {
  commandHandler.commandHelper.onStep = commandHandler.commandHelper.fallbackStep;
  commandHandler.triggerCommandStep(cmdParams);
}

/**
 * Called on reconnectSuccess emit
 * @param {Object} params - Parameters
 *
 */
function onReconnectSuccess(params = {}) {
  if (!params.anonUser) {
    const mode = params.user.mode || 'cmd';
    const room = storage.getRoom();

    commandHandler.triggerCommand({ cmd: 'mode', cmdParams: [mode] });
    storage.setAccessLevel(params.user.accessLevel);

    if (!params.firstConnection) {
      messenger.queueMessage({
        text: labels.getText('info', 'reestablished'),
      });
    } else {
      printWelcomeMessage();

      if (room) {
        commandHandler.triggerCommand({ cmd: 'room', cmdParams: [room] });
      }
    }

    messenger.queueMessage({
      text: ['Retrieving missed messages (if any)'],
      text_se: ['Hämtar missade meddelanden (om det finns några)'],
    });

    socketHandler.emit('updateDeviceSocketId', {
      device: {
        deviceId: storage.getDeviceId(),
      },
      user: {
        userName: storage.getUser(),
      },
    });
  } else {
    if (!params.firstConnection) {
      messenger.queueMessage(labels.getMessage('info', 'reestablished'));
    } else {
      printStartMessage();
    }
  }

  socketHandler.setReconnecting(false);

  if (params.welcomeMessage) {
    messenger.queueMessage({
      text: ['!!!!!', params.welcomeMessage, '!!!!!'],
    });
  }
}

/**
 * Called on disconnectUser emit
 */
function onDisconnectUser() {
  const currentUser = storage.getUser();

  // There is no saved local user. We don't need to print this
  if (currentUser && currentUser !== null) {
    messenger.queueMessage({
      text: [
        `Didn't find user ${currentUser} in database`,
        'Resetting local configuration',
      ],
      text_se: [
        `Kunde inte hitta användaren ${currentUser} i databasen`,
        'Återställer lokala konfigurationen',
      ],
    });
  }

  resetAllLocalVals();
}

/**
 * Called on morse emit. Plays and prints morse
 * @param {Object} params - Parameters
 * @param {string} params.morseCode - Morse code to be played and printed
 * @param {boolean} params.silent - Should the morse code be printed as text?
 */
function onMorse(params = {}) {
  playMorse(params.morseCode, params.silent);
}

/**
 * Called on time emit. Prints time from server
 * @param {Object} params - Parameters
 * @param {Date} params.time - Current time
 */
function onTime(params = {}) {
  messenger.queueMessage({
    text: [`Time: ${textTools.generateTimeStamp(params.time, true, true)}`],
    text_en: [`Tid: ${textTools.generateTimeStamp(params.time, true, true)}`],
  });
}

/**
 * Called on ban emit
 */
function onBan() {
  messenger.queueMessage({
    text: labels.getText('info', 'youHaveBeenBanned'),
    extraClass: 'importantMsg',
  });
  resetAllLocalVals();
}

/**
 * Called on logout emit. Clears local data
 */
function onLogout() {
  commandHandler.triggerCommand({ cmd: 'clear' });
  resetAllLocalVals();
  socketHandler.emit('followPublic');

  printStartMessage();
}

/**
 * Called on updateCommands emit
 * @param {Object} params - Parameters
 */
function onUpdateCommands(params = { commands: [] }) {
  const newCommands = params.commands;

  for (let i = 0; i < newCommands.length; i++) {
    commandHandler.updateCommand(newCommands[i]);
  }
}

/**
 * Called on weather emit.
 * @param {Object[]} report - Weather information
 */
function onWeather(report) {
  const weather = [];
  let weatherString = '';

  for (let i = 0; i < report.length; i++) {
    const weatherInstance = report[i];
    const time = new Date(weatherInstance.time);
    const hours = textTools.beautifyNumb(time.getHours());
    const day = textTools.beautifyNumb(time.getDate());
    const month = textTools.beautifyNumb(time.getMonth() + 1);
    const temperature = Math.round(weatherInstance.temperature);
    const windSpeed = Math.round(weatherInstance.gust);
    const precipitation = weatherInstance.precipitation === 0 ? 'Light ' : `${weatherInstance.precipitation}mm`;
    let coverage;
    let precipType;
    weatherString = '';

    switch (weatherInstance.precipType) {
      // None
      case 0: {
        break;
      }
      // Snow
      case 1: {
        precipType = labels.getString('weather', 'snow');

        break;
      }
      // Snow + rain
      case 2: {
        precipType = labels.getString('weather', 'snowRain');

        break;
      }
      // Rain
      case 3: {
        precipType = labels.getString('weather', 'rain');

        break;
      }
      // Drizzle
      case 4: {
        precipType = labels.getString('weather', 'drizzle');

        break;
      }
      // Freezing rain
      case 5: {
        precipType = labels.getString('weather', 'freezeRain');

        break;
      }
      // Freezing drizzle
      case 6: {
        precipType = labels.getString('weather', 'freezeDrizzle');

        break;
      }
      default: {
        break;
      }
    }

    switch (weatherInstance.cloud) {
      case 0:
      case 1:
      case 2:
      case 3: {
        coverage = labels.getString('weather', 'light');

        break;
      }
      case 4:
      case 5:
      case 6: {
        coverage = labels.getString('weather', 'moderate');

        break;
      }
      case 7:
      case 8:
      case 9: {
        coverage = labels.getString('weather', 'high');

        break;
      }
      default: {
        break;
      }
    }

    weatherString += `${day}/${month} ${hours}:00: `;
    weatherString += `${labels.getString('weather', 'temperature')}: ${temperature}${'\xB0C'} `;
    weatherString += `${labels.getString('weather', 'visibility')}: ${weatherInstance.visibility}km `;
    weatherString += `${labels.getString('weather', 'direction')}: ${weatherInstance.windDirection}${'\xB0'} `;
    weatherString += `${labels.getString('weather', 'speed')}: ${windSpeed}m/s `;
    weatherString += `${labels.getString('weather', 'pollution')}: ${coverage} `;

    if (precipType) {
      weatherString += precipitation;
      weatherString += precipType;
    }

    weather.push(weatherString);
  }

  messenger.queueMessage({ text: weather });
}

/**
 * Called on updateDeviceId emit. Sets new device ID
 * @param {string} newId - New device ID
 */
function onUpdateDeviceId(newId) {
  storage.setDeviceId(newId);
}

/**
 * Called on whoami emit
 * @param {Object} params - Parameters
 * @param {Object} params.user - User information
 */
function onWhoami(params) {
  const team = params.user.team || '';
  const userMarker = mapTools.getThisUserMarker();
  const text = textTools.createCommandStart('whoami').concat([
    `User: ${params.user.userName}`,
    `Access level: ${params.user.accessLevel}`,
    `Team: ${team}`,
    `Device ID: ${storage.getDeviceId()}`,
    `Location: ${userMarker ? userMarker.getPosition() : 'Unknown'}`,
    textTools.createCommandEnd(),
  ]);

  messenger.queueMessage({ text });
}

/**
 * Called on list emit. Receives a list to print
 * @param {Object} params - Parameters
 * @param {number} params.columns - Number of columns to print items to
 * @param {Object[]} params.itemList - List to be printed
 * @param {string} params.itemList[].listTitle - Title of the list
 */
function onList(params = {}) {
  if (params.itemList) {
    const itemList = params.itemList.itemList;
    const title = params.itemList.listTitle;

    if (title) {
      onMessage({ message: { text: textTools.createCommandStart(title) } });
    }

    onMessage({
      message: {
        text: itemList,
        linkable: params.itemList.linkable || true,
        keepInput: params.itemList.keepInput || true,
        replacePhrase: params.itemList.replacePhrase || false,
        columns: params.columns,
        extraClass: 'columns',
      },
    });
  }
}

/**
 * Called on matchFound emit
 * @param {Object} params - Parameters
 * @param {string} params.matchedName - Found match
 */
function onMatchFound(params = { matchedName: '' }) {
  domManipulator.replaceLastInputPhrase(`${params.matchedName} `);
}

/**
 * Called on mapPositions emit. Adds new map positions
 * @param {Object} params - Parameters
 * @param {Object[]} params.positions - New map positions
 * @param {string} [params.team] - Name of the team that the user in the position belongs to. Valid for user positions
 * @param {Date} [params.currentTime] - Time of update of the positions
 */
function onMapPositions(params) {
  const mapPositions = params.positions || [];
  const team = params.team;
  const userName = storage.getUser() ? storage.getUser().toLowerCase() : '';

  for (let i = 0; i < mapPositions.length; i++) {
    const mapPosition = mapPositions[i];

    if (mapPosition.positionName.toLowerCase() === userName) {
      continue;
    }

    const positionName = mapPosition.positionName;
    const latitude = parseFloat(mapPosition.position.latitude);
    const longitude = parseFloat(mapPosition.position.longitude);
    const coordsCollection = mapPosition.position.coordsCollection;
    const geometry = mapPosition.geometry;
    const type = mapPosition.type;
    const group = mapPosition.group;
    const description = mapPosition.description;

    if (geometry === 'line') {
      mapTools.setLinePosition({
        coordsCollection,
        positionName,
      });
    } else if (geometry === 'polygon') {
      mapTools.setPolygonPosition({
        positionName,
        coordsCollection,
      });
    } else if (geometry === 'point') {
      mapTools.setMarkerPosition({
        positionName,
        position: {
          latitude,
          longitude,
        },
        description,
        markerType: 'location',
      });
    } else if (type && type === 'user' && mapPosition.lastUpdated) {
      const currentTime = new Date(params.currentTime);
      const lastUpdated = new Date(mapPosition.lastUpdated);

      if (currentTime - lastUpdated < (20 * 60 * 1000)) {
        const userDescription = `Team: ${mapPosition.group || '-'}. Last seen: ${textTools.generateTimeStamp(lastUpdated, true)}`;

        mapTools.setMarkerPosition({
          lastUpdated,
          positionName,
          position: {
            latitude,
            longitude,
          },
          iconUrl: team && group && team === group ? 'images/mapiconteam.png' : 'images/mapiconuser.png',
          hideLabel: true,
          description: userDescription,
          markerType: type,
        });
      }
    }
  }

  mapTools.toggleMapLabels();
}

/**
 * Video message emitted from server
 * @param {{videoPath: string}} params - Path for the video to load from
 */
function onVideoMessage(params = {}) {
  if (!storage.getLoadVideo()) {
    return;
  }

  const videoPath = params.videoPath;

  if (videoPath) {
    videoPlayer.setVideo(videoPath);
    videoPlayer.loadVideo();

    videoPlayer.getPlayer().addEventListener('canplaythrough', () => {
      // layoutChanger.splitView(true, domManipulator.getVideoHolder());
      videoPlayer.playVideo();
    });
  }
}

/**
 * Called on reboot emit. Calls reboot command
 */
function onReboot() {
  commandHandler.triggerCommand({ cmd: 'reboot' });
}

/**
 * Called on stationStats emit
 * @param {Object} params - Parameters
 * @param {Object[]} params.teams - Team names, scores
 * @param {string} params.teams[].short_name - Name of the team
 * @param {Object[]} params.stations - Station IDs, status
 * @param {Object} params.currentRound - Times for current round
 * @param {Object} params.futureRounds - Times for future rounds
 * @param {Date} params.now - Current time
 */
function onStationStats(params) {
  const stationsStats = params.stations;
  const teamsStats = params.teams;
  const currentRound = params.currentRound;
  const futureRounds = params.futureRounds;
  const now = params.now;

  for (let i = 0; i < stationsStats.length; i++) {
    const station = stationsStats[i];
    const stationId = `${station.id || station.stationId}`;
    const stationTeam = teamsStats.find(team => station.owner === team.name);

    if (!stations[stationId]) {
      stations[stationId] = {};
    }

    if (station.owner && stationTeam && stationTeam.short_name) {
      stations[stationId].owner = stationTeam.short_name;
    } else if (stationTeam && !stationTeam.short_name) {
      stations[stationId].owner = '?';
    } else if (station.owner === null) {
      stations[stationId].owner = '-';
    }

    if (station.signalValue || station.boost) {
      stations[stationId].signalValue = station.signalValue || station.boost;
    }

    if (typeof station.active === 'boolean') {
      stations[stationId].active = station.active;
    }
  }

  for (let i = 0; i < teamsStats.length; i++) {
    const team = teamsStats[i];
    const teamName = team.name;

    if (teamName === 'ownerless') {
      continue;
    }

    teams[teamName] = team.score;
  }

  domManipulator.setStationStats(stations, teams, currentRound, futureRounds, now);
}

/**
 * Called from server on client connection
 * Sets configuration properties from server and starts the rest of the app
 * @param {Object} params - Configuration properties
 */
function onStartup(params = { }) {
  domManipulator.setStatus(labels.getString('status', 'online'));
  storage.setDefaultLanguage(params.defaultLanguage);
  storage.shouldForceFullscreen(params.forceFullscreen);
  storage.shouldGpsTrack(params.gpsTracking);
  storage.shouldDisableCommands(params.disableCommands);
  storage.shouldHideRoomNames(params.hideRoomNames);
  storage.shouldHideTimeStamp(params.hideTimeStamp);
  storage.shouldStaticInputStart(params.staticInputStart);
  storage.setDefaultInputStart(params.defaultInputStart);
  storage.shouldHideCursor(storage.isHiddenCursor());
  storage.shouldHideMenu(storage.isHiddenMenu());
  storage.shouldHideCmdInput(storage.isHiddenCmdInput());
  storage.shouldThinView(storage.isThinView());
  storage.setCenterCoordinates(params.centerLong, params.centerLat);
  storage.setCornerOneCoordinates(params.cornerOneLong, params.cornerOneLat);
  storage.setCornerTwoCoordinates(params.cornerTwoLong, params.cornerTwoLat);
  storage.setDefaultZoomLevel(params.defaultZoomLevel);
  storage.setRadioChannels(params.radioChannels);
  mapTools.setCornerCoords(storage.getCornerOneCoordinates(), storage.getCornerTwoCoordinates());

  socketHandler.emit('getCommands');
  labels.setLanguage(storage.getDefaultLanguage());
  domManipulator.setMainView(document.getElementById('background'));
  commandHandler.addSpecialHelpOptions();

  if (firstConnection) {
    populateMenu();
    padMenu();

    if (!isTouchDevice()) {
      domManipulator.focusInput();
    } else {
      document.body.classList.add('bold');
      domManipulator.getMainView().classList.add('fullscreen');
    }

    if (!storage.getDeviceId()) {
      storage.setDeviceId(textTools.createDeviceId());
    }

    setInterval(() => {
      socketHandler.emit('updateDeviceLastAlive', { device: { deviceId: storage.getDeviceId(), lastAlive: new Date() } });
    }, 5000);

    attachFullscreenListener();
    // Needed for some special keys. They are not detected with keypress
    addEventListener('keydown', specialKeyPress);
    addEventListener('keyup', keyReleased);
    addEventListener('orientationchange', () => {
      layoutChanger.toggleIsLandscape();
      layoutChanger.changeOrientation();
      domManipulator.scrollView();
    });
    window.addEventListener('focus', refocus);

    resetPreviousCommandPointer();
    setTimeouts();
    buildMorsePlayer();

    if (!storage.getAccessLevel()) {
      storage.setAccessLevel(0);
    }

    if (!storage.getUser()) {
      domManipulator.setInputStart(storage.getDefaultInputStart());
      socketHandler.emit('updateDeviceSocketId', {
        device: { deviceId: storage.getDeviceId() },
        user: {
          userName: 'NO_USER_LOGGED_IN',
        },
      });
    }

    socketHandler.emit('updateId', {
      user: { userName: storage.getUser() },
      firstConnection: true,
      device: { deviceId: storage.getDeviceId() },
    });

    mapTools.startMap();

    firstConnection = false;
  }
}

window.addEventListener('error', (event) => {
  /**
   * Reloads page
   * @private
   */
  function restart() {
    window.location.reload();
  }

  console.log(event.error);
  domManipulator.setStatus(labels.getString('status', 'offline'));
  messenger.queueMessage({
    text: ['!!!! Something bad happened and the terminal is no longer working !!!!', 'Rebooting in 3 seconds'],
  });
  setTimeout(restart, 3000);

  return false;
});

socketHandler.startSocket({
  message: onMessage,
  messages: onMessages,
  importantMsg: onImportantMsg,
  reconnect: onReconnect,
  disconnect: onDisconnect,
  follow: onFollow,
  unfollow: onUnfollow,
  login: onLogin,
  commandSuccess: onCommandSuccess,
  commandFail: onCommandFail,
  reconnectSuccess: onReconnectSuccess,
  disconnectUser: onDisconnectUser,
  morse: onMorse,
  time: onTime,
  ban: onBan,
  logout: onLogout,
  updateCommands: onUpdateCommands,
  weather: onWeather,
  updateDeviceId: onUpdateDeviceId,
  whoAmI: onWhoami,
  list: onList,
  matchFound: onMatchFound,
  startup: onStartup,
  mapPositions: onMapPositions,
  videoMessage: onVideoMessage,
  commandStep: onCommandStep,
  reboot: onReboot,
  stationStats: onStationStats,
});
