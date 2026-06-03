const DEFAULT_MAX_STRING_LENGTH = 4096;

function validatePlainObject(value, name = 'value', { allowUndefined = false } = {}) {
  if (value === undefined || value === null) {
    if (allowUndefined) return {};
    throw new Error(`${name} must be an object.`);
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${name} must be a plain object.`);
  }

  return value;
}

function validateString(value, name = 'value', options = {}) {
  const {
    max = DEFAULT_MAX_STRING_LENGTH,
    trim = true,
    required = false,
    allowUndefined = !required,
    allowNul = false
  } = options;

  if (value === undefined || value === null) {
    if (allowUndefined) return '';
    throw new Error(`${name} is required.`);
  }

  if (typeof value !== 'string') {
    throw new Error(`${name} must be a string.`);
  }

  const text = trim ? value.trim() : value;
  if (required && !text) throw new Error(`${name} is required.`);
  if (text.length > max) throw new Error(`${name} is too long (max ${max} characters).`);
  if (!allowNul && text.includes('\u0000')) throw new Error(`${name} contains an invalid null byte.`);
  return text;
}

function validateNumberLike(value, name = 'value', options = {}) {
  const { allowUndefined = true, min = -Infinity, max = Infinity } = options;
  if (value === undefined || value === null || value === '') {
    if (allowUndefined) return undefined;
    throw new Error(`${name} is required.`);
  }

  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new Error(`${name} must be a number.`);
  }

  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} must be a finite number.`);
  if (number < min || number > max) throw new Error(`${name} must be between ${min} and ${max}.`);
  return number;
}

function validateBoolean(value, name = 'value') {
  if (typeof value !== 'boolean') throw new Error(`${name} must be true or false.`);
  return value;
}

function validateStringArray(value, name = 'value', options = {}) {
  const {
    maxItems = 100,
    maxItemLength = DEFAULT_MAX_STRING_LENGTH,
    allowUndefined = true,
    trim = true
  } = options;

  if (value === undefined || value === null) {
    if (allowUndefined) return [];
    throw new Error(`${name} is required.`);
  }

  if (!Array.isArray(value)) throw new Error(`${name} must be an array.`);
  if (value.length > maxItems) throw new Error(`${name} has too many items (max ${maxItems}).`);

  return value.map((entry, index) => validateString(entry, `${name}[${index}]`, {
    max: maxItemLength,
    trim,
    allowUndefined: false
  }));
}

module.exports = {
  validatePlainObject,
  validateString,
  validateNumberLike,
  validateBoolean,
  validateStringArray
};
