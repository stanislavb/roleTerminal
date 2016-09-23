'use strict';

const defaultLanguage = require('./../config/defaults/config').app.defaultLanguage;

/**
 * Appends property name with the set default language in the configuration
 * @param {string} propertyName Name of the property
 * @returns {String} Property name with the set default language in the configuration
 */
function appendLanguageCode(propertyName) {
  if (defaultLanguage !== '') {
    return `${propertyName}_${defaultLanguage}`;
  }

  return propertyName;
}

exports.appendLanguageCode = appendLanguageCode;
